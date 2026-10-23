import { spawn, type ChildProcess} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it} from 'vitest';

/**
* 知识库一期集成（设计 §10/§13 M3）：起 mock-llm + server（临时 DATA_DIR）——
* KB CRUD → 发单 → 断言 mock 侧收到的执行 prompt 确实含注入内容（/__requests 回显）→
* 任务 injectedKbIds 落库（/api/state 与任务详情双通道）→ 成果回流生成条目。
*/
const SERVER_DIR = process.cwd(); // apps/server
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
base: string;
mockBase: string;
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

async function startRig(): Promise<Rig> {
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-kb-'));
const mock = spawn('node', [MOCK], {
env: {...process.env, MOCK_PORT: '8881', MOCK_REVIEW_MODE: 'pass'},
stdio: 'pipe',
detached: true,
});
const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
cwd: SERVER_DIR,
env: {...process.env, PORT: '8871', DATA_DIR: dataDir, LLM_RETRY_BASE_MS: '10', SWARM_ADMIN_EMAIL: 'admin@test.local', SWARM_ADMIN_PASSWORD: '<MASKED_SECRET_001>!'},
stdio: 'pipe',
detached: true,
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
const rig: Rig = { base: 'http://127.0.0.1:8871', mockBase: 'http://127.0.0.1:8881', procs: [mock, server], dataDir};
expect(await waitUp(rig.mockBase + '/__counts')).toBe(true);
expect(await waitUp(rig.base + '/api/health')).toBe(true);
await loginAdmin(rig.base);
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
fs.rmSync(rig.dataDir, { recursive: true, force: true});
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
body: JSON.stringify(body?? {}),
});
return r.json();
}
async function jput(base: string, p: string, body?: unknown): Promise<{ status: number; json: any}> {
const r = await fetch(base + p, {
method: 'PUT',
headers: { 'content-type': 'application/json', cookie: COOKIE },
body: JSON.stringify(body?? {}),
});
return { status: r.status, json: await r.json()};
}
async function jdel(base: string, p: string): Promise<{ status: number; json: any}> {
const r = await fetch(base + p, { method: 'DELETE', headers: { cookie: COOKIE } });
return { status: r.status, json: await r.json()};
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


async function waitFor<T>(fn: () => Promise<T | null>, timeout = 40_000): Promise<T> {
const t0 = Date.now();
while (Date.now() - t0 < timeout) {
const v = await fn();
if (v) return v;
await sleep(400);
}
throw new Error('waitFor 超时');
}

describe('集成：知识库一期（CRUD→注入→审计→回流）', () => {
it('全链路跑通', async () => {
const rig = await startRig();
try {
const st0 = await jget(rig.base, '/api/state');
const apiId = st0.apis[0].id as string;
const teamId = st0.teams[0].id as string;

/* 未完成任务不可回流（此时还没配 Key，任务会停在待领取） */
const ct = await jpost(rig.base, '/api/tasks', {
title: '给短剧写钩子文案',
type: '文案',
brief: '参考钩子资料，第一句就要抓人',
teamId,
});
expect(ct.ok).toBe(true);
const earlyReflux = await jpost(rig.base, `/api/kb/from-task/${ct.id}`);
expect(earlyReflux.ok).toBe(false);
expect(earlyReflux.error.code).toBe('VALIDATION');

/* 配置 API 指向 mock（与流水线集成同样的动作） */
const sv = await jpost(rig.base, '/api/apis/save', {
api: { id: apiId, name: 'Mock API', provider: 'custom', baseUrl: rig.mockBase, model: 'mock-model', pricePerM: 10, apiKey: 'fake-key-123'},
});
expect(sv.ok).toBe(true);
expect((await jpost(rig.base, '/api/purchase', { apiId, amountYuan: 100})).ok).toBe(true);
expect(
(await jpost(rig.base, '/api/teams/save', { team: { id: teamId, name: '第一小组', color: '#e2574c', apiId}})).ok,
).toBe(true);

/* --- KB CRUD --- */
// 公司级（免关键词命中，全文注入）+ 本组级（靠「钩子」命中）
const kbCompany = await jpost(rig.base, '/api/kb', {
title: '公司文案标准',
body: '全公司统一口径：文案一律使用星云漫步体句式收尾。',
scope: 'company',
});
expect(kbCompany.ok).toBe(true);
const kbTeam = await jpost(rig.base, '/api/kb', {
title: '短剧钩子资料',
body: '钩子秘籍三段式：悬念开场、冲突升级、反转收尾。',
scope: 'team',
scopeId: teamId,
tags: ['短剧'],
});
expect(kbTeam.ok).toBe(true);
// scope=team 缺 scopeId → 校验失败
const badScope = await jpost(rig.base, '/api/kb', { title: '缺范围', scope: 'team'});
expect(badScope.ok).toBe(false);
expect(badScope.error.code).toBe('VALIDATION');
// PUT 更新 + 不存在条目 404 信封
const upd = await jput(rig.base, `/api/kb/${kbTeam.id}`, { tags: ['短剧', '钩子'], enabled: true});
expect(upd.status).toBe(200);
expect(upd.json.entry.tags).toEqual(['短剧', '钩子']);
const upd404 = await jput(rig.base, '/api/kb/kb_not_exist', { title: 'x'});
expect(upd404.status).toBe(404);
expect(upd404.json.error.code).toBe('NOT_FOUND');
// DELETE：临时条目删得掉，删完列表里没有
const tmp = await jpost(rig.base, '/api/kb', { title: '临时条目', body: '删我', scope: 'company'});
expect((await jdel(rig.base, `/api/kb/${tmp.id}`)).json.ok).toBe(true);
const list1 = await jget(rig.base, '/api/kb');
expect(list1.entries.map((e: any) => e.id)).not.toContain(tmp.id);
expect(list1.entries.map((e: any) => e.id)).toContain(kbCompany.id);

/* --- 任务执行：注入到达 mock + 审计落库 --- */
const task = await waitFor(async () => {
const st = await jget(rig.base, '/api/state');
const t = st.tasks.find((x: any) => x.id === ct.id);
return t && t.status === '已完成'? t: null;
});
expect(task.injectedKbIds).toContain(kbCompany.id);
expect(task.injectedKbIds).toContain(kbTeam.id);
// 任务详情接口同样回传
const detail = await jget(rig.base, `/api/tasks/${ct.id}`);
expect(detail.ok).toBe(true);
expect(detail.task.injectedKbIds).toContain(kbTeam.id);
// mock 侧回显：执行请求里确实带上了两条注入内容
const reqs = await jget(rig.mockBase, '/__requests');
const chatUsers = reqs.filter((r: any) => r.kind === 'chat').map((r: any) => r.user as string);
expect(chatUsers.some((u) => u.includes('') && u.includes('星云漫步体'))).toBe(true);
expect(chatUsers.some((u) => u.includes('钩子秘籍三段式'))).toBe(true);

/* --- 成果回流 --- */
const reflux = await jpost(rig.base, `/api/kb/from-task/${ct.id}`);
expect(reflux.ok).toBe(true);
expect(reflux.entry.title).toBe('给短剧写钩子文案');
expect(reflux.entry.scope).toBe('team');
expect(reflux.entry.scopeId).toBe(teamId);
expect(reflux.entry.body).toBe(task.result);
expect(reflux.entry.enabled).toBe(true);
const reflux404 = await jpost(rig.base, '/api/kb/from-task/task_not_exist');
expect(reflux404.ok).toBe(false);
expect(reflux404.error.code).toBe('NOT_FOUND');
const list2 = await jget(rig.base, '/api/kb');
expect(list2.entries.map((e: any) => e.id)).toContain(reflux.id);
} finally {
stopRig(rig);
}
});
});
