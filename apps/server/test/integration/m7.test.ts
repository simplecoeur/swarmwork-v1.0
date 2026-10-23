import { spawn, type ChildProcess} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
* M7 集成：skill 系统（种子/装包/CRUD 版本/试运行记账/发单渲染/kb_binding 注入/上架审核/快照安装与升级）、
* 交付闭环（导出/只读交付页口令与撤销/篡改 token）、渠道适配器（MJ stub 模拟验证）、P1（批量发单/参考资料注入）。
*/
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const PORT = 8895;
const MOCK_PORT = 8905;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

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
req: (method: string, p: string, body?: unknown) => Promise<{ status: number; json: any; headers: Headers; text: string}>;
get: (p: string) => Promise<{ status: number; json: any; headers: Headers; text: string}>;
post: (p: string, body?: unknown) => Promise<{ status: number; json: any; headers: Headers; text: string}>;
put: (p: string, body?: unknown) => Promise<{ status: number; json: any; headers: Headers; text: string}>;
}

function makeClient(base: string): Client {
const c: Client = {
cookie: '',
async req(method, p, body) {
const r = await fetch(base + p, {
method,
headers: {
...(body === undefined? {}: { 'content-type': 'application/json'}),
...(c.cookie? { cookie: c.cookie}: {}),
},
body: body === undefined? undefined: JSON.stringify(body),
});
const sc = r.headers.get('set-cookie');
if (sc && sc.includes('swarm_session=')) {
const v = sc.split(';')[0];
if (v.length > 'swarm_session='.length) c.cookie = v;
if (v === 'swarm_session=') c.cookie = '';
}
const text = await r.text();
let json: any = null;
try {
json = JSON.parse(text);
} catch {
/* 非 JSON（导出/交付页） */
}
return { status: r.status, json, headers: r.headers, text};
},
get: (p) => c.req('GET', p),
post: (p, body) => c.req('POST', p, body?? {}),
put: (p, body) => c.req('PUT', p, body?? {}),
};
return c;
}

const procs: ChildProcess[] = [];
let dataDir = '';
let stub: http.Server | null = null;
let stubBase = '';

const admin = makeClient(BASE);
const clientS = makeClient(BASE);
const clientP = makeClient(BASE);
const clientT = makeClient(BASE);

async function setupMockWorkspace(client: Client): Promise<{ teamId: string; apiId: string}> {
const st = (await client.get('/api/state')).json;
const teamId = st.teams[0].id as string;
const save = await client.post('/api/apis/save', {
api: { name: 'Mock API', provider: 'custom', baseUrl: MOCK_BASE, model: 'mock-model', pricePerM: 10, apiKey: 'fake-key'},
});
const apiId = save.json.id as string;
await client.post('/api/purchase', { apiId, amountYuan: 100});
await client.post('/api/teams/save', {
team: { id: teamId, name: st.teams[0].name, color: st.teams[0].color, apiId},
});
return { teamId, apiId};
}

async function waitTaskDone(client: Client, taskId: string): Promise<any> {
return waitFor(async () => {
const r = await client.get(`/api/tasks/${taskId}`);
const t = r.json?.task;
return t && t.status === '已完成'? t: null;
});
}

beforeAll(async () => {
dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-m7-'));
const mock = spawn('node', [MOCK], {
env: {...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_REVIEW_MODE: 'pass'},
stdio: 'pipe',
detached: true,
});
procs.push(mock);
expect(await waitUp(MOCK_BASE + '/__counts')).toBe(true);

/* MJ 渠道 stub：实现适配器契约（绑定校验/推送/回查） */
stub = http.createServer((req, res) => {
let s = '';
req.on('data', (c) => (s += c));
req.on('end', () => {
const json = (code: number, obj: unknown) => {
res.writeHead(code, { 'content-type': 'application/json'});
res.end(JSON.stringify(obj));
};
if (req.url === '/api/v1/users/me') return json(200, { username: 'mj-admin'});
if (req.method === 'POST' && req.url === '/api/v1/swarm/deliveries') return json(200, { id: 'mj-123'});
if (req.method === 'GET' && req.url === '/api/v1/swarm/deliveries/mj-123') {
return json(200, { status: 'queued', views: 42, likes: 7});
}
return json(404, { error: 'not found'});
});
});
await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve));
const addr = stub.address() as { port: number};
stubBase = `http://127.0.0.1:${addr.port}`;

const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
cwd: SERVER_DIR,
env: {
...process.env,
PORT: String(PORT),
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
expect(await waitUp(BASE + '/api/health')).toBe(true);

const login = await admin.post('/api/auth/login', { email: 'admin@test.local', password: '<MASKED_SECRET_001>!'});
expect(login.json.ok).toBe(true);
const cp = await admin.post('/api/auth/change-password', {
currentPassword: '<MASKED_SECRET_001>!',
newPassword: '<MASKED_SECRET_002>!',
});
expect(cp.json.ok).toBe(true);
}, 60_000);

afterAll(() => {
for (const p of procs) {
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
stub?.close();
try {
fs.rmSync(dataDir, { recursive: true, force: true});
} catch {
/* 忽略 */
}
});

describe('M7 skill 系统 + 交付闭环 + 渠道 + P1', () => {
it('全链路', async () => {
/* 用户 S 注册（第 1 个），配 mock 工作区 */
const regS = await clientS.post('/api/auth/register', {
email: 's@test.local',
password: '<MASKED_SECRET_003>!',
displayName: '用户S',
});
expect(regS.json.pending).toBe(false);
const { teamId: teamS} = await setupMockWorkspace(clientS);

/* 官方 skill 种库：6 个平台 skill 对新用户可见 */
const skills0 = (await clientS.get('/api/skills')).json.skills as any[];
const officials = skills0.filter((s) => s.ownerType === 'platform');
expect(officials.map((s) => s.slug)).toEqual(
expect.arrayContaining(['viral-title', 'script-selling-points', 'episode-hooks', 'cover-copy', 'comment-scripts', 'multi-lang-intro']),
);

/* 用户 P 选短剧包开公司（第 2 个注册）：6 个官方 skill 被快照装入其空间 */
const regP = await clientP.post('/api/auth/register', {
email: 'p@test.local',
password: '<MASKED_SECRET_003>!',
displayName: '用户P',
industryPackId: 'pack_short_drama',
workspaceName: 'P的短剧公司',
});
expect(regP.json.pending).toBe(false);
const skillsP = (await clientP.get('/api/skills')).json.skills as any[];
const copiesP = skillsP.filter((s) => s.workspaceId === regP.json.workspace.id && s.sourceSkillId);
expect(copiesP).toHaveLength(6);
expect(copiesP.map((s) => s.slug)).toEqual(
expect.arrayContaining(['viral-title', 'script-selling-points', 'episode-hooks', 'cover-copy', 'comment-scripts', 'multi-lang-intro']),
);

/* S 自建 skill：草稿不可发单、试运行可跑且记账 */
const create = await clientS.post('/api/skills', {
skill: {
name: '剧名生成器',
description: '给题材想剧名',
role: '文案',
promptTemplate: '为{{genre}}题材想一个短剧名，围绕{{theme}}。',
inputSchema: [
{ key: 'genre', label: '题材', type: 'text', required: true},
{ key: 'theme', label: '主题', type: 'text', required: false, default: '逆袭'},
],
kbBinding: {},
outputSpec: '只输出一个剧名，不要解释。',
exampleInput: { genre: '复仇'},
exampleOutput: '《归来》',
changelog: '初版',
},
});
expect(create.json.ok).toBe(true);
const skillS = create.json.id as string;
const dispatchDraft = await clientS.post(`/api/skills/${skillS}/dispatch`, {
params: { genre: '复仇'},
teamId: teamS,
});
expect(dispatchDraft.json.ok).toBe(false);

const testRun = await clientS.post(`/api/skills/${skillS}/test-run`, { teamId: teamS});
expect(testRun.json.ok).toBe(true);
const testTask = await waitTaskDone(clientS, testRun.json.id as string);
expect(testTask.isSkillTest).toBe(true);
expect(testTask.skillId).toBe(skillS);
const stAfterTest = (await clientS.get('/api/state')).json;
expect(stAfterTest.ledger.filter((l: any) => l.taskId === testRun.json.id)).toHaveLength(2);

/* 编辑必须带 changelog；带了则 version+1 */
const putNoLog = await clientS.put(`/api/skills/${skillS}`, {
skill: {
name: '剧名生成器',
role: '文案',
promptTemplate: '为{{genre}}题材想两个短剧名，围绕{{theme}}。',
inputSchema: create.json.skill.inputSchema,
kbBinding: {},
outputSpec: '只输出剧名列表。',
exampleInput: { genre: '复仇'},
exampleOutput: '',
changelog: '',
},
});
expect(putNoLog.json.ok).toBe(false);
const putOk = await clientS.put(`/api/skills/${skillS}`, {
skill: {
name: '剧名生成器',
role: '文案',
promptTemplate: '为{{genre}}题材想两个短剧名，围绕{{theme}}。',
inputSchema: create.json.skill.inputSchema,
kbBinding: {},
outputSpec: '只输出剧名列表。',
exampleInput: { genre: '复仇'},
exampleOutput: '',
changelog: '改为产出两个',
},
});
expect(putOk.json.ok).toBe(true);
expect(putOk.json.skill.version).toBe(2);

/* 发布后发单：缺必填参数 400；参数齐全则渲染 brief 并落 skill 快照 */
expect((await clientS.post(`/api/skills/${skillS}/publish`)).json.ok).toBe(true);
const dispatchNoParam = await clientS.post(`/api/skills/${skillS}/dispatch`, {
params: {},
teamId: teamS,
});
expect(dispatchNoParam.json.ok).toBe(false);
const dispatch = await clientS.post(`/api/skills/${skillS}/dispatch`, {
params: { genre: '甜宠'},
teamId: teamS,
});
expect(dispatch.json.ok).toBe(true);
const dispatched = await waitTaskDone(clientS, dispatch.json.id as string);
expect(dispatched.skillVersion).toBe(2);
expect(dispatched.skillParams.genre).toBe('甜宠');
expect(dispatched.skillParams.theme).toBe('逆袭');
expect(dispatched.brief).toContain('为甜宠题材想两个短剧名，围绕逆袭。');
expect(dispatched.brief).toContain('');

/* kb_binding：entryIds 强制注入（无关键词命中的他组条目也能注入），普通单不注入 */
const team2 = await clientS.post('/api/teams/save', {
team: { name: '第二小组', color: '#3a6fd8', apiId: null},
});
const kbBind = await clientS.post('/api/kb', {
title: 'ZZQTOKEN 甲乙丙',
body: 'ZZQBINDTOKEN 仅供ZZQ校验',
scope: 'team',
scopeId: team2.json.id,
});
expect(kbBind.json.ok).toBe(true);
const bindSkill = await clientS.post('/api/skills', {
skill: {
name: '甲壳虫skill',
role: '文案',
promptTemplate: '给新剧想个名字 {{name}}',
inputSchema: [{ key: 'name', label: '名', type: 'text', required: true}],
kbBinding: { entryIds: [kbBind.json.id]},
outputSpec: '',
exampleInput: { name: '测试剧'},
exampleOutput: '',
},
});
await clientS.post(`/api/skills/${bindSkill.json.id}/publish`);
const bindDispatch = await clientS.post(`/api/skills/${bindSkill.json.id}/dispatch`, {
params: { name: '测试剧'},
teamId: teamS,
});
const bindTask = await waitTaskDone(clientS, bindDispatch.json.id as string);
expect(bindTask.injectedKbIds).toContain(kbBind.json.id);
const plainTask = await clientS.post('/api/tasks', {
title: '普通单',
type: '文案',
brief: '给新剧想个名字 测试剧',
teamId: teamS,
});
const plainDone = await waitTaskDone(clientS, plainTask.json.id as string);
expect(plainDone.injectedKbIds).not.toContain(kbBind.json.id);

/* 上架审核全链路：T 建 skill → 提交 → 管理员待审 → 通过 → S 可见并安装（快照） */
const regT = await clientT.post('/api/auth/register', {
email: 't@test.local',
password: '<MASKED_SECRET_003>!',
displayName: '用户T',
});
expect(regT.json.pending).toBe(false);
const tSkill = await clientT.post('/api/skills', {
skill: {
name: 'T的钩子skill',
role: '文案',
promptTemplate: '写钩子 v1 {{x}}',
inputSchema: [{ key: 'x', label: 'x', type: 'text', required: true}],
kbBinding: {},
outputSpec: '',
exampleInput: { x: 'a'},
exampleOutput: '',
},
});
const tSkillId = tSkill.json.id as string;
await clientT.post(`/api/skills/${tSkillId}/submit-review`);
const pending = (await admin.get('/api/admin/skills/pending')).json.skills as any[];
expect(pending.map((s) => s.id)).toContain(tSkillId);
expect((await admin.post(`/api/admin/skills/${tSkillId}/approve`)).json.ok).toBe(true);
const skillsAfterApprove = (await clientS.get('/api/skills')).json.skills as any[];
const libEntry = skillsAfterApprove.find((s) => s.id === tSkillId);
expect(libEntry).toBeTruthy();
expect(libEntry.visibility).toBe('public');
const install = await clientS.post(`/api/skills/${tSkillId}/install`, {});
expect(install.json.ok).toBe(true);
const copyId = install.json.id as string;
const installAgain = await clientS.post(`/api/skills/${tSkillId}/install`, {});
expect(installAgain.json.alreadyInstalled).toBe(true);
/* 源头升到 v2 后，副本内容仍是 v1 快照且 hasNewerSource=true；手动 upgrade 才更新 */
const tPut = await clientT.put(`/api/skills/${tSkillId}`, {
skill: {
name: 'T的钩子skill',
role: '文案',
promptTemplate: '写钩子 v2 {{x}}',
inputSchema: [{ key: 'x', label: 'x', type: 'text', required: true}],
kbBinding: {},
outputSpec: '',
exampleInput: { x: 'a'},
exampleOutput: '',
changelog: 'v2 改模板',
},
});
expect(tPut.json.skill.version).toBe(2);
const copyView = (await clientS.get(`/api/skills/${copyId}`)).json.skill;
expect(copyView.promptTemplate).toContain('v1');
expect(copyView.hasNewerSource).toBe(true);
const upgraded = await clientS.post(`/api/skills/${tSkillId}/install`, { upgrade: true});
expect(upgraded.json.upgraded).toBe(true);
const copyView2 = (await clientS.get(`/api/skills/${copyId}`)).json.skill;
expect(copyView2.promptTemplate).toContain('v2');
expect(copyView2.hasNewerSource).toBe(false);

/* 项目内调用：skill 发单挂到项目下 */
const proj = await clientS.post('/api/projects', {
name: 'S的项目',
brief: '项目说明',
teamId: teamS,
clientName: '',
});
expect(proj.json.ok).toBe(true);
const inProj = await clientS.post(`/api/skills/${skillS}/dispatch`, {
params: { genre: '复仇'},
teamId: teamS,
projectId: proj.json.id,
});
expect(inProj.json.ok).toBe(true);
const inProjTask = (await clientS.get(`/api/tasks/${inProj.json.id}`)).json.task;
expect(inProjTask.projectId).toBe(proj.json.id);

/* 交付闭环：导出 + 只读交付页（口令/撤销/篡改） */
const exp = await clientS.get(`/api/tasks/${dispatch.json.id}/export`);
expect(exp.status).toBe(200);
expect(exp.text).toContain('剧名生成器');
const expCsv = await clientS.get(`/api/tasks/${dispatch.json.id}/export?format=csv`);
expect(expCsv.text).toContain('任务标题');
expect((await clientT.get(`/api/tasks/${dispatch.json.id}/export`)).status).toBe(404);

const dlv = await clientS.post('/api/deliveries', {
scope: 'task',
taskId: dispatch.json.id,
password: 'pw1234',
expiresInDays: 7,
});
expect(dlv.json.ok).toBe(true);
const dPath = dlv.json.delivery.path as string;
const anon = makeClient(BASE);
const noPw = await anon.get(dPath);
expect(noPw.status).toBe(200);
expect(noPw.text).toContain('访问口令');
expect(noPw.text).not.toContain('mock 引擎生成的测试成果正文');
const wrongPw = await anon.post(dPath, { password: 'wrong-pw'});
expect(wrongPw.text).not.toContain('mock 引擎生成的测试成果正文');
const withPw = await anon.post(dPath, { password: 'pw1234'});
expect(withPw.text).toContain('mock 引擎生成的测试成果正文');
const tampered = await anon.get('/d/definitely-not-a-token');
expect(tampered.status).toBe(410);
expect((await clientS.post(`/api/deliveries/${dlv.json.delivery.id}/revoke`)).json.ok).toBe(true);
const afterRevoke = await anon.post(dPath, { password: 'pw1234'});
expect(afterRevoke.status).toBe(410);
/* 跨空间拿不到他人的交付记录 */
expect((await clientT.get('/api/deliveries')).json.deliveries).toHaveLength(0);

/* 渠道：未绑定先推一次 → 如实 failed 落账；绑定 MJ stub 后再推 → accepted → 回查指标 */
const pushNoBind = await clientS.post('/api/channels/push', {
channelType: 'mj',
taskId: bindTask.id,
});
expect(pushNoBind.json.ok).toBe(true);
expect(pushNoBind.json.push.status).toBe('failed');
expect(pushNoBind.json.push.message).toContain('未绑定');
const bind = await clientS.post('/api/channels/bind', {
channelType: 'mj',
baseUrl: stubBase,
token: 'mj-token-1',
});
expect(bind.json.ok).toBe(true);
expect(bind.json.bind.bound).toBe(true);
const push = await clientS.post('/api/channels/push', {
channelType: 'mj',
taskId: dispatch.json.id,
});
expect(push.json.ok).toBe(true);
expect(push.json.push.status).toBe('accepted');
expect(push.json.push.remoteRef).toBe('mj-123');
const refresh = await clientS.post(`/api/channels/pushes/${push.json.push.id}/refresh`);
expect(refresh.json.metrics.ok).toBe(true);
expect(refresh.json.metrics.metrics.views).toBe(42);
/* 跨空间推送他人任务 → 404（隔离不因渠道接口破例） */
const pushCross = await clientT.post('/api/channels/push', {
channelType: 'mj',
taskId: dispatch.json.id,
});
expect(pushCross.json.error?.code).toBe('NOT_FOUND');

/* P1：批量发单一行一单 + 参考资料注入 brief */
const batch = await clientS.post('/api/tasks/batch', {
items: [{ title: '批量标题一'}, { title: '批量标题二'}],
type: '文案',
briefSuffix: '统一要求：带数字',
references: '参考：http://example.com/ref-material',
teamId: teamS,
});
expect(batch.json.ok).toBe(true);
expect(batch.json.count).toBe(2);
const b1 = (await clientS.get(`/api/tasks/${batch.json.ids[0]}`)).json.task;
expect(b1.title).toBe('批量标题一');
expect(b1.brief).toContain('统一要求：带数字');
expect(b1.brief).toContain('');
expect(b1.brief).toContain('http://example.com/ref-material');
const single = await clientS.post('/api/tasks', {
title: '单发带参考',
type: '文案',
brief: '正文说明',
references: '链接：http://example.com/single',
teamId: teamS,
});
const singleTask = (await clientS.get(`/api/tasks/${single.json.id}`)).json.task;
expect(singleTask.brief).toContain('http://example.com/single');
});
});
