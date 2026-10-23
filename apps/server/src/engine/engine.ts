import {
  BlockedCode,
  ENGINE,
  MAX_REJECTS_BEFORE_ADJUDICATION,
  TaskStatus,
  TEMPERATURES,
  TYPE_ROLE,
  type TaskType,
} from '@swarm/shared';
import { balanceMilli } from '../domain/costService';
import { kbCapTokens, selectKbForInjection } from '../domain/kbService';
import { DomainError, refreshProjectStatus, transitionTask, type TaskGuards } from '../domain/taskService';
import { CircuitOpenError, LlmGateway } from '../llm/gateway';
import type { Logger } from '../logger';
import { decryptKey } from '../store/crypto';
import type { ApiRow, Repos, TaskRow } from '../store/repositories';

const now = () => new Date().toISOString();

/**
 * 调度引擎（设计 §9 + §15.2）：
 * DB 为准的队列、1s tick、FIFO + 守卫领取；执行/审核两阶段落库可续跑；
 * running/reviewing 每 30s 心跳，>10 分钟无心跳回收回 pending 并记日志。
 */
export class Engine {
  private readonly inFlight = new Set<string>();
  private tickTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly gateway: LlmGateway,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.recoverOnStartup();
    this.tickTimer = setInterval(() => this.tick(), ENGINE.TICK_MS);
    this.hbTimer = setInterval(() => {
      this.repos.touchHeartbeat([...this.inFlight]);
    }, ENGINE.HEARTBEAT_MS);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.tickTimer = null;
    this.hbTimer = null;
  }

  /** 启动回收：上一进程遗留的 running 一律回 pending（单进程部署，无其他所有者） */
  recoverOnStartup(): void {
    for (const task of this.repos.listTasks()) {
      if (task.status === TaskStatus.RUNNING) {
        this.repos.updateTaskStatus(task.id, TaskStatus.PENDING, { heartbeat_at: null });
        this.logger.warn('engine', '启动回收：running 任务回 pending', { taskId: task.id });
      }
    }
  }

  /** 失联回收（§15.2）：非在飞的 running/reviewing 且心跳超 10 分钟 → 回 pending 并记日志 */
  recoverStaleTasks(): void {
    const cutoff = Date.now() - ENGINE.STALE_MS;
    for (const task of this.repos.listTasks()) {
      if (this.inFlight.has(task.id)) continue;
      if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.REVIEWING) continue;
      const hb = task.heartbeat_at ? new Date(task.heartbeat_at).getTime() : 0;
      if (hb < cutoff) {
        this.repos.updateTaskStatus(task.id, TaskStatus.PENDING, { heartbeat_at: null });
        this.logger.warn('engine', '回收失联任务（>10 分钟无心跳）回 pending', { taskId: task.id });
      }
    }
  }

  private params(): { concurrency: number; taskBudgetTokens: number } {
    return this.repos.getSetting('params', { concurrency: 4, taskBudgetTokens: 0 });
  }

  private resolveApiRow(task: TaskRow): ApiRow | null {
    const team = this.repos.getTeam(task.team_id);
    const apiId = team?.api_id || this.repos.getSetting<string | null>('defaultApiId', null);
    if (!apiId) return null;
    return this.repos.getApi(apiId) ?? null;
  }

  private guards(): TaskGuards {
    return {
      resolveApi: (task) => {
        const api = this.resolveApiRow(task);
        return api ? { id: api.id, apiKey: decryptKey(api.api_key_enc) } : null;
      },
      balanceMilli: (apiId) => balanceMilli(this.repos, apiId),
      runningCount: () => this.repos.countByStatus(TaskStatus.RUNNING),
      concurrencyLimit: () => Math.max(1, this.params().concurrency || 1),
      budgetTokens: () => this.params().taskBudgetTokens || 0,
    };
  }

  tick(): void {
    this.recoverStaleTasks();
    const limit = Math.max(1, this.params().concurrency || 1);
    const tasks = this.repos.listTasks();
    // FIFO：listTasks 已按 created_at 排序
    for (const task of tasks) {
      if (this.inFlight.size >= limit) break;
      if (this.inFlight.has(task.id)) continue;
      if (task.status === TaskStatus.PENDING || task.status === TaskStatus.REJECTED) {
        if (this.circuitBlocks(task)) continue;
        void this.processClaim(task.id);
      } else if (task.status === TaskStatus.REVIEWING) {
        // 审核阶段续跑（执行已回账，不重跑）
        if (this.circuitBlocks(task)) continue;
        void this.processReview(task.id);
      }
    }
  }

  private circuitBlocks(task: TaskRow): boolean {
    if (task.blocked_code !== BlockedCode.CIRCUIT_OPEN) return false;
    const api = this.resolveApiRow(task);
    return api ? this.gateway.breaker.isOpen(api.id) : false;
  }

  private blockedMessage(code: string, api: ApiRow | null, detail?: string): string {
    const name = api ? `「${api.name}」` : '';
    switch (code) {
      case BlockedCode.NO_API:
        return '未配置可用 API：小组未分配 API 且无公司默认 API';
      case BlockedCode.NO_API_KEY:
        return `API${name}未填 Key，请先到设置后台填写（至少填一个 API 才能开工）`;
      case BlockedCode.INSUFFICIENT_BALANCE:
        return `API${name}余额不足，请到成本中心采购充值`;
      case BlockedCode.MISSING_MEMBER:
        return detail || '小组缺少对应工种或审核成员';
      case BlockedCode.CIRCUIT_OPEN:
        return `API${name}熔断中（连续调用失败），稍后自动重试`;
      default:
        return detail || '调用失败，稍后自动重试';
    }
  }

  private overBudget(task: TaskRow): boolean {
    const b = this.params().taskBudgetTokens || 0;
    return b > 0 && task.total_tokens > b;
  }

  private toAdjudication(task: TaskRow, note: string): void {
    const fresh = this.repos.getTask(task.id) ?? task;
    if (fresh.status === TaskStatus.ADJUDICATION || fresh.status === TaskStatus.DONE) return;
    transitionTask(this.repos, fresh, TaskStatus.ADJUDICATION, {
      reject_reason: `${note}（已转待裁决）`,
      blocked_code: null,
      blocked_reason: '',
    });
    refreshProjectStatus(this.repos, fresh.project_id);
    this.logger.warn('engine', `任务转待裁决：${note}`, { taskId: task.id });
  }

  private async processClaim(taskId: string): Promise<void> {
    if (this.inFlight.has(taskId)) return;
    this.inFlight.add(taskId);
    try {
      let task = this.repos.getTask(taskId);
      if (!task || (task.status !== TaskStatus.PENDING && task.status !== TaskStatus.REJECTED)) return;
      const isRedo = task.status === TaskStatus.REJECTED;
      const api = this.resolveApiRow(task);

      const role = TYPE_ROLE[task.type as TaskType] ?? '文案';
      const worker = this.repos.teamMember(task.team_id, role);
      const reviewer = this.repos.teamMember(task.team_id, '审核');
      if (!worker || !reviewer) {
        this.repos.setBlocked(
          taskId,
          BlockedCode.MISSING_MEMBER,
          this.blockedMessage(BlockedCode.MISSING_MEMBER, api, `小组缺少「${role}」或「审核」成员`),
        );
        return;
      }

      try {
        task = transitionTask(this.repos, task, TaskStatus.RUNNING, { assignee_id: worker.id }, this.guards());
      } catch (e) {
        if (e instanceof DomainError) {
          if (e.code === 'CONCURRENCY_FULL') return;
          if (e.code === 'BUDGET_EXCEEDED') {
            this.toAdjudication(task, `单任务累计 token 已达预算上限 ${this.params().taskBudgetTokens}`);
            return;
          }
          this.repos.setBlocked(taskId, e.code as BlockedCode, this.blockedMessage(e.code, api));
          return;
        }
        throw e;
      }
      if (!api) return; // transitionTask 守卫已保证 api 存在

      /* —— 知识库注入（§10）：按范围优先级+关键词检索，拼入执行 prompt，并落库审计 —— */
      const kbSel = selectKbForInjection(
        this.repos.listKb(),
        {
          teamId: task.team_id,
          memberId: worker.id,
          queryText: `${task.title}\n${task.type}\n${task.brief}`,
        },
        kbCapTokens(this.params().taskBudgetTokens || 0, task.total_tokens),
      );
      if (kbSel.entries.length) {
        this.repos.addTaskInjectedKb(
          taskId,
          kbSel.entries.map((e) => e.id),
        );
        this.logger.info('engine', `知识库注入 ${kbSel.entries.length} 条（估算 ${kbSel.totalTokens} token）`, { taskId });
      }

      /* —— 执行 / 重做阶段 —— */
      const stage = isRedo ? ('重做' as const) : ('执行' as const);
      const workerSys =
        worker.persona + (worker.prompt ? `\n专属提示词（老板为该成员单独设定，务必遵循）：${worker.prompt}` : '');
      let workerUser =
        kbSel.section +
        `任务标题：${task.title}\n任务类型：${task.type}\n任务说明：\n${task.brief || '（无补充说明）'}` +
        '\n请直接产出完整成果正文，不要输出与成果无关的解释。';
      if (isRedo) {
        workerUser += `\n\n上次成果被审核打回，理由：${task.reject_reason || ''}\n请针对该理由修改，重新产出完整成果。`;
      }
      let execOut: { text: string };
      try {
        execOut = await this.gateway.call({
          taskId,
          teamId: task.team_id,
          api,
          stage,
          idempotencyKey: `${taskId}:${stage}:${task.reject_count}`,
          run: async (provider) => {
            const r = await provider.chat({
              model: api.model,
              system: workerSys,
              messages: [{ role: 'user', content: workerUser }],
              temperature: TEMPERATURES.EXECUTION,
            });
            return { text: r.text, usage: r.usage, payload: r.text };
          },
        });
      } catch (e) {
        const backTo = isRedo ? TaskStatus.REJECTED : TaskStatus.PENDING;
        this.repos.updateTaskStatus(taskId, backTo, { heartbeat_at: null });
        const code = e instanceof CircuitOpenError ? BlockedCode.CIRCUIT_OPEN : BlockedCode.PROVIDER_ERROR;
        this.repos.setBlocked(
          taskId,
          code,
          code === BlockedCode.CIRCUIT_OPEN
            ? this.blockedMessage(code, api)
            : `执行调用失败：${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }

      let fresh = this.repos.getTask(taskId);
      if (!fresh) return;
      this.repos.updateTaskStatus(taskId, fresh.status, { result: execOut.text });
      fresh = this.repos.getTask(taskId) ?? fresh;
      if (this.overBudget(fresh)) {
        this.toAdjudication(fresh, `单任务累计 token 已超预算上限 ${this.params().taskBudgetTokens}`);
        return;
      }
      transitionTask(this.repos, fresh, TaskStatus.REVIEWING, { heartbeat_at: now() });
      await this.processReview(taskId, true);
    } catch (e) {
      this.logger.error('engine', `任务处理异常：${e instanceof Error ? e.message : String(e)}`, { taskId });
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  private async processReview(taskId: string, alreadyHeld = false): Promise<void> {
    if (!alreadyHeld) {
      if (this.inFlight.has(taskId)) return;
      this.inFlight.add(taskId);
    }
    try {
      const task = this.repos.getTask(taskId);
      if (!task || task.status !== TaskStatus.REVIEWING) return;
      const api = this.resolveApiRow(task);
      if (!api) {
        this.repos.setBlocked(taskId, BlockedCode.NO_API, this.blockedMessage(BlockedCode.NO_API, null));
        return;
      }
      const reviewer = this.repos.teamMember(task.team_id, '审核');
      if (!reviewer) {
        this.repos.setBlocked(
          taskId,
          BlockedCode.MISSING_MEMBER,
          this.blockedMessage(BlockedCode.MISSING_MEMBER, api, '小组缺少「审核」成员'),
        );
        return;
      }
      const standards = this.repos.getSetting('reviewStandards', { points: '', clientNeeds: '' });

      let verdict: { pass: boolean; reason: string };
      try {
        const out = await this.gateway.call<{ pass: boolean; reason: string }>({
          taskId,
          teamId: task.team_id,
          api,
          stage: '审核',
          idempotencyKey: `${taskId}:审核:${task.reject_count}`,
          run: async (provider) => {
            const r = await provider.review({
              model: api.model,
              persona: reviewer.persona,
              standards,
              draft: task.result,
              taskTitle: task.title,
              taskBrief: task.brief,
              temperature: TEMPERATURES.REVIEW,
            });
            return {
              text: JSON.stringify({ pass: r.pass, reason: r.reason }),
              usage: r.usage,
              payload: { pass: r.pass, reason: r.reason },
            };
          },
        });
        verdict = out.payload;
      } catch (e) {
        const code = e instanceof CircuitOpenError ? BlockedCode.CIRCUIT_OPEN : BlockedCode.PROVIDER_ERROR;
        this.repos.setBlocked(
          taskId,
          code,
          code === BlockedCode.CIRCUIT_OPEN
            ? this.blockedMessage(code, api)
            : `审核调用失败：${e instanceof Error ? e.message : String(e)}`,
        );
        return; // 保持 reviewing，下个 tick 从审核阶段续跑（不重跑执行）
      }

      const fresh = this.repos.getTask(taskId);
      if (!fresh) return;
      if (this.overBudget(fresh)) {
        this.toAdjudication(fresh, `单任务累计 token 已超预算上限 ${this.params().taskBudgetTokens}`);
        return;
      }
      if (verdict.pass) {
        transitionTask(this.repos, fresh, TaskStatus.DONE, {
          review_note: verdict.reason || '符合标准',
          finished_at: now(),
          blocked_code: null,
          blocked_reason: '',
          heartbeat_at: null,
        });
        refreshProjectStatus(this.repos, fresh.project_id);
        this.logger.info('engine', '任务完成', { taskId });
      } else {
        const rejectCount = fresh.reject_count + 1;
        if (rejectCount >= MAX_REJECTS_BEFORE_ADJUDICATION) {
          transitionTask(this.repos, fresh, TaskStatus.ADJUDICATION, {
            reject_count: rejectCount,
            reject_reason: verdict.reason || '未说明理由',
            heartbeat_at: null,
          });
          refreshProjectStatus(this.repos, fresh.project_id);
          this.logger.warn('engine', `打回满 ${MAX_REJECTS_BEFORE_ADJUDICATION} 次，转待裁决`, { taskId });
        } else {
          transitionTask(this.repos, fresh, TaskStatus.REJECTED, {
            reject_count: rejectCount,
            reject_reason: verdict.reason || '未说明理由',
            heartbeat_at: null,
          });
          this.logger.info('engine', `审核打回第 ${rejectCount} 次`, { taskId });
        }
      }
    } catch (e) {
      this.logger.error('engine', `审核处理异常：${e instanceof Error ? e.message : String(e)}`, { taskId });
    } finally {
      if (!alreadyHeld) this.inFlight.delete(taskId);
    }
  }
}
