import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MD_CANONICAL_CASE } from '../../src/domain/markdown';

/**
 * v1.2.0 批次三集成测试（G-12 成果结构化预览 / G-13 参观链接+分享卡 / G-16 全量导出）：
 * - G-12 断言①：规范用例（表格/列表/代码块）在交付页渲染为 <table>/<li>/<pre><code>。
 * - G-12 断言②：成果埋 <script>/<img onerror> → 交付页源码只见转义实体、无可执行标签。
 * - G-12 断言③：同一用例文本——登录内成果数据（/api/results）与公开交付页双端一致口径。
 * - G-13 断言①：visit 链接无登录打开见成员状态聚合与完成数；HTML 全文不含任务标题/brief/成果片段/金额。
 * - G-13 断言②：撤销 404；过期（410）与口令行为同交付页同组口径。
 * - G-13 断言③：share-card content-type 与内容（标题/空间名）；标题带 < 时转义、SVG 不破。
 * - G-16 断言①：zip 含全部约定文件；全文件检索无 API 明文 Key、掩码存在。
 * - G-16 断言②：zip 内零其他空间 id/唯一标题。
 * - G-16 断言③：audit 一条 + 超限 VALIDATION；另加非成员 404 / 成员非所有者 403。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const PLAIN_KEY = '<MASKED_SECRET_003>!';
const TASK_A_TITLE = 'G12规范成果标题ZZ';
const TASK_A_BRIEF = 'G13独特brief片段ZZ';
const TASK_B_TITLE = 'B空间唯一标题QQ';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  base: string;
  mockBase: string;
  procs: ChildProcess[];
  dataDir: string;
  adminCookie: string;
}

async function waitUp(url: string, timeout = 25_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 继续等 */
    }
    await sleep(300);
  }
  return false;
}

async function loginAdmin(base: string): Promise<string> {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: '<MASKED_SECRET_001>!' }),
  });
  const j: any = await r.json();
  expect(j.ok).toBe(true);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const r2 = await fetch(base + '/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      currentPassword: '<MASKED_SECRET_001>!',
      newPassword: '<MASKED_SECRET_002>!',
    }),
  });
  expect((await r2.json()).ok).toBe(true);
  return cookie;
}

async function startRig(serverPort: number, mockPort: number): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120d-'));
  const mock = spawn('node', [MOCK], {
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_REVIEW_MODE: 'pass' },
    stdio: 'pipe',
    detached: true,
  });
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(serverPort),
      DATA_DIR: dataDir,
      LLM_RETRY_BASE_MS: '10',
      SWARM_ADMIN_EMAIL: 'admin@test.local',
      SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_001>!',
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const rig: Rig = {
    base: `http://127.0.0.1:${serverPort}`,
    mockBase: `http://127.0.0.1:${mockPort}`,
    procs: [mock, server],
    dataDir,
    adminCookie: '',
  };
  expect(await waitUp(rig.mockBase + '/__counts')).toBe(true);
  expect(await waitUp(rig.base + '/api/health')).toBe(true);
  rig.adminCookie = await loginAdmin(rig.base);
  return rig;
}

function stopRig(rig: Rig): void {
  for (const p of rig.procs) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
  try {
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

async function jget(base: string, p: string, cookie: string): Promise<any> {
  const r = await fetch(base + p, { headers: { cookie } });
  return r.json();
}
async function jpost(base: string, p: string, body: unknown, cookie: string): Promise<any> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

function withDb<T>(rig: Rig, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(rig.dataDir, 'swarm.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

function insertTask(
  rig: Rig,
  t: {
    id: string;
    workspaceId: string;
    teamId: string;
    assigneeId?: string | null;
    title: string;
    brief: string;
    status: string;
    result: string;
    costMilli?: number;
  },
): void {
  const now = new Date().toISOString();
  withDb(rig, (db) => {
    db.prepare(
      `INSERT INTO tasks (id, project_id, team_id, assignee_id, title, type, brief, status, result,
        review_note, reject_reason, reject_count, blocked_reason, blocked_code, adjudicated,
        idempotency_key, total_tokens, total_cost_milli, heartbeat_at, injected_kb_ids, created_at,
        claimed_at, finished_at, workspace_id, created_by_user_id, skill_id, skill_version,
        skill_params, is_skill_test, injected_assets, seq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      t.id,
      null,
      t.teamId,
      t.assigneeId ?? null,
      t.title,
      '文案',
      t.brief,
      t.status,
      t.result,
      '',
      '',
      0,
      '',
      null,
      0,
      null,
      100,
      t.costMilli ?? 0,
      now,
      '[]',
      now,
      now,
      t.status === '已完成' ? now : null,
      t.workspaceId,
      null,
      null,
      null,
      '{}',
      0,
      '[]',
      null,
    );
  });
}

/* ---------------- 共享布景 ---------------- */
let rig: Rig;
let wsA = '';
let wsB = '';
let teamId = '';
let memberNames: string[] = [];
let deliveryPath = '';
const TASK_A = 'task_g12_a';
const TASK_CARD = 'task_g13_card';

beforeAll(async () => {
  rig = await startRig(8971, 8981);
  const admin = rig.adminCookie;
  const me = await jget(rig.base, '/api/auth/me', admin);
  wsA = me.workspace.id as string;
  const st = await jget(rig.base, '/api/state', admin);
  teamId = st.teams[0].id as string;
  memberNames = (st.members as Array<{ name: string }>).map((m) => m.name);
  expect(memberNames.length).toBeGreaterThan(0);

  // API 配置：明文 Key PLAIN_KEY（G-16 断言①的检索对象）+ 购額 + 团队绑 API
  const apiId = st.apis[0].id as string;
  const sv = await jpost(
    rig.base,
    '/api/apis/save',
    {
      api: {
        id: apiId,
        name: 'Mock API',
        provider: 'custom',
        baseUrl: rig.mockBase,
        model: 'mock-model',
        pricePerM: 10,
        apiKey: PLAIN_KEY,
      },
    },
    admin,
  );
  expect(sv.ok).toBe(true);
  expect((await jpost(rig.base, '/api/purchase', { apiId, amountYuan: 100 }, admin)).ok).toBe(true);
  expect(
    (
      await jpost(
        rig.base,
        '/api/teams/save',
        { team: { id: teamId, name: st.teams[0].name, color: '#e2574c', apiId } },
        admin,
      )
    ).ok,
  ).toBe(true);

  // 知识 / 资产各一份（G-16 内容断言）
  const kb = await jpost(
    rig.base,
    '/api/kb',
    { title: 'G16导出知识ZZ', body: '导出知识正文', scope: 'company', tags: [] },
    admin,
  );
  expect(kb.ok).toBe(true);
  const asset = await jpost(
    rig.base,
    '/api/assets',
    {
      asset: {
        typeId: '通用文档',
        name: 'G16导出资产ZZ',
        content: { sections: [{ key: 'full', title: '全文', body: '资产正文' }] },
      },
    },
    admin,
  );
  expect(asset.ok).toBe(true);

  // 任务 A（done，成果 = G-12 规范用例文本，金额用独特数字 777.78 元供 G-13 零泄漏断言）
  insertTask(rig, {
    id: TASK_A,
    workspaceId: wsA,
    teamId,
    title: TASK_A_TITLE,
    brief: TASK_A_BRIEF,
    status: '已完成',
    result: MD_CANONICAL_CASE,
    costMilli: 777_780,
  });
  // 分享卡专用 done 任务（标题带 < 供转义断言）
  insertTask(rig, {
    id: TASK_CARD,
    workspaceId: wsA,
    teamId,
    title: '分享卡<标题>ZZ',
    brief: '',
    status: '已完成',
    result: '这是一份用于分享卡的成果摘要文本。',
  });

  // 交付页（task A）
  const dv = await jpost(rig.base, '/api/deliveries', { scope: 'task', taskId: TASK_A }, admin);
  expect(dv.ok).toBe(true);
  deliveryPath = dv.delivery.path as string;
  expect(deliveryPath.startsWith('/d/')).toBe(true);

  // 第二空间 B + 其唯一标题任务（G-16 隔离断言②）
  const w2 = await jpost(rig.base, '/api/workspaces', { name: 'G16乙空间ZZ' }, admin);
  expect(w2.ok).toBe(true);
  wsB = w2.workspace.id as string;
  const sw = await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: wsA }, admin);
  expect(sw.ok).toBe(true);
  insertTask(rig, {
    id: 'task_g16_b',
    workspaceId: wsB,
    teamId,
    title: TASK_B_TITLE,
    brief: '',
    status: '已完成',
    result: 'B 空间成果',
  });
}, 60_000);

afterAll(() => {
  if (rig) stopRig(rig);
});

/* ================= G-12 成果结构化预览（交付页服务端渲染） ================= */
describe('G-12 验收①②③：交付页结构化渲染与 XSS 口径', () => {
  it('① 表格/列表/代码块渲染正确；③ 登录内成果原文与交付页同一用例', async () => {
    const html = await (await fetch(rig.base + deliveryPath)).text();
    expect(html).toContain('<h1>一级标题</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>列A</th>');
    expect(html).toContain('<td>甲</td>');
    expect(html).toContain('<td>乙</td>');
    expect(html).toContain('<li>无序一</li>');
    expect(html).toContain('<li>有序二</li>');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('const x = 1 &lt; 2;');
    expect(html).toContain('<a href="https://example.com" rel="noreferrer">链接</a>');
    // ③ 双端一致：登录内 /api/results 中该成果原文即同一规范用例文本
    const res = await jget(rig.base, '/api/results', rig.adminCookie);
    const mine = (res.results as Array<{ taskId: string; result: string }>).find(
      (r) => r.taskId === TASK_A,
    );
    expect(mine).toBeTruthy();
    expect(mine!.result).toBe(MD_CANONICAL_CASE);
  });

  it('② <script>/<img onerror> 只以转义实体出现、无执行', async () => {
    const html = await (await fetch(rig.base + deliveryPath)).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
  });

  it('交付页内嵌分享卡图（G-13）：带 token 卡图 URL 可取且为 SVG', async () => {
    const html = await (await fetch(rig.base + deliveryPath)).text();
    expect(html).toContain(`${deliveryPath}/share-card.svg`);
    const r = await fetch(rig.base + `${deliveryPath}/share-card.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await r.text();
    expect(svg).toContain(TASK_A_TITLE);
  });
});

/* ================= G-13 参观链接 + 分享卡 ================= */
describe('G-13 验收①②③：参观链接与分享卡', () => {
  it('① 无登录打开见成员状态聚合与完成数；全文零泄漏（标题/brief/成果/金额）', async () => {
    const created = await jpost(rig.base, '/api/visit-links', {}, rig.adminCookie);
    expect(created.ok).toBe(true);
    const path = created.visitLink.path as string;
    expect(path.startsWith('/v/')).toBe(true);

    const r = await fetch(rig.base + path);
    expect(r.status).toBe(200);
    const html = await r.text();
    // 成员名单与能力卡同款字段
    for (const name of memberNames) expect(html).toContain(name);
    // 状态聚合：待命/执行中/待审核三计数之和 = 成员数；近 30 天完成数 ≥1（任务 A）
    const grab = (label: string): number => {
      const m = new RegExp(`${label} <b>(\\d+)</b>`).exec(html);
      expect(m, `参观页应含「${label}」聚合计数`).toBeTruthy();
      return Number(m![1]);
    };
    expect(grab('待命') + grab('执行中') + grab('待审核')).toBe(memberNames.length);
    expect(grab('近 30 天完成')).toBeGreaterThanOrEqual(1);
    // 零泄漏清单
    expect(html).not.toContain(TASK_A_TITLE);
    expect(html).not.toContain(TASK_A_BRIEF);
    expect(html).not.toContain('无序一');
    expect(html).not.toContain('777.78');
    expect(html).not.toContain(wsB);
  });

  it('② 口令/过期/撤销行为与交付页同组口径', async () => {
    // 口令保护：无口令 GET 出表单、错口令仍表单、对口令出参观页
    const withPw = await jpost(
      rig.base,
      '/api/visit-links',
      { password: '<MASKED_SECRET_004>' },
      rig.adminCookie,
    );
    expect(withPw.ok).toBe(true);
    const pwPath = withPw.visitLink.path as string;
    const formHtml = await (await fetch(rig.base + pwPath)).text();
    expect(formHtml).toContain('访问口令');
    const bad = await (
      await fetch(rig.base + pwPath, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong-pass',
      })
    ).text();
    expect(bad).toContain('口令不正确');
    const good = await fetch(rig.base + pwPath, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=<MASKED_SECRET_004>',
    });
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('办公室参观');

    // 过期：建后回拨 expires_at → 410（与交付页同口径）
    const exp = await jpost(rig.base, '/api/visit-links', { expiresInDays: 1 }, rig.adminCookie);
    const expId = exp.visitLink.id as string;
    withDb(rig, (db) => {
      db.prepare('UPDATE delivery_links SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 60_000).toISOString(),
        expId,
      );
    });
    const expRes = await fetch(rig.base + (exp.visitLink.path as string));
    expect(expRes.status).toBe(410);

    // 撤销：DELETE 后打开回 404
    const rv = await jpost(rig.base, '/api/visit-links', {}, rig.adminCookie);
    const rvId = rv.visitLink.id as string;
    const del = await fetch(rig.base + `/api/visit-links/${rvId}`, {
      method: 'DELETE',
      headers: { cookie: rig.adminCookie },
    });
    expect((await del.json()).ok).toBe(true);
    const gone = await fetch(rig.base + (rv.visitLink.path as string));
    expect(gone.status).toBe(404);
  });

  it('③ share-card：content-type/标题/空间名；标题带 < 转义且 SVG 不破；未完成任务拒绝', async () => {
    const r = await fetch(rig.base + `/api/tasks/${TASK_CARD}/share-card`, {
      headers: { cookie: rig.adminCookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await r.text();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('分享卡&lt;标题&gt;ZZ');
    expect(svg).not.toContain('分享卡<标题>');
    const st = await jget(rig.base, '/api/state', rig.adminCookie);
    expect(svg).toContain(st.workspace.name as string);
    expect(svg).toContain('干活蜂群');

    // 未完成任务 → VALIDATION
    insertTask(rig, {
      id: 'task_g13_pending',
      workspaceId: wsA,
      teamId,
      title: '未完成单',
      brief: '',
      status: '待领取',
      result: '',
    });
    const bad = await fetch(rig.base + '/api/tasks/task_g13_pending/share-card', {
      headers: { cookie: rig.adminCookie },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('VALIDATION');
  });
});

/* ================= G-16 所有者一键全量导出 ================= */
describe('G-16 验收①②③：全量导出 zip', () => {
  it('①② zip 含全部约定文件、密钥零明文掩码存在、零他空间数据；③ audit 一条', async () => {
    const r = await fetch(rig.base + `/api/workspaces/${wsA}/export`, {
      method: 'POST',
      headers: { cookie: rig.adminCookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
    for (const f of [
      'tasks.jsonl',
      'projects.json',
      'kb.json',
      'assets.json',
      'skills.json',
      'members-teams.json',
      'ledger.csv',
      'settings.json',
      `results/${TASK_A}.md`,
    ]) {
      expect(names, `zip 应含 ${f}`).toContain(f);
    }
    let all = '';
    for (const n of names) {
      all += (await zip.file(n)!.async('string')) + '\n';
    }
    // 内容到位
    expect(all).toContain(TASK_A_TITLE);
    expect(all).toContain('G16导出知识ZZ');
    expect(all).toContain('G16导出资产ZZ');
    // ① 密钥零明文 + 掩码存在
    expect(all).not.toContain(PLAIN_KEY);
    const settings = await zip.file('settings.json')!.async('string');
    expect(settings).toContain('••••');
    expect(settings).toContain('Mock API');
    // ② 零其他空间数据
    expect(all).not.toContain(TASK_B_TITLE);
    expect(all).not.toContain(wsB);
    // ③ audit 一条
    const rows = withDb(
      rig,
      (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'export_workspace' AND workspace_id = ?",
          )
          .get(wsA) as unknown as { c: number },
    );
    expect(rows.c).toBe(1);
  }, 60_000);

  it('权限：非成员 404、成员非所有者 403', async () => {
    const reg = await fetch(rig.base + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'g16-outsider@test.local',
        password: '<MASKED_SECRET_005>!',
        displayName: '外人',
      }),
    });
    const rj: any = await reg.json();
    expect(rj.ok).toBe(true);
    const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
    const me = await jget(rig.base, '/api/auth/me', cookie);
    const outsiderId = me.user.id as string;

    const notMember = await fetch(rig.base + `/api/workspaces/${wsA}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(notMember.status).toBe(404);

    withDb(rig, (db) => {
      db.prepare(
        "INSERT INTO memberships (user_id, workspace_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)",
      ).run(outsiderId, wsA, new Date().toISOString());
    });
    const memberOnly = await fetch(rig.base + `/api/workspaces/${wsA}/export`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(memberOnly.status).toBe(403);
  });

  it('③ 超限：组装后 >50MB 回 VALIDATION 并提示管理员备份通道', async () => {
    // 不可压缩的大成果（随机 base64 约 78MB 原文）→ zip 必然越过 50MB 上限
    const big = crypto.randomBytes(56 * 1024 * 1024).toString('base64');
    insertTask(rig, {
      id: 'task_g16_big',
      workspaceId: wsB,
      teamId,
      title: '超大成果单',
      brief: '',
      status: '已完成',
      result: big,
    });
    const r = await fetch(rig.base + `/api/workspaces/${wsB}/export`, {
      method: 'POST',
      headers: { cookie: rig.adminCookie },
    });
    expect(r.status).toBe(400);
    const j: any = await r.json();
    expect(j.error.code).toBe('VALIDATION');
    expect(j.error.message).toContain('管理员');
  }, 180_000);
});
