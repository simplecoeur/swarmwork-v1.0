import { describe, expect, it} from 'vitest';
import {
extractKeywords,
formatKbEntry,
kbCapTokens,
kbMatches,
kbScopeRank,
selectKbForInjection,
type KbContext,
} from '../../src/domain/kbService';
import { estimateTokens} from '../../src/llm/parse';
import type { KbRow} from '../../src/store/repositories';

/**
* 知识库一期单元测试（设计 §10 + §15.1）：
* 关键词命中（标题/tags/正文）、范围优先级、禁用过滤、注入上限截断、公司标准免关键词。
*/
let seq = 0;
function entry(patch: Partial<KbRow>): KbRow {
seq += 1;
const ts = new Date(1_700_000_000_000 + seq * 1000).toISOString();
return {
id: `kb_${seq}`,
title: `条目${seq}`,
body: '',
scope: 'company',
scope_id: null,
tags: '[]',
enabled: 1,
created_at: ts,
updated_at: ts,
...patch,
};
}

const CTX: KbContext = { teamId: 'team_1', memberId: 'team_1_m2', queryText: '给短剧写钩子文案 标题带数字'};

describe('关键词抽取与命中', () => {
it('英文词与中文 bigram 都能抽出', () => {
const kws = extractKeywords('Write a Hook 短剧钩子');
expect(kws).toContain('write');
expect(kws).toContain('hook');
expect(kws).toContain('短剧');
expect(kws).toContain('钩子');
});

it('标题/tags/正文任一命中即算命中，全不中则不命中', () => {
const byTitle = entry({ title: '短剧钩子手册', body: '无关内容'});
const byTags = entry({ title: '手册', body: '无关', tags: '["短剧"]'});
const byBody = entry({ title: '手册', body: '这里讲短剧的钩子'});
const miss = entry({ title: '财务报销流程', body: '发票与审批'});
const kws = extractKeywords('短剧钩子');
expect(kbMatches(byTitle, kws)).toBe(true);
expect(kbMatches(byTags, kws)).toBe(true);
expect(kbMatches(byBody, kws)).toBe(true);
expect(kbMatches(miss, kws)).toBe(false);
});
});

describe('范围优先级', () => {
it('公司 > 本组 > 本人 > 他组；他人成员级不纳入', () => {
const company = entry({ scope: 'company'});
const ownTeam = entry({ scope: 'team', scope_id: 'team_1'});
const ownMember = entry({ scope: 'member', scope_id: 'team_1_m2'});
const otherTeam = entry({ scope: 'team', scope_id: 'team_2'});
const otherMember = entry({ scope: 'member', scope_id: 'team_2_m1'});
expect(kbScopeRank(company, CTX)).toBe(0);
expect(kbScopeRank(ownTeam, CTX)).toBe(1);
expect(kbScopeRank(ownMember, CTX)).toBe(2);
expect(kbScopeRank(otherTeam, CTX)).toBe(3);
expect(kbScopeRank(otherMember, CTX)).toBe(-1);
});

it('入选顺序按优先级排列；公司标准不要求关键词命中，他组需命中', () => {
const otherTeam = entry({ scope: 'team', scope_id: 'team_2', title: '短剧资料（他组）', body: '钩子写法'});
const ownMember = entry({ scope: 'member', scope_id: 'team_1_m2', title: '我的短剧笔记', body: '钩子'});
const ownTeam = entry({ scope: 'team', scope_id: 'team_1', title: '本组短剧资料', body: '钩子'});
const company = entry({ scope: 'company', title: '公司文案标准', body: '与短剧无关的公司级规范'});
const sel = selectKbForInjection([otherTeam, ownMember, ownTeam, company], CTX, 100_000);
expect(sel.entries.map((e) => e.id)).toEqual([company.id, ownTeam.id, ownMember.id, otherTeam.id]);
expect(sel.section).toContain('');
expect(sel.section).toContain('公司文案标准');
});

it('本组条目未命中关键词不注入；禁用条目一律不注入', () => {
const noHit = entry({ scope: 'team', scope_id: 'team_1', title: '报销流程', body: '发票审批'});
const disabled = entry({ scope: 'company', title: '已停用标准', body: '短剧钩子', enabled: 0});
const sel = selectKbForInjection([noHit, disabled], CTX, 100_000);
expect(sel.entries).toEqual([]);
expect(sel.section).toBe('');
expect(sel.totalTokens).toBe(0);
});

it('他人成员级条目即使命中关键词也不注入', () => {
const otherMember = entry({ scope: 'member', scope_id: 'team_2_m1', title: '短剧钩子私藏', body: '钩子'});
const sel = selectKbForInjection([otherMember], CTX, 100_000);
expect(sel.entries).toEqual([]);
});
});

describe('注入上限截断（§15.1）', () => {
it('上限口径：有预算取剩余的 30%，无预算取 8000', () => {
expect(kbCapTokens(10_000, 4_000)).toBe(1_800);
expect(kbCapTokens(10_000, 10_000)).toBe(0);
expect(kbCapTokens(10_000, 12_000)).toBe(0);
expect(kbCapTokens(0, 0)).toBe(8_000);
});

it('总量不超过上限；超限的大条目跳过、后续小条目仍可纳入；优先级靠前者先占额', () => {
const big = entry({ scope: 'company', title: '大标准', body: '文'.repeat(500)});
const small = entry({ scope: 'team', scope_id: 'team_1', title: '短剧小贴士', body: '钩子'});
const bigCost = estimateTokens(formatKbEntry(big));
const smallCost = estimateTokens(formatKbEntry(small));
expect(bigCost).toBeGreaterThan(smallCost);

// 上限只够小条目：大条目（公司级、优先）被跳过，小条目纳入，总量 ≤ 上限
const sel = selectKbForInjection([big, small], CTX, smallCost);
expect(sel.entries.map((e) => e.id)).toEqual([small.id]);
expect(sel.totalTokens).toBe(smallCost);
expect(sel.totalTokens).toBeLessThanOrEqual(smallCost);

// 上限为 0：什么都不注入
expect(selectKbForInjection([big, small], CTX, 0).entries).toEqual([]);

// 上限充足：两条都进，且公司级排在前面
const all = selectKbForInjection([small, big], CTX, bigCost + smallCost);
expect(all.entries.map((e) => e.id)).toEqual([big.id, small.id]);
expect(all.totalTokens).toBe(bigCost + smallCost);
});
});
