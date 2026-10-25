import { nowIso } from '../util';
import type { Repos, TemplateRow } from './repositories';

/**
 * 任务模板种子（v1.3.0 A3）：官方通用 4 个 + 短剧行业 6 个。
 * 幂等：按 (scope, industry_pack_id, name) 判重，缺才插（后续改名/下架不被种子回滚）。
 * type_id 用注册表真实 typeId（004_registry.sql：文案 / 调研）；brief 为可直接套用的
 * 完整骨架（2–4 句指令 + {{占位}}，套用后由用户手改占位，无参数表）。
 * 行业模板 industry_pack_id='short_drama'（行业标识；空间存的 pack id 经仓库层别名解析匹配）。
 */
interface TemplateDef {
  scope: 'official' | 'industry';
  industryPackId: string | null;
  name: string;
  typeId: string;
  suggestedRole: string;
  briefTemplate: string;
}

export const TASK_TEMPLATE_SEEDS: TemplateDef[] = [
  {
    scope: 'official',
    industryPackId: null,
    name: '长文摘要速览',
    typeId: '调研',
    suggestedRole: '研究员',
    briefTemplate:
      '通读下面的原文，产出一份速览摘要：先用一句话给出核心结论，再按要点列出关键信息与数据，最后单列存疑或需进一步核实的点。\n原文：{{原文}}\n篇幅要求：摘要控制在 {{字数}} 字以内，保留原文的数字与专有名词，不要加入原文没有的推断。',
  },
  {
    scope: 'official',
    industryPackId: null,
    name: '会议纪要整理',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '把下面的会议记录整理成正式纪要：包含会议主题、参会人、讨论要点、已定决议、待办事项（逐条写明负责人和截止时间）。\n会议记录：{{会议记录}}\n语气正式简洁；记录里没说清的负责人或时间写「待确认」，不要自行编造。',
  },
  {
    scope: 'official',
    industryPackId: null,
    name: '竞品动态速览',
    typeId: '调研',
    suggestedRole: '研究员',
    briefTemplate:
      '梳理竞品「{{竞品名称}}」近期的主要动态，重点关注：{{关注点}}。\n按「动态一句话 + 时间 + 对我们的影响判断」逐条输出，最后给一段总体判断：对方在加速什么、放缓什么、我们最该跟进的一件事是什么。不确定的信息标注「未证实」。',
  },
  {
    scope: 'official',
    industryPackId: null,
    name: '活动推文三连',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '围绕活动「{{活动主题}}」写三条风格不同的推广推文，核心卖点：{{卖点}}。\n三条分别是：悬念预热版（不揭晓全部信息）、福利直给版（利益点前置）、情绪共鸣版（从用户场景切入）。每条单独成段，末尾各附一行可选话题标签。',
  },
  {
    scope: 'industry',
    industryPackId: 'short_drama',
    name: '爆款标题组',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '为短剧《{{剧名}}》（题材：{{题材}}）产出一组英文视频标题，参照同名 skill「爆款标题生成」的公式口径：身份反差或未揭晓悬念打头，至少一半带数字。\n核心剧情：{{核心剧情}}。先给 10 条标题，行末括号附一句中文钩子说明。',
  },
  {
    scope: 'industry',
    industryPackId: 'short_drama',
    name: '分集钩子设计',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '为短剧《{{剧名}}》（题材：{{题材}}）设计前 {{集数}} 集的集末钩子，定位与同名 skill「分集钩子」一致：钩子落在情绪或信息揭晓的前一秒。\n分集梗概：{{分集梗概}}。按集编号输出，每集一行：钩子文案 + 钩子类型（悬念提问/身份将露/危机降临），形式不要连续重复。',
  },
  {
    scope: 'industry',
    industryPackId: 'short_drama',
    name: '封面文案',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '为短剧《{{剧名}}》（题材：{{题材}}）产出封面大字文案，口径与同名 skill「封面文案」一致：每条 ≤8 个英文词，必须含冲突或反差，禁用平铺直叙的剧情复述。\n核心卖点：{{核心卖点}}。给 6 条，编号输出，行末括号附中文释义。',
  },
  {
    scope: 'industry',
    industryPackId: 'short_drama',
    name: '评论区话术包',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '为短剧《{{剧名}}》（题材：{{题材}}）准备评论区话术包，口径与同名 skill「评论区话术」一致：语气像真人运营，不要广告腔。\n本剧最大悬念：{{最大悬念}}。产出：1 条置顶评论（带站队式提问）、5 条预设互动问答（观众可能的质疑点 + 官方口吻回复）、2 条追更引导话术，中英双语各一份。',
  },
  {
    scope: 'industry',
    industryPackId: 'short_drama',
    name: '剧本卖点提炼',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '提炼短剧《{{剧名}}》（题材：{{题材}}）的可宣发卖点，定位与同名 skill「剧本卖点提炼」一致（本模板走文案口径快速出稿）。\n剧本梗概：{{剧本梗概}}。从人物反差、爽点节奏、情感钩子、身份悬念四维拆解，输出卖点清单 + 封面文案建议 3 条 + 风险提示最多 3 条。',
  },
  {
    scope: 'industry',
    industryPackId: 'short_drama',
    name: '多语言简介',
    typeId: '文案',
    suggestedRole: '文案',
    briefTemplate:
      '为短剧《{{剧名}}》（题材：{{题材}}）写视频简介，口径与同名 skill「多语言简介」一致：先中文版再英文版，英文版前两行必须出现最强钩子并自然埋入题材关键词。\n剧情梗概：{{剧情梗概}}。目标市场：{{目标市场}}。每版 3–5 句，末尾附一行话题标签。',
  },
];

/** 任务模板种子（幂等：(scope, industry_pack_id, name) 已存在不覆盖） */
export function ensureTaskTemplates(repos: Repos): void {
  const ts = nowIso();
  for (const def of TASK_TEMPLATE_SEEDS) {
    const exists = repos.db
      .prepare(
        `SELECT id FROM task_templates WHERE scope = ? AND name = ?
           AND (industry_pack_id = ? OR (industry_pack_id IS NULL AND ? IS NULL))`,
      )
      .get(def.scope, def.name, def.industryPackId, def.industryPackId) as { id: string } | undefined;
    if (exists) continue;
    const row: TemplateRow = {
      id: `tpl_${def.scope}_${def.name}`,
      workspace_id: null,
      scope: def.scope,
      industry_pack_id: def.industryPackId,
      name: def.name,
      type_id: def.typeId,
      brief_template: def.briefTemplate,
      suggested_role: def.suggestedRole,
      created_by: null,
      created_at: ts,
      updated_at: ts,
    };
    repos.insertTemplate(row);
  }
}
