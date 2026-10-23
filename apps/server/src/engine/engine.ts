import {
BlockedCode,
ENGINE,
MAX_REJECTS_BEFORE_ADJUDICATION,
TaskStatus,
TEMPERATURES,
TYPE_ROLE,
} from '@swarm/shared';
import { resolveAssetSections } from '../domain/assetService';
import { balanceMilli, trialBalanceMilli} from '../domain/costService';
import { notifyOwner } from '../domain/notify';
import { kbCapTokens, selectKbForInjection} from '../domain/kbService';
import { DomainError, refreshProjectStatus, transitionTask, type TaskGuards} from '../domain/taskService';
import { CircuitOpenError, LlmGateway} from '../llm/gateway';
import { estimateTokens } from '../llm/parse';
import type { Logger} from '../logger';
import { decryptKey} from '../store/crypto';
import {
DEFAULT_WORKSPACE_ID,
type ApiRow,
type Repos,
type TaskRow,
} from '../store/repositories';

const now = () => new Date().toISOString();

/** 体验额度耗尽停工文案（§8.1：明确指向填自己的 Key） */
export const TRIAL_EXHAUSTED_REASON = '体验额度已用完，请到设置后台填自己的 API Key';

const wsOf = (task: TaskRow): string => task.workspace_id?? DEFAULT_WORKSPACE_ID;

/**
* 调度引擎（设计 §9 + §15.2 + M6 多租户）：
* DB 为准的队列、1s tick、FIFO + 守卫领取；执行/审核两阶段落库可续跑；
* M6：按 workspace 迭代队列——每空间的并发/预算守卫沿用既有口径且互不影响；
* API 解析链：组绑定 API → 空间默认 API →（末位）平台体验 API（自备优先，§8.1）；
* 派单查注册表（type_id → role_id），注册表无此类型时回退 shared 种子映射 TYPE_ROLE。
*/
export class Engine {
private readonly inFlight = new Set<string>();
private tickTimer: NodeJS.Timeout | null = null;
private hbTimer: NodeJS.Timeout | null = null;

constructor(
private readonly repos: Repos,
private readonly gateway: LlmGateway,
private readonly logger: Logger,
) {}

start(): void {
this.recoverOnStartup();
this.tickTimer = setInterval(() => this.tick(), ENGINE.TICK_MS);
this.hbTimer = setInterval(() => {
this.repos.touchHeartbeat([...this.inFlight]);
}, ENGINE.HEARTBEAT_MS);
}

stop(): void {
if (this.tickTimer) clearInterval(this.tickTimer);
if (this.hbTimer) clearInterval(this.hbTimer);
this.tickTimer = null;
this.hbTimer = null;
}

private allTasks(): TaskRow[] {
return this.repos.listWorkspaces().flatMap((w) => this.repos.listTasks(w.id));
}

/** 启动回收：上一进程遗留的 running 一律回 pending（单进程部署，无其他所有者） */
recoverOnStartup(): void {
for (const task of this.allTasks()) {
if (task.status === TaskStatus.RUNNING) {
this.repos.updateTaskStatus(task.id, TaskStatus.PENDING, { heartbeat_at: null});
this.logger.warn('engine', '启动回收：running 任务回 pending', { taskId: task.id});
}
}
}

/** 失联回收（§15.2）：非在飞的 running/reviewing 且心跳超 10 分钟 → 回 pending 并记日志 */
recoverStaleTasks(): void {
const cutoff = Date.now() - ENGINE.STALE_MS;
for (const task of this.allTasks()) {
if (this.inFlight.has(task.id)) continue;
if (task.status!== TaskStatus.RUNNING && task.status!== TaskStatus.REVIEWING) continue;
const hb = task.heartbeat_at? new Date(task.heartbeat_at).getTime(): 0;
if (hb < cutoff) {
this.repos.updateTaskStatus(task.id, TaskStatus.PENDING, { heartbeat_at: null});
this.logger.warn('engine', '回收失联任务（>10 分钟无心跳）回 pending', { taskId: task.id});
}
}
}

private params(workspaceId: string): { concurrency: number; taskBudgetTokens: number} {
return this.repos.getSetting('params', { concurrency: 4, taskBudgetTokens: 0}, workspaceId);
}

/** 自备 API 解析：组绑定 → 空间默认（仅本空间行） */
private resolveOwnApiRow(task: TaskRow): ApiRow | null {
const ws = wsOf(task);
const team = this.repos.getTeam(task.team_id, ws);
const apiId = team?.api_id || this.repos.getSetting<string | null>('defaultApiId', null, ws);
if (!apiId) return null;
return this.repos.getApi(apiId, ws)?? null;
}

/** 守卫链末位解析：自备 API 优先，无自备时落平台体验 API（§8.1） */
private resolveApiRow(task: TaskRow): ApiRow | null {
return this.resolveOwnApiRow(task)?? this.repos.getTrialApi()?? null;
}

private balanceFor(apiId: string, workspaceId: string): number {
const trial = this.repos.getTrialApi();
if (trial && trial.id === apiId) return trialBalanceMilli(this.repos, workspaceId);
return balanceMilli(this.repos, apiId, workspaceId);
}

private guardsFor(task: TaskRow): TaskGuards {
const ws = wsOf(task);
return {
resolveApi: (t) => {
const api = this.resolveApiRow(t);
return api? { id: api.id, apiKey: decryptKey(api.api_key_enc)}: null;
},
balanceMilli: (apiId) => this.balanceFor(apiId, ws),
runningCount: () => this.repos.countByStatus(TaskStatus.RUNNING, ws),
concurrencyLimit: () => Math.max(1, this.params(ws).concurrency || 1),
budgetTokens: () => this.params(ws).taskBudgetTokens || 0,
};
}

tick(): void {
this.recoverStaleTasks();
for (const ws of this.repos.listWorkspaces()) {
if (ws.status!== 'active') continue;
const limit = Math.max(1, this.params(ws.id).concurrency || 1);
const tasks = this.repos.listTasks(ws.id);
let inFlightHere = tasks.filter((t) => this.inFlight.has(t.id)).length;
for (const task of tasks) {
if (inFlightHere >= limit) break;
if (this.inFlight.has(task.id)) continue;
if (task.status === TaskStatus.PENDING || task.status === TaskStatus.REJECTED) {
/* 流水线顺序门控（§11.1）：同项目内 seq 更小者未终结（已完成/已取消）时，本单不领取 */
if (task.seq != null && task.project_id) {
const blockedBySibling = tasks.some(
(x) =>
x.project_id === task.project_id &&
x.seq != null &&
x.seq < task.seq! &&
x.status !== TaskStatus.DONE &&
x.status !== TaskStatus.CANCELLED,
);
if (blockedBySibling) continue;
}
if (this.circuitBlocks(task)) continue;
inFlightHere++;
void this.processClaim(task.id);
} else if (task.status === TaskStatus.REVIEWING) {
if (this.circuitBlocks(task)) continue;
inFlightHere++;
void this.processReview(task.id);
}
}
}
}

private circuitBlocks(task: TaskRow): boolean {
if (task.blocked_code!== BlockedCode.CIRCUIT_OPEN) return false;
const api = this.resolveApiRow(task);
return api? this.gateway.breaker.isOpen(api.id): false;
}

private blockedMessage(code: string, api: ApiRow | null, detail?: string): string {
const name = api? `「${api.name}」`: '';
switch (code) {
case BlockedCode.NO_API:
return '未配置可用 API：小组未分配 API 且无公司默认 API';
case BlockedCode.NO_API_KEY:
return `API${name}未填 Key，请先到设置后台填写（至少填一个 API 才能开工）`;
case BlockedCode.INSUFFICIENT_BALANCE:
return `API${name}余额不足，请到成本中心采购充值`;
case BlockedCode.MISSING_MEMBER:
return detail || '小组缺少对应工种或审核成员';
case BlockedCode.CIRCUIT_OPEN:
return `API${name}熔断中（连续调用失败），稍后自动重试`;
default:
return detail || '调用失败，稍后自动重试';
}
}

/** 余额不足时的停工文案：体验额度场景（无可用自备 API 且本空间领过体验额度）用 §8.1 专用文案 */
private insufficientReason(task: TaskRow, api: ApiRow | null): string {
const ws = wsOf(task);
const trial = this.repos.getTrialApi();
if (trial && this.repos.trialGrantedSum(trial.id, ws) > 0) {
const own = this.resolveOwnApiRow(task);
const ownUsable =
own && decryptKey(own.api_key_enc) && balanceMilli(this.repos, own.id, ws) > 0;
if (!ownUsable) return TRIAL_EXHAUSTED_REASON;
}
return this.blockedMessage(BlockedCode.INSUFFICIENT_BALANCE, api);
}

private overBudget(task: TaskRow): boolean {
const b = this.params(wsOf(task)).taskBudgetTokens || 0;
return b > 0 && task.total_tokens > b;
}

private toAdjudication(task: TaskRow, note: string): void {
const fresh = this.repos.getTask(task.id)?? task;
if (fresh.status === TaskStatus.ADJUDICATION || fresh.status === TaskStatus.DONE) return;
transitionTask(this.repos, fresh, TaskStatus.ADJUDICATION, {
reject_reason: `${note}（已转待裁决）`,
blocked_code: null,
blocked_reason: '',
});
refreshProjectStatus(this.repos, fresh.project_id);
notifyOwner(this.repos, wsOf(fresh), 'adjudication', '任务待裁决', `《${fresh.title}》：${note}，请到任务墙裁决`, fresh.id);
this.logger.warn('engine', `任务转待裁决：${note}`, { taskId: task.id});
}

/** 派单工种：查注册表（type_id → role_id），无注册时回退种子映射（§12.2） */
private roleForTask(task: TaskRow): string {
const ws = wsOf(task);
const packId = this.repos.getWorkspace(ws)?.industry_pack_id?? null;
return (
this.repos.resolveRoleForType(task.type, ws, packId)??
TYPE_ROLE[task.type]??
'文案'
);
}

private async processClaim(taskId: string): Promise<void> {
if (this.inFlight.has(taskId)) return;
this.inFlight.add(taskId);
try {
let task = this.repos.getTask(taskId);
if (!task || (task.status!== TaskStatus.PENDING && task.status!== TaskStatus.REJECTED)) return;
const ws = wsOf(task);
const isRedo = task.status === TaskStatus.REJECTED;
const api = this.resolveApiRow(task);

const role = this.roleForTask(task);
const worker = this.repos.teamMember(task.team_id, role, ws);
const reviewer = this.repos.teamMember(task.team_id, '审核', ws);
if (!worker ||!reviewer) {
this.repos.setBlocked(
taskId,
BlockedCode.MISSING_MEMBER,
this.blockedMessage(BlockedCode.MISSING_MEMBER, api, `小组缺少「${role}」或「审核」成员`),
);
return;
}

try {
task = transitionTask(
this.repos,
task,
TaskStatus.RUNNING,
{ assignee_id: worker.id},
this.guardsFor(task),
{ type: 'engine', note: '引擎领取'},
);
} catch (e) {
if (e instanceof DomainError) {
if (e.code === 'CONCURRENCY_FULL') return;
if (e.code === 'BUDGET_EXCEEDED') {
this.toAdjudication(task, `单任务累计 token 已达预算上限 ${this.params(ws).taskBudgetTokens}`);
return;
}
if (e.code === BlockedCode.INSUFFICIENT_BALANCE) {
const reason = this.insufficientReason(task, api);
this.repos.setBlocked(taskId, e.code as BlockedCode, reason);
notifyOwner(
this.repos,
ws,
reason === TRIAL_EXHAUSTED_REASON ? 'trial_exhausted' : 'balance',
reason === TRIAL_EXHAUSTED_REASON ? '体验额度已用完' : '余额不足，任务停工',
`《${task.title}》：${reason}`,
taskId,
);
return;
}
this.repos.setBlocked(taskId, e.code as BlockedCode, this.blockedMessage(e.code, api));
return;
}
throw e;
}
if (!api) return; // transitionTask 守卫已保证 api 存在

/* —— 知识库注入（§10 + §3.3）：候选集在空间层过滤，personal 仅发单人本人 —— */
/* skill 任务并入该 skill 的 kb_binding（§7.2：entryIds/tags 强制入选、scopes 限定层级，仍受同一上限约束） */
let kbBinding: { scopes?: string[]; tags?: string[]; entryIds?: string[]} | null = null;
if (task.skill_id) {
const skillRow = this.repos.getSkill(task.skill_id);
if (skillRow) {
try {
kbBinding = JSON.parse(skillRow.kb_binding || '{}') as typeof kbBinding;
} catch {
kbBinding = null;
}
}
}
const assetSections = resolveAssetSections(this.repos, taskId);
const kbSel = selectKbForInjection(
this.repos.listKb(ws),
{
teamId: task.team_id,
memberId: worker.id,
userId: task.created_by_user_id?? null,
queryText: `${task.title}\n${task.type}\n${task.brief}`,
binding: kbBinding,
assetSections,
},
kbCapTokens(this.params(ws).taskBudgetTokens || 0, task.total_tokens),
);
if (kbSel.assetIds.length) {
this.repos.addTaskInjectedAssets(taskId, kbSel.assetIds);
this.logger.info('engine', `资产注入 ${kbSel.assetIds.length} 份：${kbSel.assetIds.join(', ')}`, { taskId});
}
if (kbSel.entries.length) {
this.repos.addTaskInjectedKb(
taskId,
kbSel.entries.map((e) => e.id),
);
this.logger.info('engine', `知识库注入 ${kbSel.entries.length} 条（估算 ${kbSel.totalTokens} token）`, { taskId});
}

/* —— 执行 / 重做阶段 —— */
const stage = isRedo? ('重做' as const): ('执行' as const);
const workerSys =
worker.persona + (worker.prompt? `\n专属提示词（老板为该成员单独设定，务必遵循）：${worker.prompt}`: '');
// 个人提示词（§6）：仅对发单人本人发的任务拼入个人段
let personalSection = '';
if (task.created_by_user_id) {
const personalPrompt = this.repos.getPreference<string>(task.created_by_user_id, 'personalPrompt', '');
if (personalPrompt) {
personalSection = `\n发单人个人要求（个人偏好，与任务说明冲突时以任务说明为准）：${personalPrompt}`;
}
}
/* 项目内已完成成果（§11.1 流水线上下游衔接）：同项目已交付成果作为上下文注入，估算上限 4000 token */
let projectSection = '';
if (task.project_id) {
const siblings = this.repos
.listTasks(ws)
.filter((t) => t.project_id === task.project_id && t.id !== taskId && t.status === TaskStatus.DONE && t.result)
.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.created_at < b.created_at ? -1 : 1));
const chunks: string[] = [];
let used = 0;
for (const sib of siblings) {
const chunk = `## 项目内已完成成果：《${sib.title}》\n${sib.result}`;
const cost = estimateTokens(chunk);
if (used + cost > 4000) break;
chunks.push(chunk);
used += cost;
}
if (chunks.length) projectSection = '\n以下为同项目已完成的成果，请在产出时衔接引用：\n\n' + chunks.join('\n\n') + '\n\n';
}
let workerUser =
kbSel.section +
projectSection +
`任务标题：${task.title}\n任务类型：${task.type}\n任务说明：\n${task.brief || '（无补充说明）'}` +
personalSection +
'\n请直接产出完整成果正文，不要输出与成果无关的解释。';
if (isRedo) {
workerUser += `\n\n上次成果被审核打回，理由：${task.reject_reason || ''}\n请针对该理由修改，重新产出完整成果。`;
}
let execOut: { text: string};
try {
execOut = await this.gateway.call({
taskId,
teamId: task.team_id,
workspaceId: ws,
api,
stage,
idempotencyKey: `${taskId}:${stage}:${task.reject_count}`,
run: async (provider) => {
const r = await provider.chat({
model: api.model,
system: workerSys,
messages: [{ role: 'user', content: workerUser}],
temperature: TEMPERATURES.EXECUTION,
});
return { text: r.text, usage: r.usage, payload: r.text};
},
});
} catch (e) {
const backTo = isRedo? TaskStatus.REJECTED: TaskStatus.PENDING;
this.repos.updateTaskStatus(taskId, backTo, { heartbeat_at: null});
const code = e instanceof CircuitOpenError? BlockedCode.CIRCUIT_OPEN: BlockedCode.PROVIDER_ERROR;
this.repos.setBlocked(
taskId,
code,
code === BlockedCode.CIRCUIT_OPEN
? this.blockedMessage(code, api)
: `执行调用失败：${e instanceof Error? e.message: String(e)}`,
);
return;
}

let fresh = this.repos.getTask(taskId);
if (!fresh) return;
this.repos.updateTaskStatus(taskId, fresh.status, { result: execOut.text});
fresh = this.repos.getTask(taskId)?? fresh;
if (this.overBudget(fresh)) {
this.toAdjudication(fresh, `单任务累计 token 已超预算上限 ${this.params(ws).taskBudgetTokens}`);
return;
}
transitionTask(this.repos, fresh, TaskStatus.REVIEWING, { heartbeat_at: now()}, undefined, {
type: 'ai_member',
id: worker.id,
note: '执行完成，送审',
});
await this.processReview(taskId, true);
} catch (e) {
this.logger.error('engine', `任务处理异常：${e instanceof Error? e.message: String(e)}`, { taskId});
} finally {
this.inFlight.delete(taskId);
}
}

private async processReview(taskId: string, alreadyHeld = false): Promise<void> {
if (!alreadyHeld) {
if (this.inFlight.has(taskId)) return;
this.inFlight.add(taskId);
}
try {
const task = this.repos.getTask(taskId);
if (!task || task.status!== TaskStatus.REVIEWING) return;
const ws = wsOf(task);
const api = this.resolveApiRow(task);
if (!api) {
this.repos.setBlocked(taskId, BlockedCode.NO_API, this.blockedMessage(BlockedCode.NO_API, null));
return;
}
const reviewer = this.repos.teamMember(task.team_id, '审核', ws);
if (!reviewer) {
this.repos.setBlocked(
taskId,
BlockedCode.MISSING_MEMBER,
this.blockedMessage(BlockedCode.MISSING_MEMBER, api, '小组缺少「审核」成员'),
);
return;
}
const baseStandards = this.repos.getSetting(
'reviewStandards',
{ points: '', clientNeeds: ''},
ws,
);
// 个人审核偏好（§6）：以「附加要点」并入；空间标准为硬约束，冲突时空间为准且结论须注明未采纳项
let standards = baseStandards;
if (task.created_by_user_id) {
const personalPoints = this.repos.getPreference<string>(
task.created_by_user_id,
'reviewPreference',
'',
);
if (personalPoints) {
standards = {
points:
(baseStandards.points || '') +
`\n【发单人附加要点（个人偏好，仅加严不放松）】${personalPoints}\n（附加要点与上方空间硬要点冲突时，以空间硬要点为准，冲突项不采纳并须在审核结论中注明未采纳项）`,
clientNeeds: baseStandards.clientNeeds,
};
}
}

let verdict: { pass: boolean; reason: string};
try {
const out = await this.gateway.call<{ pass: boolean; reason: string}>({
taskId,
teamId: task.team_id,
workspaceId: ws,
api,
stage: '审核',
idempotencyKey: `${taskId}:审核:${task.reject_count}`,
run: async (provider) => {
const r = await provider.review({
model: api.model,
persona: reviewer.persona,
standards,
draft: task.result,
taskTitle: task.title,
taskBrief: task.brief,
temperature: TEMPERATURES.REVIEW,
});
return {
text: JSON.stringify({ pass: r.pass, reason: r.reason}),
usage: r.usage,
payload: { pass: r.pass, reason: r.reason},
};
},
});
verdict = out.payload;
} catch (e) {
const code = e instanceof CircuitOpenError? BlockedCode.CIRCUIT_OPEN: BlockedCode.PROVIDER_ERROR;
this.repos.setBlocked(
taskId,
code,
code === BlockedCode.CIRCUIT_OPEN
? this.blockedMessage(code, api)
: `审核调用失败：${e instanceof Error? e.message: String(e)}`,
);
return; // 保持 reviewing，下个 tick 从审核阶段续跑（不重跑执行）
}

const fresh = this.repos.getTask(taskId);
if (!fresh) return;
if (this.overBudget(fresh)) {
this.toAdjudication(fresh, `单任务累计 token 已超预算上限 ${this.params(ws).taskBudgetTokens}`);
return;
}
if (verdict.pass) {
transitionTask(
this.repos,
fresh,
TaskStatus.DONE,
{
review_note: verdict.reason || '符合标准',
finished_at: now(),
blocked_code: null,
blocked_reason: '',
heartbeat_at: null,
},
undefined,
{ type: 'ai_member', id: reviewer.id, note: '审核通过'},
);
refreshProjectStatus(this.repos, fresh.project_id);
this.logger.info('engine', '任务完成', { taskId});
} else {
const rejectCount = fresh.reject_count + 1;
if (rejectCount >= MAX_REJECTS_BEFORE_ADJUDICATION) {
transitionTask(
this.repos,
fresh,
TaskStatus.ADJUDICATION,
{
reject_count: rejectCount,
reject_reason: verdict.reason || '未说明理由',
heartbeat_at: null,
},
undefined,
{ type: 'ai_member', id: reviewer.id, note: '审核打回满次转裁决'},
);
refreshProjectStatus(this.repos, fresh.project_id);
notifyOwner(this.repos, ws, 'reject_max', '任务打回满次待裁决', `《${fresh.title}》已被审核打回 ${rejectCount} 次，转待裁决，请到任务墙处理`, taskId);
this.logger.warn('engine', `打回满 ${MAX_REJECTS_BEFORE_ADJUDICATION} 次，转待裁决`, { taskId});
} else {
transitionTask(
this.repos,
fresh,
TaskStatus.REJECTED,
{
reject_count: rejectCount,
reject_reason: verdict.reason || '未说明理由',
heartbeat_at: null,
},
undefined,
{ type: 'ai_member', id: reviewer.id, note: '审核打回'},
);
this.logger.info('engine', `审核打回第 ${rejectCount} 次`, { taskId});
}
}
} catch (e) {
this.logger.error('engine', `审核处理异常：${e instanceof Error? e.message: String(e)}`, { taskId});
} finally {
if (!alreadyHeld) this.inFlight.delete(taskId);
}
}
}
