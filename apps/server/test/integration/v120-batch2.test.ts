import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * v1.2.0 批次二集成测试（G-15 接口先行 / G-10 定时任务 / G-11 账号设置）：
 * - G-15 断言①：转让后目标用户空间列表含该空间且 role=owner；原所有者失去访问（me 不含、
 *   switch 回 403、state 落到其余空间——/api/state 为 session 空间口径、无按 id 取数入口，
 *   以「失去成员资格」三路交叉验证替代字面 404）。
 * - G-15 断言②：验密错误 / 目标 pending_deletion / 转给自己 / 目标不存在 → VALIDATION 且归属零变化。
 * - G-15 断言③：转让后原所有者 api_token 调开放面 401；新所有者页面发单正常。
 * - G-15 断言④：audit_logs 两侧各一条；双方各收到一条 type='transfer' 通知。
 * （G-10 / G-11 断言在本文件后续 describe 中，编号与施工设计一一对应。）
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120c-'));
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

async function registerUser(
  base: string,
  email: string,
  displayName: string,
  password = 'UserPass123!',
): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
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

/* ================= G-15 空间所有权转让（断言①②③④，接口级） ================= */
describe('G-15 验收①②③④：空间所有权转让接口与校验链', () => {
  it('验密/目标非法零变化；转让后新所有者 role=owner、原所有者失格、旧 Token 401、新所有者发单正常；双侧 audit+通知', async () => {
    const rig = await startRig(8941, 8951);
    try {
      const admin = rig.adminCookie;
      const adminMe = await jget(rig.base, '/api/auth/me', admin);
      const adminId: string = adminMe.user.id;
      const wsId: string = adminMe.workspace.id; // ws_default（MJ 蜂群）

      // 原所有者另建一个空间 W2（转让后其会话应回落到 W2，state 不再是被转空间）
      const w2 = await jpost(rig.base, '/api/workspaces', { name: '管理员的第二空间' }, admin);
      expect(w2.ok).toBe(true);
      const w2Id: string = w2.workspace.id;
      // 切回 ws_default 建 Token（Token 归属当前 session 空间）
      const sw = await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: wsId }, admin);
      expect(sw.ok).toBe(true);
      const tok = await jpost(rig.base, '/api/tokens', { name: '转让前 Token', scopes: ['read', 'dispatch'] }, admin);
      expect(tok.ok).toBe(true);
      const plain: string = tok.token.token;

      const b = await registerUser(rig.base, 'g15-b@test.local', '接收人 B');
      const c = await registerUser(rig.base, 'g15-c@test.local', '冷静期用户 C');
      withDb(rig, (db) => {
        db.prepare("UPDATE users SET status = 'pending_deletion' WHERE id = ?").run(c.userId);
      });

      const ownerOf = () =>
        withDb(rig, (db) => {
          const ws = db.prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(wsId) as {
            owner_user_id: string;
          };
          const rows = db
            .prepare('SELECT user_id, role FROM memberships WHERE workspace_id = ?')
            .all(wsId) as Array<{ user_id: string; role: string }>;
          return { owner: ws.owner_user_id, rows };
        });
      const before = ownerOf();
      expect(before.owner).toBe(adminId);
      expect(before.rows.some((r) => r.user_id === adminId && r.role === 'owner')).toBe(true);

      /* ----- 断言②：四种非法转让全部 VALIDATION 且归属零变化 ----- */
      const wrongPw = await raw(
        rig.base, 'POST', `/api/workspaces/${wsId}/transfer`,
        { targetUserId: b.userId, password: 'WrongPass999!' }, { cookie: admin },
      );
      expect(wrongPw.status).toBe(400);
      expect(wrongPw.json.error.code).toBe('VALIDATION');
      const toSelf = await raw(
        rig.base, 'POST', `/api/workspaces/${wsId}/transfer`,
        { targetUserId: adminId, password: '<MASKED_SECRET_002>!' }, { cookie: admin },
      );
      expect(toSelf.status).toBe(400);
      expect(toSelf.json.error.code).toBe('VALIDATION');
      const toPendingDeletion = await raw(
        rig.base, 'POST', `/api/workspaces/${wsId}/transfer`,
        { targetUserId: c.userId, password: '<MASKED_SECRET_002>!' }, { cookie: admin },
      );
      expect(toPendingDeletion.status).toBe(400);
      expect(toPendingDeletion.json.error.code).toBe('VALIDATION');
      expect(toPendingDeletion.json.error.message).toContain('注销冷静期');
      const toGhost = await raw(
        rig.base, 'POST', `/api/workspaces/${wsId}/transfer`,
        { targetUserId: 'user_nonexistent', password: '<MASKED_SECRET_002>!' }, { cookie: admin },
      );
      expect(toGhost.status).toBe(400);
      expect(toGhost.json.error.code).toBe('VALIDATION');
      // 非所有者（普通新用户对该空间无成员关系）→ 404 不泄漏
      const byStranger = await raw(
        rig.base, 'POST', `/api/workspaces/${wsId}/transfer`,
        { targetUserId: adminId, password: 'UserPass123!' }, { cookie: b.cookie },
      );
      expect(byStranger.status).toBe(404);
      expect(ownerOf()).toEqual(before);

      /* ----- 断言①③④：成功转让 ----- */
      const done = await raw(
        rig.base, 'POST', `/api/workspaces/${wsId}/transfer`,
        { targetUserId: b.userId, password: '<MASKED_SECRET_002>!' }, { cookie: admin },
      );
      expect(done.status).toBe(200);
      expect(done.json.ok).toBe(true);

      const after = ownerOf();
      expect(after.owner).toBe(b.userId);
      expect(after.rows.some((r) => r.user_id === b.userId && r.role === 'owner')).toBe(true);
      expect(after.rows.some((r) => r.user_id === adminId)).toBe(false);

      const bMe = await jget(rig.base, '/api/auth/me', b.cookie);
      const bWs = (bMe.workspaces as any[]).find((w) => w.id === wsId);
      expect(bWs).toBeTruthy();
      expect(bWs.role).toBe('owner');

      // 原所有者失去访问：me 列表不含、switch 回 403、state 回落到 W2
      const aMe = await jget(rig.base, '/api/auth/me', admin);
      expect((aMe.workspaces as any[]).some((w) => w.id === wsId)).toBe(false);
      const swBack = await raw(
        rig.base, 'POST', '/api/auth/switch-workspace', { workspaceId: wsId }, { cookie: admin },
      );
      expect(swBack.status).toBe(403);
      const aState = await jget(rig.base, '/api/state', admin);
      expect(aState.workspace.id).toBe(w2Id);

      // 断言③：原所有者转让前建的 Token 调开放面 → 401（membership 校验自然失效）
      const openAfter = await raw(rig.base, 'GET', '/api/open/tasks/whatever', undefined, {
        authorization: `Bearer ${plain}`,
      });
      expect(openAfter.status).toBe(401);
      // 新所有者在该空间页面发单正常
      const swB = await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: wsId }, b.cookie);
      expect(swB.ok).toBe(true);
      const bState = await jget(rig.base, '/api/state', b.cookie);
      const bTeamId = bState.teams[0].id as string;
      const bTask = await jpost(
        rig.base, '/api/tasks',
        { title: '新所有者首单', type: '文案', brief: '转让后发单验证', teamId: bTeamId },
        b.cookie,
      );
      expect(bTask.ok).toBe(true);

      // 断言④：audit 两侧各一条 + 双方各一条 transfer 通知（直查库：原所有者已无该空间 API 访问权）
      withDb(rig, (db) => {
        const audits = db
          .prepare(
            "SELECT user_id, action FROM audit_logs WHERE workspace_id = ? AND action LIKE 'transfer_workspace%'",
          )
          .all(wsId) as Array<{ user_id: string; action: string }>;
        expect(audits.some((a) => a.action === 'transfer_workspace_out' && a.user_id === adminId)).toBe(true);
        expect(audits.some((a) => a.action === 'transfer_workspace_in' && a.user_id === b.userId)).toBe(true);
        const notifs = db
          .prepare("SELECT user_id FROM notifications WHERE workspace_id = ? AND type = 'transfer'")
          .all(wsId) as Array<{ user_id: string }>;
        expect(notifs.some((n) => n.user_id === b.userId)).toBe(true);
        expect(notifs.some((n) => n.user_id === adminId)).toBe(true);
      });
      const bNotif = await jget(rig.base, '/api/notifications?type=transfer', b.cookie);
      expect(bNotif.total).toBeGreaterThanOrEqual(1);
    } finally {
      stopRig(rig);
    }
  });
});
