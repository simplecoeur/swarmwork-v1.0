import {
  BlockedCode,
  canTransition,
  ErrorCode,
  TaskStatus,
  type TaskStatus as TaskStatusT,
} from '@swarm/shared';
import type { Repos, TaskRow } from '../store/repositories';
import { recordTaskStep } from './taskSteps';
import { enqueueTaskEventDeliveries } from './webhookService';

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

/** 状态迁移事件的触发者（M6 task_events 底座）：user 登录用户 / engine 引擎 / ai_member 执行或审核成员 */
export interface TaskActor {
  type: 'user' | 'engine' | 'ai_member';
  id?: string | null;
  note?: string;
}

/**
 * 状态迁移统一入口（设计 §6）：校验合法迁移 + 守卫，禁止各处直接改 status。
 * 返回迁移后的任务；守卫不满足时抛 DomainError（引擎据此置 blocked 覆盖层）。
 * M6：每次成功迁移顺手落一条 task_events（方案 §5）。
 */
export function transitionTask(
  repos: Repos,
  task: TaskRow,
  to: TaskStatusT,
  patch: Partial<TaskRow> = {},
  guards?: TaskGuards,
  actor?: TaskActor,
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
  repos.insertTaskEvent({
    task_id: task.id,
    workspace_id: task.workspace_id ?? null,
    actor_type: actor?.type ?? 'engine',
    actor_id: actor?.id ?? null,
    from_status: task.status,
    to_status: to,
    note: actor?.note ?? '',
  });
  // G-07 旁路：终态迁移（done/待裁决/已取消）为订阅的 Webhook 生成投递行（函数内部吞异常，不阻断迁移）
  enqueueTaskEventDeliveries(repos, updated);
  // G-04 旁路步：裁决相关迁移各落一步（转待裁决 / 老板裁决通过），失败不阻断迁移（recordTaskStep 内部吞异常）
  if (to === TaskStatus.ADJUDICATION) {
    recordTaskStep(repos, {
      taskId: task.id,
      workspaceId: task.workspace_id ?? null,
      kind: 'adjudicated',
      summary: `转待裁决：${actor?.note ?? ''}`.slice(0, 200),
      detail: { fromStatus: task.status, toStatus: to, note: actor?.note ?? '', rejectCount: updated.reject_count },
      callKey: `adjudicated:${task.id}:enter:${updated.reject_count}`,
    });
  } else if (task.status === TaskStatus.ADJUDICATION && to === TaskStatus.DONE) {
    recordTaskStep(repos, {
      taskId: task.id,
      workspaceId: task.workspace_id ?? null,
      kind: 'adjudicated',
      summary: '老板裁决通过',
      detail: { fromStatus: task.status, toStatus: to, note: actor?.note ?? '' },
      callKey: `adjudicated:${task.id}:done`,
    });
  }
  return updated;
}

/**
 * 项目状态聚合（§15.2 + M5 扩展）：任一子任务待裁决 → 待裁决；
 * 全部未取消子任务 done（且至少一个 done）→ 已交付。已取消子任务是终态、不阻塞交付判定；
 * 全部子任务都被取消时视为没有可交付内容，保持「进行中」由老板处理。
 */
export function refreshProjectStatus(repos: Repos, projectId: string | null): void {
  if (!projectId) return;
  const project = repos.getProject(projectId);
  if (!project) return;
  const children = repos
    .listTasks(project.workspace_id ?? undefined)
    .filter((t) => t.project_id === projectId);
  const live = children.filter((t) => t.status !== TaskStatus.CANCELLED);
  let status = project.status;
  if (children.length > 0 && live.length > 0 && live.every((t) => t.status === TaskStatus.DONE)) {
    status = '已交付' as typeof status;
  } else if (children.some((t) => t.status === TaskStatus.ADJUDICATION)) {
    status = '待裁决' as typeof status;
  } else {
    status = '进行中' as typeof status;
  }
  if (status !== project.status) repos.updateProjectStatus(projectId, status);
}

/* ---------- M5 后悔药：取消 / 重试 / 删除（均经状态机校验，不直接改 status） ---------- */

/**
 * 取消任务（终态 已取消）：仅「待领取 / 被打回」与带 blocked 覆盖层的停工任务可取消；
 * 执行中（正在调用模型）、待裁决、已完成、已取消均拒绝。
 */
export function cancelTask(repos: Repos, task: TaskRow, actor?: TaskActor): TaskRow {
  const blocked = task.blocked_code !== null;
  const cancellable =
    task.status === TaskStatus.PENDING ||
    task.status === TaskStatus.REJECTED ||
    (task.status === TaskStatus.REVIEWING && blocked);
  if (!cancellable) {
    throw new DomainError(
      ErrorCode.INVALID_TRANSITION,
      task.status === TaskStatus.RUNNING
        ? '任务执行中（正在调用模型），不能取消'
        : `当前状态「${task.status}」不能取消（只有待领取/被打回/停工中的任务可取消）`,
    );
  }
  const next = transitionTask(
    repos,
    task,
    TaskStatus.CANCELLED,
    {
      finished_at: new Date().toISOString(),
      blocked_code: null,
      blocked_reason: '',
      heartbeat_at: null,
    },
    undefined,
    actor ?? { type: 'user' },
  );
  refreshProjectStatus(repos, task.project_id);
  return next;
}

/**
 * 手动重试停工任务：清 blocked 覆盖层，任务回到队列由引擎按其状态继续领取
 * （待领取→重新执行、被打回→重做、待审核→续跑审核）。仅对停工任务有效；
 * 已取消为终态不可重试；未停工的任务（含执行中/审核中/已完成）拒绝。
 */
export function retryTask(repos: Repos, task: TaskRow): TaskRow {
  if (task.status === TaskStatus.CANCELLED) {
    throw new DomainError(ErrorCode.INVALID_TRANSITION, '已取消的任务不可重试');
  }
  if (!task.blocked_code) {
    throw new DomainError(
      ErrorCode.VALIDATION,
      `任务未处于停工状态（当前「${task.status}」），无需也不可手动重试`,
    );
  }
  repos.setBlocked(task.id, null, '');
  const fresh = repos.getTask(task.id);
  if (!fresh) throw new DomainError(ErrorCode.NOT_FOUND, '任务不存在');
  return fresh;
}

/**
 * 删除任务记录：仅已完成/已取消可删。账本行保留不删（删任务不删账，
 * 余额推导与总经理汇报的按 API/小组聚合不受影响）。
 */
export function deleteTask(repos: Repos, task: TaskRow, actor?: TaskActor): void {
  if (task.status !== TaskStatus.DONE && task.status !== TaskStatus.CANCELLED) {
    throw new DomainError(
      ErrorCode.VALIDATION,
      `只有已完成/已取消的任务可删除（当前「${task.status}」）`,
    );
  }
  repos.insertTaskEvent({
    task_id: task.id,
    workspace_id: task.workspace_id ?? null,
    actor_type: actor?.type ?? 'user',
    actor_id: actor?.id ?? null,
    from_status: task.status,
    to_status: task.status,
    note: '任务记录删除（账本保留）',
  });
  repos.deleteTask(task.id);
  refreshProjectStatus(repos, task.project_id);
}
