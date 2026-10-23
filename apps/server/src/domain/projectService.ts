import { TASK_TYPES, TEMPERATURES, type TaskType } from '@swarm/shared';
import { balanceMilli } from './costService';
import { LlmGateway } from '../llm/gateway';
import type { Logger } from '../logger';
import { decryptKey } from '../store/crypto';
import type { Repos, TaskRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { patchTaskStep, recordTaskStep } from './taskSteps';

interface SubtaskSpec {
  title: string;
  type: TaskType;
  brief: string;
}

/** 解析组长拆单返回的 JSON 数组，脏数据一律丢弃 */
export function parseSplitResult(text: string): SubtaskSpec[] {
  const m = (text || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as Array<{ title?: unknown; type?: unknown; brief?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => typeof x?.title === 'string' && (x.title as string).trim())
      .slice(0, 8)
      .map((x) => ({
        title: String(x.title).trim().slice(0, 120),
        type: (TASK_TYPES as readonly string[]).includes(String(x.type))
          ? (String(x.type) as TaskType)
          : '文案',
        brief: String(x.brief ?? ''),
      }));
  } catch {
    return [];
  }
}

/**
 * 方案下发（设计 §7）：建项目 → 组长以温度 0.3 拆子任务（§15.1）→ 子任务入队。
 * 拆单调用经网关记账（task_id 记为项目 id，项目总账 = 子任务账本 + 拆单条目之和）；
 * 无可用 API / 调用失败 / 解析失败时兜底为单个子任务，保证下发不中断。
 */
export async function createProject(
  repos: Repos,
  gateway: LlmGateway,
  logger: Logger,
  input: {
    name: string;
    brief: string;
    teamId: string;
    clientName: string;
    workspaceId?: string;
    createdByUserId?: string | null;
  },
): Promise<{ projectId: string; taskIds: string[] }> {
  const ws = input.workspaceId ?? 'ws_default';
  const team = repos.getTeam(input.teamId, ws);
  if (!team) throw new Error('小组不存在');
  const projectId = uid('proj');
  const ts = nowIso();
  repos.insertProject({
    id: projectId,
    name: input.name,
    brief: input.brief,
    team_id: input.teamId,
    client_name: input.clientName,
    status: '进行中',
    created_at: ts,
    workspace_id: ws,
  });

  const fallback: SubtaskSpec[] = [{ title: input.name, type: '文案', brief: input.brief }];
  let specs = fallback;

  const apiId = team.api_id || repos.getSetting<string | null>('defaultApiId', null, ws);
  const api = apiId ? repos.getApi(apiId, ws) : undefined;
  const leader = repos.teamMember(input.teamId, '组长', ws);
  if (api && leader && decryptKey(api.api_key_enc) && balanceMilli(repos, api.id, ws) > 0) {
    try {
      const out = await gateway.call({
        taskId: projectId,
        teamId: input.teamId,
        workspaceId: ws,
        api,
        stage: '执行',
        idempotencyKey: `${projectId}:split:0`,
        // G-04：拆单步与拆单账本行同源（task_id = 项目 id、同一 cost），解析出子任务后再回填清单
        step: {
          kind: 'split',
          actorMemberId: leader.id,
          summary: '组长拆单完成',
          detail: { projectName: input.name },
        },
        run: async (provider) => {
          const r = await provider.chat({
            model: api.model,
            system:
              leader.persona +
              '\n你负责把老板的方案拆解为 3-5 个可独立执行的子任务。只返回 JSON 数组，不要输出其他内容：' +
              '[{"title":"子任务标题","type":"文案|调研|代码","brief":"具体要求"}]',
            messages: [
              {
                role: 'user',
                content: `方案名称：${input.name}\n方案简报：\n${input.brief || '（无）'}${input.clientName ? `\n甲方：${input.clientName}` : ''}`,
              },
            ],
            temperature: TEMPERATURES.SPLIT,
          });
          return { text: r.text, usage: r.usage, payload: r.text };
        },
      });
      const parsed = parseSplitResult(out.text);
      if (parsed.length) specs = parsed;
    } catch (e) {
      logger.warn('project', `拆单失败，兜底单子任务：${e instanceof Error ? e.message : String(e)}`, {
        taskId: projectId,
      });
    }
  }

  const taskIds: string[] = [];
  for (const spec of specs) {
    const id = uid('task');
    const row: TaskRow = {
      id,
      project_id: projectId,
      team_id: input.teamId,
      assignee_id: null,
      title: spec.title,
      type: spec.type,
      brief: spec.brief,
      status: '待领取',
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
      workspace_id: ws,
      created_by_user_id: input.createdByUserId ?? null,
      skill_id: null,
      skill_version: null,
    };
    repos.insertTask(row);
    taskIds.push(id);
  }
  // G-04 时间线步：项目级 split 步回填子任务清单（网关已落步时补全；无可用 API 等兜底路径则在此落 cost=0 的步）
  const subtaskPlan = specs.map((s, i) => ({ index: i + 1, title: s.title, type: s.type }));
  patchTaskStep(
    repos,
    projectId,
    `${projectId}:split:0`,
    {
      summary: `拆单完成：共 ${specs.length} 个子任务`,
      detail: { projectName: input.name, subtasks: subtaskPlan },
    },
    logger,
  );
  recordTaskStep(
    repos,
    {
      taskId: projectId,
      workspaceId: ws,
      kind: 'split',
      actorMemberId: leader?.id ?? null,
      summary: `拆单完成：共 ${specs.length} 个子任务`,
      detail: { projectName: input.name, subtasks: subtaskPlan },
      callKey: `${projectId}:split:0`,
    },
    logger,
  );
  // 每个子任务落 split 副本步（cost=0，项目拆单成本只记在项目级步上）+ plan 步（本步计划摘要）
  specs.forEach((spec, i) => {
    const childId = taskIds[i];
    recordTaskStep(
      repos,
      {
        taskId: childId,
        workspaceId: ws,
        kind: 'split',
        actorMemberId: leader?.id ?? null,
        summary: `方案拆单：共 ${specs.length} 个子任务，本单为第 ${i + 1} 个`,
        detail: { projectId, projectName: input.name, subtasks: subtaskPlan },
        callKey: `split:${projectId}`,
      },
      logger,
    );
    recordTaskStep(
      repos,
      {
        taskId: childId,
        workspaceId: ws,
        kind: 'plan',
        summary: `计划第 ${i + 1} 步：《${spec.title}》（${spec.type}）`,
        detail: { projectId, index: i + 1, title: spec.title, type: spec.type, brief: spec.brief },
        callKey: `plan:${childId}`,
      },
      logger,
    );
  });
  logger.info('project', `方案下发：拆为 ${taskIds.length} 个子任务`, { taskId: projectId });
  return { projectId, taskIds };
}
