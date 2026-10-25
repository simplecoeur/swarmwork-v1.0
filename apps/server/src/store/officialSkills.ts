import { nowIso} from '../util';
import type { Repos, SkillRow} from './repositories';

/**
* 平台官方 skill 种库（方案 §7.6/§7.7、§11.3）：首批 6 个，owner_type='platform'、visibility='public'。
* 幂等：按 slug 已存在则不覆盖（管理员/后续版本的修改不被种子回滚）。
* 短剧行业包 manifest.skillSlugs 与此处 slug 一一对应，建空间选包时快照装入。
*/
interface OfficialSkillDef {
slug: string;
name: string;
description: string;
role: string;
promptTemplate: string;
inputSchema: unknown[];
kbBinding: Record<string, unknown>;
outputSpec: string;
exampleInput: Record<string, unknown>;
exampleOutput: string;
}

export const OFFICIAL_SKILLS: OfficialSkillDef[] = [
{
slug: 'viral-title',
name: '爆款标题生成',
description: '按频道爆款公式为短剧产出一批可直用的英文标题，主打反差与悬念钩子',
role: '文案',
promptTemplate:
'为短剧《{{drama_name}}》（题材：{{genre}}）生成 {{count}} 条英文视频标题。\n关键剧情：{{key_plot}}。语气：{{tone}}。\n公式要求：每条包含身份反差或未揭晓悬念；至少一半带数字；\n参照知识库中本频道的历史高点击标题风格，不要照抄。',
inputSchema: [
{ key: 'drama_name', label: '剧名（中文）', type: 'text', required: true},
{ key: 'genre', label: '题材', type: 'select', required: true, options: ['逆袭打脸', '甜宠', '复仇', '战神归来', '萌宝', '闪婚', '追妻火葬场']},
{ key: 'key_plot', label: '关键剧情节点', type: 'textarea', required: true, placeholder: '如：女主被退婚，三年后成为男主新老板的妻子'},
{ key: 'count', label: '产出数量', type: 'number', required: false, default: 10},
{ key: 'tone', label: '语气偏好', type: 'select', required: false, options: ['狗血强刺激', '悬念克制', '甜虐']},
],
kbBinding: { scopes: ['company'], tags: ['频道定位', '历史爆款标题']},
outputSpec: '编号列表输出，每条一行英文标题，行末括号附一句中文钩子说明；\n只输出列表，不要解释与总结。',
exampleInput: {
drama_name: '退婚当天她嫁给了千亿总裁',
genre: '逆袭打脸',
key_plot: '女主订婚宴被未婚夫当众退婚，转身与神秘总裁闪婚；三年后未婚夫公司被收购，收购方老板娘正是她',
count: 5,
tone: '狗血强刺激',
},
exampleOutput:
'1. Dumped at Her Own Engagement Party — She Married a Billionaire That Night（当场反杀）\n2. 3 Years After He Left Her at the Altar, She Became His New Boss\'s Wife（身份反差+数字）',
},
{
slug: 'script-selling-points',
name: '剧本卖点提炼',
description: '从剧本梗概里提炼可宣发的核心卖点，产出投放与封面可直接用的卖点包',
role: '研究员',
promptTemplate:
'通读以下短剧梗概，面向 {{platform}} 的短剧观众提炼卖点。\n梗概：{{synopsis}}\n竞品参考：{{benchmark}}\n从四个维度拆：人物反差、爽点节奏（第几集出现第一个大爽点）、\n情感钩子、身份/秘密悬念；结合知识库里本空间历史剧的实际表现数据，\n判断哪些卖点是被验证过的、哪些是赌的，分别标注。',
inputSchema: [
{ key: 'synopsis', label: '剧本梗概', type: 'textarea', required: true},
{ key: 'platform', label: '目标平台', type: 'select', required: true, options: ['YouTube', 'TikTok']},
{ key: 'benchmark', label: '竞品参考（可选）', type: 'text', required: false},
],
kbBinding: { scopes: ['personal', 'company'], tags: ['历史剧表现', '卖点复盘']},
outputSpec:
'输出卖点包：①卖点清单（每条：卖点一句话 + 证据来自梗概哪段 + 已验证/赌注标注）\n②封面文案建议 3 条（每条 ≤8 个英文词）③风险提示（可能劝退观众的点，最多 3 条）。',
exampleInput: { synopsis: '外卖小哥实为隐退的商业帝国继承人……', platform: 'YouTube', benchmark: ''},
exampleOutput: '①卖点：身份落差（外卖服 vs 帝国继承人），梗概第 2 段，已验证（同题材完播率高）…',
},
{
slug: 'episode-hooks',
name: '分集钩子',
description: '为前 N 集逐集设计集末钩子文案，拉高连看率',
role: '文案',
promptTemplate:
'为短剧《{{drama_name}}》设计前 {{episodes}} 集的集末钩子。\n分集梗概：{{synopsis}}\n每集钩子要落在情绪或信息揭晓的前一秒，形式在悬念提问、身份将露、危机降临之间轮换，不要连续重复同一形式。',
inputSchema: [
{ key: 'drama_name', label: '剧名（中文）', type: 'text', required: true},
{ key: 'synopsis', label: '分集梗概', type: 'textarea', required: true},
{ key: 'episodes', label: '集数', type: 'number', required: false, default: 10},
],
kbBinding: { scopes: ['company'], tags: ['标题方法论']},
outputSpec: '按集编号输出，每集一行：集号 + 钩子文案（中文）+ 钩子类型标注；只输出列表。',
exampleInput: { drama_name: '退婚当天她嫁给了千亿总裁', synopsis: '第1集：订婚宴退婚……', episodes: 3},
exampleOutput: '第1集：她签下离婚协议那一刻，门外迈巴赫车队停稳——（身份将露）',
},
{
slug: 'cover-copy',
name: '封面文案',
description: '产出封面大字文案：短、狠、有冲突，适配竖屏封面排版',
role: '文案',
promptTemplate:
'为短剧《{{drama_name}}》（题材：{{genre}}）产出 {{count}} 条封面大字文案。\n核心卖点：{{selling_point}}。\n每条 ≤8 个英文词，必须含冲突或反差，禁用平铺直叙的剧情复述。',
inputSchema: [
{ key: 'drama_name', label: '剧名（中文）', type: 'text', required: true},
{ key: 'genre', label: '题材', type: 'text', required: true},
{ key: 'selling_point', label: '核心卖点', type: 'textarea', required: true},
{ key: 'count', label: '产出数量', type: 'number', required: false, default: 6},
],
kbBinding: { scopes: ['company'], tags: ['频道定位']},
outputSpec: '编号列表，每条一行英文文案 + 行末括号注中文释义；只输出列表。',
exampleInput: { drama_name: '退婚当天她嫁给了千亿总裁', genre: '逆袭打脸', selling_point: '被退婚后闪婚千亿总裁，三年后收购前未婚夫公司', count: 3},
exampleOutput: '1. Dumped, Then Married a Billionaire（被退婚，转身嫁千亿总裁）',
},
{
slug: 'comment-scripts',
name: '评论区话术',
description: '置顶评论与互动话术包：引导讨论、抬完播与追更',
role: '文案',
promptTemplate:
'为短剧《{{drama_name}}》准备评论区话术包。\n本集/全剧最大悬念：{{hook}}。\n产出：1 条置顶评论（带站队式提问）、{{qa_count}} 条预设互动问答（观众可能的质疑点 + 官方口吻回复）、2 条追更引导话术。语气像真人运营，不要广告腔。',
inputSchema: [
{ key: 'drama_name', label: '剧名（中文）', type: 'text', required: true},
{ key: 'hook', label: '最大悬念', type: 'textarea', required: true},
{ key: 'qa_count', label: '互动问答条数', type: 'number', required: false, default: 5},
],
kbBinding: { scopes: ['company'], tags: []},
outputSpec: '分三段输出：（问/答成对编号）；中英双语各一份。',
exampleInput: { drama_name: '退婚当天她嫁给了千亿总裁', hook: '总裁的真实身份何时揭晓', qa_count: 3},
exampleOutput: '如果是你，订婚宴被当众退婚，你会当场揭穿他还是转身嫁给更好的人？',
},
{
slug: 'multi-lang-intro',
name: '多语言简介',
description: '产出视频简介：中文版 + 英文版，含钩子前置与关键词布局',
role: '文案',
promptTemplate:
'为短剧《{{drama_name}}》（题材：{{genre}}）写视频简介。\n剧情梗概：{{synopsis}}。\n目标市场：{{market}}。先给中文版，再给英文版；英文版前两行必须出现最强钩子，并自然埋入题材关键词。',
inputSchema: [
{ key: 'drama_name', label: '剧名（中文）', type: 'text', required: true},
{ key: 'genre', label: '题材', type: 'text', required: true},
{ key: 'synopsis', label: '剧情梗概', type: 'textarea', required: true},
{ key: 'market', label: '目标市场', type: 'select', required: false, options: ['北美', '东南亚', '拉美', '中东'], default: '北美'},
],
kbBinding: { scopes: ['company'], tags: ['频道定位']},
outputSpec: '分两段；每段 3-5 句，末尾附一行话题标签。',
exampleInput: { drama_name: '退婚当天她嫁给了千亿总裁', genre: '逆袭打脸', synopsis: '订婚宴被退婚后闪婚神秘总裁……', market: '北美'},
exampleOutput: '订婚宴上被当众退婚，她转身嫁给了在场最危险的男人……',
},
];

/** 官方 skill 种子（幂等：slug 已存在不覆盖） */
export function ensureOfficialSkills(repos: Repos): void {
const ts = nowIso();
for (const def of OFFICIAL_SKILLS) {
if (repos.getSkillBySlugPlatform(def.slug)) continue;
const row: SkillRow = {
id: `skill_official_${def.slug}`,
slug: def.slug,
owner_type: 'platform',
owner_id: null,
workspace_id: null,
name: def.name,
description: def.description,
role: def.role,
prompt_template: def.promptTemplate,
input_schema: JSON.stringify(def.inputSchema),
kb_binding: JSON.stringify(def.kbBinding),
output_spec: def.outputSpec,
example_input: JSON.stringify(def.exampleInput),
example_output: def.exampleOutput,
version: 1,
changelog: '官方首发版本',
status: 'published',
visibility: 'public',
source_skill_id: null,
source_version: null,
install_count: 0,
verified_notes: '',
created_by: null,
created_at: ts,
updated_at: ts,
featured: 0,
featured_at: null,
listed_at: ts,
contributor_name: null,
contributor_workspace_name: null,
};
repos.insertSkill(row);
}
}
