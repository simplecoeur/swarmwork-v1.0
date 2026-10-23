import { nowIso, uid } from '../util';
import type { IndustryPackRow, Repos } from './repositories';

/**
 * 行业包（方案 §12.1）：行业差异的唯一承载物。内置首发包「短剧公司」（industry=short_drama）。
 * 包内容以 JSON manifest 存 industry_packs.content；建空间选包时按 manifest 快照装入，装后与源包脱钩。
 * 官方 skill 本体在 M7 落地，本轮 manifest 只登记 skill slug 清单占位（skillSlugs）。
 */
export interface PackTeamMember {
  role: string;
  name: string;
  persona: string;
}
export interface PackTeam {
  name: string;
  color: string;
  members: PackTeamMember[];
}
export interface PackManifest {
  teams: PackTeam[];
  kbSeeds: Array<{ title: string; body: string; tags: string[] }>;
  skillSlugs: string[];
  roleExtensions: {
    roles: Array<{ role_id: string; name: string; persona_template: string }>;
    taskTypes: Array<{ type_id: string; name: string; role_id: string }>;
  };
}

const DRAMA_PERSONA_SUFFIX = '熟悉短剧行业的节奏与受众口味，产出要短、快、强钩子。';

export const SHORT_DRAMA_MANIFEST: PackManifest = {
  teams: [
    {
      name: '短剧文案组',
      color: '#e2574c',
      members: [
        { role: '组长', name: '派单阿派', persona: `你是一名短剧文案组组长，负责把短剧宣发方案拆成标题、简介、钩子等子任务并跟进交付。${DRAMA_PERSONA_SUFFIX}` },
        { role: '研究员', name: '选题小查', persona: `你是一名短剧文案组研究员，负责为文案提供题材卖点与竞品标题风格参考。${DRAMA_PERSONA_SUFFIX}` },
        { role: '文案', name: '妙笔', persona: `你是一名短剧文案，擅长爆款标题、分集钩子、封面文案与多语言简介，文风狗血有钩子、贴合下沉市场受众。${DRAMA_PERSONA_SUFFIX}` },
        { role: '程序员', name: '码农', persona: `你是一名程序员，负责短剧文案组需要的脚本与数据处理小工具。${DRAMA_PERSONA_SUFFIX}` },
        { role: '审核', name: '严审', persona: `你是一名短剧文案审核员，只按审核要点与甲方需求逐条核对标题与文案是否合规、有钩子、不夸大。${DRAMA_PERSONA_SUFFIX}` },
      ],
    },
    {
      name: '选题调研组',
      color: '#3a6fd8',
      members: [
        { role: '组长', name: '调研组长', persona: `你是一名选题调研组组长，负责拆解短剧选题调研任务、汇总各平台热门题材结论。${DRAMA_PERSONA_SUFFIX}` },
        { role: '研究员', name: '小查', persona: `你是一名短剧选题研究员，擅长追踪热门短剧题材、榜单与受众偏好，产出结构清晰的选题报告并标注不确定信息。${DRAMA_PERSONA_SUFFIX}` },
        { role: '文案', name: '报告妙笔', persona: `你是一名文案，负责把选题调研结论写成可直接决策的简报。${DRAMA_PERSONA_SUFFIX}` },
        { role: '程序员', name: '数据码农', persona: `你是一名程序员，负责选题数据的抓取脚本与表格处理。${DRAMA_PERSONA_SUFFIX}` },
        { role: '审核', name: '调研严审', persona: `你是一名审核员，只按审核要点核对选题报告的数据来源与结论是否成立。${DRAMA_PERSONA_SUFFIX}` },
      ],
    },
    {
      name: '审片组',
      color: '#3f9e63',
      members: [
        { role: '组长', name: '审片组长', persona: `你是一名审片组组长，负责拆解审片任务、汇总各集审核意见。${DRAMA_PERSONA_SUFFIX}` },
        { role: '研究员', name: '审片小查', persona: `你是一名研究员，负责整理审片标准、平台合规要求与同类剧表现供审片参考。${DRAMA_PERSONA_SUFFIX}` },
        { role: '文案', name: '审片妙笔', persona: `你是一名文案，负责把审片意见整理成给制作方的修改清单。${DRAMA_PERSONA_SUFFIX}` },
        { role: '程序员', name: '审片码农', persona: `你是一名程序员，负责审片流程需要的批注导出与格式转换工具。${DRAMA_PERSONA_SUFFIX}` },
        { role: '审核', name: '审片严审', persona: `你是一名短剧审核员，只按审核要点与平台合规标准逐条核对剧集内容（钩子强度、违规风险、节奏）。${DRAMA_PERSONA_SUFFIX}` },
      ],
    },
  ],
  kbSeeds: [
    {
      title: '示例：标题方法论',
      body: '（示例知识，可删可改）短剧标题方法论：每条标题至少包含一项——身份反差（如外卖小哥实为总裁）、未揭晓悬念（如她打开盒子后脸色大变）、或明确数字（如三年后、99 次）。标题先给结果钩子、再留一半信息缺口，避免把结局说完。',
      tags: ['示例', '标题方法论'],
    },
    {
      title: '示例：频道定位样例',
      body: '（示例知识，可删可改）频道定位样例：面向海外下沉市场，主打逆袭打脸与甜宠两类题材；单集 1–2 分钟，前 3 集必须出现第一个大爽点；封面大字不超过 8 个英文词。',
      tags: ['示例', '频道定位'],
    },
    {
      title: '示例：卖点复盘样例',
      body: '（示例知识，可删可改）卖点复盘样例：历史经验表明「身份落差」类卖点完播率最高，「慢热铺垫」类开场 10 秒流失明显；提炼卖点时优先标注已验证卖点，赌注型卖点单独列明风险。',
      tags: ['示例', '卖点复盘'],
    },
  ],
  skillSlugs: ['viral-title', 'script-selling-points', 'episode-hooks', 'cover-copy', 'comment-scripts', 'multi-lang-intro'],
  roleExtensions: {
    roles: [],
    taskTypes: [
      { type_id: '短剧文案', name: '短剧文案', role_id: '文案' },
      { type_id: '选题调研', name: '选题调研', role_id: '研究员' },
    ],
  },
};

/** 平台内置短剧包种子（幂等：已存在则不覆盖管理员的后续修改） */
export function ensureShortDramaPack(repos: Repos): void {
  if (repos.getIndustryPack('pack_short_drama')) return;
  const ts = nowIso();
  const row: IndustryPackRow = {
    id: 'pack_short_drama',
    industry: 'short_drama',
    name: '短剧公司',
    version: '1.0.0',
    description: '首发行业包：短剧文案组、选题调研组、审片组三组结构，附示例知识种子与官方 skill 清单（skill 本体 M7 落地）。',
    author: 'platform',
    content: JSON.stringify(SHORT_DRAMA_MANIFEST),
    status: 'published',
    created_at: ts,
    updated_at: ts,
  };
  repos.insertIndustryPack(row);
}

export function parseManifest(pack: IndustryPackRow): PackManifest {
  try {
    const v = JSON.parse(pack.content) as Partial<PackManifest>;
    return {
      teams: Array.isArray(v.teams) ? v.teams : [],
      kbSeeds: Array.isArray(v.kbSeeds) ? v.kbSeeds : [],
      skillSlugs: Array.isArray(v.skillSlugs) ? v.skillSlugs : [],
      roleExtensions: {
        roles: Array.isArray(v.roleExtensions?.roles) ? v.roleExtensions.roles : [],
        taskTypes: Array.isArray(v.roleExtensions?.taskTypes) ? v.roleExtensions.taskTypes : [],
      },
    };
  } catch {
    return { teams: [], kbSeeds: [], skillSlugs: [], roleExtensions: { roles: [], taskTypes: [] } };
  }
}

/** 按 manifest 快照把行业包注册的工种/任务类型落为 pack 归属行（幂等，供包种子与管理员建包共用） */
export function registerPackExtensions(repos: Repos, pack: IndustryPackRow): void {
  const manifest = parseManifest(pack);
  const ts = nowIso();
  const existingRoles = repos.db
    .prepare('SELECT role_id FROM roles WHERE pack_id = ?')
    .all(pack.id) as unknown as Array<{ role_id: string }>;
  const haveRoles = new Set(existingRoles.map((r) => r.role_id));
  for (const r of manifest.roleExtensions.roles) {
    if (haveRoles.has(r.role_id)) continue;
    repos.insertRole({
      id: uid('role'),
      role_id: r.role_id,
      name: r.name,
      persona_template: r.persona_template,
      color: '',
      icon: '',
      industry: pack.industry,
      pack_id: pack.id,
      workspace_id: null,
      is_system: 0,
      created_at: ts,
    });
  }
  const existingTypes = repos.db
    .prepare('SELECT type_id FROM task_types WHERE pack_id = ?')
    .all(pack.id) as unknown as Array<{ type_id: string }>;
  const haveTypes = new Set(existingTypes.map((t) => t.type_id));
  for (const t of manifest.roleExtensions.taskTypes) {
    if (haveTypes.has(t.type_id)) continue;
    repos.insertTaskType({
      id: uid('tt'),
      type_id: t.type_id,
      name: t.name,
      role_id: t.role_id,
      industry: pack.industry,
      pack_id: pack.id,
      workspace_id: null,
      created_at: ts,
    });
  }
}
