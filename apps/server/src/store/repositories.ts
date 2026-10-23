import type { DatabaseSync } from 'node:sqlite';
import type { BlockedCode, ProjectStatus, TaskStatus } from '@swarm/shared';

/** 默认空间 id（M6 迁移收编的单人数据空间，见 migrations/003） */
export const DEFAULT_WORKSPACE_ID = 'ws_default';
/** 平台级全局设置伪空间（settings 复合主键用，如注册审核开关） */
export const PLATFORM_WORKSPACE_ID = '__platform__';

/* ---------- 行类型（与 §5 表结构 + M6 迁移一一对应） ---------- */
export interface ApiRow {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  api_key_enc: string;
  model: string;
  price_per_m_milli: number;
  created_at: string;
  workspace_id?: string | null;
  is_trial?: number;
}

export interface TeamRow {
  id: string;
  name: string;
  color: string;
  api_id: string | null;
  created_at: string;
  deleted_at: string | null;
  workspace_id?: string | null;
}

export interface MemberRow {
  id: string;
  team_id: string;
  name: string;
  role: string;
  persona: string;
  prompt: string;
  skill_tags: string;
  color: string;
  workspace_id?: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  brief: string;
  team_id: string;
  client_name: string;
  status: ProjectStatus;
  created_at: string;
  workspace_id?: string | null;
}

export interface TaskRow {
  id: string;
  project_id: string | null;
  team_id: string;
  assignee_id: string | null;
  title: string;
  type: string;
  brief: string;
  status: TaskStatus;
  result: string;
  review_note: string;
  reject_reason: string;
  reject_count: number;
  blocked_reason: string;
  blocked_code: BlockedCode | null;
  adjudicated: number;
  idempotency_key: string | null;
  total_tokens: number;
  total_cost_milli: number;
  heartbeat_at: string | null;
  injected_kb_ids: string;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  workspace_id?: string | null;
  created_by_user_id?: string | null;
  skill_id?: string | null;
  skill_version?: number | null;
  skill_params?: string;
  is_skill_test?: number;
  injected_assets?: string;
  seq?: number | null;
}

export interface LedgerRow {
  id: number;
  task_id: string;
  team_id: string;
  api_id: string;
  stage: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_milli: number;
  estimated: number;
  created_at: string;
  workspace_id?: string | null;
}

export interface PurchaseRow {
  id: number;
  api_id: string;
  amount_milli: number;
  created_at: string;
  workspace_id?: string | null;
  type?: string;
}

export interface LlmCallRow {
  idempotency_key: string;
  api_id: string;
  status: string;
  result_text: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated: number;
  created_at: string;
  finished_at: string | null;
}

export interface KbRow {
  id: string;
  title: string;
  body: string;
  scope: string;
  scope_id: string | null;
  tags: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  workspace_id?: string | null;
  owner_user_id?: string | null;
}

/* ----- M6 新增行类型 ----- */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  status: string;
  is_platform_admin: number;
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
  registration_ip: string;
  last_login_at: string | null;
  created_at: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  owner_user_id: string;
  status: string;
  industry_pack_id: string | null;
  created_at: string;
}

export interface MembershipRow {
  user_id: string;
  workspace_id: string;
  role: string;
  status: string;
  joined_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  current_workspace_id: string | null;
  expires_at: string;
  created_ip: string;
  user_agent: string;
  created_at: string;
  last_seen_at: string;
}

export interface RoleRow {
  id: string;
  role_id: string;
  name: string;
  persona_template: string;
  color: string;
  icon: string;
  industry: string | null;
  pack_id: string | null;
  workspace_id: string | null;
  is_system: number;
  created_at: string;
}

export interface TaskTypeRow {
  id: string;
  type_id: string;
  name: string;
  role_id: string;
  industry: string | null;
  pack_id: string | null;
  workspace_id: string | null;
  created_at: string;
}

export interface IndustryPackRow {
  id: string;
  industry: string;
  name: string;
  version: string;
  description: string;
  author: string;
  content: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/* ----- M7 新增行类型 ----- */
export interface SkillRow {
  id: string;
  slug: string;
  owner_type: string;
  owner_id: string | null;
  workspace_id: string | null;
  name: string;
  description: string;
  role: string;
  prompt_template: string;
  input_schema: string;
  kb_binding: string;
  output_spec: string;
  example_input: string;
  example_output: string;
  version: number;
  changelog: string;
  status: string;
  visibility: string;
  source_skill_id: string | null;
  source_version: number | null;
  install_count: number;
  verified_notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryLinkRow {
  id: string;
  token_hash: string;
  workspace_id: string;
  scope: string;
  task_id: string | null;
  project_id: string | null;
  title: string;
  password_hash: string;
  expires_at: string | null;
  revoked: number;
  view_count: number;
  created_by: string | null;
  created_at: string;
}

export interface ChannelPushRow {
  id: number;
  workspace_id: string;
  channel_type: string;
  task_id: string | null;
  project_id: string | null;
  status: string;
  remote_ref: string;
  message: string;
  created_at: string;
  updated_at: string;
}

/* ----- M8 新增行类型 ----- */
export interface AssetTypeRow {
  id: string;
  type_id: string;
  name: string;
  structure_schema: string;
  industry: string | null;
  pack_id: string | null;
  workspace_id: string | null;
  created_at: string;
}

export interface AssetRow {
  id: string;
  workspace_id: string;
  type_id: string;
  name: string;
  version: number;
  content: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskAssetRefRow {
  id: number;
  task_id: string;
  workspace_id: string;
  asset_id: string;
  asset_version: number;
  sections: string;
  created_at: string;
}

export interface OutcomeMarkRow {
  id: number;
  task_id: string;
  workspace_id: string;
  verdict: string;
  metrics: string;
  note: string;
  created_by: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: number;
  workspace_id: string;
  user_id: string | null;
  type: string;
  title: string;
  body: string;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

/* ----- G-05 用户反馈（feedback，迁移 009） ----- */
export interface FeedbackRow {
  id: number;
  user_id: string;
  workspace_id: string | null;
  category: string;
  content: string;
  contact: string | null;
  status: string;
  admin_note: string | null;
  created_at: string;
  handled_at: string | null;
}

/* ----- G-04 任务步骤（task_steps，迁移 008） ----- */
export interface TaskStepRow {
  id: number;
  task_id: string;
  workspace_id: string | null;
  seq: number;
  kind: string;
  actor_member_id: string | null;
  summary: string;
  detail: string;
  call_key: string;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_milli: number;
  created_at: string;
}

const now = () => new Date().toISOString();
const wsOf = (v: string | null | undefined): string => v ?? DEFAULT_WORKSPACE_ID;

/**
 * 仓储层（M6 隔离口径，方案 §3/§10）：
 * - 业务 list 方法一律带 workspaceId 强制过滤；按 id 单查传 workspaceId 时不匹配即查无（路由层回 404），
 *   不传 workspaceId 的单查仅供 domain/engine 在已校验归属的行间内部调用。
 * - ledger 只提供 insert 与查询聚合（append-only，ADR-004），不存在 update/delete 账本方法。
 */
export class Repos {
  constructor(public readonly db: DatabaseSync) {}

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ----- apis ----- */
  listApis(workspaceId: string = DEFAULT_WORKSPACE_ID): ApiRow[] {
    return this.db
      .prepare('SELECT * FROM apis WHERE workspace_id = ? ORDER BY created_at, id')
      .all(workspaceId) as unknown as ApiRow[];
  }
  getApi(id: string, workspaceId?: string): ApiRow | undefined {
    if (workspaceId !== undefined) {
      return this.db
        .prepare('SELECT * FROM apis WHERE id = ? AND workspace_id = ?')
        .get(id, workspaceId) as unknown as ApiRow | undefined;
    }
    return this.db.prepare('SELECT * FROM apis WHERE id = ?').get(id) as unknown as ApiRow | undefined;
  }
  /** 平台体验 API（is_trial=1、workspace_id 为 NULL 的平台级行，§8.1） */
  getTrialApi(): ApiRow | undefined {
    return this.db
      .prepare('SELECT * FROM apis WHERE is_trial = 1 AND workspace_id IS NULL ORDER BY created_at LIMIT 1')
      .get() as unknown as ApiRow | undefined;
  }
  insertApi(row: ApiRow): void {
    this.db
      .prepare(
        'INSERT INTO apis (id, name, provider, base_url, api_key_enc, model, price_per_m_milli, created_at, workspace_id, is_trial) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        row.id, row.name, row.provider, row.base_url, row.api_key_enc, row.model,
        row.price_per_m_milli, row.created_at,
        // workspace_id 显式为 null 表示平台级行（如体验 API），不可折算为默认空间
        row.workspace_id === undefined ? DEFAULT_WORKSPACE_ID : row.workspace_id,
        row.is_trial ?? 0,
      );
  }
  updateApi(row: ApiRow): void {
    this.db
      .prepare(
        'UPDATE apis SET name=?, provider=?, base_url=?, api_key_enc=?, model=?, price_per_m_milli=? WHERE id=?',
      )
      .run(row.name, row.provider, row.base_url, row.api_key_enc, row.model, row.price_per_m_milli, row.id);
  }
  deleteApi(id: string): void {
    this.db.prepare('DELETE FROM apis WHERE id = ?').run(id);
  }

  /* ----- teams / members ----- */
  listTeams(workspaceId: string = DEFAULT_WORKSPACE_ID): TeamRow[] {
    return this.db
      .prepare('SELECT * FROM teams WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
      .all(workspaceId) as unknown as TeamRow[];
  }
  getTeam(id: string, workspaceId?: string): TeamRow | undefined {
    const r =
      workspaceId !== undefined
        ? (this.db.prepare('SELECT * FROM teams WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as unknown as TeamRow | undefined)
        : (this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as unknown as TeamRow | undefined);
    return r && !r.deleted_at ? r : undefined;
  }
  insertTeam(row: TeamRow): void {
    this.db
      .prepare('INSERT INTO teams (id, name, color, api_id, created_at, deleted_at, workspace_id) VALUES (?,?,?,?,?,NULL,?)')
      .run(row.id, row.name, row.color, row.api_id, row.created_at, wsOf(row.workspace_id));
  }
  updateTeam(row: TeamRow): void {
    this.db
      .prepare('UPDATE teams SET name=?, color=?, api_id=? WHERE id=?')
      .run(row.name, row.color, row.api_id, row.id);
  }
  softDeleteTeam(id: string): void {
    this.db.prepare('UPDATE teams SET deleted_at=? WHERE id=?').run(now(), id);
  }
  listMembers(workspaceId: string = DEFAULT_WORKSPACE_ID): MemberRow[] {
    return this.db
      .prepare(
        'SELECT m.* FROM members m JOIN teams t ON t.id = m.team_id WHERE m.workspace_id = ? AND t.deleted_at IS NULL ORDER BY m.team_id, m.id',
      )
      .all(workspaceId) as unknown as MemberRow[];
  }
  getMember(id: string, workspaceId?: string): MemberRow | undefined {
    if (workspaceId !== undefined) {
      return this.db
        .prepare('SELECT * FROM members WHERE id = ? AND workspace_id = ?')
        .get(id, workspaceId) as unknown as MemberRow | undefined;
    }
    return this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as unknown as MemberRow | undefined;
  }
  teamMember(teamId: string, role: string, workspaceId: string = DEFAULT_WORKSPACE_ID): MemberRow | undefined {
    return this.db
      .prepare('SELECT * FROM members WHERE team_id = ? AND role = ? AND workspace_id = ? ORDER BY id LIMIT 1')
      .get(teamId, role, workspaceId) as unknown as MemberRow | undefined;
  }
  insertMember(row: MemberRow): void {
    this.db
      .prepare(
        'INSERT INTO members (id, team_id, name, role, persona, prompt, skill_tags, color, workspace_id) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.team_id, row.name, row.role, row.persona, row.prompt, row.skill_tags, row.color, wsOf(row.workspace_id));
  }
  updateMemberPrompt(id: string, name: string, prompt: string): void {
    this.db.prepare('UPDATE members SET name=?, prompt=? WHERE id=?').run(name, prompt, id);
  }
  /** 成员全量更新（M5 成员管理：名字/工种/所属组/人设/提示词） */
  updateMember(row: MemberRow): void {
    this.db
      .prepare('UPDATE members SET team_id=?, name=?, role=?, persona=?, prompt=? WHERE id=?')
      .run(row.team_id, row.name, row.role, row.persona, row.prompt, row.id);
  }
  deleteMember(id: string): void {
    this.db.prepare('DELETE FROM members WHERE id = ?').run(id);
  }
  /** 成员名下未完成任务数（M5 删除守卫：已完成/已取消不计） */
  countActiveTasksByMember(memberId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE assignee_id=? AND workspace_id=? AND status NOT IN ('已完成','已取消')",
      )
      .get(memberId, workspaceId) as { c: number };
    return r.c;
  }

  /* ----- projects ----- */
  listProjects(workspaceId: string = DEFAULT_WORKSPACE_ID): ProjectRow[] {
    return this.db
      .prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at, id')
      .all(workspaceId) as unknown as ProjectRow[];
  }
  getProject(id: string, workspaceId?: string): ProjectRow | undefined {
    if (workspaceId !== undefined) {
      return this.db
        .prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?')
        .get(id, workspaceId) as unknown as ProjectRow | undefined;
    }
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
  }
  insertProject(row: ProjectRow): void {
    this.db
      .prepare('INSERT INTO projects (id, name, brief, team_id, client_name, status, created_at, workspace_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.name, row.brief, row.team_id, row.client_name, row.status, row.created_at, wsOf(row.workspace_id));
  }
  updateProjectStatus(id: string, status: ProjectStatus): void {
    this.db.prepare('UPDATE projects SET status=? WHERE id=?').run(status, id);
  }

  /* ----- tasks ----- */
  listTasks(workspaceId: string = DEFAULT_WORKSPACE_ID): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at, id')
      .all(workspaceId) as unknown as TaskRow[];
  }
  getTask(id: string, workspaceId?: string): TaskRow | undefined {
    if (workspaceId !== undefined) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?')
        .get(id, workspaceId) as unknown as TaskRow | undefined;
    }
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  }
  insertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, team_id, assignee_id, title, type, brief, status, result,
          review_note, reject_reason, reject_count, blocked_reason, blocked_code, adjudicated,
          idempotency_key, total_tokens, total_cost_milli, heartbeat_at, injected_kb_ids, created_at, claimed_at, finished_at,
          workspace_id, created_by_user_id, skill_id, skill_version, skill_params, is_skill_test, injected_assets, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.project_id, row.team_id, row.assignee_id, row.title, row.type, row.brief, row.status,
        row.result, row.review_note, row.reject_reason, row.reject_count, row.blocked_reason, row.blocked_code,
        row.adjudicated, row.idempotency_key, row.total_tokens, row.total_cost_milli, row.heartbeat_at,
        row.injected_kb_ids, row.created_at, row.claimed_at, row.finished_at,
        wsOf(row.workspace_id), row.created_by_user_id ?? null, row.skill_id ?? null, row.skill_version ?? null,
        row.skill_params ?? '{}', row.is_skill_test ?? 0, row.injected_assets ?? '[]', row.seq ?? null,
      );
  }
  /** 状态迁移专用写入口（domain 层 transitionTask 调用），同时更新心跳 */
  updateTaskStatus(id: string, status: TaskStatus, patch: Partial<TaskRow> = {}): void {
    const cur = this.getTask(id);
    if (!cur) return;
    const next: TaskRow = { ...cur, ...patch, status };
    this.db
      .prepare(
        `UPDATE tasks SET status=?, assignee_id=?, result=?, review_note=?, reject_reason=?, reject_count=?,
          blocked_reason=?, blocked_code=?, adjudicated=?, total_tokens=?, total_cost_milli=?,
          heartbeat_at=?, injected_kb_ids=?, claimed_at=?, finished_at=? WHERE id=?`,
      )
      .run(
        next.status, next.assignee_id, next.result, next.review_note, next.reject_reason, next.reject_count,
        next.blocked_reason, next.blocked_code, next.adjudicated, next.total_tokens, next.total_cost_milli,
        next.heartbeat_at, next.injected_kb_ids, next.claimed_at, next.finished_at, id,
      );
  }
  /** 累计任务总耗缓存（须与 ledger 同事务调用，§5） */
  addTaskTotals(id: string, tokens: number, costMilli: number): void {
    this.db
      .prepare('UPDATE tasks SET total_tokens = total_tokens + ?, total_cost_milli = total_cost_milli + ? WHERE id = ?')
      .run(tokens, costMilli, id);
  }
  setBlocked(id: string, code: BlockedCode | null, reason: string): void {
    const cur = this.getTask(id);
    this.db.prepare('UPDATE tasks SET blocked_code=?, blocked_reason=? WHERE id=?').run(code, reason, id);
    // G-04 旁路步：仅在「新进入一种停工」时落 blocked 步（同 code 反复 set 不重复落，避免 tick 刷步）；
    // 落步失败吞掉不阻断停工主流程（口径同 task_events 旁路）。
    if (cur && code !== null && cur.blocked_code !== code) {
      try {
        const n = this.countTaskSteps(id, 'blocked') + 1;
        this.insertTaskStep({
          task_id: id,
          workspace_id: cur.workspace_id ?? null,
          kind: 'blocked',
          actor_member_id: null,
          summary: `停工：${reason}`.slice(0, 200),
          detail: JSON.stringify({ code, reason }),
          call_key: `blocked:${id}:${n}`,
          duration_ms: null,
          prompt_tokens: null,
          completion_tokens: null,
          cost_milli: 0,
        });
      } catch {
        /* 旁路落步失败不阻断主流程 */
      }
    }
  }
  touchHeartbeat(ids: string[]): void {
    if (!ids.length) return;
    const ts = now();
    const stmt = this.db.prepare('UPDATE tasks SET heartbeat_at=? WHERE id=?');
    for (const id of ids) stmt.run(ts, id);
  }
  countByStatus(status: TaskStatus, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM tasks WHERE status=? AND workspace_id=?')
      .get(status, workspaceId) as { c: number };
    return r.c;
  }
  /**
   * 删除任务记录（M5 后悔药）：仅 domain 层校验为已完成/已取消后调用。
   * 注意：只删 tasks 行，ledger_entries 不删（删任务不删账，ADR-004 对账不受影响）。
   */
  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /* ----- ledger（append-only） ----- */
  insertLedger(row: Omit<LedgerRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO ledger_entries (task_id, team_id, api_id, stage, prompt_tokens, completion_tokens,
          total_tokens, cost_milli, estimated, created_at, workspace_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.task_id, row.team_id, row.api_id, row.stage, row.prompt_tokens, row.completion_tokens,
        row.total_tokens, row.cost_milli, row.estimated, row.created_at, wsOf(row.workspace_id),
      );
    return Number(r.lastInsertRowid);
  }
  listLedger(workspaceId: string = DEFAULT_WORKSPACE_ID): LedgerRow[] {
    return this.db
      .prepare('SELECT * FROM ledger_entries WHERE workspace_id = ? ORDER BY id')
      .all(workspaceId) as unknown as LedgerRow[];
  }
  ledgerSumByApi(apiId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): { totalTokens: number; costMilli: number; calls: number; estimatedTokens: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli,
          COUNT(*) AS calls, COALESCE(SUM(CASE WHEN estimated=1 THEN total_tokens ELSE 0 END),0) AS estimatedTokens
         FROM ledger_entries WHERE api_id=? AND workspace_id=?`,
      )
      .get(apiId, workspaceId) as { totalTokens: number; costMilli: number; calls: number; estimatedTokens: number };
    return r;
  }
  ledgerSumByTeam(teamId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): { totalTokens: number; costMilli: number } {
    return this.db
      .prepare(
        'SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli FROM ledger_entries WHERE team_id=? AND workspace_id=?',
      )
      .get(teamId, workspaceId) as { totalTokens: number; costMilli: number };
  }
  ledgerSumByTask(taskId: string): { totalTokens: number; costMilli: number } {
    return this.db
      .prepare(
        'SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli FROM ledger_entries WHERE task_id=?',
      )
      .get(taskId) as { totalTokens: number; costMilli: number };
  }
  ledgerTotals(workspaceId: string = DEFAULT_WORKSPACE_ID): { totalTokens: number; costMilli: number; estimatedTokens: number } {
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli,
          COALESCE(SUM(CASE WHEN estimated=1 THEN total_tokens ELSE 0 END),0) AS estimatedTokens FROM ledger_entries WHERE workspace_id=?`,
      )
      .get(workspaceId) as { totalTokens: number; costMilli: number; estimatedTokens: number };
  }

  /* ----- purchases ----- */
  insertPurchase(apiId: string, amountMilli: number, workspaceId: string = DEFAULT_WORKSPACE_ID, type: string = 'purchase'): void {
    this.db
      .prepare('INSERT INTO purchases (api_id, amount_milli, created_at, workspace_id, type) VALUES (?,?,?,?,?)')
      .run(apiId, amountMilli, now(), workspaceId, type);
  }
  listPurchases(workspaceId: string = DEFAULT_WORKSPACE_ID): PurchaseRow[] {
    return this.db
      .prepare('SELECT * FROM purchases WHERE workspace_id = ? ORDER BY id')
      .all(workspaceId) as unknown as PurchaseRow[];
  }
  purchasesSumByApi(apiId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(amount_milli),0) AS s FROM purchases WHERE api_id=? AND workspace_id=?')
      .get(apiId, workspaceId) as { s: number };
    return r.s;
  }
  /** 某空间在某 API 上的体验额度发放合计（type=trial_grant） */
  trialGrantedSum(apiId: string, workspaceId: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(amount_milli),0) AS s FROM purchases WHERE api_id=? AND workspace_id=? AND type='trial_grant'")
      .get(apiId, workspaceId) as { s: number };
    return r.s;
  }

  /* ----- llm_calls（幂等登记） ----- */
  getLlmCall(key: string): LlmCallRow | undefined {
    return this.db.prepare('SELECT * FROM llm_calls WHERE idempotency_key=?').get(key) as unknown as LlmCallRow | undefined;
  }
  startLlmCall(key: string, apiId: string): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (idempotency_key, api_id, status, created_at) VALUES (?,?, 'started', ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(key, apiId, now());
  }
  finishLlmCall(key: string, resultText: string, promptTokens: number, completionTokens: number, estimated: number): void {
    this.db
      .prepare(
        `UPDATE llm_calls SET status='done', result_text=?, prompt_tokens=?, completion_tokens=?, estimated=?, finished_at=? WHERE idempotency_key=?`,
      )
      .run(resultText, promptTokens, completionTokens, estimated, now(), key);
  }
  failLlmCall(key: string): void {
    this.db.prepare("UPDATE llm_calls SET status='failed', finished_at=? WHERE idempotency_key=?").run(now(), key);
  }

  /* ----- kb ----- */
  /** 本空间条目 + 平台公共条目（workspace_id 为 NULL）；personal 的按人过滤在调用方/注入层做 */
  listKb(workspaceId: string = DEFAULT_WORKSPACE_ID): KbRow[] {
    return this.db
      .prepare('SELECT * FROM kb_entries WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY created_at, id')
      .all(workspaceId) as unknown as KbRow[];
  }
  getKb(id: string, workspaceId?: string): KbRow | undefined {
    if (workspaceId !== undefined) {
      return this.db
        .prepare('SELECT * FROM kb_entries WHERE id = ? AND (workspace_id = ? OR workspace_id IS NULL)')
        .get(id, workspaceId) as unknown as KbRow | undefined;
    }
    return this.db.prepare('SELECT * FROM kb_entries WHERE id = ?').get(id) as unknown as KbRow | undefined;
  }
  insertKb(row: KbRow): void {
    this.db
      .prepare(
        'INSERT INTO kb_entries (id, title, body, scope, scope_id, tags, enabled, created_at, updated_at, workspace_id, owner_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        row.id, row.title, row.body, row.scope, row.scope_id, row.tags, row.enabled, row.created_at, row.updated_at,
        // workspace_id 显式为 null 表示平台公共条目，不可折算为默认空间
        row.workspace_id === undefined ? DEFAULT_WORKSPACE_ID : row.workspace_id,
        row.owner_user_id ?? null,
      );
  }
  updateKb(row: KbRow): void {
    this.db
      .prepare(
        'UPDATE kb_entries SET title=?, body=?, scope=?, scope_id=?, tags=?, enabled=?, updated_at=?, owner_user_id=? WHERE id=?',
      )
      .run(row.title, row.body, row.scope, row.scope_id, row.tags, row.enabled, row.updated_at, row.owner_user_id ?? null, row.id);
  }
  deleteKb(id: string): void {
    this.db.prepare('DELETE FROM kb_entries WHERE id = ?').run(id);
  }
  /** 记录本单注入的知识条目（与既有记录取并集，覆盖执行/重做多次尝试，§10 审计） */
  addTaskInjectedKb(id: string, kbIds: string[]): void {
    if (!kbIds.length) return;
    const cur = this.getTask(id);
    if (!cur) return;
    let existing: string[] = [];
    try {
      existing = JSON.parse(cur.injected_kb_ids || '[]') as string[];
    } catch {
      existing = [];
    }
    const merged = [...new Set([...existing, ...kbIds])];
    this.db.prepare('UPDATE tasks SET injected_kb_ids=? WHERE id=?').run(JSON.stringify(merged), id);
  }

  /* ----- settings（复合主键 workspace_id + key） ----- */
  getSetting<T>(key: string, fallback: T, workspaceId: string = DEFAULT_WORKSPACE_ID): T {
    const r = this.db
      .prepare('SELECT value FROM settings WHERE workspace_id=? AND key=?')
      .get(workspaceId, key) as { value: string } | undefined;
    if (!r) return fallback;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return fallback;
    }
  }
  setSetting(key: string, value: unknown, workspaceId: string = DEFAULT_WORKSPACE_ID): void {
    this.db
      .prepare(
        'INSERT INTO settings (workspace_id, key, value) VALUES (?,?,?) ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value',
      )
      .run(workspaceId, key, JSON.stringify(value ?? null));
  }

  /* ----- users / workspaces / memberships（M6） ----- */
  insertUser(row: UserRow): void {
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, display_name, status, is_platform_admin, must_change_password,
          failed_attempts, locked_until, registration_ip, last_login_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.email, row.password_hash, row.display_name, row.status, row.is_platform_admin,
        row.must_change_password, row.failed_attempts, row.locked_until, row.registration_ip, row.last_login_at, row.created_at,
      );
  }
  getUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as unknown as UserRow | undefined;
  }
  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  }
  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as unknown as UserRow[];
  }
  updateUser(row: UserRow): void {
    this.db
      .prepare(
        `UPDATE users SET email=?, password_hash=?, display_name=?, status=?, is_platform_admin=?, must_change_password=?,
          failed_attempts=?, locked_until=?, last_login_at=? WHERE id=?`,
      )
      .run(
        row.email, row.password_hash, row.display_name, row.status, row.is_platform_admin,
        row.must_change_password, row.failed_attempts, row.locked_until, row.last_login_at, row.id,
      );
  }
  countRecentRegistrationsByIp(ip: string, sinceIso: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM users WHERE registration_ip = ? AND created_at >= ?')
      .get(ip, sinceIso) as { c: number };
    return r.c;
  }

  insertWorkspace(row: WorkspaceRow): void {
    this.db
      .prepare('INSERT INTO workspaces (id, name, owner_user_id, status, industry_pack_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(row.id, row.name, row.owner_user_id, row.status, row.industry_pack_id, row.created_at);
  }
  getWorkspace(id: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as unknown as WorkspaceRow | undefined;
  }
  listWorkspaces(): WorkspaceRow[] {
    return this.db.prepare('SELECT * FROM workspaces ORDER BY created_at, id').all() as unknown as WorkspaceRow[];
  }
  insertMembership(row: MembershipRow): void {
    this.db
      .prepare(
        `INSERT INTO memberships (user_id, workspace_id, role, status, joined_at) VALUES (?,?,?,?,?)
         ON CONFLICT(user_id, workspace_id) DO UPDATE SET role=excluded.role, status=excluded.status`,
      )
      .run(row.user_id, row.workspace_id, row.role, row.status, row.joined_at);
  }
  getMembership(userId: string, workspaceId: string): MembershipRow | undefined {
    return this.db
      .prepare('SELECT * FROM memberships WHERE user_id = ? AND workspace_id = ?')
      .get(userId, workspaceId) as unknown as MembershipRow | undefined;
  }
  listMembershipsByUser(userId: string): MembershipRow[] {
    return this.db
      .prepare("SELECT * FROM memberships WHERE user_id = ? AND status = 'active' ORDER BY joined_at")
      .all(userId) as unknown as MembershipRow[];
  }

  /* ----- sessions / login_logs / preferences ----- */
  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, current_workspace_id, expires_at, created_ip, user_agent, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.user_id, row.current_workspace_id, row.expires_at, row.created_ip, row.user_agent, row.created_at, row.last_seen_at);
  }
  getSession(idHash: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(idHash) as unknown as SessionRow | undefined;
  }
  updateSession(row: SessionRow): void {
    this.db
      .prepare('UPDATE sessions SET current_workspace_id=?, expires_at=?, last_seen_at=? WHERE id=?')
      .run(row.current_workspace_id, row.expires_at, row.last_seen_at, row.id);
  }
  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(idHash);
  }
  deleteSessionsByUser(userId: string, exceptIdHash?: string): void {
    if (exceptIdHash) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptIdHash);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }
  insertLoginLog(row: { user_id: string | null; email: string; success: number; ip: string; reason: string }): void {
    this.db
      .prepare('INSERT INTO login_logs (user_id, email, success, ip, reason, created_at) VALUES (?,?,?,?,?,?)')
      .run(row.user_id, row.email, row.success, row.ip, row.reason, now());
  }
  getPreferences(userId: string): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
      .all(userId) as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value) as unknown;
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  }
  getPreference<T>(userId: string, key: string, fallback: T): T {
    const r = this.db
      .prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?')
      .get(userId, key) as { value: string } | undefined;
    if (!r) return fallback;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return fallback;
    }
  }
  setPreference(userId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO user_preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value',
      )
      .run(userId, key, JSON.stringify(value ?? null));
  }

  /* ----- task_events / audit_logs ----- */
  insertTaskEvent(row: {
    task_id: string;
    workspace_id: string | null;
    actor_type: string;
    actor_id: string | null;
    from_status: string | null;
    to_status: string;
    note?: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO task_events (task_id, workspace_id, actor_type, actor_id, from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.task_id, row.workspace_id, row.actor_type, row.actor_id, row.from_status, row.to_status, row.note ?? '', now());
  }
  listTaskEvents(taskId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id')
      .all(taskId) as unknown as Array<Record<string, unknown>>;
  }
  insertAudit(row: {
    workspace_id: string | null;
    user_id: string | null;
    action: string;
    target_type?: string;
    target_id?: string;
    detail?: string;
    ip?: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO audit_logs (workspace_id, user_id, action, target_type, target_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.workspace_id, row.user_id, row.action, row.target_type ?? '', row.target_id ?? '', row.detail ?? '', row.ip ?? '', now());
  }

  /* ----- 注册表（roles / task_types，§12.2） ----- */
  /** 当前空间可见工种：平台通用（无 pack）+ 本空间所属行业包注册的 + 本空间自定义的 */
  listRolesVisible(workspaceId: string, packId: string | null): RoleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM roles WHERE workspace_id = ?
           OR (workspace_id IS NULL AND pack_id IS NULL)
           OR (workspace_id IS NULL AND pack_id IS NOT NULL AND pack_id = ?)
         ORDER BY is_system DESC, created_at, id`,
      )
      .all(workspaceId, packId ?? '') as unknown as RoleRow[];
  }
  listTaskTypesVisible(workspaceId: string, packId: string | null): TaskTypeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_types WHERE workspace_id = ?
           OR (workspace_id IS NULL AND pack_id IS NULL)
           OR (workspace_id IS NULL AND pack_id IS NOT NULL AND pack_id = ?)
         ORDER BY created_at, id`,
      )
      .all(workspaceId, packId ?? '') as unknown as TaskTypeRow[];
  }
  /** 派单解析：任务类型 → 工种（优先空间自定义，其次行业包，其次平台通用） */
  resolveRoleForType(typeId: string, workspaceId: string, packId: string | null): string | null {
    const rows = this.listTaskTypesVisible(workspaceId, packId).filter((t) => t.type_id === typeId);
    if (!rows.length) return null;
    const own = rows.find((t) => t.workspace_id === workspaceId);
    const pack = rows.find((t) => t.pack_id && t.pack_id === packId);
    return (own ?? pack ?? rows[0]).role_id;
  }
  insertRole(row: RoleRow): void {
    this.db
      .prepare(
        'INSERT INTO roles (id, role_id, name, persona_template, color, icon, industry, pack_id, workspace_id, is_system, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.role_id, row.name, row.persona_template, row.color, row.icon, row.industry, row.pack_id, row.workspace_id, row.is_system, row.created_at);
  }
  insertTaskType(row: TaskTypeRow): void {
    this.db
      .prepare(
        'INSERT INTO task_types (id, type_id, name, role_id, industry, pack_id, workspace_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.type_id, row.name, row.role_id, row.industry, row.pack_id, row.workspace_id, row.created_at);
  }

  /* ----- 行业包 ----- */
  listIndustryPacks(onlyPublished = false): IndustryPackRow[] {
    const sql = onlyPublished
      ? "SELECT * FROM industry_packs WHERE status = 'published' ORDER BY created_at, id"
      : 'SELECT * FROM industry_packs ORDER BY created_at, id';
    return this.db.prepare(sql).all() as unknown as IndustryPackRow[];
  }
  getIndustryPack(id: string): IndustryPackRow | undefined {
    return this.db
      .prepare('SELECT * FROM industry_packs WHERE id = ? OR industry = ?')
      .get(id, id) as unknown as IndustryPackRow | undefined;
  }
  insertIndustryPack(row: IndustryPackRow): void {
    this.db
      .prepare(
        'INSERT INTO industry_packs (id, industry, name, version, description, author, content, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.industry, row.name, row.version, row.description, row.author, row.content, row.status, row.created_at, row.updated_at);
  }
  updateIndustryPack(row: IndustryPackRow): void {
    this.db
      .prepare(
        'UPDATE industry_packs SET industry=?, name=?, version=?, description=?, author=?, content=?, status=?, updated_at=? WHERE id=?',
      )
      .run(row.industry, row.name, row.version, row.description, row.author, row.content, row.status, row.updated_at, row.id);
  }

  /* ----- skills（M7，方案 §7） ----- */
  insertSkill(row: SkillRow): void {
    this.db
      .prepare(
        `INSERT INTO skills (id, slug, owner_type, owner_id, workspace_id, name, description, role,
          prompt_template, input_schema, kb_binding, output_spec, example_input, example_output,
          version, changelog, status, visibility, source_skill_id, source_version, install_count,
          verified_notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.slug, row.owner_type, row.owner_id, row.workspace_id, row.name, row.description,
        row.role, row.prompt_template, row.input_schema, row.kb_binding, row.output_spec,
        row.example_input, row.example_output, row.version, row.changelog, row.status, row.visibility,
        row.source_skill_id, row.source_version, row.install_count, row.verified_notes, row.created_by,
        row.created_at, row.updated_at,
      );
  }
  updateSkill(row: SkillRow): void {
    this.db
      .prepare(
        `UPDATE skills SET slug=?, owner_type=?, owner_id=?, workspace_id=?, name=?, description=?, role=?,
          prompt_template=?, input_schema=?, kb_binding=?, output_spec=?, example_input=?, example_output=?,
          version=?, changelog=?, status=?, visibility=?, source_skill_id=?, source_version=?, install_count=?,
          verified_notes=?, updated_at=? WHERE id=?`,
      )
      .run(
        row.slug, row.owner_type, row.owner_id, row.workspace_id, row.name, row.description, row.role,
        row.prompt_template, row.input_schema, row.kb_binding, row.output_spec, row.example_input,
        row.example_output, row.version, row.changelog, row.status, row.visibility, row.source_skill_id,
        row.source_version, row.install_count, row.verified_notes, row.updated_at, row.id,
      );
  }
  getSkill(id: string): SkillRow | undefined {
    return this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as unknown as SkillRow | undefined;
  }
  getSkillBySlugPlatform(slug: string): SkillRow | undefined {
    return this.db
      .prepare("SELECT * FROM skills WHERE slug = ? AND owner_type = 'platform'")
      .get(slug) as unknown as SkillRow | undefined;
  }
  /** 平台库：官方（owner_type=platform）+ 上架审核通过（visibility=public），均为 published 且未归档 */
  listLibrarySkills(): SkillRow[] {
    return this.db
      .prepare(
        "SELECT * FROM skills WHERE status = 'published' AND (owner_type = 'platform' OR visibility = 'public') ORDER BY install_count DESC, created_at, id",
      )
      .all() as unknown as SkillRow[];
  }
  /** 本空间 skill 全量（含自己的草稿/私有、空间共享、已装副本） */
  listWorkspaceSkills(workspaceId: string): SkillRow[] {
    return this.db
      .prepare('SELECT * FROM skills WHERE workspace_id = ? ORDER BY created_at, id')
      .all(workspaceId) as unknown as SkillRow[];
  }
  listPendingReviewSkills(): SkillRow[] {
    return this.db
      .prepare("SELECT * FROM skills WHERE visibility = 'pending_review' ORDER BY updated_at, id")
      .all() as unknown as SkillRow[];
  }
  findInstalledCopy(workspaceId: string, sourceSkillId: string): SkillRow | undefined {
    return this.db
      .prepare('SELECT * FROM skills WHERE workspace_id = ? AND source_skill_id = ?')
      .get(workspaceId, sourceSkillId) as unknown as SkillRow | undefined;
  }
  bumpSkillInstallCount(id: string): void {
    this.db.prepare('UPDATE skills SET install_count = install_count + 1 WHERE id = ?').run(id);
  }

  /* ----- 交付页 / 渠道推送（M7 §11.2） ----- */
  insertDeliveryLink(row: DeliveryLinkRow): void {
    this.db
      .prepare(
        `INSERT INTO delivery_links (id, token_hash, workspace_id, scope, task_id, project_id, title,
          password_hash, expires_at, revoked, view_count, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.token_hash, row.workspace_id, row.scope, row.task_id, row.project_id, row.title,
        row.password_hash, row.expires_at, row.revoked, row.view_count, row.created_by, row.created_at,
      );
  }
  getDeliveryByTokenHash(tokenHash: string): DeliveryLinkRow | undefined {
    return this.db
      .prepare('SELECT * FROM delivery_links WHERE token_hash = ?')
      .get(tokenHash) as unknown as DeliveryLinkRow | undefined;
  }
  getDelivery(id: string, workspaceId: string): DeliveryLinkRow | undefined {
    return this.db
      .prepare('SELECT * FROM delivery_links WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as unknown as DeliveryLinkRow | undefined;
  }
  listDeliveries(workspaceId: string): DeliveryLinkRow[] {
    return this.db
      .prepare('SELECT * FROM delivery_links WHERE workspace_id = ? ORDER BY created_at DESC, id')
      .all(workspaceId) as unknown as DeliveryLinkRow[];
  }
  revokeDelivery(id: string): void {
    this.db.prepare('UPDATE delivery_links SET revoked = 1 WHERE id = ?').run(id);
  }
  bumpDeliveryView(id: string): void {
    this.db.prepare('UPDATE delivery_links SET view_count = view_count + 1 WHERE id = ?').run(id);
  }
  insertChannelPush(row: Omit<ChannelPushRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO channel_pushes (workspace_id, channel_type, task_id, project_id, status, remote_ref, message, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.workspace_id, row.channel_type, row.task_id, row.project_id, row.status, row.remote_ref, row.message, row.created_at, row.updated_at);
    return Number(r.lastInsertRowid);
  }
  updateChannelPush(id: number, status: string, remoteRef: string, message: string): void {
    this.db
      .prepare('UPDATE channel_pushes SET status=?, remote_ref=?, message=?, updated_at=? WHERE id=?')
      .run(status, remoteRef, message, now(), id);
  }
  listChannelPushes(workspaceId: string): ChannelPushRow[] {
    return this.db
      .prepare('SELECT * FROM channel_pushes WHERE workspace_id = ? ORDER BY id DESC')
      .all(workspaceId) as unknown as ChannelPushRow[];
  }
  getChannelPush(id: number, workspaceId: string): ChannelPushRow | undefined {
    return this.db
      .prepare('SELECT * FROM channel_pushes WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as unknown as ChannelPushRow | undefined;
  }

  /* ----- 资产库（M8 §11.4/§12.3） ----- */
  listAssetTypesVisible(workspaceId: string, packId: string | null): AssetTypeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM asset_types WHERE workspace_id = ?
           OR (workspace_id IS NULL AND pack_id IS NULL)
           OR (workspace_id IS NULL AND pack_id IS NOT NULL AND pack_id = ?)
         ORDER BY created_at, id`,
      )
      .all(workspaceId, packId ?? '') as unknown as AssetTypeRow[];
  }
  insertAssetType(row: AssetTypeRow): void {
    this.db
      .prepare(
        'INSERT INTO asset_types (id, type_id, name, structure_schema, industry, pack_id, workspace_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.type_id, row.name, row.structure_schema, row.industry, row.pack_id, row.workspace_id, row.created_at);
  }
  insertAsset(row: AssetRow): void {
    this.db
      .prepare(
        'INSERT INTO assets (id, workspace_id, type_id, name, version, content, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.workspace_id, row.type_id, row.name, row.version, row.content, row.created_by, row.created_at, row.updated_at);
    this.insertAssetVersion(row.id, row.version, row.content);
  }
  insertAssetVersion(assetId: string, version: number, content: string): void {
    this.db
      .prepare('INSERT INTO asset_versions (asset_id, version, content, created_at) VALUES (?,?,?,?)')
      .run(assetId, version, content, now());
  }
  updateAsset(row: AssetRow): void {
    this.db
      .prepare('UPDATE assets SET type_id=?, name=?, version=?, content=?, updated_at=? WHERE id=?')
      .run(row.type_id, row.name, row.version, row.content, row.updated_at, row.id);
  }
  getAsset(id: string, workspaceId?: string): AssetRow | undefined {
    if (workspaceId !== undefined) {
      return this.db
        .prepare('SELECT * FROM assets WHERE id = ? AND workspace_id = ?')
        .get(id, workspaceId) as unknown as AssetRow | undefined;
    }
    return this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as unknown as AssetRow | undefined;
  }
  listAssets(workspaceId: string): AssetRow[] {
    return this.db
      .prepare('SELECT * FROM assets WHERE workspace_id = ? ORDER BY created_at, id')
      .all(workspaceId) as unknown as AssetRow[];
  }
  getAssetVersion(assetId: string, version: number): string | undefined {
    const r = this.db
      .prepare('SELECT content FROM asset_versions WHERE asset_id = ? AND version = ?')
      .get(assetId, version) as { content: string } | undefined;
    return r?.content;
  }
  insertTaskAssetRef(row: Omit<TaskAssetRefRow, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO task_asset_refs (task_id, workspace_id, asset_id, asset_version, sections, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(row.task_id, row.workspace_id, row.asset_id, row.asset_version, row.sections, row.created_at);
  }
  listTaskAssetRefs(taskId: string): TaskAssetRefRow[] {
    return this.db
      .prepare('SELECT * FROM task_asset_refs WHERE task_id = ? ORDER BY id')
      .all(taskId) as unknown as TaskAssetRefRow[];
  }
  /** 记录本单实际注入的资产（id@version 列表，多次执行尝试取并集） */
  addTaskInjectedAssets(id: string, assetRefs: string[]): void {
    if (!assetRefs.length) return;
    const cur = this.getTask(id);
    if (!cur) return;
    let existing: string[] = [];
    try {
      existing = JSON.parse(cur.injected_assets || '[]') as string[];
    } catch {
      existing = [];
    }
    const merged = [...new Set([...existing, ...assetRefs])];
    this.db.prepare('UPDATE tasks SET injected_assets=? WHERE id=?').run(JSON.stringify(merged), id);
  }

  /* ----- 成果标记 / 提醒 / 台账视图（M8） ----- */
  insertOutcomeMark(row: Omit<OutcomeMarkRow, 'id'>): number {
    const r = this.db
      .prepare(
        'INSERT INTO outcome_marks (task_id, workspace_id, verdict, metrics, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(row.task_id, row.workspace_id, row.verdict, row.metrics, row.note, row.created_by, row.created_at);
    return Number(r.lastInsertRowid);
  }
  latestOutcomeMark(taskId: string): OutcomeMarkRow | undefined {
    return this.db
      .prepare('SELECT * FROM outcome_marks WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as unknown as OutcomeMarkRow | undefined;
  }
  insertNotification(row: Omit<NotificationRow, 'id'>): number {
    const r = this.db
      .prepare(
        'INSERT INTO notifications (workspace_id, user_id, type, title, body, task_id, read_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.workspace_id, row.user_id, row.type, row.title, row.body, row.task_id, row.read_at, row.created_at);
    return Number(r.lastInsertRowid);
  }
  hasUnreadNotification(workspaceId: string, type: string, taskId: string | null): boolean {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS c FROM notifications WHERE workspace_id = ? AND type = ? AND task_id IS ? AND read_at IS NULL',
      )
      .get(workspaceId, type, taskId) as { c: number };
    return r.c > 0;
  }
  listNotifications(workspaceId: string, limit = 50): NotificationRow[] {
    return this.db
      .prepare('SELECT * FROM notifications WHERE workspace_id = ? ORDER BY id DESC LIMIT ?')
      .all(workspaceId, limit) as unknown as NotificationRow[];
  }
  /** G-03：通知分页 + 按 type 过滤（page 从 1 起）；返回当页行与过滤后总数 */
  listNotificationsPaged(
    workspaceId: string,
    opts: { type?: string; page?: number; pageSize?: number } = {},
  ): { rows: NotificationRow[]; total: number } {
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const where = opts.type ? 'workspace_id = ? AND type = ?' : 'workspace_id = ?';
    const args: Array<string | number> = opts.type ? [workspaceId, opts.type] : [workspaceId];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE ${where}`).get(...args) as { c: number }
    ).c;
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as unknown as NotificationRow[];
    return { rows, total };
  }
  countUnreadNotifications(workspaceId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM notifications WHERE workspace_id = ? AND read_at IS NULL')
      .get(workspaceId) as { c: number };
    return r.c;
  }
  markNotificationRead(id: number, workspaceId: string): void {
    this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND workspace_id = ? AND read_at IS NULL')
      .run(now(), id, workspaceId);
  }
  markAllNotificationsRead(workspaceId: string): void {
    this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL')
      .run(now(), workspaceId);
  }
  listTaskEventsByWorkspace(workspaceId: string, limit = 200): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM task_events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?')
      .all(workspaceId, limit) as unknown as Array<Record<string, unknown>>;
  }
  listAuditByWorkspace(workspaceId: string, limit = 200): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM audit_logs WHERE workspace_id = ? ORDER BY id DESC LIMIT ?')
      .all(workspaceId, limit) as unknown as Array<Record<string, unknown>>;
  }

  /* ----- 任务步骤（G-04，迁移 008）：旁路记录，只读投影，不参与状态机/回账决策 ----- */
  /**
   * 落一步（seq 在同 task_id 内自动递增）。UNIQUE(task_id, call_key) 冲突时抛错——
   * 调用方（domain/taskSteps 的 recordTaskStep）负责吞掉并记日志，保证重复写步被拒绝且不阻断主流程。
   */
  insertTaskStep(row: Omit<TaskStepRow, 'id' | 'seq' | 'created_at'>): TaskStepRow {
    const r = this.db
      .prepare(
        `INSERT INTO task_steps (task_id, workspace_id, seq, kind, actor_member_id, summary, detail,
           call_key, duration_ms, prompt_tokens, completion_tokens, cost_milli, created_at)
         VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM task_steps WHERE task_id=?),?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.task_id, row.workspace_id, row.task_id, row.kind, row.actor_member_id, row.summary,
        row.detail, row.call_key, row.duration_ms, row.prompt_tokens, row.completion_tokens,
        row.cost_milli, now(),
      );
    const saved = this.db
      .prepare('SELECT * FROM task_steps WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as unknown as TaskStepRow;
    return saved;
  }
  getTaskStepByCallKey(taskId: string, callKey: string): TaskStepRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? AND call_key = ?')
      .get(taskId, callKey) as unknown as TaskStepRow | undefined;
  }
  /** 补全已存在步的调用指标（网关回账时把「开始」步补成带 usage/耗时/成本的完整步） */
  updateTaskStepMetrics(
    id: number,
    patch: {
      summary?: string;
      detail?: string;
      duration_ms?: number | null;
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      cost_milli?: number;
    },
  ): void {
    const cur = this.db.prepare('SELECT * FROM task_steps WHERE id = ?').get(id) as unknown as TaskStepRow | undefined;
    if (!cur) return;
    this.db
      .prepare(
        'UPDATE task_steps SET summary=?, detail=?, duration_ms=?, prompt_tokens=?, completion_tokens=?, cost_milli=? WHERE id=?',
      )
      .run(
        patch.summary ?? cur.summary,
        patch.detail ?? cur.detail,
        patch.duration_ms !== undefined ? patch.duration_ms : cur.duration_ms,
        patch.prompt_tokens !== undefined ? patch.prompt_tokens : cur.prompt_tokens,
        patch.completion_tokens !== undefined ? patch.completion_tokens : cur.completion_tokens,
        patch.cost_milli !== undefined ? patch.cost_milli : cur.cost_milli,
        id,
      );
  }
  /* ----- 反馈（G-05，迁移 009）：只落库 + 管理台可见，不做工单流转 ----- */
  insertFeedback(row: Omit<FeedbackRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO feedback (user_id, workspace_id, category, content, contact, status, admin_note, created_at, handled_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.user_id, row.workspace_id, row.category, row.content, row.contact, row.status,
        row.admin_note, row.created_at, row.handled_at,
      );
    return Number(r.lastInsertRowid);
  }
  getFeedback(id: number): FeedbackRow | undefined {
    return this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as unknown as FeedbackRow | undefined;
  }
  /** 管理台列表：分页 + 按 status 过滤 */
  listFeedback(opts: { status?: string; page?: number; pageSize?: number } = {}): { rows: FeedbackRow[]; total: number } {
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const where = opts.status ? 'status = ?' : '1 = 1';
    const args: Array<string | number> = opts.status ? [opts.status] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM feedback WHERE ${where}`).get(...args) as { c: number }
    ).c;
    const rows = this.db
      .prepare(`SELECT * FROM feedback WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as unknown as FeedbackRow[];
    return { rows, total };
  }
  /** 频率限制口径：同用户 since 之后提交的反馈条数（POST /api/feedback 10 分钟 ≤5 条） */
  countFeedbackSince(userId: string, sinceIso: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM feedback WHERE user_id = ? AND created_at >= ?')
      .get(userId, sinceIso) as { c: number };
    return r.c;
  }
  markFeedbackHandled(id: number, adminNote: string | null): void {
    this.db
      .prepare("UPDATE feedback SET status = 'handled', admin_note = ?, handled_at = ? WHERE id = ?")
      .run(adminNote, now(), id);
  }

  /**
   * G-08 预估聚合：近 since 后 ledger 按任务汇总成本（仅真实任务行；
   * 记在项目 id 上的拆单行无 tasks 行、不计入单均口径）。
   */
  ledgerTaskCosts(
    workspaceId: string,
    sinceIso: string,
  ): Array<{ taskId: string; skillId: string | null; type: string; costMilli: number }> {
    return this.db
      .prepare(
        `SELECT l.task_id AS taskId, t.skill_id AS skillId, t.type AS type,
           COALESCE(SUM(l.cost_milli),0) AS costMilli
         FROM ledger_entries l JOIN tasks t ON t.id = l.task_id
         WHERE l.workspace_id = ? AND l.created_at >= ?
         GROUP BY l.task_id`,
      )
      .all(workspaceId, sinceIso) as unknown as Array<{
      taskId: string;
      skillId: string | null;
      type: string;
      costMilli: number;
    }>;
  }
  /** 最近一笔自有采购额（厘，type='purchase'，按 id 倒序）；无采购史返回 null（G-08 默认阈值口径） */
  latestPurchaseMilli(workspaceId: string): number | null {
    const r = this.db
      .prepare(
        "SELECT amount_milli AS s FROM purchases WHERE workspace_id = ? AND type = 'purchase' ORDER BY id DESC LIMIT 1",
      )
      .get(workspaceId) as { s: number } | undefined;
    return r ? r.s : null;
  }

  /** 按插入顺序（id 升序 = 时间顺序）取某任务全部步骤 */
  listTaskSteps(taskId: string): TaskStepRow[] {
    return this.db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY id')
      .all(taskId) as unknown as TaskStepRow[];
  }
  countTaskSteps(taskId: string, kind?: string): number {
    const r = kind
      ? (this.db.prepare('SELECT COUNT(*) AS c FROM task_steps WHERE task_id = ? AND kind = ?').get(taskId, kind) as { c: number })
      : (this.db.prepare('SELECT COUNT(*) AS c FROM task_steps WHERE task_id = ?').get(taskId) as { c: number });
    return r.c;
  }
}
