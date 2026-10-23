import { BlockedCode, ErrorCode } from '@swarm/shared';
import type { Logger } from '../logger';
import { decryptKey } from '../store/crypto';
import type { Repos, ScheduleRow, SessionRow, UserRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { attachAssetRefs, type AssetRefInput } from './assetService';
import { balanceMilli, trialBalanceMilli } from './costService';
import { notifyOwner } from './notify';
import {
  PIPELINE_TEMPLATES,
  runPipeline,
  validatePipelineRun,
  type PipelineTemplate,
} from './pipelineService';
import { createTaskFromSkill, mergeSkillParams, skillVisibleToWorkspace } from './skillService';
import { DomainError } from './taskService';

/**
 * 定时任务（G-10）：计划 = 到点替老板按下发单钮。
 * - 建改校验与手动发单共用同一套函数：skill 走 mergeSkillParams、流水线走 validatePipelineRun、
 *   普通任务在建改时按 createOneTask 的口径校验（小组/类型注册/资产归属），到点发单走 createOneTask 本体。
 * - next_run_at 由服务端按 timezone（Node 内置 Intl，不引时区库）+ time_local + freq/weekday 计算（UTC ISO 存储）。
 * - 调度器（进程内 30s 扫描，与引擎 1s tick 分开）：到期计划在单个事务内先推进 next_run_at、
 *   再走与手动完全相同的发单路径；last_* 在事务外更新。停机错过多个周期只补最近一次
 *   （next_run_at 一次推进到未来最近周期，只发一单）。
 * - 守卫口径与引擎领取守卫同源（组绑定/默认 API → 体验 API、Key、余额推导）：到点被拦截
 *   不建单，last_result='blocked' + notifyOwner(type='schedule_result')；成功不逐次通知。
 */

/* ================= 时区计算（Intl） ================= */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new DomainError(ErrorCode.VALIDATION, `时区「${timezone}」不合法`);
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** 某 UTC 时刻在 timeZone 的 UTC 偏移（ms）：把当地墙钟当 UTC 读出的值减真实时刻 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 当地墙钟（y/m/d H:Mi）→ UTC 时刻：迭代两次偏移校正（DST 切换日亦收敛到最近合法时刻） */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - tzOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/* ----- 空间时区口径（G-10 同源：settings.timezone，缺省 Asia/Shanghai；v1.3.0 G 晨报/签到共用） ----- */

/** 空间时区：与定时计划建改的缺省口径完全一致（空间设置 timezone，未设时 Asia/Shanghai） */
export function workspaceTimezone(repos: Repos, workspaceId: string): string {
  return repos.getSetting<string>('timezone', 'Asia/Shanghai', workspaceId);
}

/** 某 UTC 时刻在 timeZone 下的本地日期（YYYY-MM-DD） */
export function zonedDateStr(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/** 某 UTC 时刻在 timeZone 下的本地时刻（HH:MM，24 小时制） */
export function zonedTimeStr(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 本地日期（YYYY-MM-DD）在 timeZone 下当日 00:00 对应的 UTC 时刻 */
export function zonedDayStartUtc(dateStr: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new DomainError(ErrorCode.VALIDATION, `日期「${dateStr}」不合法（须 YYYY-MM-DD）`);
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, timeZone);
}

function parseTimeLocal(timeLocal: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(timeLocal || '');
  if (!m) throw new DomainError(ErrorCode.VALIDATION, `时间「${timeLocal}」不合法（须 HH:MM）`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new DomainError(ErrorCode.VALIDATION, `时间「${timeLocal}」不合法`);
  return { hour, minute };
}

/** 在 from 之后、按 freq/weekday/time_local/timezone 的最近一次运行时刻（UTC ISO） */
export function computeNextRunAt(
  sched: { freq: string; weekday: number | null; time_local: string; timezone: string },
  from: Date,
): string {
  assertValidTimezone(sched.timezone);
  const { hour, minute } = parseTimeLocal(sched.time_local);
  const local = zonedParts(from, sched.timezone);
  // 当地日期 +n 天的 y/m/d（用 UTC 日历滚动，避免本地时区干扰）
  const localDatePlus = (n: number) => {
    const d = new Date(Date.UTC(local.year, local.month - 1, local.day + n));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  };
  if (sched.freq === 'weekly') {
    const target = sched.weekday ?? local.weekday;
    const delta = (target - local.weekday + 7) % 7;
    const c = localDatePlus(delta);
    let cand = zonedTimeToUtc(c.y, c.m, c.d, hour, minute, sched.timezone);
    if (cand.getTime() <= from.getTime()) {
      const c2 = localDatePlus(delta + 7);
      cand = zonedTimeToUtc(c2.y, c2.m, c2.d, hour, minute, sched.timezone);
    }
    return cand.toISOString();
  }
  // daily
  let cand = zonedTimeToUtc(local.year, local.month, local.day, hour, minute, sched.timezone);
  if (cand.getTime() <= from.getTime()) {
    const c = localDatePlus(1);
    cand = zonedTimeToUtc(c.y, c.m, c.d, hour, minute, sched.timezone);
  }
  return cand.toISOString();
}

/* ================= 参数与校验（与手动发单共用） ================= */

export interface ScheduleInput {
  kind: string;
  skillId?: string | null;
  pipelineTemplateId?: string | null;
  teamId: string;
  title?: string;
  brief?: string;
  type?: string;
  params?: Record<string, unknown>;
  assetRefs?: AssetRefInput[];
}

export function parseScheduleParams(row: ScheduleRow): Record<string, unknown> {
  try {
    const v = JSON.parse(row.params || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function assetRefsOf(params: Record<string, unknown>): AssetRefInput[] {
  const v = params.assetRefs;
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is AssetRefInput =>
      !!r && typeof r === 'object' && typeof (r as AssetRefInput).assetId === 'string',
  );
}

function assertAssetRefsExist(repos: Repos, workspaceId: string, refs: AssetRefInput[]): void {
  for (const ref of refs) {
    if (!repos.getAsset(ref.assetId, workspaceId)) {
      throw new DomainError(ErrorCode.NOT_FOUND, `资产「${ref.assetId}」不存在`);
    }
  }
}

/**
 * 计划建改校验（与 dispatch/runPipeline/createOneTask 共用同一套参数校验函数）：
 * 返回归一化的 skillId/pipelineTemplateId 与待存 params 快照（assetRefs 并入 params）。
 */
export function validateScheduleInput(
  repos: Repos,
  workspaceId: string,
  input: ScheduleInput,
): { skillId: string | null; pipelineTemplateId: string | null; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { ...(input.params ?? {}) };
  if (input.assetRefs !== undefined) {
    if (input.assetRefs.length) params.assetRefs = input.assetRefs;
    else delete params.assetRefs;
  }
  const refs = assetRefsOf(params);
  if (input.kind === 'skill') {
    if (!input.skillId) throw new DomainError(ErrorCode.VALIDATION, '定时 skill 计划必须指定 skill');
    const skill = repos.getSkill(input.skillId);
    if (!skill || !skillVisibleToWorkspace(skill, workspaceId)) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'skill 不存在');
    }
    if (skill!.status !== 'published') {
      throw new DomainError(ErrorCode.VALIDATION, 'skill 尚未发布，不能设定时计划（先发布再设定时）');
    }
    if (!repos.getTeam(input.teamId, workspaceId)) {
      throw new DomainError(ErrorCode.VALIDATION, '小组不存在');
    }
    const { assetRefs: _omit, ...skillParams } = params;
    mergeSkillParams(skill!, skillParams); // 与发单同一校验：必填/枚举不合即 VALIDATION
    assertAssetRefsExist(repos, workspaceId, refs);
    return { skillId: skill!.id, pipelineTemplateId: null, params };
  }
  if (input.kind === 'pipeline') {
    if (!input.pipelineTemplateId) {
      throw new DomainError(ErrorCode.VALIDATION, '定时流水线计划必须指定流水线模板');
    }
    const template = PIPELINE_TEMPLATES.find((t) => t.id === input.pipelineTemplateId);
    if (!template) throw new DomainError(ErrorCode.NOT_FOUND, '流水线模板不存在');
    validatePipelineRun(repos, workspaceId, template!, input.teamId, params);
    return { skillId: null, pipelineTemplateId: template!.id, params };
  }
  if (input.kind === 'task') {
    if (!repos.getTeam(input.teamId, workspaceId)) {
      throw new DomainError(ErrorCode.VALIDATION, '小组不存在');
    }
    if (!(input.title ?? '').trim()) throw new DomainError(ErrorCode.VALIDATION, '任务标题必填');
    const type = input.type ?? '文案';
    const packId = repos.getWorkspace(workspaceId)?.industry_pack_id ?? null;
    if (!repos.listTaskTypesVisible(workspaceId, packId).some((t) => t.type_id === type)) {
      throw new DomainError(ErrorCode.VALIDATION, `任务类型「${type}」未在注册表中登记`);
    }
    assertAssetRefsExist(repos, workspaceId, refs);
    return { skillId: null, pipelineTemplateId: null, params };
  }
  throw new DomainError(ErrorCode.VALIDATION, `不支持的计划类型「${input.kind}」`);
}

/* ================= 到点发单（与手动同一路径） ================= */

/** 与 routes.ts createOneTask 结构一致的注入契约（调度器在同一进程内由路由层注入本体） */
export type ScheduleCreateTaskFn = (
  ctx: { user: UserRow; session: SessionRow; workspaceId: string },
  body: {
    title: string;
    type: string;
    brief: string;
    references?: string;
    teamId: string;
    projectId?: string | null;
    assetRefs?: Array<{ assetId: string; sections?: string[] }>;
    source?: string;
  },
) => { id: string; duplicated?: boolean };

export interface ScheduleDispatchDeps {
  createTask?: ScheduleCreateTaskFn;
  logger?: Logger;
}

export interface ScheduleOutcome {
  result: 'dispatched' | 'blocked' | 'failed';
  taskIds: string[];
  projectId?: string;
  error?: string;
}

/**
 * 守卫预检（与引擎领取守卫同源：组绑定 API → 空间默认 API → 平台体验 API；Key 与余额推导口径一致）。
 * 返回拦截原因 = 本次到点不建单、记 blocked；null = 可发单。
 */
export function dispatchBlockReason(
  repos: Repos,
  workspaceId: string,
  teamId: string,
): { code: string; reason: string } | null {
  const team = repos.getTeam(teamId, workspaceId);
  const ownApiId = team?.api_id || repos.getSetting<string | null>('defaultApiId', null, workspaceId);
  if (ownApiId) {
    const api = repos.getApi(ownApiId, workspaceId);
    if (api) {
      if (!decryptKey(api.api_key_enc)) {
        return { code: BlockedCode.NO_API_KEY, reason: `API「${api.name}」未填 Key，请先到设置后台填写` };
      }
      if (balanceMilli(repos, api.id, workspaceId) <= 0) {
        return { code: BlockedCode.INSUFFICIENT_BALANCE, reason: `API「${api.name}」余额不足，请到成本中心采购充值` };
      }
      return null;
    }
  }
  const trial = repos.getTrialApi();
  if (trial) {
    if (!decryptKey(trial.api_key_enc)) {
      return { code: BlockedCode.NO_API_KEY, reason: '体验 API 未配置 Key' };
    }
    if (trialBalanceMilli(repos, workspaceId) > 0) return null;
    if (repos.trialGrantedSum(trial.id, workspaceId) > 0) {
      return {
        code: BlockedCode.INSUFFICIENT_BALANCE,
        reason: '体验额度已用完，请到设置后台填自己的 API Key',
      };
    }
  }
  return { code: BlockedCode.NO_API, reason: '未配置可用 API：小组未分配 API 且无公司默认 API' };
}

function markScheduleSource(repos: Repos, taskId: string, workspaceId: string, userId: string | null): void {
  repos.insertTaskEvent({
    task_id: taskId,
    workspace_id: workspaceId,
    actor_type: 'user',
    actor_id: userId,
    from_status: null,
    to_status: '待领取',
    note: '发单（定时任务）',
  });
}

/** 执行一次计划发单（永不抛错：失败归类为 blocked/failed 返回，供调度器落 last_result） */
export function dispatchSchedule(
  repos: Repos,
  schedule: ScheduleRow,
  deps: ScheduleDispatchDeps = {},
): ScheduleOutcome {
  const ws = schedule.workspace_id;
  const params = parseScheduleParams(schedule);
  const refs = assetRefsOf(params);
  const blocked = dispatchBlockReason(repos, ws, schedule.team_id);
  if (blocked) return { result: 'blocked', taskIds: [], error: blocked.reason };
  try {
    if (schedule.kind === 'skill') {
      const skill = schedule.skill_id ? repos.getSkill(schedule.skill_id) : undefined;
      if (!skill || !skillVisibleToWorkspace(skill, ws) || skill.status !== 'published') {
        return { result: 'failed', taskIds: [], error: '计划引用的 skill 已不可用（被下架/删除）' };
      }
      const { assetRefs: _omit, ...skillParams } = params;
      const task = createTaskFromSkill(repos, {
        skill: skill!,
        params: skillParams,
        teamId: schedule.team_id,
        workspaceId: ws,
        userId: schedule.created_by_user_id,
      });
      if (refs.length) attachAssetRefs(repos, task.id, ws, refs);
      markScheduleSource(repos, task.id, ws, schedule.created_by_user_id);
      return { result: 'dispatched', taskIds: [task.id] };
    }
    if (schedule.kind === 'pipeline') {
      const template: PipelineTemplate | undefined = PIPELINE_TEMPLATES.find(
        (t) => t.id === schedule.pipeline_template_id,
      );
      if (!template) return { result: 'failed', taskIds: [], error: '计划引用的流水线模板已不存在' };
      const { projectId, taskIds } = runPipeline(repos, {
        template: template!,
        teamId: schedule.team_id,
        name: schedule.title || undefined,
        params,
        workspaceId: ws,
        userId: schedule.created_by_user_id,
      });
      for (const id of taskIds) markScheduleSource(repos, id, ws, schedule.created_by_user_id);
      return { result: 'dispatched', taskIds, projectId };
    }
    // kind === 'task'：走 routes 的 createOneTask 本体（与页面发单同一函数、来源标记 schedule）
    if (!deps.createTask) {
      return { result: 'failed', taskIds: [], error: '调度器未注入发单路径（createTask）' };
    }
    const user = repos.getUser(schedule.created_by_user_id);
    if (!user || user.status !== 'active') {
      return { result: 'failed', taskIds: [], error: '计划创建者账号已不可用' };
    }
    const r = deps.createTask(
      {
        user: user!,
        session: null as unknown as SessionRow,
        workspaceId: ws,
      },
      {
        title: schedule.title,
        type: schedule.type,
        brief: schedule.brief,
        teamId: schedule.team_id,
        assetRefs: refs.length ? refs : undefined,
        source: 'schedule',
      },
    );
    return { result: 'dispatched', taskIds: [r.id] };
  } catch (e) {
    return {
      result: 'failed',
      taskIds: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 调度器一轮：取全部到期计划，逐个在单个事务内「先推进 next_run_at 到未来最近周期、再发单」，
 * 事务外回写 last_run_at/last_task_id/last_result；非成功（blocked/failed）通知所有者，成功不通知。
 * 重复扫描/进程重启安全：next_run_at 已在事务内推进，后来者查不到到期行，不会重复发单。
 */
export function runDueSchedules(
  repos: Repos,
  deps: ScheduleDispatchDeps = {},
  now: Date = new Date(),
): Array<{ scheduleId: string; outcome: ScheduleOutcome }> {
  const due = repos.listDueSchedules(now.toISOString());
  const results: Array<{ scheduleId: string; outcome: ScheduleOutcome }> = [];
  for (const s of due) {
    let outcome: ScheduleOutcome = { result: 'failed', taskIds: [], error: '未执行' };
    repos.tx(() => {
      const fresh = repos.getSchedule(s.id);
      if (!fresh || fresh.enabled !== 1) {
        outcome = { result: 'failed', taskIds: [], error: '计划已停用或删除' };
        return;
      }
      repos.updateSchedule({
        ...fresh,
        next_run_at: computeNextRunAt(fresh, now),
        updated_at: nowIso(),
      });
      outcome = dispatchSchedule(repos, fresh, deps);
    });
    if (outcome.error === '计划已停用或删除') continue;
    const cur = repos.getSchedule(s.id);
    if (cur) {
      repos.updateSchedule({
        ...cur,
        last_run_at: nowIso(),
        last_task_id: outcome.taskIds[0] ?? cur.last_task_id,
        last_result: outcome.result,
        updated_at: nowIso(),
      });
    }
    if (outcome.result !== 'dispatched') {
      try {
        notifyOwner(
          repos,
          s.workspace_id,
          'schedule_result',
          outcome.result === 'blocked' ? '定时任务被拦截，未能发单' : '定时任务发单失败',
          `计划「${s.title || s.id}」本次未发出：${outcome.error ?? outcome.result}`,
          null,
        );
      } catch {
        /* 通知失败不影响调度落账 */
      }
      deps.logger?.warn(
        'schedule',
        `定时计划 ${s.id} 本次 ${outcome.result}：${outcome.error ?? ''}`,
      );
    } else {
      deps.logger?.info('schedule', `定时计划 ${s.id} 已发单：${outcome.taskIds.join(', ')}`);
    }
    results.push({ scheduleId: s.id, outcome });
  }
  return results;
}

export function newScheduleId(): string {
  return uid('sch');
}
