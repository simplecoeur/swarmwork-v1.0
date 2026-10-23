import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericWebhookAdapter } from '../../src/domain/channels';
import { assertSafeOutboundUrl } from '../../src/domain/ssrf';

/**
 * v1.2.0 批次三收尾集成测试（G-14 管理员代入查看 / G-15 转让页面侧接口回归 / G-17 通用 Webhook 渠道）：
 * - G-14 断言①：代入后 /api/state 为目标空间数据；主要写接口逐个 403 IMPERSONATION_READ_ONLY；退出后恢复。
 * - G-14 断言②：非管理员 impersonate → 403。
 * - G-14 断言③：所有者 ledger-view 含代入起止两条（impersonate_start/stop）+ impersonation 站内通知到位。
 * - G-14 断言④：代入态再 impersonate 他空间 → VALIDATION。
 * - G-15 页面侧回归一条：按邮箱精确查（只读补口）→ 转让全链仍绿（所有权/membership/新所有者 me）。
 *   （页面本身为构建 + 走查验收，此处只兜接口回归。）
 * - G-17 断言①：stub 探活通过置已绑定；探活 500 绑定失败且原因如实（含 HTTP 500）。
 * - G-17 断言②：已交付任务推送 → stub 收到完整 payload（标题/成果全文/交付页链接/用量摘要）+
 *   HMAC 验签通过（与 G-07 共用 signWebhookBody 口径）；channel_pushes 落 success 一条；
 *   端点失败落 failed 且错误可见；fetchMetrics 明确 unsupported。
 * - G-17 断言③：MJ 适配器既有 stub 契约全绿（绑定/推送 accepted/回查指标）。
 * - G-17 SSRF 复用断言：通用 Webhook 填 169.254.169.254 被同一守卫拒绝（接口 400 + util/适配器直查）。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const USER_PW = 'UserPass123!';
const GW_SECRET = '<MASKED_SECRET_004>';
const MARKER_TASK = 'task_g14_marker';
const MARKER_TITLE = 'G14目标空间标记任务ZZ';
const DONE_TASK = 'task_g17_done';
const DONE_TITLE = 'G17待推送成果标题ZZ';
const DONE_RESULT = 'G17成果全文ZZ：这是一份完整的交付成果正文，用于校验 payload 全文不截断。';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  base: string;
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
  extraEnv: Record<string, string>,
): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120e-'));
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
    procs: [mock, server],
    dataDir,
    adminCookie: '',
  };
  expect(await waitUp(`http://127.0.0.1:${mockPort}/__counts`)).toBe(true);
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

interface RawRes {
  status: number;
  j: any;
}
async function raw(
  base: string,
  method: string,
  p: string,
  body: unknown,
  cookie: string,
): Promise<RawRes> {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
const jget = async (base: string, p: string, cookie: string): Promise<any> =>
  (await raw(base, 'GET', p, undefined, cookie)).j;
const jpost = async (base: string, p: string, body: unknown, cookie: string): Promise<any> =>
  (await raw(base, 'POST', p, body ?? {}, cookie)).j;

async function registerUser(
  base: string,
  email: string,
  displayName: string,
): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: USER_PW, displayName }),
  });
  const j: any = await reg.json();
  expect(j.ok).toBe(true);
  expect(j.pending).toBe(false);
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  const me = await jget(base, '/api/auth/me', cookie);
  return { cookie, userId: me.user.id as string, workspaceId: me.workspace.id as string };
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

function insertDoneTask(
  rig: Rig,
  t: { id: string; workspaceId: string; teamId: string; title: string; result: string },
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
      t.id, null, t.teamId, null, t.title, '文案', 'brief', '已完成', t.result,
      '', '', 0, '', null, 0, null, 321, 2500, now, '[]', now, now, now,
      t.workspaceId, null, null, null, '{}', 0, '[]', null,
    );
  });
}

/* ---------------- 渠道 stub（通用 Webhook 端点 + MJ 契约端点同台） ---------------- */
interface StubHit {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const stubHits: StubHit[] = [];
let stubServer: http.Server | null = null;
let stubBase = '';

async function startStub(port: number): Promise<void> {
  stubBase = `http://127.0.0.1:${port}`;
  stubServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stubHits.push({ path: req.url ?? '', headers: req.headers, body });
      const url = req.url ?? '';
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url === '/hook-fail') return json(500, { error: 'stub boom' });
      if (url === '/hook') return json(200, { ok: true });
      if (url === '/api/v1/users/me') return json(200, { username: 'mj-admin' });
      if (url === '/api/v1/swarm/deliveries' && req.method === 'POST') return json(200, { id: 'mj-123' });
      if (url === '/api/v1/swarm/deliveries/mj-123') {
        return json(200, { status: 'queued', views: 42, likes: 7, comments: 3 });
      }
      return json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => stubServer!.listen(port, '127.0.0.1', resolve));
}

function hmacOk(secret: string, hit: StubHit): boolean {
  const sig = String(hit.headers['x-swarm-signature'] ?? '');
  const expectSig =
    'sha256=' + crypto.createHmac('sha256', secret).update(hit.body, 'utf8').digest('hex');
  return sig === expectSig;
}

/* ================= G-14 / G-15 / G-17 主 rig（开 SSRF 开发例外供本地 stub 联调） ================= */
let rig: Rig;
let wsAdmin = '';
let adminTeamId = '';
let ownerA: { cookie: string; userId: string; workspaceId: string };

beforeAll(async () => {
  rig = await startRig(8985, 8995, { SWARM_WEBHOOK_ALLOW_INSECURE: '1' });
  await startStub(8997);
  const admin = rig.adminCookie;
  const me = await jget(rig.base, '/api/auth/me', admin);
  wsAdmin = me.workspace.id as string;
  const stAdmin = await jget(rig.base, '/api/state', admin);
  adminTeamId = stAdmin.teams[0].id as string;

  ownerA = await registerUser(rig.base, 'owner-a@test.local', '空间主 A');
  const stA = await jget(rig.base, '/api/state', ownerA.cookie);
  insertDoneTask(rig, {
    id: MARKER_TASK,
    workspaceId: ownerA.workspaceId,
    teamId: stA.teams[0].id as string,
    title: MARKER_TITLE,
    result: '标记成果',
  });
  insertDoneTask(rig, {
    id: DONE_TASK,
    workspaceId: wsAdmin,
    teamId: adminTeamId,
    title: DONE_TITLE,
    result: DONE_RESULT,
  });
});

afterAll(() => {
  stopRig(rig);
  stubServer?.close();
});

describe('G-14 管理员代入查看', () => {
  it('断言②：非管理员调 impersonate → 403', async () => {
    const r = await raw(
      rig.base, 'POST', `/api/admin/impersonate/${ownerA.workspaceId}`, {}, ownerA.cookie,
    );
    expect(r.status).toBe(403);
    expect(r.j.ok).toBe(false);
  });

  it('断言①前半：代入后 me/state 均为目标空间，state 含目标空间标记任务', async () => {
    const r = await raw(
      rig.base, 'POST', `/api/admin/impersonate/${ownerA.workspaceId}`, {}, rig.adminCookie,
    );
    expect(r.status).toBe(200);
    expect(r.j.ok).toBe(true);
    expect(r.j.impersonation.workspaceId).toBe(ownerA.workspaceId);
    expect(r.j.impersonation.ownerUserId).toBe(ownerA.userId);

    const me = await jget(rig.base, '/api/auth/me', rig.adminCookie);
    expect(me.impersonation).not.toBeNull();
    expect(me.impersonation.workspaceId).toBe(ownerA.workspaceId);
    expect(me.workspace.id).toBe(ownerA.workspaceId);

    const st = await jget(rig.base, '/api/state', rig.adminCookie);
    expect(st.workspace.id).toBe(ownerA.workspaceId);
    expect((st.tasks as Array<{ title: string }>).some((t) => t.title === MARKER_TITLE)).toBe(true);
  });

  it('断言①守卫 + 断言④：主要写接口逐个 403 IMPERSONATION_READ_ONLY；白名单放行；代入态再代入 → VALIDATION；退出代入', async () => {
    const admin = rig.adminCookie;
    const writeChecks: Array<[string, string, unknown]> = [
      ['POST', '/api/tasks', { title: 'x', type: '文案', brief: 'b', teamId: 't' }],
      ['POST', '/api/kb', { title: 'x', body: 'b', scope: 'company', tags: [] }],
      ['PUT', '/api/kb/whatever', { title: 'x' }],
      ['POST', '/api/apis/save', { api: { name: 'x', provider: 'custom', baseUrl: 'https://x', model: 'm', pricePerM: 1 } }],
      ['POST', '/api/purchase', { apiId: 'x', amountYuan: 1 }],
      ['POST', '/api/teams/save', { team: { name: 'x', color: '#000' } }],
      ['POST', '/api/workspaces', { name: '新空间' }],
      ['PUT', '/api/preferences', { key: 'k', value: 'v' }],
      ['POST', '/api/channels/bind', { channelType: 'mj', baseUrl: 'https://x' }],
      ['POST', '/api/channels/push', { channelType: 'mj', taskId: MARKER_TASK }],
      ['POST', '/api/feedback', { category: 'bug', content: 'x' }],
      ['POST', `/api/workspaces/${ownerA.workspaceId}/transfer`, { targetUserId: 'u', password: 'p' }],
      ['POST', '/api/auth/switch-workspace', { workspaceId: wsAdmin }],
    ];
    for (const [method, p, body] of writeChecks) {
      const r = await raw(rig.base, method, p, body, admin);
      expect(r.status, `${method} ${p}`).toBe(403);
      expect(r.j.error?.code, `${method} ${p}`).toBe('IMPERSONATION_READ_ONLY');
    }
    // 白名单：GET 读取与通知标已读放行
    const st = await raw(rig.base, 'GET', '/api/state', undefined, admin);
    expect(st.status).toBe(200);
    const readAll = await raw(rig.base, 'POST', '/api/notifications/read-all', {}, admin);
    expect(readAll.j.ok).toBe(true);
    // 断言④：代入态再 impersonate 他空间 → VALIDATION
    const again = await raw(rig.base, 'POST', `/api/admin/impersonate/${wsAdmin}`, {}, admin);
    expect(again.status).toBe(400);
    expect(again.j.error?.code).toBe('VALIDATION');
    // 退出代入（白名单）
    const stop = await raw(rig.base, 'POST', '/api/admin/impersonate/stop', {}, admin);
    expect(stop.status).toBe(200);
    expect(stop.j.ok).toBe(true);
    expect(typeof stop.j.durationSec).toBe('number');
  });

  it('断言①后半：退出后当前空间切回管理员空间、写接口恢复', async () => {
    const me = await jget(rig.base, '/api/auth/me', rig.adminCookie);
    expect(me.impersonation).toBeNull();
    expect(me.workspace.id).toBe(wsAdmin);
    const w = await raw(rig.base, 'PUT', '/api/preferences', { key: 'g14probe', value: 'ok' }, rig.adminCookie);
    expect(w.j.ok).toBe(true);
  });

  it('断言③：所有者台账含代入起止两条 + impersonation 站内通知到位', async () => {
    const view = await jget(rig.base, '/api/ledger-view', ownerA.cookie);
    const texts = (view.timeline as Array<{ text: string }>).map((x) => x.text);
    expect(texts.some((t) => t.includes('impersonate_start'))).toBe(true);
    expect(texts.some((t) => t.includes('impersonate_stop'))).toBe(true);
    const notif = await jget(rig.base, '/api/notifications?type=impersonation', ownerA.cookie);
    expect(notif.total).toBeGreaterThanOrEqual(1);
  });
});

describe('G-15 转让页面侧接口回归（页面为构建+走查验收，此处兜全链）', () => {
  it('按邮箱精确查 → 转让全链仍绿：所有权与 membership 变更、新所有者 me 可见', async () => {
    const src = await registerUser(rig.base, 'g15-src@test.local', '转让方 D');
    const dst = await registerUser(rig.base, 'g15-dst@test.local', '接收方 E');

    const look = await raw(
      rig.base, 'GET', `/api/users/lookup?email=${encodeURIComponent('g15-dst@test.local')}`,
      undefined, src.cookie,
    );
    expect(look.status).toBe(200);
    expect(look.j.user.id).toBe(dst.userId);
    expect(look.j.user.status).toBe('active');

    const miss = await raw(
      rig.base, 'GET', '/api/users/lookup?email=nobody@test.local', undefined, src.cookie,
    );
    expect(miss.status).toBe(404);

    const tr = await jpost(
      rig.base, `/api/workspaces/${src.workspaceId}/transfer`,
      { targetUserId: dst.userId, password: USER_PW }, src.cookie,
    );
    expect(tr.ok).toBe(true);

    const ownerNow = withDb(rig, (db) =>
      db.prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(src.workspaceId) as {
        owner_user_id: string;
      },
    );
    expect(ownerNow.owner_user_id).toBe(dst.userId);

    const dstMe = await jget(rig.base, '/api/auth/me', dst.cookie);
    const joined = (dstMe.workspaces as Array<{ id: string; role: string }>).find(
      (w) => w.id === src.workspaceId,
    );
    expect(joined?.role).toBe('owner');
  });
});

describe('G-17 通用 Webhook 渠道适配器', () => {
  it('断言①前半：stub 探活通过 → 已绑定，bind.ping 的 HMAC 验签通过', async () => {
    stubHits.length = 0;
    const r = await jpost(
      rig.base, '/api/channels/bind',
      { channelType: 'generic_webhook', url: `${stubBase}/hook`, secret: GW_SECRET, events: ['delivered'] },
      rig.adminCookie,
    );
    expect(r.ok).toBe(true);
    expect(r.bind.bound).toBe(true);
    const ping = stubHits.find((h) => h.path === '/hook');
    expect(ping).toBeTruthy();
    expect(ping!.headers['x-swarm-event']).toBe('bind.ping');
    expect(JSON.parse(ping!.body).event).toBe('bind.ping');
    expect(hmacOk(GW_SECRET, ping!)).toBe(true);

    const chs = await jget(rig.base, '/api/channels', rig.adminCookie);
    const gw = (chs.channels as Array<any>).find((c) => c.type === 'generic_webhook');
    expect(gw.bound).toBe(true);
    expect(gw.url).toBe(`${stubBase}/hook`);
    expect(gw.hasSecret).toBe(true);
    expect(gw.supportsMetrics).toBe(false);
  });

  it('断言①后半：探活端点 500 → 绑定失败且原因如实（含 HTTP 500）', async () => {
    const r = await jpost(
      rig.base, '/api/channels/bind',
      { channelType: 'generic_webhook', url: `${stubBase}/hook-fail`, secret: GW_SECRET },
      ownerA.cookie,
    );
    expect(r.ok).toBe(true);
    expect(r.bind.bound).toBe(false);
    expect(String(r.bind.message)).toContain('500');
  });

  it('断言②前半：已交付任务推送 → stub 收到完整 payload + HMAC 通过，pushes 落 success，refresh 明示不支持回流', async () => {
    stubHits.length = 0;
    const r = await jpost(
      rig.base, '/api/channels/push',
      { channelType: 'generic_webhook', taskId: DONE_TASK },
      rig.adminCookie,
    );
    expect(r.ok).toBe(true);
    expect(r.push.status).toBe('success');
    expect(r.push.channelType).toBe('generic_webhook');

    const hit = stubHits.find((h) => h.path === '/hook');
    expect(hit).toBeTruthy();
    expect(hit!.headers['x-swarm-event']).toBe('delivered');
    expect(hmacOk(GW_SECRET, hit!)).toBe(true);
    const payload = JSON.parse(hit!.body);
    expect(payload.event).toBe('delivered');
    expect(payload.title).toBe(DONE_TITLE);
    expect(payload.content).toBe(DONE_RESULT);
    expect(String(payload.deliveryUrl)).toMatch(/^\/d\//);
    expect(String(payload.usageSummary)).toContain('321');
    expect(payload.totalTokens).toBe(321);

    const pushes = await jget(rig.base, '/api/channels/pushes', rig.adminCookie);
    const row = (pushes.pushes as Array<any>).find((p) => p.id === r.push.id);
    expect(row.status).toBe('success');

    const refresh = await jpost(
      rig.base, `/api/channels/pushes/${r.push.id}/refresh`, {}, rig.adminCookie,
    );
    expect(refresh.ok).toBe(true);
    expect(refresh.metrics.ok).toBe(false);
    expect(refresh.metrics.supported).toBe(false);
    expect(String(refresh.metrics.message)).toContain('不支持数据回流');
  });

  it('断言②后半：端点失败 → pushes 落 failed 且错误可见', async () => {
    const bind = await jpost(
      rig.base, '/api/channels/bind',
      { channelType: 'generic_webhook', url: `${stubBase}/hook-fail`, secret: GW_SECRET },
      rig.adminCookie,
    );
    expect(bind.bind.bound).toBe(false);
    const r = await jpost(
      rig.base, '/api/channels/push',
      { channelType: 'generic_webhook', taskId: DONE_TASK },
      rig.adminCookie,
    );
    expect(r.ok).toBe(true);
    expect(r.push.status).toBe('failed');
    expect(String(r.push.message)).toContain('500');
    const pushes = await jget(rig.base, '/api/channels/pushes', rig.adminCookie);
    const row = (pushes.pushes as Array<any>).find((p) => p.id === r.push.id);
    expect(row.status).toBe('failed');
    expect(String(row.message)).toContain('500');
    // 复位为可用绑定，避免影响后续用例
    await jpost(
      rig.base, '/api/channels/bind',
      { channelType: 'generic_webhook', url: `${stubBase}/hook`, secret: GW_SECRET },
      rig.adminCookie,
    );
  });

  it('断言③：MJ 适配器既有 stub 契约全绿（绑定/推送 accepted/回查 views=42）', async () => {
    const bind = await jpost(
      rig.base, '/api/channels/bind',
      { channelType: 'mj', baseUrl: stubBase, token: 'mj-token' },
      rig.adminCookie,
    );
    expect(bind.ok).toBe(true);
    expect(bind.bind.bound).toBe(true);
    expect(bind.bind.accountLabel).toBe('mj-admin');

    const push = await jpost(
      rig.base, '/api/channels/push',
      { channelType: 'mj', taskId: DONE_TASK },
      rig.adminCookie,
    );
    expect(push.ok).toBe(true);
    expect(push.push.status).toBe('accepted');
    expect(push.push.remoteRef).toBe('mj-123');

    const refresh = await jpost(
      rig.base, `/api/channels/pushes/${push.push.id}/refresh`, {}, rig.adminCookie,
    );
    expect(refresh.ok).toBe(true);
    expect(refresh.metrics.ok).toBe(true);
    expect(refresh.metrics.metrics.views).toBe(42);
  });
});

/* ================= G-17 SSRF 复用（独立 rig：不开开发例外） ================= */
describe('G-17 SSRF 复用断言（169.254.169.254 被同一守卫拒绝）', () => {
  let rig2: Rig;
  beforeAll(async () => {
    rig2 = await startRig(8986, 8996, {});
  });
  afterAll(() => stopRig(rig2));

  it('接口层：绑定通用 Webhook 填云元数据地址 → 400 VALIDATION（SSRF 守卫）', async () => {
    const r = await raw(
      rig2.base, 'POST', '/api/channels/bind',
      { channelType: 'generic_webhook', url: 'https://169.254.169.254/hook', secret: 's3cret' },
      rig2.adminCookie,
    );
    expect(r.status).toBe(400);
    expect(r.j.error?.code).toBe('VALIDATION');
    expect(String(r.j.error?.message)).toContain('SSRF');
  });

  it('util/适配器直查：assertSafeOutboundUrl 与 GenericWebhookAdapter 同口径拒绝', async () => {
    await expect(assertSafeOutboundUrl('https://169.254.169.254/x')).rejects.toThrow(/SSRF/);
    await expect(assertSafeOutboundUrl('https://8.8.8.8/hook')).resolves.toBeInstanceOf(URL);
    const adapter = new GenericWebhookAdapter();
    const bind = await adapter.authBind({
      baseUrl: '', token: '', url: 'https://169.254.169.254/x', secret: 's3cret',
    });
    expect(bind.bound).toBe(false);
    expect(bind.message).toContain('SSRF');
  });
});
