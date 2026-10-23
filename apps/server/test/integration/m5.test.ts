import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * M5 集成（业务流程补全一期）：
 * Rig A（不配 Key）：成员 CRUD + 删除守卫、停工任务重试/取消/删除、备份下载可被 sqlite 打开。
 * Rig B（mock pass）：apis/test 成功与失败两路且不记账；已完成任务取消被拒、删除后账本保留。
 */
const SERVER_DIR = process.cwd(); // apps/server
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  base: string;
  mockBase: string | null;
  procs: ChildProcess[];
  dataDir: string;
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

async function startServer(port: number, extraEnv: Record<string, string> = {}): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-m5-'));
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LLM_RETRY_BASE_MS: '10', SWARM_ADMIN_EMAIL: 'admin@test.local', SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_001>!', ...extraEnv },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const rig: Rig = { base: `http://127.0.0.1:${port}`, mockBase: null, procs: [server], dataDir };
  expect(await waitUp(rig.base + '/api/health')).toBe(true);
  await loginAdmin(rig.base);
  return rig;
}

async function startMockRig(serverPort: number, mockPort: number): Promise<Rig> {
  const mock = spawn('node', [MOCK], {
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_REVIEW_MODE: 'pass' },
    stdio: 'pipe',
    detached: true,
  });
  const rig = await startServer(serverPort);
  rig.procs.unshift(mock);
  rig.mockBase = `http://127.0.0.1:${mockPort}`;
  expect(await waitUp(rig.mockBase + '/__counts')).toBe(true);
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

async function jget(base: string, p: string): Promise<any> {
  const r = await fetch(base + p, { headers: { cookie: COOKIE } });
  return r.json();
}
async function jpost(base: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

/* M6 登录夹具：管理员由环境变量种子创建（must_change_password=1），登录后先改密再操作 */
let COOKIE = '';
async function loginAdmin(base: string): Promise<void> {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: '<MASKED_SECRET_001>!' }),
  });
  const j: any = await r.json();
  expect(j.ok).toBe(true);
  COOKIE = (r.headers.get('set-cookie') || '').split(';')[0];
  expect(COOKIE).toContain('swarm_session=');
  const r2 = await fetch(base + '/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({ currentPassword: '<MASKED_SECRET_001>!', newPassword: '<MASKED_SECRET_002>!' }),
  });
  expect((await r2.json()).ok).toBe(true);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 30_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('waitFor 超时');
}
async function taskById(rig: Rig, taskId: string): Promise<any> {
  const st = await jget(rig.base, '/api/state');
  return st.tasks.find((t: any) => t.id === taskId);
}

describe('集成 M5 Rig A：成员 CRUD + 删除守卫 / 后悔药 / 备份', () => {
  it('成员全生命周期与任务后悔药、备份下载', async () => {
    const rig = await startServer(8854);
    try {
      const st0 = await jget(rig.base, '/api/state');
      const teamId = st0.teams[0].id as string;
      expect(st0.members.length).toBe(5);

      /* --- 成员新建 --- */
      const nm = await jpost(rig.base, '/api/members/save', {
        member: { name: '新同学', role: '文案', teamId, prompt: '口径P' },
      });
      expect(nm.ok).toBe(true);
      let st = await jget(rig.base, '/api/state');
      const created = st.members.find((m: any) => m.id === nm.id);
      expect(created).toMatchObject({ name: '新同学', role: '文案', teamId, prompt: '口径P' });

      /* --- 建第二组（自动带 5 名种子成员），把新成员换组+改工种+改提示词 --- */
      const t2 = await jpost(rig.base, '/api/teams/save', {
        team: { name: '第二小组', color: '#3a6fd8', apiId: null },
      });
      expect(t2.ok).toBe(true);
      const mv = await jpost(rig.base, '/api/members/save', {
        member: { id: nm.id, name: '新同学', role: '研究员', teamId: t2.id, prompt: '口径Q' },
      });
      expect(mv.ok).toBe(true);
      st = await jget(rig.base, '/api/state');
      const moved = st.members.find((m: any) => m.id === nm.id);
      expect(moved).toMatchObject({ role: '研究员', teamId: t2.id, prompt: '口径Q' });
      // 换组到不存在的小组 → VALIDATION
      const badTeam = await jpost(rig.base, '/api/members/save', {
        member: { name: 'x', role: '文案', teamId: 'team_nope', prompt: '' },
      });
      expect(badTeam.ok).toBe(false);
      expect(badTeam.error.code).toBe('VALIDATION');

      /* --- 删除守卫：给第一组发单（无 Key 会停工，但负责人已在创建时落位） --- */
      const ct = await jpost(rig.base, '/api/tasks', {
        title: '守卫测试单',
        type: '文案',
        brief: 'b',
        teamId,
      });
      expect(ct.ok).toBe(true);
      const t1 = await taskById(rig, ct.id);
      expect(t1.assigneeId).toBeTruthy();
      const guard = await jpost(rig.base, '/api/members/delete', { id: t1.assigneeId });
      expect(guard.ok).toBe(false);
      expect(guard.error.code).toBe('MEMBER_HAS_ACTIVE_TASKS');
      expect(guard.error.message).toContain('未完成任务');

      /* --- 取消该任务（终态）后守卫放行 --- */
      const cx = await jpost(rig.base, `/api/tasks/${ct.id}/cancel`);
      expect(cx.ok).toBe(true);
      expect(cx.task.status).toBe('已取消');
      expect(cx.task.blockedCode).toBeNull();
      const cx2 = await jpost(rig.base, `/api/tasks/${ct.id}/cancel`);
      expect(cx2.ok).toBe(false);
      expect(cx2.error.code).toBe('INVALID_TRANSITION');
      const rtCancelled = await jpost(rig.base, `/api/tasks/${ct.id}/retry`);
      expect(rtCancelled.ok).toBe(false);
      expect(rtCancelled.error.code).toBe('INVALID_TRANSITION');
      const delMember = await jpost(rig.base, '/api/members/delete', { id: t1.assigneeId });
      expect(delMember.ok).toBe(true);
      const delAgain = await jpost(rig.base, '/api/members/delete', { id: t1.assigneeId });
      expect(delAgain.ok).toBe(false);
      expect(delAgain.error.code).toBe('NOT_FOUND');

      /* --- 停工重试：新任务等引擎置 blocked（无 Key）→ retry 清除（响应体即时断言）→ 取消 → 删除 --- */
      const ct2 = await jpost(rig.base, '/api/tasks', {
        title: '重试测试单',
        type: '调研',
        brief: 'b',
        teamId,
      });
      const blocked = await waitFor(async () => {
        const t = await taskById(rig, ct2.id);
        return t && t.blockedCode ? t : null;
      });
      expect(blocked.blockedCode).toBe('NO_API_KEY');
      const rt = await jpost(rig.base, `/api/tasks/${ct2.id}/retry`);
      expect(rt.ok).toBe(true);
      expect(rt.task.blockedCode).toBeNull();
      expect(rt.task.blockedReason).toBe('');
      expect(rt.task.status).toBe('待领取');
      const cx3 = await jpost(rig.base, `/api/tasks/${ct2.id}/cancel`);
      expect(cx3.ok).toBe(true);
      const del = await jpost(rig.base, `/api/tasks/${ct2.id}/delete`);
      expect(del.ok).toBe(true);
      expect(await taskById(rig, ct2.id)).toBeUndefined();
      const del404 = await jpost(rig.base, `/api/tasks/${ct2.id}/delete`);
      expect(del404.ok).toBe(false);
      expect(del404.error.code).toBe('NOT_FOUND');
      // 未完成任务不可删：再发一单（待领取）→ delete 被 VALIDATION 拒
      const ct3 = await jpost(rig.base, '/api/tasks', { title: '不可删', type: '文案', brief: '', teamId });
      const delPending = await jpost(rig.base, `/api/tasks/${ct3.id}/delete`);
      expect(delPending.ok).toBe(false);
      expect(delPending.error.code).toBe('VALIDATION');

      /* --- 备份下载：附件 + SQLite 魔数 + 可被 sqlite 打开查询 --- */
      const resp = await fetch(rig.base + '/api/backup', { headers: { cookie: COOKIE } });
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-disposition')).toContain('attachment');
      expect(resp.headers.get('content-disposition')).toContain('.db');
      const buf = Buffer.from(await resp.arrayBuffer());
      expect(buf.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
      const bakPath = path.join(rig.dataDir, 'backup-test.db');
      fs.writeFileSync(bakPath, buf);
      const bak = new DatabaseSync(bakPath, { readOnly: true });
      try {
        const row = bak.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
        expect(row.c).toBeGreaterThanOrEqual(2); // ct（已取消）+ ct3 至少两条
        const tbl = bak
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_entries'")
          .get();
        expect(tbl).toBeTruthy();
      } finally {
        bak.close();
      }
    } finally {
      stopRig(rig);
    }
  });
});

describe('集成 M5 Rig B：apis/test 两路 + 已完成任务后悔药', () => {
  it('测试连接成功/失败且不记账；已完成任务取消被拒、删除保留账本', async () => {
    const rig = await startMockRig(8855, 8865);
    try {
      const st0 = await jget(rig.base, '/api/state');
      const apiId = st0.apis[0].id as string;
      const teamId = st0.teams[0].id as string;
      const sv = await jpost(rig.base, '/api/apis/save', {
        api: {
          id: apiId,
          name: 'Mock API',
          provider: 'custom',
          baseUrl: rig.mockBase,
          model: 'mock-model',
          pricePerM: 10,
          apiKey: 'fake-key-123',
        },
      });
      expect(sv.ok).toBe(true);
      expect((await jpost(rig.base, '/api/purchase', { apiId, amountYuan: 100 })).ok).toBe(true);
      expect(
        (await jpost(rig.base, '/api/teams/save', {
          team: { id: teamId, name: '第一小组', color: '#e2574c', apiId },
        })).ok,
      ).toBe(true);

      const ledgerBefore = (await jget(rig.base, '/api/state')).ledger.length;

      /* --- 成功路：按已存 id 测（用库里配置+Key） --- */
      const okTest = await jpost(rig.base, '/api/apis/test', { id: apiId });
      expect(okTest.ok).toBe(true);
      expect(okTest.test.ok).toBe(true);
      expect(okTest.test.latencyMs).toBeGreaterThanOrEqual(0);
      expect(okTest.test.message).toContain('连接成功');

      /* --- 失败路 1：路径错误 → 厂商 404 原文摘要 --- */
      const failTest = await jpost(rig.base, '/api/apis/test', {
        api: { provider: 'custom', baseUrl: `${rig.mockBase}/nope`, model: 'mock-model', apiKey: 'k' },
      });
      expect(failTest.ok).toBe(true);
      expect(failTest.test.ok).toBe(false);
      expect(failTest.test.message).toContain('404');

      /* --- 失败路 2：端口不可达 → 网络错误原因 --- */
      const deadTest = await jpost(rig.base, '/api/apis/test', {
        api: { provider: 'custom', baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'k' },
      });
      expect(deadTest.test.ok).toBe(false);
      expect(deadTest.test.message.length).toBeGreaterThan(0);

      /* --- 无 Key：明确提示，不发请求 --- */
      const noKey = await jpost(rig.base, '/api/apis/test', {
        api: { provider: 'custom', baseUrl: rig.mockBase, model: 'm', apiKey: '' },
      });
      expect(noKey.test.ok).toBe(false);
      expect(noKey.test.message).toContain('Key');

      /* --- 探活不记账：ledger 条数不变、余额不变 --- */
      const stAfterTest = await jget(rig.base, '/api/state');
      expect(stAfterTest.ledger.length).toBe(ledgerBefore);
      expect(stAfterTest.apis[0].balanceYuan).toBe(100);

      /* --- 已完成任务：取消被拒；删除后任务消失但账本 2 条保留 --- */
      const ct = await jpost(rig.base, '/api/tasks', {
        title: '完成后悔药测试单',
        type: '文案',
        brief: 'b',
        teamId,
      });
      const done = await waitFor(async () => {
        const t = await taskById(rig, ct.id);
        return t && t.status === '已完成' ? t : null;
      });
      expect(done.totalTokens).toBe(300);
      const cancelDone = await jpost(rig.base, `/api/tasks/${ct.id}/cancel`);
      expect(cancelDone.ok).toBe(false);
      expect(cancelDone.error.code).toBe('INVALID_TRANSITION');
      const entriesBefore = (await jget(rig.base, '/api/state')).ledger.filter(
        (l: any) => l.taskId === ct.id,
      );
      expect(entriesBefore.length).toBe(2);
      const del = await jpost(rig.base, `/api/tasks/${ct.id}/delete`);
      expect(del.ok).toBe(true);
      const stFinal = await jget(rig.base, '/api/state');
      expect(stFinal.tasks.find((t: any) => t.id === ct.id)).toBeUndefined();
      expect(stFinal.ledger.filter((l: any) => l.taskId === ct.id).length).toBe(2);
      // 删任务不删账：余额仍按账本推导（100 - 0.004）
      expect(Math.abs(stFinal.apis[0].balanceYuan - 99.996)).toBeLessThan(1e-9);
    } finally {
      stopRig(rig);
    }
  });
});
