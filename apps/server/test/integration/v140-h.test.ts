import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveOwnApiId, resolveOwnApiRow } from '../../src/domain/apiResolve';
import { createProject } from '../../src/domain/projectService';
import { dispatchBlockReason } from '../../src/domain/scheduleService';
import type { LlmGateway } from '../../src/llm/gateway';
import type { Logger } from '../../src/logger';
import { openDb } from '../../src/store/db';
import { encryptKey } from '../../src/store/crypto';
import { Repos } from '../../src/store/repositories';

/**
 * v1.4.0 H（成员级 API 绑定）集成测试：
 * - 进程内：统一解析优先级（成员 > 小组 > 默认）、成员悬空下行、小组悬空回 null 的现行语义、
 *   无成员上下文回退旧链、teamId 缺省取成员 team_id、跨空间成员/API 不串、
 *   schedule 预检口径不变、projectService 拆单以组长成员绑定为准、clearApiBindings 按空间清理。
 * - HTTP：members/save 的 apiId DTO 往返（绑定 → state/capabilities 可见；null 清除；省略不改；
 *   跨空间 API 绑定被拒）、删 API 后 teams/members 绑定清理 + defaultApiId 改指与回退。
 */
const SERVER_DIR = process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TS = '2026-10-25T00:00:00.000Z';

/* ================= 进程内 ================= */

function setupRepos(): Repos {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-h-unit-'));
  return new Repos(openDb(path.join(dir, 't.db')));
}

function seedResolveRepos(): Repos {
  const repos = setupRepos();
  const mkApi = (id: string, ws: string, model: string) =>
    repos.insertApi({
      id,
      name: id,
      provider: 'custom',
      base_url: 'http://127.0.0.1:9',
      api_key_enc: encryptKey('sk-test'),
      model,
      price_per_m_milli: 1000,
      created_at: TS,
      workspace_id: ws,
      is_trial: 0,
    });
  mkApi('api_member', 'ws_h', 'member-model');
  mkApi('api_team', 'ws_h', 'team-model');
  mkApi('api_default', 'ws_h', 'default-model');
  mkApi('api_other', 'ws_other', 'other-model');
  repos.setSetting('defaultApiId', 'api_default', 'ws_h');
  repos.setSetting('defaultApiId', 'api_other', 'ws_other');

  const mkTeam = (id: string, ws: string, apiId: string | null) =>
    repos.insertTeam({
      id,
      name: id,
      color: '#000',
      api_id: apiId,
      created_at: TS,
      deleted_at: null,
      workspace_id: ws,
    });
  mkTeam('team_h', 'ws_h', 'api_team');
  mkTeam('team_plain', 'ws_h', null);
  mkTeam('team_dangling', 'ws_h', 'api_gone');
  mkTeam('team_other', 'ws_other', null);

  const mkMember = (id: string, ws: string, teamId: string, apiId: string | null, role = '文案') =>
    repos.insertMember({
      id,
      team_id: teamId,
      name: id,
      role,
      persona: `${id}人设`,
      prompt: '',
      skill_tags: '[]',
      color: '',
      workspace_id: ws,
      api_id: apiId,
    });
  mkMember('m_bound', 'ws_h', 'team_h', 'api_member');
  mkMember('m_unbound', 'ws_h', 'team_h', null);
  mkMember('m_dangling', 'ws_h', 'team_h', 'api_gone_member');
  mkMember('m_dangling_plain', 'ws_h', 'team_plain', 'api_gone_member');
  mkMember('m_plain', 'ws_h', 'team_plain', null);
  mkMember('m_in_dangling_team', 'ws_h', 'team_dangling', null);
  mkMember('m_bound_in_dangling_team', 'ws_h', 'team_dangling', 'api_member');
  // api_id 指向他空间的 API 行：本空间查无此行 → 等同悬空
  mkMember('m_cross_api', 'ws_h', 'team_plain', 'api_other');
  mkMember('m_other', 'ws_other', 'team_other', 'api_other');

  // schedule 预检用的余额（组绑定与默认两支都可用）
  repos.insertPurchase('api_team', 100_000, 'ws_h', 'purchase');
  repos.insertPurchase('api_default', 100_000, 'ws_h', 'purchase');
  return repos;
}

describe('H 进程内：resolveOwnApiRow/Id 优先级与悬空语义', () => {
  it('成员 > 小组 > 默认；行与 id 两路同口径', () => {
    const repos = seedResolveRepos();
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_bound', teamId: 'team_h' })?.id).toBe('api_member');
    expect(resolveOwnApiId(repos, 'ws_h', { memberId: 'm_bound', teamId: 'team_h' })).toBe('api_member');
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_unbound', teamId: 'team_h' })?.id).toBe('api_team');
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_plain', teamId: 'team_plain' })?.id).toBe('api_default');
  });

  it('成员悬空下行：退小组、小组无绑定退默认（不阻塞）', () => {
    const repos = seedResolveRepos();
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_dangling', teamId: 'team_h' })?.id).toBe('api_team');
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_dangling_plain', teamId: 'team_plain' })?.id).toBe(
      'api_default',
    );
  });

  it('无成员上下文回退旧链：小组 → 默认；teamId 缺省时取成员 team_id', () => {
    const repos = seedResolveRepos();
    expect(resolveOwnApiRow(repos, 'ws_h', { teamId: 'team_h' })?.id).toBe('api_team');
    expect(resolveOwnApiRow(repos, 'ws_h', { teamId: 'team_plain' })?.id).toBe('api_default');
    expect(resolveOwnApiRow(repos, 'ws_h', {})?.id).toBe('api_default');
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_unbound' })?.id).toBe('api_team');
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_plain' })?.id).toBe('api_default');
  });

  it('小组悬空仍回 null（现行语义，不下行到默认）；成员绑定可越过小组悬空', () => {
    const repos = seedResolveRepos();
    expect(resolveOwnApiRow(repos, 'ws_h', { teamId: 'team_dangling' })).toBeNull();
    expect(resolveOwnApiId(repos, 'ws_h', { teamId: 'team_dangling' })).toBeNull();
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_in_dangling_team', teamId: 'team_dangling' })).toBeNull();
    expect(
      resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_bound_in_dangling_team', teamId: 'team_dangling' })?.id,
    ).toBe('api_member');
  });

  it('跨空间不串：他空间成员被跳过；成员 api_id 指向他空间 API 视为悬空下行', () => {
    const repos = seedResolveRepos();
    // m_other 属 ws_other：以 ws_h 解析时跳过成员级（其 team_other 也不采信）→ ws_h 默认
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_other' })?.id).toBe('api_default');
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_other', teamId: 'team_plain' })?.id).toBe('api_default');
    // 本空间成员绑了他空间的 API id → 本空间查无 → 下行到默认
    expect(resolveOwnApiRow(repos, 'ws_h', { memberId: 'm_cross_api', teamId: 'team_plain' })?.id).toBe(
      'api_default',
    );
    // 反向：ws_other 内解析自己的成员正常命中
    expect(resolveOwnApiRow(repos, 'ws_other', { memberId: 'm_other' })?.id).toBe('api_other');
  });

  it('dispatchBlockReason 口径不变：小组可用 → 放行；小组悬空 → NO_API（不退默认/体验）', () => {
    const repos = seedResolveRepos();
    expect(dispatchBlockReason(repos, 'ws_h', 'team_h')).toBeNull();
    expect(dispatchBlockReason(repos, 'ws_h', 'team_plain')).toBeNull();
    const blocked = dispatchBlockReason(repos, 'ws_h', 'team_dangling');
    expect(blocked?.code).toBe('NO_API');
  });

  it('clearApiBindings：只清本空间的小组/成员绑定，他空间同 id 引用不动', () => {
    const repos = seedResolveRepos();
    repos.clearApiBindings('api_team', 'ws_h');
    expect(repos.getTeam('team_h', 'ws_h')?.api_id).toBeNull();
    repos.clearApiBindings('api_other', 'ws_h');
    // ws_h 内 m_cross_api 的（悬空）绑定被清；ws_other 的成员/默认不受影响
    expect(repos.getMember('m_cross_api', 'ws_h')?.api_id).toBeNull();
    expect(repos.getMember('m_other', 'ws_other')?.api_id).toBe('api_other');
  });
});

describe('H 进程内：projectService 拆单以组长成员绑定为准', () => {
  it('组长绑成员级 API 时，拆单调用用成员 API（越过小组/默认）', async () => {
    const repos = seedResolveRepos();
    repos.insertMember({
      id: 'leader_bound',
      team_id: 'team_plain',
      name: '组长甲',
      role: '组长',
      persona: '组长人设',
      prompt: '',
      skill_tags: '[]',
      color: '',
      workspace_id: 'ws_h',
      api_id: 'api_member',
    });
    repos.insertPurchase('api_member', 100_000, 'ws_h', 'purchase');
    let capturedApiId: string | null = null;
    const fakeGateway = {
      call: async (params: { api: { id: string } }) => {
        capturedApiId = params.api.id;
        return { text: '[]' };
      },
    } as unknown as LlmGateway;
    const stubLogger = { info() {}, warn() {}, error() {} } as unknown as Logger;
    const out = await createProject(repos, fakeGateway, stubLogger, {
      name: '拆单测试方案',
      brief: '简报',
      teamId: 'team_plain',
      clientName: '',
      workspaceId: 'ws_h',
    });
    expect(capturedApiId).toBe('api_member');
    expect(out.taskIds).toHaveLength(1); // '[]' 解析为空 → 兜底单子任务
  });
});

/* ================= HTTP 黑盒 ================= */

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

async function startRig(serverPort: number): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-h-'));
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
  const rig: Rig = { base: `http://127.0.0.1:${serverPort}`, procs: [server], dataDir, adminCookie: '' };
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
  p: string,
  body: unknown,
  cookie: string,
): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body ?? {}),
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
  rig = await startRig(9031);
  userA = await registerUser(rig.base, 'h-a@test.local', '甲', '甲空间H');
  userB = await registerUser(rig.base, 'h-b@test.local', '乙', '乙空间H');
}, 60_000);

afterAll(() => {
  if (rig) stopRig(rig);
});

async function saveApiFor(cookie: string, name: string, model: string): Promise<string> {
  const j = await jpost(
    rig.base,
    '/api/apis/save',
    { api: { name, provider: 'custom', baseUrl: 'http://127.0.0.1:9', model, pricePerM: 1, apiKey: 'sk-http' } },
    cookie,
  );
  expect(j.ok).toBe(true);
  return j.id as string;
}
async function stateOf(cookie: string): Promise<any> {
  const st = await jget(rig.base, '/api/state', cookie);
  expect(st.ok ?? true).toBeTruthy();
  return st;
}

describe('H HTTP：members/save apiId DTO 往返', () => {
  it('绑定 → state/capabilities 可见；省略 apiId 不改；null 清除；跨空间 API 绑定被拒', async () => {
    const apiA1 = await saveApiFor(userA.cookie, '甲一号', 'model-a1');
    const apiA2 = await saveApiFor(userA.cookie, '甲二号', 'model-a2');
    const apiB1 = await saveApiFor(userB.cookie, '乙一号', 'model-b1');

    const st0 = await stateOf(userA.cookie);
    const member = (st0.members as any[])[0];
    expect(member).toBeTruthy();
    expect(member.apiId).toBeNull();

    const save = (patch: Record<string, unknown>) =>
      jpost(
        rig.base,
        '/api/members/save',
        {
          member: {
            id: member.id,
            name: member.name,
            role: member.role,
            teamId: member.teamId,
            prompt: member.prompt ?? '',
            ...patch,
          },
        },
        userA.cookie,
      );

    // 绑定 apiA2 → state.members 与 capabilities.members 都带 apiId
    expect((await save({ apiId: apiA2 })).ok).toBe(true);
    const st1 = await stateOf(userA.cookie);
    expect((st1.members as any[]).find((m) => m.id === member.id).apiId).toBe(apiA2);
    expect((st1.capabilities.members as any[]).find((m) => m.memberId === member.id).apiId).toBe(apiA2);
    // 工种不变 → 人设保留（DB 直查 persona 非空且未被重置为空）
    const personaRow = withDb(rig, (db) =>
      db.prepare('SELECT persona FROM members WHERE id = ?').get(member.id),
    ) as any;
    expect(typeof personaRow.persona).toBe('string');
    expect(personaRow.persona.length).toBeGreaterThan(0);

    // 省略 apiId（undefined）→ 不改
    expect((await save({ name: '改名甲' })).ok).toBe(true);
    const st2 = await stateOf(userA.cookie);
    const renamed = (st2.members as any[]).find((m) => m.id === member.id);
    expect(renamed.name).toBe('改名甲');
    expect(renamed.apiId).toBe(apiA2);

    // 跨空间 API（乙空间的 apiB1）→ 拒绝，绑定不变
    const cross = await raw(rig.base, '/api/members/save', {
      member: {
        id: member.id,
        name: '改名甲',
        role: member.role,
        teamId: member.teamId,
        prompt: '',
        apiId: apiB1,
      },
    }, userA.cookie);
    expect(cross.status).toBe(400);
    const st3 = await stateOf(userA.cookie);
    expect((st3.members as any[]).find((m) => m.id === member.id).apiId).toBe(apiA2);

    // null → 清除
    expect((await save({ name: '改名甲', apiId: null })).ok).toBe(true);
    const st4 = await stateOf(userA.cookie);
    expect((st4.members as any[]).find((m) => m.id === member.id).apiId).toBeNull();
    expect((st4.capabilities.members as any[]).find((m) => m.memberId === member.id).apiId).toBeNull();

    void apiA1;
  });
});

describe('H HTTP：删 API 后绑定清理与回退', () => {
  it('删被绑 API：teams/members 绑定置空、defaultApiId 改指剩余第一支、解析回退到新默认', async () => {
    const st0 = await stateOf(userA.cookie);
    const apis = st0.apis as any[];
    expect(apis.length).toBeGreaterThanOrEqual(2);
    const doomed = apis[0];
    const survivor = apis[1];
    const team = (st0.teams as any[])[0];
    const member = (st0.members as any[])[0];

    // 小组与成员都绑到 doomed，并把 doomed 设为空间默认
    expect(
      (await jpost(rig.base, '/api/teams/save', {
        team: { id: team.id, name: team.name, color: team.color, apiId: doomed.id },
      }, userA.cookie)).ok,
    ).toBe(true);
    expect(
      (await jpost(rig.base, '/api/members/save', {
        member: {
          id: member.id,
          name: member.name,
          role: member.role,
          teamId: member.teamId,
          prompt: member.prompt ?? '',
          apiId: doomed.id,
        },
      }, userA.cookie)).ok,
    ).toBe(true);
    expect(
      (await jpost(rig.base, '/api/settings/default-api', { apiId: doomed.id }, userA.cookie)).ok,
    ).toBe(true);
    const stBound = await stateOf(userA.cookie);
    expect(stBound.defaultApiId).toBe(doomed.id);
    expect((stBound.teams as any[]).find((t) => t.id === team.id).apiId).toBe(doomed.id);
    expect((stBound.members as any[]).find((m) => m.id === member.id).apiId).toBe(doomed.id);

    // 删除 doomed
    expect((await jpost(rig.base, '/api/apis/delete', { id: doomed.id }, userA.cookie)).ok).toBe(true);

    const st1 = await stateOf(userA.cookie);
    expect((st1.apis as any[]).some((a) => a.id === doomed.id)).toBe(false);
    // 绑定清理：小组/成员 apiId 置空（不靠悬空）
    expect((st1.teams as any[]).find((t) => t.id === team.id).apiId).toBeNull();
    expect((st1.members as any[]).find((m) => m.id === member.id).apiId).toBeNull();
    const dbRows = withDb(rig, (db) => ({
      team: db.prepare('SELECT api_id FROM teams WHERE id = ?').get(team.id) as any,
      member: db.prepare('SELECT api_id FROM members WHERE id = ?').get(member.id) as any,
    }));
    expect(dbRows.team.api_id).toBeNull();
    expect(dbRows.member.api_id).toBeNull();
    // defaultApiId 改指剩余第一支（先例口径）
    expect(st1.defaultApiId).toBe(survivor.id);
    expect(st1.defaultApiId).toBe((st1.apis as any[])[0].id);
  });
});
