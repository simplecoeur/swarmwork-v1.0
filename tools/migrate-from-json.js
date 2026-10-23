'use strict';
/*
 * 旧数据迁移工具：把 v0（local-app）的 JSON 数据一键导入新版 SQLite（设计 §13 M2）。
 * 用法：node tools/migrate-from-json.js [旧data目录] [目标DATA_DIR]
 *   默认旧目录 ../../local-app/data（相对仓库根的 ../local-app/data），默认目标 ../../data（仓库根 data/）。
 * 安全：目标库已有业务数据时拒绝执行（防重复导入）；导入后打印对账摘要。
 * 金额映射：旧版元（浮点）→ 新版厘（整数，round）。旧版存量 balanceYuan 不迁移——
 * 新版余额为推导值（purchases − ledger，ADR-004），对账摘要会同时列出旧存量余额供人工核对。
 * Key 加密算法与 apps/server/src/store/crypto.ts 保持一致（机器派生密钥 + AES-256-GCM），
 * 本工具为独立脚本无法 import TS，故在此复刻同一实现，修改时两处必须同步。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(REPO_ROOT, '..', 'local-app', 'data');
const DST_DIR = process.argv[3] ? path.resolve(process.argv[3]) : path.join(REPO_ROOT, 'data');
const DB_PATH = path.join(DST_DIR, 'swarm.db');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'apps', 'server', 'src', 'store', 'migrations');

const yuanToMilli = (y) => Math.round((Number(y) || 0) * 1000);

function encryptKey(plain) {
  if (!plain) return '';
  const key = crypto.scryptSync(`agent-swarm:${os.hostname()}:${os.userInfo().username}`, 'agent-swarm-key-v1', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function readJson(file, fallback) {
  const p = path.join(SRC_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const v = f.replace(/\.sql$/, '');
    if (applied.has(v)) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
  }
}

function main() {
  const settings = readJson('settings.json', null);
  if (!settings) {
    console.error('旧数据目录缺少 settings.json：' + SRC_DIR);
    process.exit(1);
  }
  const oldTasks = readJson('tasks.json', []);
  const oldLedger = readJson('ledger.json', []);
  const oldPurchases = readJson('purchases.json', []);

  // —— 迁移前聚合（旧口径） ——
  const before = {
    tasks: oldTasks.length,
    ledger: oldLedger.length,
    totalTokens: oldLedger.reduce((s, l) => s + (l.totalTokens || 0), 0),
    totalCostMilli: oldLedger.reduce((s, l) => s + yuanToMilli(l.costYuan), 0),
    purchasesMilli: oldPurchases.reduce((s, p) => s + yuanToMilli(p.amountYuan), 0),
  };

  fs.mkdirSync(DST_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  runMigrations(db);
  const existing = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c + db.prepare('SELECT COUNT(*) AS c FROM ledger_entries').get().c;
  if (existing > 0) {
    console.error('目标库已有业务数据（tasks/ledger 非空），为防重复导入已中止。目标：' + DB_PATH);
    process.exit(1);
  }

  const ts = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const insApi = db.prepare(
      'INSERT INTO apis (id, name, provider, base_url, api_key_enc, model, price_per_m_milli, created_at, workspace_id) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    for (const a of settings.apis || []) {
      insApi.run(a.id, a.name, a.provider, a.baseUrl || '', encryptKey(a.apiKey || ''), a.model || '', yuanToMilli(a.pricePerM), ts, 'ws_default');
    }
    const insTeam = db.prepare('INSERT INTO teams (id, name, color, api_id, created_at, deleted_at, workspace_id) VALUES (?,?,?,?,?,NULL,?)');
    for (const t of settings.teams || []) insTeam.run(t.id, t.name, t.color || '#5b8def', t.apiId || null, ts, 'ws_default');
    const insMember = db.prepare(
      'INSERT INTO members (id, team_id, name, role, persona, prompt, skill_tags, color, workspace_id) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    for (const m of settings.members || []) {
      insMember.run(m.id, m.teamId, m.name, m.role, m.persona || '', m.prompt || '', '[]', '', 'ws_default');
    }
    const insTask = db.prepare(
      `INSERT INTO tasks (id, project_id, team_id, assignee_id, title, type, brief, status, result, review_note,
        reject_reason, reject_count, blocked_reason, blocked_code, adjudicated, idempotency_key, total_tokens,
        total_cost_milli, heartbeat_at, created_at, claimed_at, finished_at, workspace_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const t of oldTasks) {
      insTask.run(
        t.id, null, t.teamId, t.assigneeId || null, t.title, t.type, t.brief || '', t.status, t.result || '',
        t.reviewNote || '', t.rejectReason || '', t.rejectCount || 0, t.blockedReason || '', null,
        t.reviewNote && t.reviewNote.includes('老板裁决') ? 1 : 0, null,
        t.totalTokens || 0, yuanToMilli(t.totalCost), null, t.createdAt || ts, t.claimedAt || null, t.finishedAt || null, 'ws_default',
      );
    }
    const insLedger = db.prepare(
      `INSERT INTO ledger_entries (task_id, team_id, api_id, stage, prompt_tokens, completion_tokens,
        total_tokens, cost_milli, estimated, created_at, workspace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const l of oldLedger) {
      insLedger.run(
        l.taskId, l.teamId, l.apiId, l.stage, l.promptTokens || 0, l.completionTokens || 0,
        l.totalTokens || 0, yuanToMilli(l.costYuan), 0, l.ts || ts, 'ws_default',
      );
    }
    const insPurchase = db.prepare('INSERT INTO purchases (api_id, amount_milli, created_at, workspace_id, type) VALUES (?,?,?,?,?)');
    for (const p of oldPurchases) insPurchase.run(p.apiId, yuanToMilli(p.amountYuan), p.ts || ts, 'ws_default', 'purchase');

    const setSetting = db.prepare('INSERT INTO settings (workspace_id, key, value) VALUES (?,?,?) ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value');
    setSetting.run('ws_default', 'defaultApiId', JSON.stringify(settings.defaultApiId ?? null));
    setSetting.run('ws_default', 'params', JSON.stringify(settings.params || { concurrency: 4, taskBudgetTokens: 0 }));
    setSetting.run('ws_default', 'reviewStandards', JSON.stringify(settings.reviewStandards || { points: '', clientNeeds: '' }));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // —— 迁移后聚合（新口径，SQL 直查） ——
  const after = {
    tasks: db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c,
    ledger: db.prepare('SELECT COUNT(*) AS c FROM ledger_entries').get().c,
    totalTokens: db.prepare('SELECT COALESCE(SUM(total_tokens),0) AS s FROM ledger_entries').get().s,
    totalCostMilli: db.prepare('SELECT COALESCE(SUM(cost_milli),0) AS s FROM ledger_entries').get().s,
    purchasesMilli: db.prepare('SELECT COALESCE(SUM(amount_milli),0) AS s FROM purchases').get().s,
  };
  const balanceOf = (apiId) =>
    db.prepare('SELECT COALESCE(SUM(amount_milli),0) AS s FROM purchases WHERE api_id=?').get(apiId).s -
    db.prepare('SELECT COALESCE(SUM(cost_milli),0) AS s FROM ledger_entries WHERE api_id=?').get(apiId).s;

  const ok =
    before.tasks === after.tasks &&
    before.ledger === after.ledger &&
    before.totalTokens === after.totalTokens &&
    before.totalCostMilli === after.totalCostMilli &&
    before.purchasesMilli === after.purchasesMilli;

  console.log('=== 数据迁移对账摘要 ===');
  console.log(`源：${SRC_DIR}`);
  console.log(`目标：${DB_PATH}`);
  console.log(`任务数：      ${before.tasks} → ${after.tasks}`);
  console.log(`账本条数：    ${before.ledger} → ${after.ledger}`);
  console.log(`总 token：    ${before.totalTokens} → ${after.totalTokens}`);
  console.log(`总成本：      ${before.totalCostMilli} 厘 → ${after.totalCostMilli} 厘`);
  console.log(`采购合计：    ${before.purchasesMilli} 厘 → ${after.purchasesMilli} 厘`);
  for (const a of settings.apis || []) {
    console.log(`API「${a.name}」推导余额：${balanceOf(a.id)} 厘（旧存量字段 ${yuanToMilli(a.balanceYuan)} 厘，仅供人工核对）`);
  }
  console.log(ok ? '对账结果：一致 ✓' : '对账结果：不一致 ✗（请勿使用目标库，检查上方差异）');
  process.exit(ok ? 0 : 1);
}

main();
