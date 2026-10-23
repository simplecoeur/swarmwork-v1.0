import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskStatus } from '@swarm/shared';
import { generateBriefing } from '../../src/domain/briefingService';
import { doCheckin, getCheckinStatus, runDailyTick } from '../../src/domain/dailyService';
import { saveDailySettings } from '../../src/domain/dailySettings';
import { openDb } from '../../src/store/db';
import { Repos, type TaskRow } from '../../src/store/repositories';

/**
 * v1.3.0 第二阶段集成测试（G 晨报/签到 + C2 问卷/团队锻造 + 一期补点）：
 * - 进程内直调 runDailyTick/generateBriefing：晨报幂等、昨日口径、督促回显、热点失败兜底、提醒去重、已签到不提醒。
 * - HTTP：签到幂等与 streak 口径、daily-settings（含 mailStatus 据实 not_configured）、briefings 跨空间隔离、
 *   test-connection 裸配置两路、建空间无问卷=默认种子 / 带问卷=forge 团队 + API 默认 + 存档脱敏、PUT 问卷不重组。
 * - 补点：管理员 pending 风格模板列表、/api/presets 含 tongyi/zhipu。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- CST 日期工具（空间默认时区 Asia/Shanghai） ---------- */
function cstDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
function shiftDateStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}
const TODAY = cstDateStr(new Date());
const YESTERDAY = shiftDateStr(TODAY, -1);
const DAY_BEFORE = shiftDateStr(TODAY, -2);

/* ================= 进程内直调（runDailyTick / generateBriefing / 签到口径） ================= */

function setupRepos(): Repos {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-gc2-unit-'));
  return new Repos(openDb(path.join(dir, 't.db')));
}

function insertUserWs(repos: Repos, userId: string, wsId: string): void {
  repos.insertUser({
    id: userId,
    email: `${userId}@test.local`,
    password_hash: 'x',
    display_name: userId,
    status: 'active',
    is_platform_admin: 0,
    must_change_password: 0,
    failed_attempts: 0,
    locked_until: null,
    registration_ip: '',
    last_login_at: null,
    created_at: '2026-10-20T00:00:00.000Z',
  } as never);
  repos.insertWorkspace({
    id: wsId,
    name: wsId,
    owner_user_id: userId,
    status: 'active',
    industry_pack_id: null,
    created_at: '2026-10-20T00:00:00.000Z',
  } as never);
  repos.insertTeam({
    id: `${wsId}_team`,
    name: '测试组',
    color: '#000',
    api_id: null,
    created_at: '2026-10-20T00:00:00.000Z',
    deleted_at: null,
    workspace_id: wsId,
  } as never);
}

let taskSeq = 0;
function insertTask(repos: Repos, wsId: string, patch: Partial<TaskRow>): TaskRow {
  taskSeq += 1;
  const row = {
    id: `task_${taskSeq}`,
    project_id: null,
    team_id: `${wsId}_team`,
    assignee_id: null,
    title: `t${taskSeq}`,
    type: '文案',
    brief: '',
    status: TaskStatus.PENDING,
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
    created_at: '2026-10-23T04:00:00.000Z',
    claimed_at: null,
    finished_at: null,
    workspace_id: wsId,
    ...patch,
  } as TaskRow;
  repos.insertTask(row);
  return row;
}

/** 2026-10-24 10:30 CST（= 02:30Z）：晚于晨报 09:00 与提醒 10:00 */
const TICK_NOW = new Date('2026-10-24T02:30:00.000Z');

describe('G 进程内：runDailyTick / generateBriefing / 签到口径', () => {
  it('tick 直调两次：晨报幂等一行、提醒恰一条；内容口径正确', async () => {
    process.env.SWARM_NEWS_FEEDS_JSON = JSON.stringify([
      { name: '闭口源', url: 'http://127.0.0.1:1/feed' },
    ]);
    try {
      const repos = setupRepos();
      insertUserWs(repos, 'owner1', 'ws_tick');
      saveDailySettings(repos, 'ws_tick', {
        briefingEnabled: true,
        briefingTime: '09:00',
        checkinReminderEnabled: true,
        checkinReminderTime: '10:00',
        newsTopic: 'general',
        supervisionItems: '盯紧回款\n检查库存',
      });
      insertTask(repos, 'ws_tick', { title: '昨日待领取任务', status: TaskStatus.PENDING });
      insertTask(repos, 'ws_tick', {
        title: '昨日待审核任务',
        status: TaskStatus.REVIEWING,
        reject_count: 1,
      });
      insertTask(repos, 'ws_tick', { title: '昨日已完成任务', status: TaskStatus.DONE });
      insertTask(repos, 'ws_tick', {
        title: '今日新任务',
        status: TaskStatus.PENDING,
        created_at: '2026-10-24T01:00:00.000Z',
      });

      await runDailyTick(repos, TICK_NOW);
      await runDailyTick(repos, TICK_NOW);

      const briefings = repos.listBriefings('ws_tick', 7);
      expect(briefings).toHaveLength(1);
      expect(briefings[0].date).toBe('2026-10-24');
      const md = briefings[0].content_md;
      // 昨日口径：昨日未完成进首段；今日新建不进；已完成不进
      expect(md).toContain('昨日待领取任务');
      expect(md).toContain('昨日待审核任务');
      expect(md).not.toContain('今日新任务');
      expect(md).not.toContain('昨日已完成任务');
      expect(md).toContain('曾被打回');
      // 第二段：当前计数置顶 + 督促事项原样逐行回显
      expect(md).toContain('当前待裁决 0 件、待审核 1 件');
      expect(md).toContain('- 盯紧回款');
      expect(md).toContain('- 检查库存');
      // 第三段：feeds 闭口 → 兜底文案，晨报照常生成
      expect(md).toContain('今日热点暂不可用');

      const notes = repos.listNotifications('ws_tick', 50);
      expect(notes.filter((n) => n.type === 'checkin_reminder')).toHaveLength(1);
      expect(notes.filter((n) => n.type === 'daily_briefing')).toHaveLength(1);

      // generateBriefing 直调再两次仍幂等
      const again = await generateBriefing(repos, 'ws_tick', '2026-10-24');
      expect(again.created).toBe(false);
      expect(repos.listBriefings('ws_tick', 7)).toHaveLength(1);
    } finally {
      delete process.env.SWARM_NEWS_FEEDS_JSON;
    }
  });

  it('已签到空间不提醒；签到 streak 口径（断一天即断 / 未签截至昨日）', async () => {
    const repos = setupRepos();
    insertUserWs(repos, 'owner2', 'ws_checked');
    saveDailySettings(repos, 'ws_checked', {
      briefingEnabled: false,
      checkinReminderEnabled: true,
      checkinReminderTime: '10:00',
    });
    repos.insertCheckin({
      id: 'ck_ws2_today',
      user_id: 'owner2',
      workspace_id: 'ws_checked',
      date: '2026-10-24',
      created_at: '2026-10-24T01:00:00.000Z',
    });
    await runDailyTick(repos, TICK_NOW);
    expect(
      repos.listNotifications('ws_checked', 50).filter((n) => n.type === 'checkin_reminder'),
    ).toHaveLength(0);

    // streak：今日+昨日+前日 = 3
    insertUserWs(repos, 'owner3', 'ws_streak');
    doCheckin(repos, 'owner3', 'ws_streak', TICK_NOW);
    repos.insertCheckin({ id: 'ck_s1', user_id: 'owner3', workspace_id: 'ws_streak', date: '2026-10-23', created_at: '2026-10-23T01:00:00.000Z' });
    repos.insertCheckin({ id: 'ck_s2', user_id: 'owner3', workspace_id: 'ws_streak', date: '2026-10-22', created_at: '2026-10-22T01:00:00.000Z' });
    const st = getCheckinStatus(repos, 'owner3', 'ws_streak', TICK_NOW);
    expect(st.checkedToday).toBe(true);
    expect(st.streak).toBe(3);
    expect(st.monthDays).toEqual(['2026-10-22', '2026-10-23', '2026-10-24']);
    expect(st.lastCheckinDate).toBe('2026-10-24');

    // 断一天：今日 + 前日（缺昨日）→ streak 1
    repos.insertCheckin({ id: 'ck_g1', user_id: 'owner4', workspace_id: 'ws_streak', date: '2026-10-24', created_at: '2026-10-24T01:00:00.000Z' });
    repos.insertCheckin({ id: 'ck_g2', user_id: 'owner4', workspace_id: 'ws_streak', date: '2026-10-22', created_at: '2026-10-22T01:00:00.000Z' });
    expect(getCheckinStatus(repos, 'owner4', 'ws_streak', TICK_NOW).streak).toBe(1);

    // 今日未签：截至昨日连续段（昨日+前日）→ streak 2、checkedToday=false
    repos.insertCheckin({ id: 'ck_y1', user_id: 'owner5', workspace_id: 'ws_streak', date: '2026-10-23', created_at: '2026-10-23T01:00:00.000Z' });
    repos.insertCheckin({ id: 'ck_y2', user_id: 'owner5', workspace_id: 'ws_streak', date: '2026-10-22', created_at: '2026-10-22T01:00:00.000Z' });
    const st5 = getCheckinStatus(repos, 'owner5', 'ws_streak', TICK_NOW);
    expect(st5.checkedToday).toBe(false);
    expect(st5.streak).toBe(2);
  });
});

/* ================= HTTP 黑盒 ================= */

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

async function startRig(serverPort: number, mockPort: number): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-gc2-'));
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
      SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_00' + '1>!',
      SWARM_SCHEDULE_TICK_MS: '3600000',
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
async function jput(base: string, p: string, body: unknown, cookie: string): Promise<any> {
  const r = await fetch(base + p, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
async function raw(
  base: string,
  p: string,
  method: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, {
    method,
    headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function registerUser(
  base: string,
  email: string,
  displayName: string,
  workspaceName?: string,
): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const r = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: '<MASKED_SECRET_005>!', displayName, workspaceName }),
  });
  const j: any = await r.json();
  expect(j.ok).toBe(true);
  expect(j.pending).toBe(false);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
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

let rig: Rig;
let userA: { cookie: string; userId: string; workspaceId: string };
let userB: { cookie: string; userId: string; workspaceId: string };

beforeAll(async () => {
  rig = await startRig(9011, 9021);
  userA = await registerUser(rig.base, 'gc2-a@test.local', '甲', '甲空间');
  userB = await registerUser(rig.base, 'gc2-b@test.local', '乙', '乙空间');
}, 60_000);

afterAll(() => {
  if (rig) stopRig(rig);
});

describe('G HTTP：daily-settings / 签到 / 晨报读取', () => {
  it('daily-settings：缺省值 + mailStatus 据实 not_configured；PUT 合并与校验', async () => {
    const j = await jget(rig.base, '/api/daily-settings', userA.cookie);
    expect(j.ok).toBe(true);
    expect(j.settings.briefingEnabled).toBe(true);
    expect(j.settings.briefingTime).toBe('09:00');
    expect(j.settings.checkinReminderEnabled).toBe(true);
    expect(j.settings.checkinReminderTime).toBe('10:00');
    expect(j.settings.newsTopic).toBe('short_drama');
    expect(j.settings.mailStatus).toBe('not_configured');

    const put = await jput(
      rig.base,
      '/api/daily-settings',
      { briefingTime: '08:30', newsTopic: 'ai', supervisionItems: '督促甲' },
      userA.cookie,
    );
    expect(put.ok).toBe(true);
    expect(put.settings.briefingTime).toBe('08:30');
    expect(put.settings.newsTopic).toBe('ai');
    expect(put.settings.checkinReminderTime).toBe('10:00'); // 未传字段保持
    const bad = await raw(rig.base, '/api/daily-settings', 'PUT', userA.cookie, { briefingTime: '25:00' });
    expect(bad.status).toBe(400);
    const badTopic = await raw(rig.base, '/api/daily-settings', 'PUT', userA.cookie, { newsTopic: 'nope' });
    expect(badTopic.status).toBe(400);
  });

  it('签到：POST 两次幂等一行；DB 补昨日/前日后 streak=3；断一天 streak=1', async () => {
    const first = await jpost(rig.base, '/api/checkin', {}, userA.cookie);
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(first.checkedToday).toBe(true);
    const second = await jpost(rig.base, '/api/checkin', {}, userA.cookie);
    expect(second.created).toBe(false);
    const rows = withDb(rig, (db) =>
      db
        .prepare('SELECT COUNT(*) AS c FROM checkins WHERE user_id = ? AND workspace_id = ?')
        .get(userA.userId, userA.workspaceId),
    ) as any;
    expect(rows.c).toBe(1);

    withDb(rig, (db) => {
      const ins = db.prepare(
        'INSERT INTO checkins (id, user_id, workspace_id, date, created_at) VALUES (?,?,?,?,?)',
      );
      ins.run('ck_a_y', userA.userId, userA.workspaceId, YESTERDAY, new Date().toISOString());
      ins.run('ck_a_db', userA.userId, userA.workspaceId, DAY_BEFORE, new Date().toISOString());
    });
    const st = await jget(rig.base, '/api/checkin', userA.cookie);
    expect(st.streak).toBe(3);
    expect(st.monthDays).toContain(TODAY);
    expect(st.monthDays).toContain(YESTERDAY);
    expect(st.lastCheckinDate).toBe(TODAY);

    // 乙：只补前日，今日签到 → 中间断一天，streak=1
    withDb(rig, (db) => {
      db.prepare(
        'INSERT INTO checkins (id, user_id, workspace_id, date, created_at) VALUES (?,?,?,?,?)',
      ).run('ck_b_db', userB.userId, userB.workspaceId, DAY_BEFORE, new Date().toISOString());
    });
    const bPost = await jpost(rig.base, '/api/checkin', {}, userB.cookie);
    expect(bPost.created).toBe(true);
    const stB = await jget(rig.base, '/api/checkin', userB.cookie);
    expect(stB.streak).toBe(1);
  });

  it('briefings：今日/列表按空间隔离', async () => {
    withDb(rig, (db) => {
      db.prepare(
        'INSERT INTO briefings (id, workspace_id, date, content_md, created_at) VALUES (?,?,?,?,?)',
      ).run('brief_a', userA.workspaceId, TODAY, '# 甲的晨报', new Date().toISOString());
    });
    const todayA = await jget(rig.base, '/api/briefings/today', userA.cookie);
    expect(todayA.briefing?.contentMd).toBe('# 甲的晨报');
    const listA = await jget(rig.base, '/api/briefings', userA.cookie);
    expect(listA.briefings).toHaveLength(1);
    const todayB = await jget(rig.base, '/api/briefings/today', userB.cookie);
    expect(todayB.briefing).toBeNull();
    const listB = await jget(rig.base, '/api/briefings', userB.cookie);
    expect(listB.briefings).toHaveLength(0);
  });
});

describe('C2 HTTP：test-connection / 建空间问卷 / 存档', () => {
  it('test-connection：mock 成功；错误地址失败带原文；未登录 401', async () => {
    const ok = await jpost(
      rig.base,
      '/api/apis/test-connection',
      { provider: 'custom', baseUrl: rig.mockBase, model: 'mock-model', apiKey: 'k-1' },
      userA.cookie,
    );
    expect(ok.ok).toBe(true);
    expect(ok.test.ok).toBe(true);

    const bad = await jpost(
      rig.base,
      '/api/apis/test-connection',
      { provider: 'custom', baseUrl: 'http://127.0.0.1:1', model: 'mock-model', apiKey: 'k-1' },
      userA.cookie,
    );
    expect(bad.test.ok).toBe(false);
    expect(typeof bad.test.message).toBe('string');
    expect(bad.test.message.length).toBeGreaterThan(0);

    const anon = await fetch(rig.base + '/api/apis/test-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', baseUrl: rig.mockBase, model: 'm', apiKey: 'k' }),
    });
    expect(anon.status).toBe(401);
  });

  it('无 questionnaire 建空间：团队与默认种子一致（通用小组）', async () => {
    const w = await jpost(rig.base, '/api/workspaces', { name: '普通空间' }, userB.cookie);
    expect(w.ok).toBe(true);
    const st = await jget(rig.base, '/api/state', userB.cookie);
    expect((st.teams as any[]).map((t) => t.name).sort()).toEqual(['通用小组']);
    expect((st.members as any[])).toHaveLength(5);
    // 切回乙的注册空间待后续用例（后续建空间用例各自切换）
    await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: userB.workspaceId }, userB.cookie);
  });

  it('带 questionnaire（短剧包 + 内容生产/运营推广）：forge 团队 + API 默认 + 存档脱敏 + 提醒落 dailySettings', async () => {
    const w = await jpost(
      rig.base,
      '/api/workspaces',
      {
        name: '问卷短剧空间',
        industryPackId: 'short_drama',
        questionnaire: {
          api: { provider: 'custom', baseUrl: rig.mockBase, model: 'mock-model', apiKey: '<MASKED_SECRET_006>' },
          industry: 'short_drama',
          job: '制片人',
          uses: ['内容生产', '运营推广'],
          problems: '缺人手',
          checkinReminderEnabled: false,
          checkinReminderTime: '07:45',
          briefingEnabled: true,
          briefingTime: '08:15',
          supervisionItems: '盯紧上线节奏',
        },
      },
      userB.cookie,
    );
    expect(w.ok).toBe(true);
    const wsId = w.workspace.id as string;

    const st = await jget(rig.base, '/api/state', userB.cookie);
    const teamNames = (st.teams as any[]).map((t) => t.name).sort();
    // 行业层三组 + 运营推广（短剧化命名）；内容生产已被文案组覆盖不重复建
    expect(teamNames).toEqual(['审片组', '短剧文案组', '短剧运营组', '选题调研组'].sort());
    const members = st.members as any[];
    expect(members).toHaveLength(19);
    const personas = withDb(rig, (db) =>
      db.prepare('SELECT persona FROM members WHERE workspace_id = ?').all(wsId),
    ) as any[];
    expect(personas).toHaveLength(19);
    expect(personas.every((m) => typeof m.persona === 'string' && m.persona.trim().length > 0)).toBe(true);
    const registry = await jget(rig.base, '/api/registry', userB.cookie);
    const roleIds = new Set((registry.roles as any[]).map((r) => r.roleId));
    expect(members.every((m) => roleIds.has(m.role))).toBe(true);

    // API 已建且为默认
    const api = (st.apis as any[]).find((a) => a.baseUrl === rig.mockBase);
    expect(api).toBeTruthy();
    expect(st.defaultApiId).toBe(api.id);

    // 存档：api 段脱敏、原文不含明文 Key
    const q = await jget(rig.base, '/api/questionnaire', userB.cookie);
    expect(q.questionnaire.api.apiId).toBe(api.id);
    expect(q.questionnaire.api.keyMasked).toBe('••••');
    expect(q.questionnaire.job).toBe('制片人');
    const rawRow = withDb(rig, (db) =>
      db.prepare('SELECT answers FROM questionnaire_responses WHERE workspace_id = ?').get(wsId),
    ) as any;
    expect(rawRow.answers).not.toContain('sk-secret-123');
    expect(rawRow.answers).not.toContain('apiKey');

    // 提醒字段进 dailySettings
    const ds = await jget(rig.base, '/api/daily-settings', userB.cookie);
    expect(ds.settings.checkinReminderEnabled).toBe(false);
    expect(ds.settings.checkinReminderTime).toBe('07:45');
    expect(ds.settings.briefingTime).toBe('08:15');
    expect(ds.settings.supervisionItems).toBe('盯紧上线节奏');
  });

  it('通用包 × 4 职能：四组齐全、人设带 job；空 uses 兜底通用组', async () => {
    const w = await jpost(
      rig.base,
      '/api/workspaces',
      {
        name: '通用问卷空间',
        questionnaire: { job: '教师', uses: ['内容生产', '日常办公', '学习研究', '运营推广'] },
      },
      userB.cookie,
    );
    expect(w.ok).toBe(true);
    const st = await jget(rig.base, '/api/state', userB.cookie);
    expect((st.teams as any[]).map((t) => t.name).sort()).toEqual(
      ['内容创作组', '办公助理组', '学习研究组', '运营推广组'].sort(),
    );
    const members = st.members as any[];
    expect(members).toHaveLength(16);
    const personas = withDb(rig, (db) =>
      db.prepare('SELECT persona FROM members WHERE workspace_id = ?').all(w.workspace.id),
    ) as any[];
    expect(personas).toHaveLength(16);
    expect(personas.every((m) => typeof m.persona === 'string' && m.persona.includes('教师'))).toBe(true);

    const w2 = await jpost(
      rig.base,
      '/api/workspaces',
      { name: '空问卷空间', questionnaire: { job: '', uses: [] } },
      userB.cookie,
    );
    expect(w2.ok).toBe(true);
    const st2 = await jget(rig.base, '/api/state', userB.cookie);
    expect((st2.teams as any[]).map((t) => t.name)).toEqual(['通用小组']);
    expect((st2.members as any[])).toHaveLength(5);
  });

  it('PUT questionnaire：只改存档、不重组团队、不碰 apis、忽略 apiKey', async () => {
    // 切回问卷短剧空间
    const list = await jget(rig.base, '/api/workspaces', userB.cookie);
    const drama = (list.workspaces as any[]).find((x) => x.name === '问卷短剧空间');
    expect(drama).toBeTruthy();
    await jpost(rig.base, '/api/auth/switch-workspace', { workspaceId: drama.id }, userB.cookie);
    const before = await jget(rig.base, '/api/state', userB.cookie);
    const memberCount = (before.members as any[]).length;
    const apiCount = (before.apis as any[]).length;

    const put = await jput(
      rig.base,
      '/api/questionnaire',
      { job: '导演', api: { provider: 'custom', baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: '<MASKED_SECRET_007>' } },
      userB.cookie,
    );
    expect(put.ok).toBe(true);
    expect(put.questionnaire.job).toBe('导演');

    const after = await jget(rig.base, '/api/state', userB.cookie);
    expect((after.members as any[])).toHaveLength(memberCount);
    expect((after.apis as any[])).toHaveLength(apiCount);
    const rawRow = withDb(rig, (db) =>
      db.prepare('SELECT answers FROM questionnaire_responses WHERE workspace_id = ?').get(drama.id),
    ) as any;
    expect(rawRow.answers).not.toContain('should-not-save');
  });
});

describe('补点：一期遗留', () => {
  it('管理员 pending 风格模板列表；非管理员 403', async () => {
    const cfg = {
      palette: { wall: '#111111', floor: '#222222', accent: '#333333' },
      floorPattern: 'tile',
      furniture: { sofa: 'linen', plantLeft: 'fern' },
      poster: { imageFileId: null },
      sign: { mode: 'text', text: '甲的办公室', imageFileId: null },
    };
    const created = await jpost(rig.base, '/api/style-templates', { name: '待审风格', config: cfg }, userA.cookie);
    expect(created.ok).toBe(true);
    const tplId = created.template.id as string;
    expect((await jpost(rig.base, `/api/style-templates/${tplId}/submit-review`, {}, userA.cookie)).ok).toBe(true);

    const pending = await jget(rig.base, '/api/admin/style-templates/pending', rig.adminCookie);
    expect(pending.ok).toBe(true);
    const found = (pending.templates as any[]).find((t) => t.id === tplId);
    expect(found).toBeTruthy();
    expect(found.visibility).toBe('pending_review');
    expect(found.contributorName).toBe('甲');
    expect(found.config).toBeTruthy();

    const forbidden = await raw(rig.base, '/api/admin/style-templates/pending', 'GET', userA.cookie);
    expect(forbidden.status).toBe(403);
  });

  it('GET /api/presets 含 tongyi / zhipu', async () => {
    const presets = await jget(rig.base, '/api/presets', userA.cookie);
    expect(presets.tongyi.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(presets.tongyi.model).toBe('qwen-plus');
    expect(presets.zhipu.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(presets.zhipu.model).toBe('glm-4-plus');
  });
});
