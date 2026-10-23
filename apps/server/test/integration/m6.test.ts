import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * M6 集成（多用户平台后端）：账号/会话/改密强制/锁定/吊销、越权矩阵（跨空间 404 + 零串数据）、
 * 注册表自定义工种端到端、行业包开空间、体验额度发放→消耗→耗尽、迁移对账（001/002 存量库）。
 */
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const MIGRATIONS = path.join(SERVER_DIR, 'src', 'store', 'migrations');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 40_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('waitFor 超时');
}

interface Client {
  cookie: string;
  req: (
    method: string,
    p: string,
    body?: unknown,
  ) => Promise<{ status: number; json: any; headers: Headers }>;
  get: (p: string) => Promise<{ status: number; json: any; headers: Headers }>;
  post: (p: string, body?: unknown) => Promise<{ status: number; json: any; headers: Headers }>;
  put: (p: string, body?: unknown) => Promise<{ status: number; json: any; headers: Headers }>;
  del: (p: string) => Promise<{ status: number; json: any; headers: Headers }>;
}

function makeClient(base: string): Client {
  const c: Client = {
    cookie: '',
    async req(method, p, body) {
      const r = await fetch(base + p, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(c.cookie ? { cookie: c.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = r.headers.get('set-cookie');
      if (sc && sc.includes('swarm_session=')) {
        const v = sc.split(';')[0];
        c.cookie = v.startsWith('swarm_session=') && v.length > 'swarm_session='.length ? v : c.cookie;
        if (v === 'swarm_session=') c.cookie = '';
      }
      let json: any = null;
      try {
        json = await r.json();
      } catch {
        /* 非 JSON 响应（如备份） */
      }
      return { status: r.status, json, headers: r.headers };
    },
    get: (p) => c.req('GET', p),
    post: (p, body) => c.req('POST', p, body ?? {}),
    put: (p, body) => c.req('PUT', p, body ?? {}),
    del: (p) => c.req('DELETE', p),
  };
  return c;
}

interface Rig {
  base: string;
  mockBase: string | null;
  procs: ChildProcess[];
  dataDir: string;
  admin: Client;
}

async function startServer(
  port: number,
  opts: { mockPort?: number; dataDir?: string } = {},
): Promise<Rig> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-m6-'));
  const procs: ChildProcess[] = [];
  let mockBase: string | null = null;
  if (opts.mockPort) {
    const mock = spawn('node', [MOCK], {
      env: { ...process.env, MOCK_PORT: String(opts.mockPort), MOCK_REVIEW_MODE: 'pass' },
      stdio: 'pipe',
      detached: true,
    });
    procs.push(mock);
    mockBase = `http://127.0.0.1:${opts.mockPort}`;
    expect(await waitUp(mockBase + '/__counts')).toBe(true);
  }
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      LLM_RETRY_BASE_MS: '10',
      SWARM_ADMIN_EMAIL: 'admin@test.local',
      SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_001>!',
    },
    stdio: 'pipe',
    detached: true,
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  procs.push(server);
  const base = `http://127.0.0.1:${port}`;
  expect(await waitUp(base + '/api/health')).toBe(true);
  const rig: Rig = { base, mockBase, procs, dataDir, admin: makeClient(base) };
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

/** 管理员登录 + 强制改密（种子管理员 must_change_password=1） */
async function loginAdmin(rig: Rig): Promise<void> {
  const r = await rig.admin.post('/api/auth/login', {
    email: 'admin@test.local',
    password: '<MASKED_SECRET_001>!',
  });
  expect(r.json.ok).toBe(true);
  expect(r.json.user.mustChangePassword).toBe(true);
  const cp = await rig.admin.post('/api/auth/change-password', {
    currentPassword: '<MASKED_SECRET_001>!',
    newPassword: '<MASKED_SECRET_002>!',
  });
  expect(cp.json.ok).toBe(true);
}

async function registerUser(
  rig: Rig,
  email: string,
  displayName: string,
): Promise<{ client: Client; res: any }> {
  const client = makeClient(rig.base);
  const res = await client.post('/api/auth/register', {
    email,
    password: '<MASKED_SECRET_003>!',
    displayName,
  });
  return { client, res: res.json };
}

describe('M6 Rig A：账号体系 + 越权矩阵 + 注册表/行业包/偏好', () => {
  it('全链路', async () => {
    const rig = await startServer(8891);
    try {
      const anon = makeClient(rig.base);
      /* 无会话一律 401 */
      const noAuth = await anon.get('/api/state');
      expect(noAuth.status).toBe(401);
      expect(noAuth.json.error.code).toBe('UNAUTHORIZED');

      /* 管理员：未改密前业务接口 403，改密后放行；默认空间为收编的「MJ 蜂群」 */
      const login = await rig.admin.post('/api/auth/login', {
        email: 'admin@test.local',
        password: '<MASKED_SECRET_001>!',
      });
      expect(login.json.ok).toBe(true);
      expect(login.json.user.isPlatformAdmin).toBe(true);
      const gated = await rig.admin.get('/api/state');
      expect(gated.status).toBe(403);
      expect(gated.json.error.code).toBe('FORBIDDEN');
      const badCp = await rig.admin.post('/api/auth/change-password', {
        currentPassword: 'wrong-password',
        newPassword: '<MASKED_SECRET_002>!',
      });
      expect(badCp.json.ok).toBe(false);
      const cp = await rig.admin.post('/api/auth/change-password', {
        currentPassword: '<MASKED_SECRET_001>!',
        newPassword: '<MASKED_SECRET_002>!',
      });
      expect(cp.json.ok).toBe(true);
      const adminState = (await rig.admin.get('/api/state')).json;
      expect(adminState.workspace).toEqual({ id: 'ws_default', name: 'MJ 蜂群' });
      expect(adminState.teams.length).toBe(1);
      expect(adminState.members.length).toBe(5);

      /* 注册用户 A（即时开通 + 通用种子零短剧字样） */
      const { client: clientA, res: regA } = await registerUser(rig, 'a@test.local', '用户A');
      expect(regA.ok).toBe(true);
      expect(regA.pending).toBe(false);
      const wsA = regA.workspace.id as string;
      const stateA = (await clientA.get('/api/state')).json;
      expect(stateA.teams).toHaveLength(1);
      expect(stateA.teams[0].name).toBe('通用小组');
      expect(stateA.members).toHaveLength(5);
      expect(JSON.stringify(stateA)).not.toContain('短剧');
      const registryA = (await clientA.get('/api/registry')).json;
      expect(registryA.roles.map((r: any) => r.roleId)).toEqual(
        expect.arrayContaining(['组长', '研究员', '文案', '程序员', '审核']),
      );
      expect(JSON.stringify(registryA)).not.toContain('短剧');

      /* A 在自己空间造数据：API / 任务 / 公司 KB / 个人 KB / 项目 */
      const teamA = stateA.teams[0].id as string;
      const apiSave = await clientA.post('/api/apis/save', {
        api: { name: 'A的API', provider: 'custom', baseUrl: 'http://127.0.0.1:9', model: 'm', pricePerM: 10, apiKey: 'sk-a-secret' },
      });
      expect(apiSave.json.ok).toBe(true);
      const apiA = apiSave.json.id as string;
      const taskA = await clientA.post('/api/tasks', {
        title: 'A的任务',
        type: '文案',
        brief: 'A专属',
        teamId: teamA,
      });
      expect(taskA.json.ok).toBe(true);
      const kbA = await clientA.post('/api/kb', { title: 'A公司资料', body: 'A公司内容', scope: 'company' });
      expect(kbA.json.ok).toBe(true);
      const kbPersonalA = await clientA.post('/api/kb', {
        title: 'A的个人秘籍ZZZ',
        body: '个人专属内容QQQ',
        scope: 'personal',
      });
      expect(kbPersonalA.json.ok).toBe(true);
      const memberA = stateA.members[0].id as string;
      const projA = await clientA.post('/api/projects', {
        name: 'A的项目',
        brief: 'b',
        teamId: teamA,
        clientName: '',
      });
      expect(projA.json.ok).toBe(true);

      /* 注册用户 B（即时开通） */
      const { client: clientB, res: regB } = await registerUser(rig, 'b@test.local', '用户B');
      expect(regB.pending).toBe(false);
      const wsB = regB.workspace.id as string;
      expect(wsB).not.toBe(wsA);

      /* —— 越权矩阵：B 会话直查 A 的 id 全部 404 —— */
      expect((await clientB.get(`/api/tasks/${taskA.json.id}`)).status).toBe(404);
      expect((await clientB.put(`/api/kb/${kbA.json.id}`, { title: 'x' })).status).toBe(404);
      expect((await clientB.del(`/api/kb/${kbA.json.id}`)).status).toBe(404);
      expect((await clientB.post(`/api/kb/from-task/${taskA.json.id}`)).json.error.code).toBe('NOT_FOUND');
      expect((await clientB.post('/api/members/delete', { id: memberA })).json.error.code).toBe('NOT_FOUND');
      expect((await clientB.post('/api/purchase', { apiId: apiA, amountYuan: 1 })).json.error.code).toBe('NOT_FOUND');
      expect((await clientB.post('/api/apis/delete', { id: apiA })).json.error.code).toBe('NOT_FOUND');
      const switchBad = await clientB.post('/api/auth/switch-workspace', { workspaceId: wsA });
      expect(switchBad.status).toBe(403);
      /* B 的 state / cost 零串数据 */
      const stateB = (await clientB.get('/api/state')).json;
      expect(stateB.tasks.map((t: any) => t.id)).not.toContain(taskA.json.id);
      expect(stateB.projects.map((p: any) => p.id)).not.toContain(projA.json.id);
      expect(stateB.apis.map((a: any) => a.id)).not.toContain(apiA);
      expect(stateB.ledger).toHaveLength(0);
      expect(JSON.stringify(stateB)).not.toContain('A的任务');
      const kbListB = (await clientB.get('/api/kb')).json;
      expect(kbListB.entries.map((e: any) => e.id)).not.toContain(kbA.json.id);
      expect(kbListB.entries.map((e: any) => e.id)).not.toContain(kbPersonalA.json.id);
      const reportB = (await clientB.get('/api/cost/report')).json.report;
      expect(reportB.totals.totalTokens).toBe(0);
      expect(reportB.byApi.map((a: any) => a.apiId)).not.toContain(apiA);
      /* 备份仅管理员：B 403；管理员 200 且注明整库范围 */
      expect((await clientB.get('/api/backup')).status).toBe(403);
      const bak = await fetch(rig.base + '/api/backup', { headers: { cookie: rig.admin.cookie } });
      expect(bak.status).toBe(200);
      expect(bak.headers.get('x-backup-scope')).toContain('full-database');
      await bak.arrayBuffer();

      /* —— 注册表：B 新增自定义工种/任务类型，A 不可见 —— */
      const roleB = await clientB.post('/api/registry/roles', {
        role: { name: '剪辑师', personaTemplate: '你是一名剪辑师。' },
      });
      expect(roleB.json.ok).toBe(true);
      const ttB = await clientB.post('/api/registry/task-types', {
        taskType: { name: '剪辑', roleId: '剪辑师' },
      });
      expect(ttB.json.ok).toBe(true);
      const registryB = (await clientB.get('/api/registry')).json;
      expect(registryB.roles.map((r: any) => r.roleId)).toContain('剪辑师');
      expect(registryB.taskTypes.map((t: any) => t.typeId)).toContain('剪辑');
      const registryA2 = (await clientA.get('/api/registry')).json;
      expect(registryA2.roles.map((r: any) => r.roleId)).not.toContain('剪辑师');

      /* —— 行业包：B 选短剧包建空间得三组 + 知识种子；包内任务类型可见 —— */
      const packs = (await clientB.get('/api/industry-packs')).json;
      expect(packs.packs.map((p: any) => p.id)).toContain('pack_short_drama');
      const wsDrama = await clientB.post('/api/workspaces', {
        name: 'B的短剧公司',
        industryPackId: 'pack_short_drama',
      });
      expect(wsDrama.json.ok).toBe(true);
      const stateDrama = (await clientB.get('/api/state')).json;
      expect(stateDrama.teams.map((t: any) => t.name)).toEqual(
        expect.arrayContaining(['短剧文案组', '选题调研组', '审片组']),
      );
      const kbDrama = (await clientB.get('/api/kb')).json;
      expect(kbDrama.entries.map((e: any) => e.title)).toEqual(
        expect.arrayContaining(['示例：标题方法论', '示例：频道定位样例', '示例：卖点复盘样例']),
      );
      const registryDrama = (await clientB.get('/api/registry')).json;
      expect(registryDrama.taskTypes.map((t: any) => t.typeId)).toContain('短剧文案');

      /* —— 个人偏好按用户隔离 —— */
      await clientB.put('/api/preferences', { key: 'personalPrompt', value: '偏好X' });
      expect((await clientB.get('/api/preferences')).json.preferences.personalPrompt).toBe('偏好X');
      expect((await clientA.get('/api/preferences')).json.preferences.personalPrompt).toBeUndefined();

      /* —— 登录锁定：用户 C 连错 5 次锁定，正确密码也被拒 —— */
      const { res: regC } = await registerUser(rig, 'c@test.local', '用户C');
      expect(regC.pending).toBe(false);
      const loginC = makeClient(rig.base);
      let lastFail: any = null;
      for (let i = 0; i < 5; i++) {
        lastFail = await loginC.post('/api/auth/login', { email: 'c@test.local', password: '<MASKED_SECRET_004>' });
      }
      expect(lastFail.json.error.code).toBe('ACCOUNT_LOCKED');
      const lockedLogin = await loginC.post('/api/auth/login', {
        email: 'c@test.local',
        password: '<MASKED_SECRET_003>!',
      });
      expect(lockedLogin.json.error.code).toBe('ACCOUNT_LOCKED');

      /* —— 同 IP 短时第 4 次注册命中风控 → pending；管理员通过后开通 —— */
      const { client: clientD, res: regD } = await registerUser(rig, 'd@test.local', '用户D');
      expect(regD.pending).toBe(true);
      const loginD0 = await makeClient(rig.base).post('/api/auth/login', {
        email: 'd@test.local',
        password: '<MASKED_SECRET_003>!',
      });
      expect(loginD0.status).toBe(403);
      const userDId = regD.user.id as string;
      const approve = await rig.admin.post(`/api/admin/users/${userDId}/approve`);
      expect(approve.json.ok).toBe(true);
      const loginD = await clientD.post('/api/auth/login', {
        email: 'd@test.local',
        password: '<MASKED_SECRET_003>!',
      });
      expect(loginD.json.ok).toBe(true);
      expect((await clientD.get('/api/state')).json.teams.length).toBeGreaterThan(0);

      /* —— 登出吊销：登出后旧 Cookie 401 —— */
      expect((await clientD.post('/api/auth/logout')).json.ok).toBe(true);
      expect((await clientD.get('/api/auth/me')).status).toBe(401);

      /* —— 管理员停用即时吊销全部会话 —— */
      const loginD2 = await clientD.post('/api/auth/login', {
        email: 'd@test.local',
        password: '<MASKED_SECRET_003>!',
      });
      expect(loginD2.json.ok).toBe(true);
      expect((await clientD.get('/api/auth/me')).status).toBe(200);
      expect((await rig.admin.post(`/api/admin/users/${userDId}/disable`)).json.ok).toBe(true);
      expect((await clientD.get('/api/auth/me')).status).toBe(401);
      const loginD3 = await makeClient(rig.base).post('/api/auth/login', {
        email: 'd@test.local',
        password: '<MASKED_SECRET_003>!',
      });
      expect(loginD3.status).toBe(403);

      /* —— 管理员重置密码：临时密码登录触发强制改密，改密后放行 —— */
      const { client: clientE, res: regE } = await registerUser(rig, 'e@test.local', '用户E');
      expect(regE.pending).toBe(true); // 同 IP 风控继续命中
      await rig.admin.post(`/api/admin/users/${regE.user.id}/approve`);
      const reset = await rig.admin.post(`/api/admin/users/${regE.user.id}/reset-password`);
      expect(reset.json.ok).toBe(true);
      expect(typeof reset.json.temporaryPassword).toBe('string');
      const loginE = await clientE.post('/api/auth/login', {
        email: 'e@test.local',
        password: reset.json.temporaryPassword,
      });
      expect(loginE.json.ok).toBe(true);
      expect(loginE.json.user.mustChangePassword).toBe(true);
      expect((await clientE.get('/api/state')).status).toBe(403);
      const cpE = await clientE.post('/api/auth/change-password', {
        currentPassword: reset.json.temporaryPassword,
        newPassword: '<MASKED_SECRET_005>!',
      });
      expect(cpE.json.ok).toBe(true);
      expect((await clientE.get('/api/state')).status).toBe(200);
    } finally {
      stopRig(rig);
    }
  });
});

describe('M6 Rig B：体验额度 + 注册表端到端 + 个人 KB 注入隔离（mock）', () => {
  it('体验额度发放→消耗→耗尽停工；自定义工种跑通一单；个人 KB 不被他人任务注入', async () => {
    const rig = await startServer(8892, { mockPort: 8902 });
    try {
      await loginAdmin(rig);
      const mockBase = rig.mockBase!;

      /* 平台体验 API（管理员维护，平台级行） */
      const trialSave = await rig.admin.post('/api/admin/trial-api', {
        api: {
          name: '平台体验',
          provider: 'custom',
          baseUrl: mockBase,
          model: 'mock-model',
          pricePerM: 10,
          apiKey: 'trial-key-1',
        },
      });
      expect(trialSave.json.ok).toBe(true);
      const trialApiId = trialSave.json.id as string;
      const trialInfo = (await rig.admin.get('/api/admin/trial-api')).json;
      expect(trialInfo.api.hasKey).toBe(true);
      expect(trialInfo.api.apiKeyMasked).not.toContain('trial-key-1');

      /* 新用户 T：无自备 API，靠体验额度跑第一单 */
      const { client: clientT, res: regT } = await registerUser(rig, 't@test.local', '体验用户');
      expect(regT.pending).toBe(false);
      const wsT = regT.workspace.id as string;
      const stateT0 = (await clientT.get('/api/state')).json;
      expect(stateT0.apis).toHaveLength(0);
      const teamT = stateT0.teams[0].id as string;

      const grant = await rig.admin.post('/api/admin/trial-grants', {
        workspaceId: wsT,
        amountYuan: 0.003,
      });
      expect(grant.json.ok).toBe(true);
      expect(grant.json.trialRemainingYuan).toBeCloseTo(0.003, 9);

      const task1 = await clientT.post('/api/tasks', {
        title: '体验第一单',
        type: '文案',
        brief: '用体验额度跑',
        teamId: teamT,
      });
      expect(task1.json.ok).toBe(true);
      const done1 = await waitFor(async () => {
        const st = (await clientT.get('/api/state')).json;
        const t = st.tasks.find((x: any) => x.id === task1.json.id);
        return t && t.status === '已完成' ? t : null;
      });
      expect(done1.totalTokens).toBe(300);
      const stateT1 = (await clientT.get('/api/state')).json;
      const trialLedger = stateT1.ledger.filter((l: any) => l.apiId === trialApiId);
      expect(trialLedger).toHaveLength(2);
      expect(stateT1.purchases.some((p: any) => p.type === 'trial_grant')).toBe(true);

      /* 耗尽（0.003 发放 − 0.004 消耗 < 0）：第二单停工且文案明确 */
      const task2 = await clientT.post('/api/tasks', {
        title: '体验第二单',
        type: '文案',
        brief: '额度已空',
        teamId: teamT,
      });
      const blocked2 = await waitFor(async () => {
        const st = (await clientT.get('/api/state')).json;
        const t = st.tasks.find((x: any) => x.id === task2.json.id);
        return t && t.blockedCode ? t : null;
      });
      expect(blocked2.blockedCode).toBe('INSUFFICIENT_BALANCE');
      expect(blocked2.blockedReason).toBe('体验额度已用完，请到设置后台填自己的 API Key');

      /* 管理员聚合视图可见发放与消耗 */
      const adminWs = (await rig.admin.get('/api/admin/workspaces')).json;
      const wsRow = adminWs.workspaces.find((w: any) => w.id === wsT);
      expect(wsRow.trialGrantedYuan).toBeCloseTo(0.003, 9);
      expect(wsRow.trialRemainingYuan).toBeLessThanOrEqual(0);
      expect(wsRow.taskCount).toBe(2);

      /* —— 注册表端到端：默认空间新增自定义工种并跑通一单（mock） —— */
      const stAdmin = (await rig.admin.get('/api/state')).json;
      const apiAdmin = stAdmin.apis[0].id as string;
      const teamAdmin = stAdmin.teams[0].id as string;
      await rig.admin.post('/api/apis/save', {
        api: {
          id: apiAdmin,
          name: 'Mock API',
          provider: 'custom',
          baseUrl: mockBase,
          model: 'mock-model',
          pricePerM: 10,
          apiKey: 'fake-key-123',
        },
      });
      await rig.admin.post('/api/purchase', { apiId: apiAdmin, amountYuan: 100 });
      await rig.admin.post('/api/teams/save', {
        team: { id: teamAdmin, name: '第一小组', color: '#e2574c', apiId: apiAdmin },
      });
      expect(
        (await rig.admin.post('/api/registry/roles', { role: { name: '剪辑师', personaTemplate: '你是一名剪辑师，擅长节奏与转场。' } })).json.ok,
      ).toBe(true);
      expect(
        (await rig.admin.post('/api/registry/task-types', { taskType: { name: '剪辑', roleId: '剪辑师' } })).json.ok,
      ).toBe(true);
      const cutter = await rig.admin.post('/api/members/save', {
        member: { name: '小剪', role: '剪辑师', teamId: teamAdmin, prompt: '' },
      });
      expect(cutter.json.ok).toBe(true);
      const cutTask = await rig.admin.post('/api/tasks', {
        title: '剪辑一单',
        type: '剪辑',
        brief: '剪出节奏感',
        teamId: teamAdmin,
      });
      expect(cutTask.json.ok).toBe(true);
      const cutDone = await waitFor(async () => {
        const st = (await rig.admin.get('/api/state')).json;
        const t = st.tasks.find((x: any) => x.id === cutTask.json.id);
        return t && t.status === '已完成' ? t : null;
      });
      expect(cutDone.assigneeId).toBe(cutter.json.id);

      /* —— 个人 KB 注入隔离：管理员个人条目只注入管理员自己的任务 —— */
      const kbPersonal = await rig.admin.post('/api/kb', {
        title: '个人钩子秘籍',
        body: '个人专属钩子内容PPP，命中钩子时注入',
        scope: 'personal',
      });
      expect(kbPersonal.json.ok).toBe(true);
      const ownTask = await rig.admin.post('/api/tasks', {
        title: '给钩子写文案',
        type: '文案',
        brief: '需要钩子',
        teamId: teamAdmin,
      });
      const ownDone = await waitFor(async () => {
        const st = (await rig.admin.get('/api/state')).json;
        const t = st.tasks.find((x: any) => x.id === ownTask.json.id);
        return t && t.status === '已完成' ? t : null;
      });
      expect(ownDone.injectedKbIds).toContain(kbPersonal.json.id);

      /* 第二个用户 U 经 DB 直加 membership 加入默认空间（OPC 预留路径），其会话下个人条目不可见且不被注入 */
      const { client: clientU, res: regU } = await registerUser(rig, 'u@test.local', '用户U');
      expect(regU.pending).toBe(false);
      const db = new DatabaseSync(path.join(rig.dataDir, 'swarm.db'));
      db.prepare(
        "INSERT INTO memberships (user_id, workspace_id, role, status, joined_at) VALUES (?, 'ws_default', 'member', 'active', ?)",
      ).run(regU.user.id, new Date().toISOString());
      db.close();
      const switched = await clientU.post('/api/auth/switch-workspace', { workspaceId: 'ws_default' });
      expect(switched.json.ok).toBe(true);
      const kbListU = (await clientU.get('/api/kb')).json;
      expect(kbListU.entries.map((e: any) => e.id)).not.toContain(kbPersonal.json.id);
      const uTask = await clientU.post('/api/tasks', {
        title: '钩子文案来一份',
        type: '文案',
        brief: '同样需要钩子',
        teamId: teamAdmin,
      });
      expect(uTask.json.ok).toBe(true);
      const uDone = await waitFor(async () => {
        const st = (await clientU.get('/api/state')).json;
        const t = st.tasks.find((x: any) => x.id === uTask.json.id);
        return t && t.status === '已完成' ? t : null;
      });
      expect(uDone.injectedKbIds).not.toContain(kbPersonal.json.id);
    } finally {
      stopRig(rig);
    }
  });
});

describe('M6 Rig C：迁移对账（001/002 存量库 → 新迁移回填默认空间）', () => {
  it('存量 API/成员/账本/采购/设置逐项一致且全部落 ws_default', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-m6-legacy-'));
    /* 构造只应用 001/002 的存量库并种入已知数据 */
    const dbPath = path.join(dataDir, 'swarm.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const f of ['001_init.sql', '002_kb.sql']) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        f.replace(/\.sql$/, ''),
        '2026-10-23T00:00:00.000Z',
      );
    }
    const ts = '2026-10-20T00:00:00.000Z';
    db.prepare(
      'INSERT INTO apis (id, name, provider, base_url, api_key_enc, model, price_per_m_milli, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run('api_legacy', '存量API', 'custom', 'http://127.0.0.1:9', '', 'm1', 10_000, ts);
    db.prepare(
      'INSERT INTO teams (id, name, color, api_id, created_at, deleted_at) VALUES (?,?,?,?,?,NULL)',
    ).run('team_legacy', '存量小组', '#000000', null, ts);
    db.prepare(
      'INSERT INTO members (id, team_id, name, role, persona, prompt, skill_tags, color) VALUES (?,?,?,?,?,?,?,?)',
    ).run('mem_legacy', 'team_legacy', '存量成员', '文案', '人设', '', '[]', '');
    db.prepare('INSERT INTO purchases (api_id, amount_milli, created_at) VALUES (?,?,?)').run(
      'api_legacy',
      100_000,
      ts,
    );
    db.prepare(
      `INSERT INTO ledger_entries (task_id, team_id, api_id, stage, prompt_tokens, completion_tokens, total_tokens, cost_milli, estimated, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('task_legacy', 'team_legacy', 'api_legacy', '执行', 100, 50, 150, 2, 0, ts);
    db.prepare(
      `INSERT INTO ledger_entries (task_id, team_id, api_id, stage, prompt_tokens, completion_tokens, total_tokens, cost_milli, estimated, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('task_legacy', 'team_legacy', 'api_legacy', '审核', 100, 50, 150, 1, 0, ts);
    db.prepare(
      `INSERT INTO tasks (id, project_id, team_id, assignee_id, title, type, brief, status, result, review_note,
        reject_reason, reject_count, blocked_reason, blocked_code, adjudicated, idempotency_key, total_tokens,
        total_cost_milli, heartbeat_at, injected_kb_ids, created_at, claimed_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'task_legacy', null, 'team_legacy', 'mem_legacy', '存量任务', '文案', 'b', '已完成', '成果', '',
      '', 0, '', null, 0, null, 300, 3, null, '[]', ts, ts, ts,
    );
    db.prepare(
      'INSERT INTO kb_entries (id, title, body, scope, scope_id, tags, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('kb_legacy', '存量资料', '存量内容', 'company', null, '[]', 1, ts, ts);
    const setOld = db.prepare('INSERT INTO settings (key, value) VALUES (?,?)');
    setOld.run('defaultApiId', JSON.stringify('api_legacy'));
    setOld.run('params', JSON.stringify({ concurrency: 4, taskBudgetTokens: 0 }));
    setOld.run('reviewStandards', JSON.stringify({ points: '标题必须带数字', clientNeeds: '甲方X' }));
    db.close();

    const rig = await startServer(8894, { dataDir });
    try {
      await loginAdmin(rig);
      const st = (await rig.admin.get('/api/state')).json;
      expect(st.workspace.id).toBe('ws_default');
      const api = st.apis.find((a: any) => a.id === 'api_legacy');
      expect(api).toBeTruthy();
      // 余额推导一致：100000 厘采购 − (2+1) 厘账本 = 99997 厘 = 99.997 元
      expect(Math.abs(api.balanceYuan - 99.997)).toBeLessThan(1e-9);
      expect(st.members.map((m: any) => m.id)).toContain('mem_legacy');
      expect(st.teams.map((t: any) => t.id)).toContain('team_legacy');
      expect(st.tasks).toHaveLength(1);
      expect(st.ledger).toHaveLength(2);
      expect(st.purchases.reduce((s: number, p: any) => s + p.amountYuan, 0)).toBe(100);
      expect(st.reviewStandards.points).toBe('标题必须带数字');
      const kb = (await rig.admin.get('/api/kb')).json;
      expect(kb.entries.map((e: any) => e.id)).toContain('kb_legacy');

      /* DB 直查：回填与新表落位 */
      const db2 = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const cnt = (sql: string) => (db2.prepare(sql).get() as { c: number }).c;
        expect(cnt("SELECT COUNT(*) AS c FROM tasks WHERE workspace_id='ws_default'")).toBe(1);
        expect(cnt("SELECT COUNT(*) AS c FROM ledger_entries WHERE workspace_id='ws_default'")).toBe(2);
        expect(cnt("SELECT COUNT(*) AS c FROM purchases WHERE workspace_id='ws_default' AND type='purchase'")).toBe(1);
        expect(cnt("SELECT COUNT(*) AS c FROM settings WHERE workspace_id='ws_default'")).toBe(3);
        expect(cnt("SELECT COUNT(*) AS c FROM workspaces WHERE id='ws_default'")).toBe(1);
        expect(cnt("SELECT COUNT(*) AS c FROM users WHERE is_platform_admin=1")).toBe(1);
        expect(cnt('SELECT COUNT(*) AS c FROM roles')).toBe(5);
        expect(cnt('SELECT COUNT(*) AS c FROM task_types WHERE pack_id IS NULL')).toBe(3);
        expect(cnt("SELECT COUNT(*) AS c FROM industry_packs WHERE industry='short_drama'")).toBe(1);
      } finally {
        db2.close();
      }
    } finally {
      stopRig(rig);
    }
  });
});
