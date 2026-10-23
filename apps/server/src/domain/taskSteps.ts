import type { TaskStepKind } from '@swarm/shared';
import type { Logger } from '../logger';
import type { Repos } from '../store/repositories';

export type { TaskStepKind };

/**
 * 任务步骤旁路记录（G-04）：引擎/domain 各触点经此落步，口径与 task_events 一致——
 * 只做记录、不参与状态机与回账决策；落库失败（唯一约束冲突/库异常）一律吞掉并记日志，绝不阻断主流程。
 * Provider 调用步的 cost/usage 由网关在回账同一事务内同源写入（见 llm/gateway），保证可对账。
 */
export interface RecordStepInput {
  taskId: string;
  workspaceId?: string | null;
  kind: TaskStepKind;
  actorMemberId?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  /** 幂等键：同 (taskId, callKey) 已存在时本次写入被唯一约束拒绝（返回 false） */
  callKey: string;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costMilli?: number;
}

/** 落一步；成功返回 true，重复（唯一约束）或失败返回 false（已吞异常并记日志） */
export function recordTaskStep(repos: Repos, input: RecordStepInput, logger?: Logger): boolean {
  try {
    repos.insertTaskStep({
      task_id: input.taskId,
      workspace_id: input.workspaceId ?? null,
      kind: input.kind,
      actor_member_id: input.actorMemberId ?? null,
      summary: input.summary,
      detail: JSON.stringify(input.detail ?? {}),
      call_key: input.callKey,
      duration_ms: input.durationMs ?? null,
      prompt_tokens: input.promptTokens ?? null,
      completion_tokens: input.completionTokens ?? null,
      cost_milli: input.costMilli ?? 0,
    });
    return true;
  } catch (e) {
    logger?.warn('task-steps', `步骤落库失败（已忽略）：${e instanceof Error ? e.message : String(e)}`, {
      taskId: input.taskId,
    });
    return false;
  }
}

/** 补全已存在步的 summary/detail（如拆单解析后回填子任务清单、审核返回后回填结论摘要）；步不存在则无操作 */
export function patchTaskStep(
  repos: Repos,
  taskId: string,
  callKey: string,
  patch: { summary?: string; detail?: Record<string, unknown> },
  logger?: Logger,
): void {
  try {
    const cur = repos.getTaskStepByCallKey(taskId, callKey);
    if (!cur) return;
    repos.updateTaskStepMetrics(cur.id, {
      summary: patch.summary,
      detail: patch.detail !== undefined ? JSON.stringify(patch.detail) : undefined,
    });
  } catch (e) {
    logger?.warn('task-steps', `步骤补全失败（已忽略）：${e instanceof Error ? e.message : String(e)}`, {
      taskId,
    });
  }
}
