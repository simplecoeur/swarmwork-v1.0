import { TaskStatus, type SkillInputFieldDto, type SkillKbBindingDto} from '@swarm/shared';
import { nowIso, uid} from '../util';
import type { Repos, SkillRow, TaskRow} from '../store/repositories';
import { DomainError} from './taskService';

/**
* skill 域服务（方案 §7）：skill 渲染成普通任务进现有状态机/账本，引擎与审核机制全复用。
* 渲染 = 参数校验（必填/默认值）→ 模板 {{key}} 占位替换 → 拼 output_spec 与已验证做法备注。
* 任务上落 skill_id + skill_version + skill_params 快照，保证可追溯与一键再发。
*/

export function parseInputSchema(json: string): SkillInputFieldDto[] {
try {
const v = JSON.parse(json || '[]') as unknown;
if (!Array.isArray(v)) return [];
return v.filter(
(f): f is SkillInputFieldDto =>
!!f && typeof f === 'object' && typeof (f as SkillInputFieldDto).key === 'string',
);
} catch {
return [];
}
}

export function parseKbBinding(json: string): SkillKbBindingDto {
try {
const v = JSON.parse(json || '{}') as SkillKbBindingDto;
return v && typeof v === 'object'? v: {};
} catch {
return {};
}
}

export function parseJsonObject(json: string): Record<string, unknown> {
try {
const v = JSON.parse(json || '{}') as unknown;
return v && typeof v === 'object' &&!Array.isArray(v)? (v as Record<string, unknown>): {};
} catch {
return {};
}
}

/** 参数合并：schema 默认值 ← 实际入参；必填缺失抛 VALIDATION（消息指明字段） */
export function mergeSkillParams(
skill: SkillRow,
params: Record<string, unknown> | undefined,
): Record<string, unknown> {
const fields = parseInputSchema(skill.input_schema);
const given = params?? {};
const out: Record<string, unknown> = {...given};
for (const f of fields) {
const v = out[f.key];
if ((v === undefined || v === null || v === '') && f.default!== undefined) {
out[f.key] = f.default;
}
const finalV = out[f.key];
if (f.required && (finalV === undefined || finalV === null || finalV === '')) {
throw new DomainError('VALIDATION', `参数「${f.label || f.key}」必填`);
}
if (f.type === 'select' && Array.isArray(f.options) && f.options.length && finalV!== undefined && finalV!== '') {
if (!f.options.includes(String(finalV))) {
throw new DomainError('VALIDATION', `参数「${f.label || f.key}」必须是可选值之一`);
}
}
}
return out;
}

export function renderTemplate(template: string, params: Record<string, unknown>): string {
return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) => {
const v = params[key];
if (v === undefined || v === null) return '';
if (typeof v === 'boolean') return v? '是': '否';
return String(v);
});
}

/** 渲染 brief：模板正文 + 输出规格段 + 已验证做法段（飞轮沉淀，§11.5） */
export function renderSkillBrief(skill: SkillRow, params: Record<string, unknown>): string {
let brief = renderTemplate(skill.prompt_template, params);
if (skill.output_spec.trim()) {
brief += `\n\n\n${skill.output_spec.trim()}`;
}
if (skill.verified_notes.trim()) {
brief += `\n\n\n${skill.verified_notes.trim()}`;
}
return brief;
}

/** skill 工种 → 任务类型：注册表中找 role 匹配的任务类型（空间自定义优先），找不到回退 */
export function resolveTypeForSkill(repos: Repos, skill: SkillRow, workspaceId: string): string {
const ws = repos.getWorkspace(workspaceId);
const packId = ws?.industry_pack_id?? null;
const types = repos.listTaskTypesVisible(workspaceId, packId);
const own = types.find((t) => t.workspace_id === workspaceId && t.role_id === skill.role);
const any = types.find((t) => t.role_id === skill.role);
if (own) return own.type_id;
if (any) return any.type_id;
if (types.some((t) => t.type_id === skill.role)) return skill.role;
return types[0]?.type_id?? '文案';
}

export interface SkillDispatchInput {
skill: SkillRow;
params?: Record<string, unknown>;
teamId: string;
projectId?: string | null;
workspaceId: string;
userId: string | null;
isTest?: boolean;
titleOverride?: string;
}

/** 由 skill 生成一单（发单/试运行/再发共用）：渲染 brief、落 skill 快照、写发单事件 */
export function createTaskFromSkill(repos: Repos, input: SkillDispatchInput): TaskRow {
const { skill, workspaceId} = input;
const team = repos.getTeam(input.teamId, workspaceId);
if (!team) throw new DomainError('VALIDATION', '小组不存在');
const params = mergeSkillParams(skill, input.params);
const type = resolveTypeForSkill(repos, skill, workspaceId);
const role = repos.resolveRoleForType(type, workspaceId, repos.getWorkspace(workspaceId)?.industry_pack_id?? null)?? skill.role;
const worker = repos.teamMember(team.id, role, workspaceId);
const id = uid('task');
const row: TaskRow = {
id,
project_id: input.projectId?? null,
team_id: team.id,
assignee_id: worker?.id?? null,
title: input.titleOverride || (input.isTest? `${skill.name}`: skill.name),
type,
brief: renderSkillBrief(skill, params),
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
workspace_id: workspaceId,
created_by_user_id: input.userId,
skill_id: skill.id,
skill_version: skill.version,
skill_params: JSON.stringify(params),
is_skill_test: input.isTest? 1: 0,
};
repos.insertTask(row);
repos.insertTaskEvent({
task_id: id,
workspace_id: workspaceId,
actor_type: 'user',
actor_id: input.userId,
from_status: null,
to_status: TaskStatus.PENDING,
note: input.isTest? `skill 试运行发单（${skill.name} v${skill.version}）`: `skill 发单（${skill.name} v${skill.version}）`,
});
return row;
}

/** 快照复制（§7.4 安装口径）：内容整份复制、与源头脱钩，记 source 与源版本 */
export function copySkillSnapshot(
repos: Repos,
src: SkillRow,
workspaceId: string,
userId: string | null,
): SkillRow {
const ts = nowIso();
const row: SkillRow = {
...src,
id: uid('skill'),
owner_type: 'workspace',
owner_id: null,
workspace_id: workspaceId,
status: 'published',
visibility: 'workspace',
source_skill_id: src.id,
source_version: src.version,
install_count: 0,
created_by: userId,
created_at: ts,
updated_at: ts,
};
repos.insertSkill(row);
repos.bumpSkillInstallCount(src.id);
return row;
}

/** skill 可见性（发单/查看口径）：本空间自有行 / 平台库行（官方或已上架） */
export function skillVisibleToWorkspace(skill: SkillRow, workspaceId: string): boolean {
if (skill.workspace_id === workspaceId) return true;
if (skill.status!== 'published') return false;
return skill.owner_type === 'platform' || skill.visibility === 'public';
}
