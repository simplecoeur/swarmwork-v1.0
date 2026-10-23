import {
  BlockedCode,
  canTransition,
  ErrorCode,
  TaskStatus,
  type TaskStatus as TaskStatusT,
} from '@swarm/shared';
import type { Repos, TaskRow } from '../store/repositories';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TaskGuards {
  /** 解析任务所属 API（含 Key 明文，仅服务端内部使用） */
  resolveApi(task: TaskRow): { id: string; apiKey: string } | null;
  /** 推导余额（厘） */
  balanceMilli(apiId: string): number;
  /** 当前全公司 running 数 */
  runningCount(): number;
  concurrencyLimit(): number;
  budgetTokens(): number;
}

/**
 * 状态迁移统一入口（设计 §6）：校验合法迁移 + 守卫，禁止各处直接改 status。
 * 返回迁移后的任务；守卫不满足时抛 DomainError（引擎据此置 blocked 覆盖层）。
 */
export function transitionTask(
  repos: Repos,
  task: TaskRow,
  to: TaskStatusT,
  patch: Partial<TaskRow> = {},
  guards?: TaskGuards,
): TaskRow {
  if (!canTransition(task.status, to)) {
    throw new DomainError(
      ErrorCode.INVALID_TRANSITION,
      `非法状态迁移：${task.status} → ${to}`,
    );
  }
  if (to === TaskStatus.RUNNING && guards) {
    const api = guards.resolveApi(task);
    if (!api) {
      throw new DomainError(
        BlockedCode.NO_API,
        '未配置可用 API：小组未分配 API 且无公司默认 API',
      );
    }
    if (!api.apiKey) {
      throw new DomainError(BlockedCode.NO_API_KEY, 'API 未填 Key（至少填一个 API 才能开工）');
    }
    if (guards.balanceMilli(api.id) <= 0) {
      throw new DomainError(BlockedCode.INSUFFICIENT_BALANCE, 'API 余额不足，请先采购充值');
    }
    if (guards.runningCount() >= guards.concurrencyLimit()) {
      // 并发满不是 blocked：保持 pending 由引擎下个 tick 重试
      throw new DomainError('CONCURRENCY_FULL', '并发已满，排队等待');
    }
    const budget = guards.budgetTokens();
    if (budget > 0 && task.total_tokens >= budget) {
      throw new DomainError(ErrorCode.BUDGET_EXCEEDED, '单任务累计 token 已达预算上限');
    }
  }
  const next: Partial<TaskRow> = { ...patch };
  if (to === TaskStatus.RUNNING) {
    next.heartbeat_at = new Date().toISOString();
    next.blocked_code = null;
    next.blocked_reason = '';
    if (!task.claimed_at) next.claimed_at = new Date().toISOString();
  }
  repos.updateTaskStatus(task.id, to, next);
  const updated = repos.getTask(task.id);
  if (!updated) throw new DomainError(ErrorCode.NOT_FOUND, '任务不存在');
  return updated;
}

/** 项目状态聚合（§15.2）：任一子任务待裁决 → 待裁决；全部 done → 已交付 */
export function refreshProjectStatus(repos: Repos, projectId: string | null): void {
  if (!projectId) return;
  const project = repos.getProject(projectId);
  if (!project) return;
  const children = repos.listTasks().filter((t) => t.project_id === projectId);
  let status = project.status;
  if (children.length > 0 && children.every((t) => t.status === TaskStatus.DONE)) {
    status = '已交付' as typeof status;
  } else if (children.some((t) => t.status === TaskStatus.ADJUDICATION)) {
    status = '待裁决' as typeof status;
  } else {
    status = '进行中' as typeof status;
  }
  if (status !== project.status) repos.updateProjectStatus(projectId, status);
}
