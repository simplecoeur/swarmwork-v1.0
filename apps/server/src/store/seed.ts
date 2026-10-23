import { yuanToMilli } from '@swarm/shared';
import { encryptKey } from './crypto';
import type { Repos } from './repositories';

export const ROLE_PERSONAS: Array<{ role: string; name: string; persona: string }> = [
  { role: '组长', name: '阿派', persona: '你是一名派单员/组长，负责理解老板的方案、拆解任务、跟进进度，表达简洁干练。' },
  { role: '研究员', name: '小查', persona: '你是一名研究员，擅长查资料、汇总信息、提炼要点，产出结构清晰的调研摘要，注明不确定的信息。' },
  { role: '文案', name: '妙笔', persona: '你是一名文案，擅长写标题、脚本、简介、推文等文字产出，文风生动有钩子，贴合目标受众。' },
  { role: '程序员', name: '码农', persona: '你是一名程序员，擅长写清晰、可直接运行的代码片段，并附简短的使用说明。' },
  { role: '审核', name: '严审', persona: '你是一名严格的审核员，只按老板给定的审核要点与甲方需求逐条核对成果，不放水也不吹毛求疵。' },
];

export function makeMemberRows(teamId: string, teamName: string, isFirst: boolean) {
  return ROLE_PERSONAS.map((r, i) => ({
    id: `${teamId}_m${i}`,
    team_id: teamId,
    name: isFirst ? r.name : teamName + r.name,
    role: r.role,
    persona: r.persona,
    prompt: '',
    skill_tags: '[]',
    color: '',
  }));
}

/** 空库时写入种子：第一小组 + 一条待填 Key 的 DeepSeek 占位 API（与 v0 行为一致） */
export function seedIfEmpty(repos: Repos): void {
  if (repos.listApis().length > 0) return;
  const ts = new Date().toISOString();
  repos.tx(() => {
    repos.insertApi({
      id: 'api_seed_deepseek',
      name: 'DeepSeek（待填 Key）',
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      api_key_enc: encryptKey(''),
      model: 'deepseek-chat',
      price_per_m_milli: yuanToMilli(2),
      created_at: ts,
    });
    repos.insertTeam({
      id: 'team_1',
      name: '第一小组',
      color: '#e2574c',
      api_id: null,
      created_at: ts,
      deleted_at: null,
    });
    for (const m of makeMemberRows('team_1', '第一小组', true)) repos.insertMember(m);
    repos.setSetting('defaultApiId', 'api_seed_deepseek');
    repos.setSetting('params', { concurrency: 4, taskBudgetTokens: 0 });
    repos.setSetting('reviewStandards', { points: '', clientNeeds: '' });
  });
}
