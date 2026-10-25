import type { FastifyInstance} from 'fastify';
import {
ErrorCode,
TaskStatus,
milliToYuan,
type AssetDto,
type AssetTypeDto,
type NotificationDto,
type OutcomeMarkDto,
type PipelineTemplateDto,
} from '@swarm/shared';
import { assetDtoOf } from '../domain/assetService';
import { VERIFIED_RULE_TAG} from '../domain/kbService';
import { PIPELINE_TEMPLATES, findSkillBySlugForWorkspace, runPipeline} from '../domain/pipelineService';
import { createTaskFromSkill, parseJsonObject, skillVisibleToWorkspace} from '../domain/skillService';
import type { Logger} from '../logger';
import type { AssetRow, Repos, TaskRow} from '../store/repositories';
import { nowIso, uid} from '../util';
import {
assetSaveSchema,
assetTypeSaveSchema,
notifyConfigSchema,
outcomeSchema,
pipelineRunSchema,
redispatchSchema,
sedimentSchema,
} from './schemas';
import type { M7Helpers, RouteCtx} from './m7';

function fail(code: string, message: string, status = 400): never {
throw Object.assign(new Error(message), { code, statusCode: status});
}

function markDto(m: {
id: number;
task_id: string;
verdict: string;
metrics: string;
note: string;
created_by: string | null;
created_at: string;
}): OutcomeMarkDto {
return {
id: m.id,
taskId: m.task_id,
verdict: m.verdict as OutcomeMarkDto['verdict'],
metrics: parseJsonObject(m.metrics) as Record<string, number>,
note: m.note,
createdBy: m.created_by,
createdAt: m.created_at,
};
}

export function registerM8Routes(
app: FastifyInstance,
deps: { repos: Repos; logger: Logger},
helpers: M7Helpers,
): void {
const { repos, logger} = deps;
const { wsAuth, audit} = helpers;

const getTaskOr404 = (ctx: RouteCtx & { workspaceId: string}, id: string): TaskRow => {
const t = repos.getTask(id, ctx.workspaceId);
if (!t) fail(ErrorCode.NOT_FOUND, '任务不存在', 404);
return t!;
};

/* ================= 资产库（§11.4 / §12.3） ================= */
app.get('/api/asset-types', async (req) => {
const ctx = wsAuth(req);
const packId = repos.getWorkspace(ctx.workspaceId)?.industry_pack_id?? null;
const types: AssetTypeDto[] = repos.listAssetTypesVisible(ctx.workspaceId, packId).map((t) => ({
typeId: t.type_id,
name: t.name,
structureSchema: parseJsonObject(t.structure_schema),
industry: t.industry,
packId: t.pack_id,
workspaceId: t.workspace_id,
}));
return { ok: true, assetTypes: types};
});

app.post('/api/asset-types', async (req) => {
const ctx = wsAuth(req);
const { assetType: b} = assetTypeSaveSchema.parse(req.body?? {});
const typeId = b.typeId?? b.name;
const packId = repos.getWorkspace(ctx.workspaceId)?.industry_pack_id?? null;
if (repos.listAssetTypesVisible(ctx.workspaceId, packId).some((t) => t.type_id === typeId)) {
fail(ErrorCode.VALIDATION, `资产类型「${typeId}」已注册`);
}
repos.insertAssetType({
id: uid('at'),
type_id: typeId,
name: b.name,
structure_schema: JSON.stringify(b.structureSchema),
industry: null,
pack_id: null,
workspace_id: ctx.workspaceId,
created_at: nowIso(),
});
audit(req, ctx, 'create_asset_type', 'asset_type', typeId);
return { ok: true, typeId};
});

app.get('/api/assets', async (req) => {
const ctx = wsAuth(req);
return { ok: true, assets: repos.listAssets(ctx.workspaceId).map(assetDtoOf) as AssetDto[]};
});

app.post('/api/assets', async (req) => {
const ctx = wsAuth(req);
const { asset: b} = assetSaveSchema.parse(req.body?? {});
const packId = repos.getWorkspace(ctx.workspaceId)?.industry_pack_id?? null;
if (!repos.listAssetTypesVisible(ctx.workspaceId, packId).some((t) => t.type_id === b.typeId)) {
fail(ErrorCode.VALIDATION, `资产类型「${b.typeId}」未在注册表中登记`);
}
const ts = nowIso();
const row: AssetRow = {
id: uid('asset'),
workspace_id: ctx.workspaceId,
type_id: b.typeId,
name: b.name,
version: 1,
content: JSON.stringify(b.content),
created_by: ctx.user.id,
created_at: ts,
updated_at: ts,
};
repos.insertAsset(row);
audit(req, ctx, 'create_asset', 'asset', row.id, row.name);
return { ok: true, id: row.id, asset: assetDtoOf(row)};
});

app.put('/api/assets/:id', async (req) => {
const ctx = wsAuth(req);
const { id} = req.params as { id: string};
const cur = repos.getAsset(id, ctx.workspaceId);
if (!cur) fail(ErrorCode.NOT_FOUND, '资产不存在', 404);
const { asset: b} = assetSaveSchema.parse(req.body?? {});
const contentChanged = JSON.stringify(b.content)!== cur!.content;
const next: AssetRow = {
...cur!,
type_id: b.typeId,
name: b.name,
content: JSON.stringify(b.content),
version: contentChanged? cur!.version + 1: cur!.version,
updated_at: nowIso(),
};
repos.updateAsset(next);
if (contentChanged) repos.insertAssetVersion(next.id, next.version, next.content);
audit(req, ctx, 'update_asset', 'asset', id, `v${next.version}`);
return { ok: true, asset: assetDtoOf(next)};
});

app.get('/api/assets/:id/versions/:version', async (req) => {
const ctx = wsAuth(req);
const { id, version} = req.params as { id: string; version: string};
if (!repos.getAsset(id, ctx.workspaceId)) fail(ErrorCode.NOT_FOUND, '资产不存在', 404);
const content = repos.getAssetVersion(id, Number(version));
if (content === undefined) fail(ErrorCode.NOT_FOUND, '该版本不存在', 404);
return { ok: true, assetId: id, version: Number(version), content: JSON.parse(content!) as unknown};
});

/* ================= 成果库 + 飞轮（§5.1 / §11.5） ================= */
app.get('/api/results', async (req) => {
const ctx = wsAuth(req);
const q = (req.query?? {}) as { q?: string; skillId?: string; projectId?: string; verified?: string};
let tasks = repos
.listTasks(ctx.workspaceId)
.filter((t) => t.status === TaskStatus.DONE);
if (q.skillId) tasks = tasks.filter((t) => t.skill_id === q.skillId);
if (q.projectId) tasks = tasks.filter((t) => t.project_id === q.projectId);
if (q.q) {
const needle = q.q.toLowerCase();
tasks = tasks.filter(
(t) => t.title.toLowerCase().includes(needle) || t.result.toLowerCase().includes(needle),
);
}
const withMarks = tasks.map((t) => ({ task: t, mark: repos.latestOutcomeMark(t.id)}));
const filtered =
q.verified === '1'
? withMarks.filter((x) => x.mark?.verdict === 'effective')
: withMarks;
return {
ok: true,
results: filtered.map(({ task, mark}) => ({
taskId: task.id,
title: task.title,
type: task.type,
projectId: task.project_id,
skillId: task.skill_id,
skillVersion: task.skill_version,
result: task.result,
totalTokens: task.total_tokens,
totalCostYuan: milliToYuan(task.total_cost_milli),
finishedAt: task.finished_at,
mark: mark? markDto(mark): null,
})),
};
});

app.post('/api/tasks/:id/outcome', async (req) => {
const ctx = wsAuth(req);
const { id} = req.params as { id: string};
const task = getTaskOr404(ctx, id);
if (task.status!== TaskStatus.DONE) fail(ErrorCode.VALIDATION, '只有已完成的成果可标记渠道表现');
const body = outcomeSchema.parse(req.body?? {});
const markId = repos.insertOutcomeMark({
task_id: id,
workspace_id: ctx.workspaceId,
verdict: body.verdict,
metrics: JSON.stringify(body.metrics),
note: body.note,
created_by: ctx.user.id,
created_at: nowIso(),
});
audit(req, ctx, 'mark_outcome', 'task', id, `${body.verdict} ${JSON.stringify(body.metrics)}`);
return { ok: true, id: markId};
});

app.post('/api/tasks/:id/sediment', async (req) => {
const ctx = wsAuth(req);
const { id} = req.params as { id: string};
const task = getTaskOr404(ctx, id);
if (task.status!== TaskStatus.DONE) fail(ErrorCode.VALIDATION, '只有已完成的成果可沉淀');
const mark = repos.latestOutcomeMark(id);
if (!mark || mark.verdict!== 'effective') {
fail(ErrorCode.VALIDATION, '只有标记为「有效」的成果可沉淀（先在成果库打有效标记）');
}
const body = sedimentSchema.parse(req.body?? {});
const metricsText = Object.entries(parseJsonObject(mark.metrics))
.map(([k, v]) => `${k}=${v}`)
.join('，');
if (body.target === 'kb') {
const ts = nowIso();
const kbId = uid('kb');
repos.insertKb({
id: kbId,
title: task.title,
body:
`${task.result}\n\n该成果经渠道数据验证有效${metricsText? `（${metricsText}）`: ''}。` +
(body.note? `\n沉淀备注：${body.note}`: ''),
scope: 'company',
scope_id: null,
tags: JSON.stringify([VERIFIED_RULE_TAG, '已验证']),
enabled: 1,
created_at: ts,
updated_at: ts,
workspace_id: ctx.workspaceId,
owner_user_id: null,
});
audit(req, ctx, 'sediment_kb', 'task', id, kbId);
logger.info('flywheel', '成果沉淀为已验证规律知识条目', { taskId: id, kbId});
return { ok: true, target: 'kb', id: kbId};
}
if (!task.skill_id) fail(ErrorCode.VALIDATION, '该成果不是 skill 产出，无法沉淀到 skill（可选沉淀到知识库）');
const skill = repos.getSkill(task.skill_id);
if (!skill) fail(ErrorCode.NOT_FOUND, '成果对应的 skill 已不存在', 404);
const line = `- [${nowIso().slice(0, 10)}] 《${task.title}》经验证有效${metricsText? `（${metricsText}）`: ''}${body.note? `：${body.note}`: ''}`;
repos.updateSkill({
...skill!,
verified_notes: skill!.verified_notes? `${skill!.verified_notes}\n${line}`: line,
updated_at: nowIso(),
});
audit(req, ctx, 'sediment_skill', 'task', id, task.skill_id);
return { ok: true, target: 'skill', id: task.skill_id};
});

/** 一键再发（§5.1）：skill 单带原参数重发（可改参数），普通单按原标题/说明克隆 */
app.post('/api/tasks/:id/redispatch', async (req) => {
const ctx = wsAuth(req);
const { id} = req.params as { id: string};
const src = getTaskOr404(ctx, id);
const body = redispatchSchema.parse(req.body?? {});
const teamId = body.teamId?? src.team_id;
if (src.skill_id) {
const skill = repos.getSkill(src.skill_id);
if (!skill ||!skillVisibleToWorkspace(skill, ctx.workspaceId)) {
fail(ErrorCode.VALIDATION, '原任务引用的 skill 已不可用，无法一键再发');
}
const params = body.params?? parseJsonObject(src.skill_params?? '{}');
const task = createTaskFromSkill(repos, {
skill: skill!,
params,
teamId,
workspaceId: ctx.workspaceId,
userId: ctx.user.id,
titleOverride: body.title,
});
audit(req, ctx, 'redispatch_task', 'task', task.id, `源任务 ${id}`);
return { ok: true, id: task.id};
}
const team = repos.getTeam(teamId, ctx.workspaceId);
if (!team) fail(ErrorCode.VALIDATION, '小组不存在');
const role =
repos.resolveRoleForType(src.type, ctx.workspaceId, repos.getWorkspace(ctx.workspaceId)?.industry_pack_id?? null)?? '文案';
const worker = repos.teamMember(team.id, role, ctx.workspaceId);
const newId = uid('task');
repos.insertTask({
id: newId,
project_id: null,
team_id: team.id,
assignee_id: worker?.id?? null,
title: body.title?? src.title,
type: src.type,
brief: src.brief,
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
created_at: nowIso(),
claimed_at: null,
finished_at: null,
workspace_id: ctx.workspaceId,
created_by_user_id: ctx.user.id,
skill_id: null,
skill_version: null,
});
repos.insertTaskEvent({
task_id: newId,
workspace_id: ctx.workspaceId,
actor_type: 'user',
actor_id: ctx.user.id,
from_status: null,
to_status: TaskStatus.PENDING,
note: `一键再发（源任务 ${id}）`,
});
for (const ref of repos.listTaskAssetRefs(id)) {
repos.insertTaskAssetRef({
task_id: newId,
workspace_id: ctx.workspaceId,
asset_id: ref.asset_id,
asset_version: ref.asset_version,
sections: ref.sections,
created_at: nowIso(),
});
}
audit(req, ctx, 'redispatch_task', 'task', newId, `源任务 ${id}`);
return { ok: true, id: newId};
});

/* ================= 工作台账（§5.1） ================= */
app.get('/api/ledger-view', async (req) => {
const ctx = wsAuth(req);
const events = repos.listTaskEventsByWorkspace(ctx.workspaceId).map((e) => ({
ts: String(e.created_at),
kind: 'task_event' as const,
taskId: String(e.task_id),
text: `任务 ${String(e.task_id)}：${String(e.from_status?? '（新建）')} → ${String(e.to_status)}${e.note? `（${String(e.note)}）`: ''}`,
actorType: String(e.actor_type),
}));
const audits = repos.listAuditByWorkspace(ctx.workspaceId).map((a) => ({
ts: String(a.created_at),
kind: 'audit' as const,
taskId: null as string | null,
text: `操作 ${String(a.action)}${a.target_id? ` → ${String(a.target_id)}`: ''}${a.detail? `（${String(a.detail)}）`: ''}`,
actorType: 'user',
}));
const timeline = [...events,...audits].sort((a, b) => (a.ts < b.ts? 1: -1)).slice(0, 200);
return { ok: true, timeline};
});

app.get('/api/ledger-view/export', async (req, reply) => {
const ctx = wsAuth(req);
const month = ((req.query as { month?: string})?.month?? '').trim();
if (!/^\d{4}-\d{2}$/.test(month)) fail(ErrorCode.VALIDATION, '需要 month=YYYY-MM');
const rows = repos
.listLedger(ctx.workspaceId)
.filter((l) => l.created_at.startsWith(month));
const head = '时间,任务ID,小组ID,API,阶段,prompt_tokens,completion_tokens,total_tokens,成本(元),估算';
const lines = rows.map((l) =>
[
l.created_at,
l.task_id,
l.team_id,
l.api_id,
l.stage,
l.prompt_tokens,
l.completion_tokens,
l.total_tokens,
milliToYuan(l.cost_milli),
l.estimated === 1? '是': '否',
].join(','),
);
reply.header('content-type', 'text/csv; charset=utf-8');
reply.header('content-disposition', `attachment; filename="ledger-${month}.csv"`);
return reply.send([head,...lines].join('\n') + '\n');
});

/* ================= 成套流水线（§11.1） ================= */
app.get('/api/pipelines/templates', async (req) => {
const ctx = wsAuth(req);
const templates: PipelineTemplateDto[] = PIPELINE_TEMPLATES.map((t) => ({
id: t.id,
name: t.name,
industry: t.industry,
description: t.description,
commonParams: t.commonParams,
steps: t.steps.map((s) => ({
skillSlug: s.skillSlug,
title: s.title,
available:!!findSkillBySlugForWorkspace(repos, ctx.workspaceId, s.skillSlug),
})),
}));
return { ok: true, templates};
});

app.post('/api/pipelines/run', async (req) => {
const ctx = wsAuth(req);
const body = pipelineRunSchema.parse(req.body?? {});
const template = PIPELINE_TEMPLATES.find((t) => t.id === body.templateId);
if (!template) fail(ErrorCode.NOT_FOUND, '流水线模板不存在', 404);
const { projectId, taskIds} = runPipeline(repos, {
template: template!,
teamId: body.teamId,
name: body.name,
params: body.params,
workspaceId: ctx.workspaceId,
userId: ctx.user.id,
});
audit(req, ctx, 'run_pipeline', 'project', projectId, template!.name);
logger.info('pipeline', `流水线「${template!.name}」生成项目与 ${taskIds.length} 条子任务`, { taskId: projectId});
return { ok: true, projectId, taskIds};
});

/* ================= 站内提醒（§9 M8） ================= */
app.get('/api/notifications', async (req) => {
const ctx = wsAuth(req);
// G-03：分页（?page=&pageSize=）+ 按 type 过滤（?type=）；无参数时保持旧口径（第一页 20 条）
const q = (req.query?? {}) as { type?: string; page?: string; pageSize?: string};
const page = Math.max(1, Number(q.page?? 1) || 1);
const pageSize = Math.min(100, Math.max(1, Number(q.pageSize?? 20) || 20));
const { rows, total} = repos.listNotificationsPaged(ctx.workspaceId, {
type: q.type? String(q.type): undefined,
page,
pageSize,
});
const notifications: NotificationDto[] = rows.map((n) => ({
id: n.id,
type: n.type,
title: n.title,
body: n.body,
taskId: n.task_id,
readAt: n.read_at,
createdAt: n.created_at,
}));
return { ok: true, notifications, unread: repos.countUnreadNotifications(ctx.workspaceId), total, page, pageSize};
});

app.post('/api/notifications/:id/read', async (req) => {
const ctx = wsAuth(req);
const { id} = req.params as { id: string};
repos.markNotificationRead(Number(id), ctx.workspaceId);
return { ok: true, unread: repos.countUnreadNotifications(ctx.workspaceId)};
});

app.post('/api/notifications/read-all', async (req) => {
const ctx = wsAuth(req);
repos.markAllNotificationsRead(ctx.workspaceId);
return { ok: true, unread: 0};
});

/** 通知配置位：站内提醒开关 + 邮件地址（邮件通道二期，本版仅存配置、不发信） */
app.get('/api/notifications/settings', async (req) => {
const ctx = wsAuth(req);
const cfg = repos.getSetting('notifyConfig', { emailEnabled: false, email: ''}, ctx.workspaceId);
return { ok: true, config: cfg, mailChannel: 'reserved-not-implemented'};
});
app.put('/api/notifications/settings', async (req) => {
const ctx = wsAuth(req);
const body = notifyConfigSchema.parse(req.body?? {});
repos.setSetting('notifyConfig', body, ctx.workspaceId);
return { ok: true, config: body};
});

}
