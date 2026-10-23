import { KB_INJECTION} from '@swarm/shared';
import { estimateTokens} from '../llm/parse';
import type { KbRow, Repos} from '../store/repositories';
import { nowIso, uid} from '../util';

/**
 * 条目创建的统一落库口径（手建 POST /api/kb 与 G-06 文件导入 confirm 共用同一行形）：
 * scope/scopeId/workspace/owner 的归一化由调用方按路由层口径完成，本函数只负责组行 + 落库。
 */
export interface CreateKbEntryInput {
title: string;
body: string;
/** 已归一化的 scope（member 已折算为 personal） */
scope: string;
scopeId: string | null;
tags: string[];
enabled: boolean;
/** platform 条目为 null，其余为当前空间 */
workspaceId: string | null;
ownerUserId: string | null;
}

export function createKbEntry(repos: Repos, input: CreateKbEntryInput): KbRow {
const ts = nowIso();
const row: KbRow = {
id: uid('kb'),
title: input.title,
body: input.body,
scope: input.scope,
scope_id: input.scopeId,
tags: JSON.stringify(input.tags),
enabled: input.enabled? 1: 0,
created_at: ts,
updated_at: ts,
workspace_id: input.workspaceId,
owner_user_id: input.ownerUserId,
};
repos.insertKb(row);
return row;
}

/**
* 知识库检索与注入组装（设计 §10 + §15.1，一期关键词方案，向量检索在二期）：
* - 候选范围：公司级（全量，不要求关键词命中——公司标准全文注入）+
* 小组级/成员级中与任务标题/类型/说明关键词命中的条目；禁用条目一律排除；
* 他人成员级条目不注入（成员级为本人专属），他组条目可命中但优先级最低（§13 跨组引用）。
* - 优先级（§15.1）：公司标准 > 本组资料 > 本人资料 > 他组资料，同级按创建时间 FIFO。
* - 上限：注入总量 ≤ 任务剩余预算的 30%；无预算上限时固定 8k token。
* 按优先级逐条纳入（整条计入，超限跳过该条继续看后续更小的条），token 按 llm/parse 同口径估算。
*/

/** skill 知识绑定（§7.2）：执行时并入注入候选集——entryIds/tags 命中者强制入选并提优先，scopes 限定候选层级 */
export interface KbBindingFilter {
scopes?: string[];
tags?: string[];
entryIds?: string[];
}

/** 飞轮已验证规律标签（§11.5）：带此标签的条目在注入排序中高于未验证的历史成果 */
export const VERIFIED_RULE_TAG = '爆款规律';

export interface KbContext {
teamId: string;
/** 执行成员 id（成员级范围按此匹配） */
memberId: string | null;
/** 发单人（登录用户 id）：personal 条目仅注入本人发的任务（M6 §3.3） */
userId?: string | null;
/** 检索文本：任务标题 + 类型 + 说明拼接 */
queryText: string;
/** 任务引用的 skill 的 kb_binding（M7） */
binding?: KbBindingFilter | null;
/** 任务显式引用的资产分段（M8 §11.4）：强制入选、优先级仅次于平台公共 */
assetSections?: Array<{ id: string; text: string }> | null;
}

/** 关键词抽取：英文/数字词（≥2 字符，小写）+ 中文连续片段及其 2 字 bigram */
export function extractKeywords(text: string): string[] {
const out = new Set<string>();
const lower = (text || '').toLowerCase();
for (const m of lower.matchAll(/[a-z0-9][a-z0-9_-]+/g)) out.add(m[0]);
for (const m of lower.matchAll(/[一-鿿]+/g)) {
const run = m[0];
if (run.length <= 2) {
out.add(run);
} else {
for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
}
}
return [...out];
}

function parseTags(tagsJson: string): string[] {
try {
const v = JSON.parse(tagsJson || '[]') as unknown;
return Array.isArray(v)? v.filter((t): t is string => typeof t === 'string'): [];
} catch {
return [];
}
}

/** 条目是否被任一关键词命中（标题/tags/正文，大小写不敏感子串匹配） */
export function kbMatches(entry: KbRow, keywords: string[]): boolean {
if (!keywords.length) return false;
const hay = `${entry.title}\n${parseTags(entry.tags).join(' ')}\n${entry.body}`.toLowerCase();
return keywords.some((k) => k.length > 0 && hay.includes(k));
}

/**
 * 范围优先级：数值越小越优先；-1 表示不纳入候选。
 * M6 注入优先级（§3.3）：平台公共 > 本空间公司级 > 本组资料 > 发单人个人资料 > 他组资料。
 * platform 用 -1 档（与「不纳入」的 -1 区分靠 selectKbForInjection 中 rank<0 的判定只针对 personal/member 他人条目，
 * 故 platform 单独用 -2 表示最高优先）。
 * personal：owner_user_id 有值时仅发单人本人命中；存量折算条目（owner 为空）按 scope_id 的 AI 成员映射尽力匹配。
 */
export function kbScopeRank(entry: KbRow, ctx: KbContext): number {
if (entry.scope === 'platform') return -2;
if (entry.scope === 'company') return 0;
if (entry.scope === 'team') return entry.scope_id === ctx.teamId? 1: 3;
if (entry.scope === 'personal' || entry.scope === 'member') {
if (entry.owner_user_id) return ctx.userId && entry.owner_user_id === ctx.userId? 2: -1;
return ctx.memberId && entry.scope_id === ctx.memberId? 2: -1;
}
return -1;
}

/** 单条注入文本（与最终拼进 prompt 的片段一致，token 估算以此为准） */
export function formatKbEntry(entry: KbRow): string {
return `## ${entry.title}\n${entry.body}`;
}

export interface KbSelection {
entries: KbRow[];
/** 实际注入的资产 id 列表（M8，按引用顺序、受上限裁剪后的结果） */
assetIds: string[];
/** 注入文本总估算 token（各条 formatKbEntry 之和） */
totalTokens: number;
/** 拼好的知识库 prompt 片段（无入选条目时为空串） */
section: string;
}

/**
* 注入上限（§15.1）：有单任务预算时取「剩余预算（预算 − 已消耗）」的 30%（向下取整），
* 无预算上限（budgetTokens ≤ 0）时取固定 8k。
*/
export function kbCapTokens(budgetTokens: number, usedTokens: number): number {
if (budgetTokens > 0) {
return Math.max(0, Math.floor((budgetTokens - usedTokens) * KB_INJECTION.BUDGET_SHARE));
}
return KB_INJECTION.NO_BUDGET_CAP_TOKENS;
}

export function selectKbForInjection(entries: KbRow[], ctx: KbContext, capTokens: number): KbSelection {
const keywords = extractKeywords(ctx.queryText);
const binding = ctx.binding ?? null;
const boundIds = new Set(binding?.entryIds ?? []);
const boundTags = new Set(binding?.tags ?? []);
const boundScopes = binding?.scopes?.length ? new Set(binding.scopes) : null;
const candidates = entries
.filter((e) => e.enabled === 1)
.filter((e) => !boundScopes || boundScopes.has(e.scope))
.map((e) => {
const rank = kbScopeRank(e, ctx);
const tags = parseTags(e.tags);
const forced = boundIds.has(e.id) || tags.some((t) => boundTags.has(t));
// 排序档：平台公共 -3 < skill 绑定强制 -2 < 已验证规律 -1（§11.5：高于未验证历史成果）< 原 scope 档
let sortRank = rank;
if (forced) sortRank = -2;
else if (tags.includes(VERIFIED_RULE_TAG)) sortRank = Math.min(rank, -1);
return { e, rank, sortRank, forced};
})
.filter(({ rank, forced}) => rank !== -1 || forced)
.filter(({ e, rank, forced}) => forced || rank <= 0 || kbMatches(e, keywords))
.sort((a, b) => a.sortRank - b.sortRank || (a.e.created_at < b.e.created_at? -1: a.e.created_at > b.e.created_at? 1: a.e.id < b.e.id? -1: 1));

const picked: KbRow[] = [];
let total = 0;
for (const { e} of candidates) {
const cost = estimateTokens(formatKbEntry(e));
if (total + cost > capTokens) continue; // 超限跳过该条，后续更小的条仍可纳入
picked.push(e);
total += cost;
}

// 资产分段（M8 §11.4）：整份引用、与知识条目共用同一注入上限，点名引用的部分优先（排在知识段之前组装）
const assetTexts: string[] = [];
const assetIds: string[] = [];
for (const s of ctx.assetSections ?? []) {
const cost = estimateTokens(s.text);
if (total + cost > capTokens) continue;
assetTexts.push(s.text);
assetIds.push(s.id);
total += cost;
}

const parts: string[] = [];
if (assetTexts.length) {
parts.push('\n以下为本任务引用的资产内容，请在产出时严格依据（与任务说明冲突时以任务说明为准）：\n\n' + assetTexts.join('\n\n'));
}
if (picked.length) {
parts.push('\n以下资料来自公司知识库，请在产出时参考（与任务说明冲突时以任务说明为准）：\n\n' + picked.map(formatKbEntry).join('\n\n'));
}
const section = parts.length ? parts.join('\n') + '\n\n' : '';
return { entries: picked, assetIds, totalTokens: total, section};
}
