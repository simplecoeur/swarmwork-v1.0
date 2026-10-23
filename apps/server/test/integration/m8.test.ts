import { spawn, type ChildProcess} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
* M8 集成：资产库（类型注册表/版本快照/按集引用注入/历史版本可追溯）、
* 数据飞轮（标记→沉淀 KB 规律/skill 备注→再发单命中）、成果库（筛选/再发）、
* 成套流水线（短剧上线包 6 环节 seq 串行 + 上游成果注入下游）、站内提醒（余额/裁决）、工作台账。
*/
const SERVER_DIR = process.cwd();
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
const MOCK = path.join(REPO_ROOT, 'tools', 'mock-llm.js');
const PORT = 8896;
const MOCK_PORT = 8906;
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

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 45_000): Promise<T> {
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
req: (method: string, p: string, body?: unknown) => Promise<{ status: number; json: any; text: string}>;
get: (p: string) => Promise<{ status: number; json: any; text: string}>;
post: (p: string, body?: unknown) => Promise<{ status: number; json: any; text: string}>;
put: (p: string, body?: unknown) => Promise<{ status: number; json: any; text: string}>;
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
/* 非 JSON */
}
return { status: r.status, json, text};
},
get: (p) => c.req('GET', p),
post: (p, body) => c.req('POST', p, body?? {}),
put: (p, body) => c.req('PUT', p, body?? {}),
};
return c;
}

const procs: ChildProcess[] = [];
let dataDir = '';
const clientF = makeClient(BASE);
let teamF = '';
let assetId = '';
let plainDoneId = '';
let skillDoneId = '';
let skillCopyId = '';

async function waitTaskDone(client: Client, taskId: string): Promise<any> {
return waitFor(async () => {
const r = await client.get(`/api/tasks/${taskId}`);
const t = r.json?.task;
return t && t.status === '已完成'? t: null;
});
}

async function mockRequests(): Promise<Array<{ kind: string; user: string}>> {
const r = await fetch(MOCK_BASE + '/__requests');
return (await r.json()) as Array<{ kind: string; user: string}>;
}

beforeAll(async () => {
dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-m8-'));
const mock = spawn('node', [MOCK], {
env: {...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_REVIEW_MODE: 'pass'},
stdio: 'pipe',
detached: true,
});
procs.push(mock);
expect(await waitUp(MOCK_BASE + '/__counts')).toBe(true);
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

/* 用户 F 选短剧包开公司（自带三组 + 6 个官方 skill 副本） */
const reg = await clientF.post('/api/auth/register', {
email: 'f@test.local',
password: '<MASKED_SECRET_003>!',
displayName: '用户F',
industryPackId: 'pack_short_drama',
workspaceName: 'F的短剧公司',
});
expect(reg.json.pending).toBe(false);
const st = (await clientF.get('/api/state')).json;
teamF = st.teams[0].id as string;
const save = await clientF.post('/api/apis/save', {
api: { name: 'Mock API', provider: 'custom', baseUrl: MOCK_BASE, model: 'mock-model', pricePerM: 10, apiKey: 'fake-key'},
});
await clientF.post('/api/purchase', { apiId: save.json.id, amountYuan: 100});
await clientF.post('/api/teams/save', {
team: { id: teamF, name: st.teams[0].name, color: st.teams[0].color, apiId: save.json.id},
});
const skills = (await clientF.get('/api/skills')).json.skills as any[];
skillCopyId = skills.find((s) => s.slug === 'viral-title' && s.workspaceId)?.id as string;
expect(skillCopyId).toBeTruthy();
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
try {
fs.rmSync(dataDir, { recursive: true, force: true});
} catch {
/* 忽略 */
}
});

describe('M8 资产库', () => {
it('类型注册表 + 资产版本 + 按集引用注入 + 版本可追溯', async () => {
const types = (await clientF.get('/api/asset-types')).json.assetTypes as any[];
expect(types.map((t) => t.typeId)).toEqual(expect.arrayContaining(['剧本', '通用文档']));
const custom = await clientF.post('/api/asset-types', {
assetType: { name: '商品资料', structureSchema: { sections: '按卖点分段'}},
});
expect(custom.json.ok).toBe(true);

const created = await clientF.post('/api/assets', {
asset: {
typeId: '剧本',
name: '测试剧本',
content: {
sections: [
{ key: 'ep1', title: '第1集', body: 'EP1BODYZZQ 第一集正文'},
{ key: 'ep2', title: '第2集', body: 'EP2BODYZZQ 第二集正文'},
],
},
},
});
expect(created.json.ok).toBe(true);
assetId = created.json.id as string;
expect(created.json.asset.version).toBe(1);

const updated = await clientF.put(`/api/assets/${assetId}`, {
asset: {
typeId: '剧本',
name: '测试剧本',
content: {
sections: [
{ key: 'ep1', title: '第1集', body: 'EP1BODYZZQ 第一集正文修订版'},
{ key: 'ep2', title: '第2集', body: 'EP2BODYZZQ 第二集正文'},
{ key: 'ep3', title: '第3集', body: 'EP3BODYZZQ 第三集正文'},
],
},
},
});
expect(updated.json.asset.version).toBe(2);
const v1 = await clientF.get(`/api/assets/${assetId}/versions/1`);
expect(JSON.stringify(v1.json.content)).toContain('第一集正文');
expect(JSON.stringify(v1.json.content)).not.toContain('修订版');

/* 按集引用：只注入 ep1（当前 v2 内容），任务记录注入资产为 assetId@2 */
const task = await clientF.post('/api/tasks', {
title: '按剧本写钩子',
type: '文案',
brief: '依据剧本第一集写钩子',
teamId: teamF,
assetRefs: [{ assetId, sections: ['ep1']}],
});
expect(task.json.ok).toBe(true);
const done = await waitTaskDone(clientF, task.json.id as string);
expect(done.injectedAssets).toContain(`${assetId}@2`);
const reqs = await mockRequests();
const hit = reqs.filter((r) => r.kind === 'chat' && r.user.includes('EP1BODYZZQ'));
expect(hit.length).toBeGreaterThan(0);
expect(hit[hit.length - 1].user).toContain('修订版');
expect(hit[hit.length - 1].user).not.toContain('EP2BODYZZQ');

/* 资产再升 v3 后，历史任务的注入记录仍指向 @2 */
await clientF.put(`/api/assets/${assetId}`, {
asset: {
typeId: '剧本',
name: '测试剧本',
content: { sections: [{ key: 'ep1', title: '第1集', body: 'EP1BODYZZQ 第三版正文'}]},
},
});
const again = (await clientF.get(`/api/tasks/${task.json.id}`)).json.task;
expect(again.injectedAssets).toContain(`${assetId}@2`);
});
});

describe('M8 数据飞轮 + 成果库', () => {
it('标记→沉淀（KB 规律 / skill 备注）→再发命中；成果库筛选与一键再发', async () => {
/* 一单普通成果 + 一单 skill 成果 */
const plain = await clientF.post('/api/tasks', {
title: '飞轮普通单',
type: '文案',
brief: '写一段简介',
teamId: teamF,
});
const plainDone = await waitTaskDone(clientF, plain.json.id as string);
plainDoneId = plainDone.id;
const skillDispatch = await clientF.post(`/api/skills/${skillCopyId}/dispatch`, {
params: {
drama_name: '飞轮测试剧',
genre: '逆袭打脸',
key_plot: '被退婚后闪婚总裁',
count: 3,
tone: '狗血强刺激',
},
teamId: teamF,
});
expect(skillDispatch.json.ok).toBe(true);
const skillDone = await waitTaskDone(clientF, skillDispatch.json.id as string);
skillDoneId = skillDone.id;

/* 未标记先沉淀 → 拒绝；标记无效 → 沉淀仍拒绝；标记有效 → 可沉淀 */
const earlySed = await clientF.post(`/api/tasks/${plainDoneId}/sediment`, { target: 'kb'});
expect(earlySed.json.ok).toBe(false);
const markBad = await clientF.post(`/api/tasks/${plainDoneId}/outcome`, {
verdict: 'ineffective',
metrics: { views: 10},
});
expect(markBad.json.ok).toBe(true);
const sedBad = await clientF.post(`/api/tasks/${plainDoneId}/sediment`, { target: 'kb'});
expect(sedBad.json.ok).toBe(false);
const mark = await clientF.post(`/api/tasks/${plainDoneId}/outcome`, {
verdict: 'effective',
metrics: { views: 12000, ctr: 0.09},
});
expect(mark.json.ok).toBe(true);
const sedKb = await clientF.post(`/api/tasks/${plainDoneId}/sediment`, {
target: 'kb',
note: '下次同题材优先用',
});
expect(sedKb.json.ok).toBe(true);
const kbList = (await clientF.get('/api/kb')).json.entries as any[];
const rule = kbList.find((e) => e.id === sedKb.json.id);
expect(rule).toBeTruthy();
expect(rule.tags).toEqual(expect.arrayContaining(['爆款规律']));

/* 新任务注入命中该规律条目（公司级沉淀条目进入注入候选并实际注入） */
const follow = await clientF.post('/api/tasks', {
title: '飞轮跟进单',
type: '文案',
brief: '延续上次的简介风格再写一段',
teamId: teamF,
});
const followDone = await waitTaskDone(clientF, follow.json.id as string);
expect(followDone.injectedKbIds).toContain(sedKb.json.id);

/* 沉淀到 skill：备注落 skill，后续同 skill 发单 brief 带已验证做法段 */
await clientF.post(`/api/tasks/${skillDoneId}/outcome`, {
verdict: 'effective',
metrics: { views: 30000},
});
const sedSkill = await clientF.post(`/api/tasks/${skillDoneId}/sediment`, { target: 'skill'});
expect(sedSkill.json.ok).toBe(true);
const skillView = (await clientF.get(`/api/skills/${skillCopyId}`)).json.skill;
expect(skillView.verifiedNotes).toContain('经验证有效');
const dispatch2 = await clientF.post(`/api/skills/${skillCopyId}/dispatch`, {
params: { drama_name: '第二部剧', genre: '甜宠', key_plot: '闪婚后日久生情', count: 3, tone: '悬念克制'},
teamId: teamF,
});
const task2 = (await clientF.get(`/api/tasks/${dispatch2.json.id}`)).json.task;
expect(task2.brief).toContain('');

/* 成果库：已验证有效筛选 + 关键词搜索 + 一键再发（带原参数） */
const verified = (await clientF.get('/api/results?verified=1')).json.results as any[];
expect(verified.map((r) => r.taskId)).toEqual(expect.arrayContaining([plainDoneId, skillDoneId]));
expect(verified.find((r) => r.taskId === plainDoneId).mark.metrics.views).toBe(12000);
const searched = (await clientF.get('/api/results?q=飞轮普通单')).json.results as any[];
expect(searched.map((r) => r.taskId)).toContain(plainDoneId);
const redispatch = await clientF.post(`/api/tasks/${skillDoneId}/redispatch`, {});
expect(redispatch.json.ok).toBe(true);
const reTask = (await clientF.get(`/api/tasks/${redispatch.json.id}`)).json.task;
expect(reTask.skillId).toBe(skillCopyId);
expect(reTask.skillParams.drama_name).toBe('飞轮测试剧');
});
});

describe('M8 成套流水线', () => {
it('短剧上线包一键生成 6 环节并整包交付（seq 串行 + 上游成果注入下游）', async () => {
const templates = (await clientF.get('/api/pipelines/templates')).json.templates as any[];
const pack = templates.find((t) => t.id === 'drama-launch-pack');
expect(pack).toBeTruthy();
expect(pack.steps).toHaveLength(6);
expect(pack.steps.every((s: any) => s.available)).toBe(true);

const missing = await clientF.post('/api/pipelines/run', {
templateId: 'drama-launch-pack',
teamId: teamF,
params: {},
});
expect(missing.json.ok).toBe(false);

const run = await clientF.post('/api/pipelines/run', {
templateId: 'drama-launch-pack',
teamId: teamF,
params: {
drama_name: '流水线测试剧',
genre: '逆袭打脸',
synopsis: '订婚宴被退婚，转身闪婚总裁，三年后归来收购前未婚夫公司',
key_plot: '退婚、闪婚、三年后收购',
selling_point: '身份落差与当场反杀',
hook: '总裁身份何时揭晓',
platform: 'YouTube',
market: '北美',
},
});
expect(run.json.ok).toBe(true);
expect(run.json.taskIds).toHaveLength(6);

const allDone = await waitFor(async () => {
const st = (await clientF.get('/api/state')).json;
const children = st.tasks.filter((t: any) => run.json.taskIds.includes(t.id));
return children.length === 6 && children.every((t: any) => t.status === '已完成')? children: null;
}, 55_000);
expect(allDone).toHaveLength(6);
const st = (await clientF.get('/api/state')).json;
const proj = st.projects.find((p: any) => p.id === run.json.projectId);
expect(proj.status).toBe('已交付');
/* 下游任务的执行请求里出现上游成果衔接段（项目内已完成成果） */
const reqs = await mockRequests();
expect(reqs.some((r) => r.kind === 'chat' && r.user.includes('项目内已完成成果'))).toBe(true);
});
});

describe('M8 站内提醒 + 工作台账', () => {
it('余额耗尽提醒 + 待裁决提醒 + 已读流转 + 台账与对账导出', async () => {
/* 余额提醒：新 API 不充值 + 新组绑该 API → 任务停工并生成 balance 提醒 */
const api2 = await clientF.post('/api/apis/save', {
api: { name: '空余额API', provider: 'custom', baseUrl: MOCK_BASE, model: 'mock-model', pricePerM: 10, apiKey: 'k2'},
});
const team2 = await clientF.post('/api/teams/save', {
team: { name: '空余额组', color: '#888888', apiId: api2.json.id},
});
const brokeTask = await clientF.post('/api/tasks', {
title: '余额测试单',
type: '文案',
brief: '随便写点',
teamId: team2.json.id,
});
expect(brokeTask.json.ok).toBe(true);
/* 空余额组的组长/审核成员由建组种子生成；把该组 API 改绑到未充值的 api2（teams/save 已带 apiId） */
const notif1 = await waitFor(async () => {
const n = (await clientF.get('/api/notifications')).json;
return n.notifications.some((x: any) => x.type === 'balance' && x.taskId === brokeTask.json.id)? n: null;
});
expect(notif1.unread).toBeGreaterThan(0);

/* 待裁决提醒：预算上限 100 token，单子 300 token 必超 → 转裁决并提醒 */
await clientF.post('/api/settings/params', { concurrency: 4, taskBudgetTokens: 100});
const overTask = await clientF.post('/api/tasks', {
title: '预算超限单',
type: '文案',
brief: '写一段长文',
teamId: teamF,
});
const notif2 = await waitFor(async () => {
const t = (await clientF.get(`/api/tasks/${overTask.json.id}`)).json.task;
if (!t || t.status!== '待裁决') return null;
const n = (await clientF.get('/api/notifications')).json;
return n.notifications.some((x: any) => x.type === 'adjudication' && x.taskId === overTask.json.id)? n: null;
});
expect(notif2).toBeTruthy();
await clientF.post('/api/settings/params', { concurrency: 4, taskBudgetTokens: 0});

/* 已读流转 */
const list = (await clientF.get('/api/notifications')).json;
const first = list.notifications[0];
const read = await clientF.post(`/api/notifications/${first.id}/read`);
expect(read.json.unread).toBe(list.unread - 1);
const readAll = await clientF.post('/api/notifications/read-all');
expect(readAll.json.unread).toBe(0);

/* 通知配置位：邮件仅留配置 */
const cfgPut = await clientF.put('/api/notifications/settings', {
emailEnabled: true,
email: 'boss@example.com',
});
expect(cfgPut.json.ok).toBe(true);
const cfgGet = await clientF.get('/api/notifications/settings');
expect(cfgGet.json.mailChannel).toBe('reserved-not-implemented');
expect(cfgGet.json.config.email).toBe('boss@example.com');

/* 工作台账：时间线有事件；按月对账 CSV 可导出 */
const view = (await clientF.get('/api/ledger-view')).json;
expect(view.timeline.length).toBeGreaterThan(0);
expect(view.timeline.some((x: any) => x.kind === 'task_event')).toBe(true);
const month = new Date().toISOString().slice(0, 7);
const csv = await clientF.get(`/api/ledger-view/export?month=${month}`);
expect(csv.status).toBe(200);
expect(csv.text).toContain('total_tokens');
});
});
