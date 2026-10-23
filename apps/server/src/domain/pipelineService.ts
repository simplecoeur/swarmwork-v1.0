import { nowIso, uid } from '../util';
import type { Repos, SkillRow } from '../store/repositories';
import { createTaskFromSkill, mergeSkillParams } from './skillService';
import { DomainError } from './taskService';
import { patchTaskStep, recordTaskStep } from './taskSteps';

/**
 * 成套流水线（方案 §11.1）：流水线 = 预置项目模板 + 一组 skill 的编排，不是新引擎。
 * 所有者填一次公共参数 → 生成一个项目 + 全套子任务（每条由对应 skill 渲染 brief，seq 标记顺序，
 * 引擎按 seq 串行领取；上游成果经引擎的「项目内已完成成果」通道注入下游）。
 */
export interface PipelineStep {
  skillSlug: string;
  title: string;
}
export interface PipelineTemplate {
  id: string;
  name: string;
  industry: string | null;
  description: string;
  /** 公共参数字段（前端一次填写，逐个 skill 按各自 schema 取用/校验） */
  commonParams: Array<{ key: string; label: string; required: boolean }>;
  steps: PipelineStep[];
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: 'drama-launch-pack',
    name: '短剧上线包',
    industry: 'short_drama',
    description: '一部剧从卖点到评论区话术的整套上线物料：卖点提炼 → 标题组 → 简介 → 封面文案 → 分集钩子 → 评论区话术。',
    commonParams: [
      { key: 'drama_name', label: '剧名（中文）', required: true },
      { key: 'genre', label: '题材', required: true },
      { key: 'synopsis', label: '剧情/分集梗概', required: true },
      { key: 'key_plot', label: '关键剧情节点', required: true },
      { key: 'selling_point', label: '核心卖点', required: true },
      { key: 'hook', label: '最大悬念', required: true },
      { key: 'platform', label: '目标平台', required: false },
      { key: 'market', label: '目标市场', required: false },
    ],
    steps: [
      { skillSlug: 'script-selling-points', title: '卖点提炼' },
      { skillSlug: 'viral-title', title: '标题组' },
      { skillSlug: 'multi-lang-intro', title: '简介' },
      { skillSlug: 'cover-copy', title: '封面文案' },
      { skillSlug: 'episode-hooks', title: '分集钩子' },
      { skillSlug: 'comment-scripts', title: '评论区话术' },
    ],
  },
];

/** 在空间内按 slug 找 skill：优先空间副本，其次平台官方/库内行 */
export function findSkillBySlugForWorkspace(
  repos: Repos,
  workspaceId: string,
  slug: string,
): SkillRow | undefined {
  const own = repos.listWorkspaceSkills(workspaceId).find((s) => s.slug === slug && s.status === 'published');
  if (own) return own;
  return repos
    .listLibrarySkills()
    .find((s) => s.slug === slug);
}

export function runPipeline(
  repos: Repos,
  input: {
    template: PipelineTemplate;
    teamId: string;
    name?: string;
    params: Record<string, unknown>;
    workspaceId: string;
    userId: string | null;
  },
): { projectId: string; taskIds: string[] } {
  const { template, workspaceId } = input;
  const team = repos.getTeam(input.teamId, workspaceId);
  if (!team) throw new DomainError('VALIDATION', '小组不存在');
  // 先全量校验：缺哪个环节的 skill、缺哪个必填参数，在建项目之前一次性报清
  const skills: SkillRow[] = [];
  for (const step of template.steps) {
    const skill = findSkillBySlugForWorkspace(repos, workspaceId, step.skillSlug);
    if (!skill) {
      throw new DomainError(
        'VALIDATION',
        `流水线环节「${step.title}」需要的 skill「${step.skillSlug}」在本空间不可用（先从平台库安装或选行业包开公司）`,
      );
    }
    skills.push(skill);
  }
  for (const skill of skills) mergeSkillParams(skill, input.params);
  for (const cp of template.commonParams) {
    if (cp.required && (input.params[cp.key] === undefined || input.params[cp.key] === '')) {
      throw new DomainError('VALIDATION', `公共参数「${cp.label}」必填`);
    }
  }

  const projectId = uid('proj');
  const dramaName = typeof input.params.drama_name === 'string' ? input.params.drama_name : '';
  repos.insertProject({
    id: projectId,
    name: input.name || `${template.name}${dramaName ? `：《${dramaName}》` : ''}`,
    brief: `流水线模板「${template.name}」一键生成；公共参数：${JSON.stringify(input.params)}`,
    team_id: input.teamId,
    client_name: '',
    status: '进行中',
    created_at: nowIso(),
    workspace_id: workspaceId,
  });
  const taskIds: string[] = [];
  const stepPlan = template.steps.map((s, i) => ({ index: i + 1, title: s.title, type: skills[i].name }));
  template.steps.forEach((step, i) => {
    const task = createTaskFromSkill(repos, {
      skill: skills[i],
      params: input.params,
      teamId: input.teamId,
      projectId,
      workspaceId,
      userId: input.userId,
      titleOverride: step.title,
    });
    // 落流水线顺序位：引擎按 seq 串行领取（上游未交付，下游不启动）
    repos.db
      .prepare('UPDATE tasks SET seq = ? WHERE id = ?')
      .run(i + 1, task.id);
    taskIds.push(task.id);
    // G-04：流水线子任务落 split 副本步（模板编排即计划来源，cost=0）并补全 plan 步细节（计划卡同源）
    recordTaskStep(repos, {
      taskId: task.id,
      workspaceId,
      kind: 'split',
      summary: `流水线「${template.name}」共 ${template.steps.length} 个环节，本单为第 ${i + 1} 个`,
      detail: { projectId, templateId: template.id, templateName: template.name, subtasks: stepPlan },
      callKey: `split:${projectId}`,
    });
    patchTaskStep(repos, task.id, `plan:${task.id}`, {
      summary: `计划第 ${i + 1} 步：《${step.title}》（流水线环节）`,
      detail: { projectId, index: i + 1, title: step.title, skillSlug: step.skillSlug },
    });
  });
  return { projectId, taskIds };
}
