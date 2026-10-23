import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { computeNextRunAt, runDueSchedules } from '../../src/domain/scheduleService';
import { encryptKey } from '../../src/store/crypto';
import { openDb } from '../../src/store/db';
import { ensureOfficialSkills } from '../../src/store/officialSkills';
import { Repos, type ScheduleRow } from '../../src/store/repositories';

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

/* ================= G-10 时区计算（断言⑤，进程内） ================= */
describe('G-10 验收⑤：next_run_at 按 timezone 计算（Intl，跨 UTC 日期边界）', () => {
  it('daily/weekly 在 Asia/Shanghai 与 America/New_York 下落点正确', () => {
    // 2026-10-23T17:00Z = 上海 2026-10-24（周六）01:00
    const from = new Date('2026-10-23T17:00:00.000Z');
    // daily 00:30：今日已过 → 明日（周日）00:30 CST = 2026-10-24T16:30Z（UTC 日期比当地早一天）
    expect(
      computeNextRunAt({ freq: 'daily', weekday: null, time_local: '00:30', timezone: 'Asia/Shanghai' }, from),
    ).toBe('2026-10-24T16:30:00.000Z');
    // daily 09:00：今日未到 → 今日 09:00 CST = 2026-10-24T01:00Z
    expect(
      computeNextRunAt({ freq: 'daily', weekday: null, time_local: '09:00', timezone: 'Asia/Shanghai' }, from),
    ).toBe('2026-10-24T01:00:00.000Z');
    // weekly 周日（0）00:30 → 2026-10-25 00:30 CST = 2026-10-24T16:30Z
    expect(
      computeNextRunAt({ freq: 'weekly', weekday: 0, time_local: '00:30', timezone: 'Asia/Shanghai' }, from),
    ).toBe('2026-10-24T16:30:00.000Z');
    // weekly 周六（6）00:30：今日已过 → 下周六 2026-10-31 00:30 CST = 2026-10-30T16:30Z
    expect(
      computeNextRunAt({ freq: 'weekly', weekday: 6, time_local: '00:30', timezone: 'Asia/Shanghai' }, from),
    ).toBe('2026-10-30T16:30:00.000Z');
    // 纽约：2026-10-23T12:00Z = 08:00 EDT，daily 09:00 → 同日 13:00Z
    expect(
      computeNextRunAt(
        { freq: 'daily', weekday: null, time_local: '09:00', timezone: 'America/New_York' },
        new Date('2026-10-23T12:00:00.000Z'),
      ),
    ).toBe('2026-10-23T13:00:00.000Z');
  });
});

/* ================= G-10 调度器语义（断言②③④ + 流水线路径，进程内） ================= */
describe('G-10 验收②③④（进程内）：只发一单 / 停用删除不发 / 零余额 blocked+通知 / 流水线同路径', () => {
  function seedRepos(): { repos: Repos; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v120c-sched-'));
    const db = openDb(path.join(dir, 'swarm.db'));
    const repos = new Repos(db);
    const ts = new Date().toISOString();
    const mkWs = (wsId: string, userId: string, withApi: boolean) => {
      repos.insertWorkspace({
        id: wsId, name: `空间 ${wsId}`, owner_user_id: userId, status: 'active',
        industry_pack_id: null, created_at: ts,
      });
      repos.insertMembership({ user_id: userId, workspace_id: wsId, role: 'owner', status: 'active', joined_at: ts });
      repos.insertTeam({
        id: `${wsId}_team`, name: '小组', color: '#000', api_id: null, created_at: ts,
        deleted_at: null, workspace_id: wsId,
      });
      for (const role of ['文案', '审核']) {
        repos.insertMember({
          id: `${wsId}_m_${role}`, team_id: `${wsId}_team`, name: role, role,
          persona: `${role}人设`, prompt: '', skill_tags: '[]', color: '', workspace_id: wsId,
        });
      }
      if (withApi) {
        repos.insertApi({
          id: `${wsId}_api`, name: '测试 API', provider: 'custom', base_url: 'http://127.0.0.1:9',
          api_key_enc: encryptKey('sk-test'), model: 'm', price_per_m_milli: 1000, created_at: ts,
          workspace_id: wsId, is_trial: 0,
        });
        repos.setSetting('defaultApiId', `${wsId}_api`, wsId);
        repos.insertPurchase(`${wsId}_api`, 100_000, wsId, 'purchase');
      }
    };
    mkWs('wsSched', 'user_sched', true);
    mkWs('wsBroke', 'user_broke', false);
    repos.insertSkill({
      id: 'skill_sched', slug: 'sched-skill', owner_type: 'workspace', owner_id: null,
      workspace_id: 'wsSched', name: '定时技能', description: '', role: '文案',
      prompt_template: '为《{{drama_name}}》写标题', input_schema: JSON.stringify([
        { key: 'drama_name', label: '剧名', type: 'text', required: true },
      ]),
      kb_binding: '{}', output_spec: '', example_input: '{}', example_output: '', version: 1,
      changelog: '', status: 'published', visibility: 'workspace', source_skill_id: null,
      source_version: null, install_count: 0, verified_notes: '', created_by: 'user_sched',
      created_at: ts, updated_at: ts,
    });
    repos.insertAsset({
      id: 'asset_sched', workspace_id: 'wsSched', type_id: '通用文档', name: '定时资产', version: 1,
      content: JSON.stringify({ sections: [{ key: 'ep1', title: '第一集', body: '正文一' }] }),
      created_by: 'user_sched', created_at: ts, updated_at: ts,
    });
    return { repos, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  const dueSchedule = (patch: Partial<ScheduleRow>): ScheduleRow => {
    const ts = new Date().toISOString();
    return {
      id: 'sch_x', workspace_id: 'wsSched', created_by_user_id: 'user_sched', kind: 'skill',
      skill_id: 'skill_sched', pipeline_template_id: null, team_id: 'wsSched_team', title: '定时技能',
      brief: '', type: '文案',
      params: JSON.stringify({ drama_name: '测试剧', assetRefs: [{ assetId: 'asset_sched' }] }),
      freq: 'daily', weekday: null, time_local: '09:00', timezone: 'Asia/Shanghai', enabled: 1,
      next_run_at: '2020-01-01T00:00:00.000Z', last_run_at: null, last_task_id: null, last_result: null,
      created_at: ts, updated_at: ts, ...patch,
    };
  };

  it('断言③：到期 skill 计划只发一单（重复扫描不再发），参数/资产快照与手动一致，last_task_id 正确', () => {
    const { repos, cleanup } = seedRepos();
    try {
      repos.insertSchedule(dueSchedule({ id: 'sch_once' }));
      const first = runDueSchedules(repos, {}, new Date());
      expect(first.length).toBe(1);
      expect(first[0].outcome.result).toBe('dispatched');
      const taskId = first[0].outcome.taskIds[0];
      const task = repos.getTask(taskId, 'wsSched');
      expect(task).toBeTruthy();
      expect(task!.brief).toContain('测试剧');
      expect(JSON.parse(task!.skill_params || '{}').drama_name).toBe('测试剧');
      const refs = repos.listTaskAssetRefs(taskId);
      expect(refs.length).toBe(1);
      expect(refs[0].asset_id).toBe('asset_sched');
      expect(refs[0].asset_version).toBe(1);
      const saved = repos.getSchedule('sch_once');
      expect(saved!.last_task_id).toBe(taskId);
      expect(saved!.last_result).toBe('dispatched');
      expect(new Date(saved!.next_run_at).getTime()).toBeGreaterThan(Date.now());
      // 重复扫描（模拟进程重启后再次扫到）：next_run_at 已推进未来 → 不再发单
      const second = runDueSchedules(repos, {}, new Date());
      expect(second.length).toBe(0);
      expect(repos.listTasks('wsSched').length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('断言②：停用与删除的到期计划不发单', () => {
    const { repos, cleanup } = seedRepos();
    try {
      repos.insertSchedule(dueSchedule({ id: 'sch_off', enabled: 0 }));
      repos.insertSchedule(dueSchedule({ id: 'sch_del' }));
      repos.deleteSchedule('sch_del');
      const out = runDueSchedules(repos, {}, new Date());
      expect(out.length).toBe(0);
      expect(repos.listTasks('wsSched').length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('断言④：零余额（无 API）空间到点 → blocked、不建单、所有者收到 schedule_result 通知', () => {
    const { repos, cleanup } = seedRepos();
    try {
      repos.insertSchedule(
        dueSchedule({
          id: 'sch_blocked', workspace_id: 'wsBroke', created_by_user_id: 'user_broke',
          team_id: 'wsBroke_team', skill_id: 'skill_sched',
        }),
      );
      // wsBroke 无该 skill 可见行 → 先把 skill 复制为 wsBroke 可见（平台行口径）以便只卡在守卫
      const out = runDueSchedules(repos, {}, new Date());
      const row = out.find((r) => r.scheduleId === 'sch_blocked');
      expect(row).toBeTruthy();
      // skill 在 wsBroke 不可见会归 failed；本断言针对守卫 blocked：在 wsSched 删余额同样验证
      expect(['blocked', 'failed']).toContain(row!.outcome.result);
      expect(repos.listTasks('wsBroke').length).toBe(0);

      // 精确 blocked 路径：wsSched 的 skill 计划，但把余额抽干（删采购 + ledger 抵平）
      repos.insertSchedule(dueSchedule({ id: 'sch_blocked2' }));
      repos.db.prepare("DELETE FROM purchases WHERE workspace_id = 'wsSched'").run();
      const out2 = runDueSchedules(repos, {}, new Date());
      const row2 = out2.find((r) => r.scheduleId === 'sch_blocked2');
      expect(row2!.outcome.result).toBe('blocked');
      expect(repos.listTasks('wsSched').length).toBe(0);
      const saved = repos.getSchedule('sch_blocked2');
      expect(saved!.last_result).toBe('blocked');
      const notifs = repos.listNotifications('wsSched', 10).filter((n) => n.type === 'schedule_result');
      expect(notifs.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it('流水线计划走 runPipeline 同一路径：生成项目 + 6 个子任务且 last_task_id 指向首个子任务', () => {
    const { repos, cleanup } = seedRepos();
    try {
      ensureOfficialSkills(repos);
      repos.insertSchedule(
        dueSchedule({
          id: 'sch_pipe', kind: 'pipeline', skill_id: null, pipeline_template_id: 'drama-launch-pack',
          title: '定时流水线',
          params: JSON.stringify({
            drama_name: '测试剧', genre: '逆袭打脸', synopsis: '梗概', key_plot: '关键剧情',
            selling_point: '卖点', hook: '悬念', platform: 'YouTube',
          }),
        }),
      );
      const out = runDueSchedules(repos, {}, new Date());
      const row = out.find((r) => r.scheduleId === 'sch_pipe');
      expect(row!.outcome.result).toBe('dispatched');
      expect(row!.outcome.taskIds.length).toBe(6);
      expect(row!.outcome.projectId).toBeTruthy();
      expect(repos.getSchedule('sch_pipe')!.last_task_id).toBe(row!.outcome.taskIds[0]);
      expect(repos.listTasks('wsSched').length).toBe(6);
    } finally {
      cleanup();
    }
  });
});

/* ================= G-10 全链路（断言①②④，rig：真实调度 tick） ================= */
describe('G-10 验收①②④（rig）：到点自动发单与手动一致 / 停用不发 / 零余额 blocked+通知', () => {
  it('daily 计划到点发单（参数/资产快照 = 手动单）、weekly nextRunAt 跨 UTC 边界正确、停用不发、零余额 blocked', async () => {
    const rig = await startRig(8942, 8952, { SWARM_SCHEDULE_TICK_MS: '400' });
    try {
      const admin = rig.adminCookie;
      const { teamId } = await configureMock(rig, admin);

      // 自定义 skill（带必填参数）+ 资产，供手动单与定时单同参数对照
      const sk = await jpost(
        rig.base, '/api/skills',
        {
          skill: {
            name: '定时对照技能', description: '', role: '文案',
            promptTemplate: '为《{{drama_name}}》写一组标题',
            inputSchema: [{ key: 'drama_name', label: '剧名', type: 'text', required: true }],
            kbBinding: {}, outputSpec: '', exampleInput: {}, exampleOutput: '',
          },
        },
        admin,
      );
      expect(sk.ok).toBe(true);
      const pub = await jpost(rig.base, `/api/skills/${sk.id}/publish`, {}, admin);
      expect(pub.ok).toBe(true);
      const asset = await jpost(
        rig.base, '/api/assets',
        {
          asset: {
            typeId: '通用文档', name: '对照资产',
            content: { sections: [{ key: 'ep1', title: '第一集', body: '正文' }] },
          },
        },
        admin,
      );
      expect(asset.ok).toBe(true);

      // 手动发单（同参数 + 同资产引用）
      const manual = await jpost(
        rig.base, `/api/skills/${sk.id}/dispatch`,
        { params: { drama_name: '对照剧' }, teamId, assetRefs: [{ assetId: asset.id }] },
        admin,
      );
      expect(manual.ok).toBe(true);

      // 建 daily 计划：time 设为上海当前 +3 分钟（走真实 computeNextRunAt，断言其 HH:MM 与时区落点）
      const future = new Date(Date.now() + 3 * 60_000);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(future);
      const hh = parts.find((p) => p.type === 'hour')!.value;
      const mm = parts.find((p) => p.type === 'minute')!.value;
      const created = await jpost(
        rig.base, '/api/schedules',
        {
          kind: 'skill', skillId: sk.id, teamId, params: { drama_name: '对照剧' },
          assetRefs: [{ assetId: asset.id }], freq: 'daily', timeLocal: `${hh}:${mm}`,
          timezone: 'Asia/Shanghai',
        },
        admin,
      );
      expect(created.ok).toBe(true);
      const schId: string = created.schedule.id;
      const nextParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(created.schedule.nextRunAt));
      expect(nextParts.find((p) => p.type === 'hour')!.value).toBe(hh);
      expect(nextParts.find((p) => p.type === 'minute')!.value).toBe(mm);

      // weekly 跨 UTC 边界断言：选上海明天的星期、00:15 → UTC 必然是前一天 16:15
      const tomorrowWd = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai', weekday: 'short',
      }).format(new Date(Date.now() + 86_400_000));
      const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const weekly = await jpost(
        rig.base, '/api/schedules',
        {
          kind: 'task', teamId, title: '每周对照任务', type: '文案', brief: 'b',
          freq: 'weekly', weekday: wdMap[tomorrowWd], timeLocal: '00:15', timezone: 'Asia/Shanghai',
        },
        admin,
      );
      expect(weekly.ok).toBe(true);
      const wNext = new Date(weekly.schedule.nextRunAt);
      expect(wNext.getUTCHours()).toBe(16);
      expect(wNext.getUTCMinutes()).toBe(15);
      const wLocal = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(wNext);
      expect(wLocal.find((p) => p.type === 'weekday')!.value).toBe(tomorrowWd);

      // 把 daily 计划的 next_run_at 直接拨到过去（施工口径：DB 拨时模拟到点，调度 tick 400ms 真实触发）
      withDb(rig, (db) => {
        db.prepare("UPDATE schedules SET next_run_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(schId);
      });
      const fired = await waitFor(async () => {
        const list = await jget(rig.base, '/api/schedules', admin);
        const row = (list.schedules as any[]).find((s) => s.id === schId);
        return row && row.lastTaskId ? row : null;
      }, 30_000);
      expect(fired.lastResult).toBe('dispatched');
      const st = await jget(rig.base, '/api/state', admin);
      const manualTask = (st.tasks as any[]).find((t) => t.id === manual.id);
      const schedTask = (st.tasks as any[]).find((t) => t.id === fired.lastTaskId);
      expect(schedTask).toBeTruthy();
      expect(schedTask.brief).toBe(manualTask.brief);
      expect(schedTask.skillParams).toEqual(manualTask.skillParams);
      withDb(rig, (db) => {
        const refs = db
          .prepare('SELECT asset_id, asset_version FROM task_asset_refs WHERE task_id = ?')
          .all(fired.lastTaskId) as Array<{ asset_id: string; asset_version: number }>;
        expect(refs).toEqual([{ asset_id: asset.id, asset_version: 1 }]);
        const ev = db
          .prepare("SELECT note FROM task_events WHERE task_id = ? AND note LIKE '%定时%'")
          .all(fired.lastTaskId) as Array<{ note: string }>;
        expect(ev.length).toBeGreaterThanOrEqual(1);
      });

      /* ----- 断言②（rig 侧）：停用计划拨到过去也不发 ----- */
      const off = await jpost(
        rig.base, '/api/schedules',
        {
          kind: 'task', teamId, title: '停用对照', type: '文案', brief: 'b',
          freq: 'daily', timeLocal: '09:00', timezone: 'Asia/Shanghai',
        },
        admin,
      );
      expect(off.ok).toBe(true);
      const offId: string = off.schedule.id;
      const upd = await fetch(rig.base + `/api/schedules/${offId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: admin },
        body: JSON.stringify({ enabled: false }),
      });
      expect((await upd.json()).ok).toBe(true);
      withDb(rig, (db) => {
        db.prepare("UPDATE schedules SET next_run_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(offId);
      });
      await sleep(1600);
      const offList = await jget(rig.base, '/api/schedules', admin);
      const offRow = (offList.schedules as any[]).find((s) => s.id === offId);
      expect(offRow.lastTaskId).toBeNull();
      // 删除后同样不发
      const del = await fetch(rig.base + `/api/schedules/${offId}`, {
        method: 'DELETE', headers: { cookie: admin },
      });
      expect((await del.json()).ok).toBe(true);
      const afterDel = await jget(rig.base, '/api/schedules', admin);
      expect((afterDel.schedules as any[]).some((s) => s.id === offId)).toBe(false);

      /* ----- 断言④（rig 侧）：零余额新空间到点 blocked + schedule_result 通知 + 零任务 ----- */
      const broke = await registerUser(rig.base, 'g10-broke@test.local', '零余额老板');
      const bState = await jget(rig.base, '/api/state', broke.cookie);
      const bTeamId = bState.teams[0].id as string;
      const bSch = await jpost(
        rig.base, '/api/schedules',
        {
          kind: 'task', teamId: bTeamId, title: '零余额定时单', type: '文案', brief: 'b',
          freq: 'daily', timeLocal: '09:00', timezone: 'Asia/Shanghai',
        },
        broke.cookie,
      );
      expect(bSch.ok).toBe(true);
      withDb(rig, (db) => {
        db.prepare("UPDATE schedules SET next_run_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(bSch.schedule.id);
      });
      const blockedRow = await waitFor(async () => {
        const list = await jget(rig.base, '/api/schedules', broke.cookie);
        const row = (list.schedules as any[]).find((s) => s.id === bSch.schedule.id);
        return row && row.lastResult === 'blocked' ? row : null;
      }, 30_000);
      expect(blockedRow.lastTaskId).toBeNull();
      const bState2 = await jget(rig.base, '/api/state', broke.cookie);
      expect(bState2.tasks.length).toBe(0);
      const notif = await jget(rig.base, '/api/notifications?type=schedule_result', broke.cookie);
      expect(notif.total).toBeGreaterThanOrEqual(1);
    } finally {
      stopRig(rig);
    }
  });
});
