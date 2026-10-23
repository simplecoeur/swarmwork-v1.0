import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { searchWorkspace, escapeLikePattern } from '../../src/domain/searchService';
import { assertSafeOutboundUrl } from '../../src/domain/ssrf';
import { webhookEventForStatus } from '../../src/domain/webhookService';
import { openDb } from '../../src/store/db';
import { Repos } from '../../src/store/repositories';

/**
 * v1.2.0 批次二集成测试（G-07 开放 API/Webhook + G-09 全局搜索）：
 * - G-07 断言①：建 Token → Bearer 发单全链（落库来源可辨、ledger 记账）→ 状态/成果与页面所见一致。
 * - G-07 断言②：吊销后 401、无 Token 401、scope 只有 read 时发单 403（反之亦然）。
 * - G-07 断言③：A 空间 Token 查 B 空间任务 id 回 404。
 * - G-07 断言④：stub 收 task.done 投递（body 含 id/状态、HMAC 验签通过）；端点连续失败 →
 *   attempts=3 后 delivery 置 failed 且所有者收到 webhook_failed 通知。
 * - G-07 断言⑤：169.254.169.254 与 127.0.0.1 的 Webhook URL（http/https 均）拒绝创建。
 * - G-07 附：迁移 010 存量升级对账；membership 失格守卫（删成员关系后 Token 回 401，G-15 预留校验）；
 *   SSRF util 与终态映射的进程内断言。
 * - G-09 断言①：同一唯一关键词埋六类实体 → 一次搜索六组各命中、title/snippet 正确、types 过滤生效。
 * - G-09 断言②：B 空间关键词在 A 搜零命中；他人 personal KB 在 A 搜零命中（searchService 进程内精确断言）。
 * - G-09 断言③：q 含 %/_ 按字面搜索、结果集精确（进程内造干扰数据断言）。
 * - G-09 断言④：资产 snippet 不含正文唯一词；正文唯一词本身也搜不到该资产。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');

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
    body: JSON.stringify({ currentPassword: '<MASKED_SECRET_001>!', newPassword: '<MASKED_SECRET_002>!' }),
  });
  expect((await r2.json()).ok).toBe(true);
  return cookie;
}

async function startRig(
  serverPort: number,
  mockPort: number,
  extraEnv: Record<string, string> = {},
): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120b2-'));
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
      ...extraEnv,
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
async function raw(
  base: string,
  method: string,
  p: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function openCall(
  base: string,
  method: string,
  p: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return raw(base, method, p, body, token ? { authorization: `Bearer ${token}` } : {});
}

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 45_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('waitFor 超时');
}

async function configureMock(
  rig: Rig,
  cookie: string,
  purchaseYuan = 100,
): Promise<{ apiId: string; teamId: string }> {
  const st = await jget(rig.base, '/api/state', cookie);
  const apiId = st.apis[0].id as string;
  const teamId = st.teams[0].id as string;
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
        apiKey: 'fake-key-123',
      },
    },
    cookie,
  );
  expect(sv.ok).toBe(true);
  const pu = await jpost(rig.base, '/api/purchase', { apiId, amountYuan: purchaseYuan }, cookie);
  expect(pu.ok).toBe(true);
  const ts = await jpost(
    rig.base,
    '/api/teams/save',
    { team: { id: teamId, name: st.teams[0].name, color: '#e2574c', apiId } },
    cookie,
  );
  expect(ts.ok).toBe(true);
  return { apiId, teamId };
}

async function taskById(rig: Rig, cookie: string, taskId: string): Promise<any> {
  const st = await jget(rig.base, '/api/state', cookie);
  return st.tasks.find((t: any) => t.id === taskId);
}
async function waitStatus(rig: Rig, cookie: string, taskId: string, status: string): Promise<any> {
  return waitFor(async () => {
    const t = await taskById(rig, cookie, taskId);
    return t && t.status === status ? t : null;
  });
}

/* ---------- stub Webhook 接收端：记录请求，模式可切换 ok/fail ---------- */
interface StubHit {
  headers: http.IncomingHttpHeaders;
  body: string;
}
function startStub(): Promise<{ port: number; hits: StubHit[]; setMode: (m: 'ok' | 'fail') => void; close: () => void }> {
  const hits: StubHit[] = [];
  let mode: 'ok' | 'fail' = 'ok';
  const srv = http.createServer((req, res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: s });
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('stub boom');
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      resolve({
        port,
        hits,
        setMode: (m) => {
          mode = m;
        },
        close: () => srv.close(),
      });
    });
  });
}

/* ================= G-07 全链（断言①②③④） ================= */
describe('G-07 验收①②③④：Token 发单全链 / 吊销与 scope / 跨空间 404 / Webhook 投递与终败', () => {
  it('Bearer 发单跑通并记账、来源可辨；吊销 401、read-only 发单 403；跨空间 404；HMAC 投递成功与失败 3 次置 failed + 通知', async () => {
    const rig = await startRig(8917, 8927, {
      // 开发例外开关：允许 http + 回环地址，仅本测试 rig（stub 在本机回环）
      SWARM_WEBHOOK_ALLOW_INSECURE: '1',
      SWARM_WEBHOOK_TICK_MS: '400',
      SWARM_WEBHOOK_RETRY_DELAYS_MS: '150,300,600',
    });
    const stub = await startStub();
    try {
      const admin = rig.adminCookie;
      const { teamId } = await configureMock(rig, admin);

      /* ----- 断言①：建 Token（明文只出现一次）→ 发单全链 ----- */
      const created = await jpost(
        rig.base,
        '/api/tokens',
        { name: '外部系统集成', scopes: ['dispatch', 'read'] },
        admin,
      );
      expect(created.ok).toBe(true);
      const plain: string = created.token.token;
      expect(plain.startsWith('swk_')).toBe(true);
      expect(created.token.tokenPrefix).toBe(plain.slice(0, 8));
      const tokenId: string = created.token.id;
      // 列表只回掩码信息，绝不含明文
      const list = await jget(rig.base, '/api/tokens', admin);
      expect(JSON.stringify(list)).not.toContain(plain);
      expect((list.tokens as any[]).some((t) => t.id === tokenId)).toBe(true);

      const dispatched = await openCall(rig.base, 'POST', '/api/open/tasks', plain, {
        title: 'G07 开放面发单',
        type: '文案',
        brief: '写一句开放面文案',
        teamId,
      });
      expect(dispatched.status).toBe(200);
      expect(dispatched.json.ok).toBe(true);
      const taskId: string = dispatched.json.id;
      expect(dispatched.json.task.source).toBe('api');
      expect(dispatched.json.task.status).toBe('待领取');

      // 来源可辨：task_events note 与时间线一致（页面侧也能查到同一条）
      const timeline = await jget(rig.base, `/api/tasks/${taskId}/timeline`, admin);
      expect((timeline.events as any[]).some((e) => String(e.note).includes('开放 API'))).toBe(true);

      // 任务经引擎跑完；开放面查状态/成果与页面一致 + ledger 记账
      await waitStatus(rig, admin, taskId, '已完成');
      const stOpen = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, plain);
      expect(stOpen.status).toBe(200);
      expect(stOpen.json.task.status).toBe('已完成');
      const result = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}/result`, plain);
      expect(result.status).toBe(200);
      expect(result.json.task.result).toContain('mock 引擎生成的测试成果');
      expect(result.json.task.totalTokens).toBeGreaterThan(0);
      const pageTask = await taskById(rig, admin, taskId);
      expect(pageTask.result).toBe(result.json.task.result);
      const st = await jget(rig.base, '/api/state', admin);
      const ledgerRows = (st.ledger as any[]).filter((l) => l.taskId === taskId);
      expect(ledgerRows.length).toBeGreaterThan(0);
      expect(ledgerRows.reduce((s, l) => s + l.costYuan, 0)).toBeGreaterThan(0);

      /* ----- 断言②：无 Token 401 / 假 Token 401 / scope 不足 403 ----- */
      const noTok = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, null);
      expect(noTok.status).toBe(401);
      const badTok = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, 'swk_bogus_token_value');
      expect(badTok.status).toBe(401);

      const roCreated = await jpost(rig.base, '/api/tokens', { name: '只读', scopes: ['read'] }, admin);
      const roPlain: string = roCreated.token.token;
      const roDispatch = await openCall(rig.base, 'POST', '/api/open/tasks', roPlain, {
        title: '只读 Token 不许发单',
        type: '文案',
        brief: 'x',
        teamId,
      });
      expect(roDispatch.status).toBe(403);
      const roRead = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, roPlain);
      expect(roRead.status).toBe(200);

      const woCreated = await jpost(rig.base, '/api/tokens', { name: '只写', scopes: ['dispatch'] }, admin);
      const woPlain: string = woCreated.token.token;
      const woRead = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, woPlain);
      expect(woRead.status).toBe(403);

      /* ----- 断言③：B 空间 Token 查 A 空间任务 → 404 ----- */
      const reg = await fetch(rig.base + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'g07-b@test.local',
          password: 'BUserPass123!',
          displayName: 'B 空间老板',
        }),
      });
      const regJson: any = await reg.json();
      expect(regJson.ok).toBe(true);
      const bCookie = (reg.headers.get('set-cookie') || '').split(';')[0];
      const bCreated = await jpost(rig.base, '/api/tokens', { name: 'B 的 Token', scopes: ['read'] }, bCookie);
      expect(bCreated.ok).toBe(true);
      const cross = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, bCreated.token.token);
      expect(cross.status).toBe(404);

      /* ----- 断言④上半：Webhook 创建 → task.done 投递到达 stub、HMAC 验签通过 ----- */
      const secret = 'whsec-test-123';
      const hookCreated = await jpost(
        rig.base,
        '/api/webhooks',
        { url: `http://127.0.0.1:${stub.port}/hook`, secret, events: ['task.done'] },
        admin,
      );
      expect(hookCreated.ok).toBe(true);
      expect(JSON.stringify(hookCreated)).not.toContain(secret);
      expect(hookCreated.webhook.hasSecret).toBe(true);
      const hookId: string = hookCreated.webhook.id;

      // 测试投递：立即 success 且 stub 收到 test 事件
      const testRes = await jpost(rig.base, `/api/webhooks/${hookId}/test`, {}, admin);
      expect(testRes.ok).toBe(true);
      expect(testRes.delivery.status).toBe('success');
      const testHit = stub.hits.find((h) => {
        try {
          return (JSON.parse(h.body) as { event?: string }).event === 'test';
        } catch {
          return false;
        }
      });
      expect(testHit).toBeTruthy();

      const t2 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G07 投递验证单', type: '文案', brief: '写一句', teamId },
        admin,
      );
      expect(t2.ok).toBe(true);
      await waitStatus(rig, admin, t2.id, '已完成');
      const doneHit = await waitFor(async () => {
        const h = stub.hits.find((x) => {
          try {
            const j = JSON.parse(x.body) as { event?: string; taskId?: string };
            return j.event === 'task.done' && j.taskId === t2.id;
          } catch {
            return false;
          }
        });
        return h ?? null;
      });
      const parsed = JSON.parse(doneHit.body) as { event: string; taskId: string; task: { status: string } };
      expect(parsed.task.status).toBe('已完成');
      const expectSig =
        'sha256=' + crypto.createHmac('sha256', secret).update(doneHit.body, 'utf8').digest('hex');
      expect(doneHit.headers['x-swarm-signature']).toBe(expectSig);

      /* ----- 断言④下半：端点连续失败 → attempts=3 置 failed + webhook_failed 通知 ----- */
      const hook2 = await jpost(
        rig.base,
        '/api/webhooks',
        { url: `http://127.0.0.1:${stub.port}/fail-hook`, secret: 'whsec-fail-456', events: ['task.done'] },
        admin,
      );
      expect(hook2.ok).toBe(true);
      stub.setMode('fail');
      const t3 = await jpost(
        rig.base,
        '/api/tasks',
        { title: 'G07 失败投递单', type: '文案', brief: '写一句', teamId },
        admin,
      );
      await waitStatus(rig, admin, t3.id, '已完成');
      const failedDelivery = await waitFor(async () => {
        const d = await jget(rig.base, `/api/webhooks/${hook2.webhook.id}/deliveries`, admin);
        const row = (d.deliveries as any[]).find((x) => x.taskId === t3.id);
        return row && row.status === 'failed' ? row : null;
      }, 60_000);
      expect(failedDelivery.attempts).toBe(3);
      expect(String(failedDelivery.lastError)).toContain('500');
      const notif = await jget(rig.base, '/api/notifications?type=webhook_failed', admin);
      expect(notif.total).toBeGreaterThanOrEqual(1);
      stub.setMode('ok');

      /* ----- 断言②收尾：吊销后同 Token 任一开放端点 401 + audit 可见 ----- */
      const del = await raw(rig.base, 'DELETE', `/api/tokens/${tokenId}`, undefined, { cookie: admin });
      expect(del.json.ok).toBe(true);
      const afterRevoke = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, plain);
      expect(afterRevoke.status).toBe(401);
      const afterRevokePost = await openCall(rig.base, 'POST', '/api/open/tasks', plain, {
        title: '吊销后发单',
        type: '文案',
        brief: 'x',
        teamId,
      });
      expect(afterRevokePost.status).toBe(401);
      const ledgerView = await jget(rig.base, '/api/ledger-view', admin);
      expect(
        (ledgerView.timeline as any[]).some(
          (x) => x.kind === 'audit' && String(x.text).includes('revoke_api_token'),
        ),
      ).toBe(true);

      /* ----- 附：membership 失格守卫（G-15 预留校验落点）——删成员关系后 Token 立即 401 ----- */
      const meB = await jget(rig.base, '/api/auth/me', bCookie);
      const bUserId: string = meB.user.id;
      const bWsId: string = meB.workspace.id;
      const db = new DatabaseSync(path.join(rig.dataDir, 'swarm.db'));
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        db.prepare('DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?').run(bUserId, bWsId);
      } finally {
        db.close();
      }
      const memberless = await openCall(rig.base, 'GET', `/api/open/tasks/${taskId}`, bCreated.token.token);
      expect(memberless.status).toBe(401);
    } finally {
      stub.close();
      stopRig(rig);
    }
  });
});

/* ================= G-07 SSRF 拒绝（断言⑤）+ 迁移 010 升级对账 ================= */
describe('G-07 验收⑤：SSRF 守卫拒绝内网/元数据 Webhook URL + 迁移 010 存量升级', () => {
  it('169.254.169.254 与 127.0.0.1（http/https）与明文 http 公网地址均被拒绝创建，零落库', async () => {
    const rig = await startRig(8918, 8928);
    try {
      const admin = rig.adminCookie;
      const badUrls = [
        'http://169.254.169.254/x',
        'https://169.254.169.254/x',
        'http://127.0.0.1/x',
        'https://127.0.0.1:8443/x',
        'http://example.com/hook',
        'https://localhost/hook',
        'https://10.0.0.5/hook',
        'https://192.168.1.10/hook',
        'https://[::1]/hook',
      ];
      for (const url of badUrls) {
        const r = await raw(rig.base, 'POST', '/api/webhooks', { url, events: ['task.done'] }, { cookie: admin });
        expect(r.status, url).toBe(400);
        expect(r.json.error.code, url).toBe('VALIDATION');
      }
      const list = await jget(rig.base, '/api/webhooks', admin);
      expect(list.webhooks.length).toBe(0);
      // 公网 https 字面 IP 不被误杀（8.8.8.8 为公共 DNS 地址，非私网段）
      const okRes = await jpost(
        rig.base,
        '/api/webhooks',
        { url: 'https://8.8.8.8/hook', events: ['task.done'] },
        admin,
      );
      expect(okRes.ok).toBe(true);
    } finally {
      stopRig(rig);
    }
  });

  it('存量库（只应用 001–009）可直接升级 010，旧数据完好、三张新表可用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120b2-upg-'));
    const dbPath = path.join(dir, 'swarm.db');
    const migDir = path.join(SERVER_DIR, 'src', 'store', 'migrations');
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const f of fs.readdirSync(migDir).filter((x) => /^00[1-9]_/.test(x)).sort()) {
      rawDb.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
      rawDb
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(f.replace(/\.sql$/, ''), '2026-10-23T00:00:00.000Z');
    }
    rawDb
      .prepare(
        `INSERT INTO tasks (id, team_id, title, type, status, created_at, workspace_id)
         VALUES ('task_legacy_b2', 'team_x', '批次二存量任务', '文案', '已完成', '2026-10-23T00:00:00.000Z', 'ws_default')`,
      )
      .run();
    rawDb.close();

    const db = openDb(dbPath);
    try {
      const versions = (
        db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>
      ).map((r) => r.version);
      expect(versions).toContain('010_open_api');
      const legacy = db.prepare("SELECT title FROM tasks WHERE id = 'task_legacy_b2'").get() as { title: string };
      expect(legacy.title).toBe('批次二存量任务');
      const repos = new Repos(db);
      repos.insertApiToken({
        id: 'tok_legacy',
        user_id: 'user_x',
        workspace_id: 'ws_default',
        name: '升级验证',
        token_hash: 'h'.repeat(64),
        token_prefix: 'swk_abcd',
        scopes: '["read"]',
        last_used_at: null,
        revoked_at: null,
        created_at: new Date().toISOString(),
      });
      expect(repos.getApiTokenByHash('h'.repeat(64))?.name).toBe('升级验证');
      repos.insertWebhook({
        id: 'whk_legacy',
        workspace_id: 'ws_default',
        url: 'https://8.8.8.8/hook',
        secret_enc: '',
        events: '["task.done"]',
        enabled: 1,
        created_at: new Date().toISOString(),
      });
      expect(repos.listWebhooks('ws_default').length).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SSRF util 与终态映射（进程内）：字面 IP/协议判定、开发开关放行、事件映射正确', async () => {
    await expect(assertSafeOutboundUrl('https://169.254.169.254/x')).rejects.toThrow();
    await expect(assertSafeOutboundUrl('http://127.0.0.1/x')).rejects.toThrow();
    await expect(assertSafeOutboundUrl('https://127.0.0.1/x')).rejects.toThrow();
    await expect(assertSafeOutboundUrl('http://example.com/x')).rejects.toThrow();
    const ok = await assertSafeOutboundUrl('https://8.8.8.8/hook');
    expect(ok.hostname).toBe('8.8.8.8');
    const dev = await assertSafeOutboundUrl('http://127.0.0.1:9000/x', { allowInsecure: true });
    expect(dev.port).toBe('9000');
    expect(webhookEventForStatus('已完成')).toBe('task.done');
    expect(webhookEventForStatus('待裁决')).toBe('task.adjudication');
    expect(webhookEventForStatus('已取消')).toBe('task.failed');
    expect(webhookEventForStatus('执行中')).toBeNull();
  });
});

/* ================= G-09 全局搜索（断言① + HTTP 侧②） ================= */
describe('G-09 验收①②（HTTP）：六类各命中、types 过滤、跨空间零命中', () => {
  it('同一唯一关键词埋六类实体 → 一次搜索六组全命中；B 空间关键词在 A 搜零命中', async () => {
    const rig = await startRig(8919, 8929);
    try {
      const admin = rig.adminCookie;
      const { teamId } = await configureMock(rig, admin);
      const KW = 'QZXUNIQ7';

      // task + result：带 KW 标题的任务跑完（mock 成果非空）→ task 组与 result 组同命中
      const t = await jpost(
        rig.base,
        '/api/tasks',
        { title: `报告 ${KW} 任务`, type: '文案', brief: '写报告', teamId },
        admin,
      );
      expect(t.ok).toBe(true);
      await waitStatus(rig, admin, t.id, '已完成');
      // kb
      const kb = await jpost(
        rig.base,
        '/api/kb',
        { title: `手册 ${KW}`, body: '知识正文内容', scope: 'company', tags: [] },
        admin,
      );
      expect(kb.ok).toBe(true);
      // asset：名称带 KW，正文埋另一个唯一词（断言④在进程内组精确验证，HTTP 侧先验 snippet 不含它）
      const assetBodyWord = 'ASSETBODYONLY9';
      const asset = await jpost(
        rig.base,
        '/api/assets',
        {
          asset: {
            typeId: '通用文档',
            name: `资料 ${KW}`,
            content: { sections: [{ key: 's1', title: '分段标题甲', body: `正文 ${assetBodyWord} 内容` }] },
          },
        },
        admin,
      );
      expect(asset.ok).toBe(true);
      // skill
      const skill = await jpost(
        rig.base,
        '/api/skills',
        {
          skill: {
            name: `技能 ${KW}`,
            description: '搜索验证用技能',
            role: '文案',
            promptTemplate: '写 {{x}}',
            inputSchema: [],
            kbBinding: {},
            outputSpec: '',
            exampleInput: {},
            exampleOutput: '',
          },
        },
        admin,
      );
      expect(skill.ok).toBe(true);
      // project（mock 拆单兜底为同名子任务，不影响 projects 组断言）
      const project = await jpost(
        rig.base,
        '/api/projects',
        { name: `项目 ${KW}`, brief: '项目简报', teamId, clientName: '' },
        admin,
      );
      expect(project.ok).toBe(true);

      const res = await jget(rig.base, `/api/search?q=${KW}`, admin);
      expect(res.ok).toBe(true);
      const byType = new Map((res.groups as any[]).map((g) => [g.type, g.items]));
      for (const type of ['task', 'result', 'kb', 'asset', 'skill', 'project']) {
        expect(byType.has(type), `分组 ${type} 应命中`).toBe(true);
        expect((byType.get(type) as any[]).length).toBeGreaterThanOrEqual(1);
      }
      expect((byType.get('task') as any[]).some((i) => i.id === t.id)).toBe(true);
      expect((byType.get('result') as any[]).some((i) => i.id === t.id)).toBe(true);
      expect((byType.get('result') as any[])[0].snippet).toContain('mock 引擎生成的测试成果');
      expect((byType.get('kb') as any[]).some((i) => i.id === kb.id)).toBe(true);
      const assetItem = (byType.get('asset') as any[]).find((i) => i.id === asset.id);
      expect(assetItem).toBeTruthy();
      expect(assetItem.snippet).toContain('分段标题甲');
      expect(JSON.stringify(res)).not.toContain(assetBodyWord);
      expect((byType.get('skill') as any[]).some((i) => i.id === skill.id)).toBe(true);
      expect((byType.get('project') as any[]).some((i) => i.id === project.id)).toBe(true);

      // types 过滤：只要 kb 组
      const filtered = await jget(rig.base, `/api/search?q=${KW}&types=kb`, admin);
      expect((filtered.groups as any[]).map((g) => g.type)).toEqual(['kb']);

      /* ----- 断言②（HTTP 侧）：B 空间实体关键词在 A 空间搜 → 零命中 ----- */
      const reg = await fetch(rig.base + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'g09-b@test.local',
          password: 'BUserPass123!',
          displayName: 'B 空间老板',
        }),
      });
      const regJson: any = await reg.json();
      expect(regJson.ok).toBe(true);
      const bCookie = (reg.headers.get('set-cookie') || '').split(';')[0];
      const BKW = 'BSPACEONLY5';
      const bKb = await jpost(
        rig.base,
        '/api/kb',
        { title: `B 的手册 ${BKW}`, body: 'B 正文', scope: 'company', tags: [] },
        bCookie,
      );
      expect(bKb.ok).toBe(true);
      const fromA = await jget(rig.base, `/api/search?q=${BKW}`, admin);
      expect(fromA.results.length).toBe(0);
      const fromB = await jget(rig.base, `/api/search?q=${BKW}`, bCookie);
      expect((fromB.results as any[]).some((i) => i.id === bKb.id)).toBe(true);
    } finally {
      stopRig(rig);
    }
  });
});

/* ================= G-09 可见性/转义/资产口径（断言②③④，searchService 进程内） ================= */
describe('G-09 验收②③④（进程内）：他人 personal 零命中、%/_ 字面精确、资产 snippet 不含正文', () => {
  function seedRepos(): { repos: Repos; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120b2-svc-'));
    const db = openDb(path.join(dir, 'swarm.db'));
    const repos = new Repos(db);
    const ts = new Date().toISOString();
    const taskRow = (id: string, ws: string, title: string, extra: Record<string, unknown> = {}) => ({
      id,
      project_id: null,
      team_id: 'team_x',
      assignee_id: null,
      title,
      type: '文案',
      brief: '简报',
      status: '待领取' as never,
      result: '',
      review_note: '',
      reject_reason: '',
      reject_count: 0,
      blocked_reason: '',
      blocked_code: null,
      adjudicated: 0,
      idempotency_key: null,
      total_tokens: 0,
      total_cost_milli: 0,
      heartbeat_at: null,
      injected_kb_ids: '[]',
      created_at: ts,
      claimed_at: null,
      finished_at: null,
      workspace_id: ws,
      created_by_user_id: 'user_a',
      skill_id: null,
      skill_version: null,
      skill_params: '{}',
      is_skill_test: 0,
      injected_assets: '[]',
      seq: null,
      ...extra,
    });
    // A 空间：% 与 _ 的字面/干扰对照组
    repos.insertTask(taskRow('task_pct_hit', 'wsA', '折扣100%真词'));
    repos.insertTask(taskRow('task_pct_miss', 'wsA', '折扣1000干扰词'));
    repos.insertTask(taskRow('task_us_hit', 'wsA', '代号甲_乙真词'));
    repos.insertTask(taskRow('task_us_miss', 'wsA', '代号甲X乙干扰词'));
    // B 空间任务（跨空间零命中对象）
    repos.insertTask(taskRow('task_b', 'wsB', 'B空间任务BKEYWORD1'));
    // KB：他人 personal（owner=user_b）与本人 personal、公司级
    const kbRow = (id: string, ws: string | null, title: string, scope: string, owner: string | null) => ({
      id,
      title,
      body: '正文',
      scope,
      scope_id: null,
      tags: '[]',
      enabled: 1,
      created_at: ts,
      updated_at: ts,
      workspace_id: ws,
      owner_user_id: owner,
    });
    repos.insertKb(kbRow('kb_other_personal', 'wsA', '他人私藏 PKEYWORD2', 'personal', 'user_b'));
    repos.insertKb(kbRow('kb_own_personal', 'wsA', '本人私藏 PKEYWORD2', 'personal', 'user_a'));
    repos.insertKb(kbRow('kb_b', 'wsB', 'B空间知识 BKEYWORD1', 'company', null));
    // 资产：正文埋唯一词，名称/分段标题不含
    repos.insertAsset({
      id: 'asset_a',
      workspace_id: 'wsA',
      type_id: '通用文档',
      name: '季度资料汇编',
      version: 1,
      content: JSON.stringify({
        sections: [{ key: 's1', title: '公开分段标题', body: '正文深处藏着 BODYONLYWORD3' }],
      }),
      created_by: 'user_a',
      created_at: ts,
      updated_at: ts,
    });
    return {
      repos,
      cleanup: () => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it('断言②：跨空间与他人 personal 零命中，本人 personal 与本空间正常命中', () => {
    const { repos, cleanup } = seedRepos();
    try {
      const cross = searchWorkspace(repos, 'wsA', 'user_a', 'BKEYWORD1');
      expect(cross.results.length).toBe(0);
      const personal = searchWorkspace(repos, 'wsA', 'user_a', 'PKEYWORD2');
      const kbItems = personal.groups.find((g) => g.type === 'kb')?.items ?? [];
      expect(kbItems.map((i) => i.id)).toEqual(['kb_own_personal']);
    } finally {
      cleanup();
    }
  });

  it('断言③：% 与 _ 按字面搜索不误报（结果集精确）', () => {
    const { repos, cleanup } = seedRepos();
    try {
      expect(escapeLikePattern('100%_\\')).toBe('100\\%\\_\\\\');
      const pct = searchWorkspace(repos, 'wsA', 'user_a', '100%');
      const pctTasks = pct.groups.find((g) => g.type === 'task')?.items ?? [];
      expect(pctTasks.map((i) => i.id)).toEqual(['task_pct_hit']);
      const us = searchWorkspace(repos, 'wsA', 'user_a', '甲_乙');
      const usTasks = us.groups.find((g) => g.type === 'task')?.items ?? [];
      expect(usTasks.map((i) => i.id)).toEqual(['task_us_hit']);
    } finally {
      cleanup();
    }
  });

  it('断言④：资产结果 snippet 不含正文唯一词，且正文唯一词本身搜不到该资产', () => {
    const { repos, cleanup } = seedRepos();
    try {
      const byName = searchWorkspace(repos, 'wsA', 'user_a', '季度资料');
      const assetItems = byName.groups.find((g) => g.type === 'asset')?.items ?? [];
      expect(assetItems.length).toBe(1);
      expect(assetItems[0].snippet).toContain('公开分段标题');
      expect(assetItems[0].snippet).not.toContain('BODYONLYWORD3');
      expect(JSON.stringify(byName)).not.toContain('BODYONLYWORD3');
      const byBody = searchWorkspace(repos, 'wsA', 'user_a', 'BODYONLYWORD3');
      expect(byBody.groups.find((g) => g.type === 'asset')).toBeUndefined();
      expect(byBody.results.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});
