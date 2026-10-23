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
          workspace_id, created_by_user_id, skill_id, skill_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.project_id, row.team_id, row.assignee_id, row.title, row.type, row.brief, row.status,
        row.result, row.review_note, row.reject_reason, row.reject_count, row.blocked_reason, row.blocked_code,
        row.adjudicated, row.idempotency_key, row.total_tokens, row.total_cost_milli, row.heartbeat_at,
        row.injected_kb_ids, row.created_at, row.claimed_at, row.finished_at,
        wsOf(row.workspace_id), row.created_by_user_id ?? null, row.skill_id ?? null, row.skill_version ?? null,
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
    this.db.prepare('UPDATE tasks SET blocked_code=?, blocked_reason=? WHERE id=?').run(code, reason, id);
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
}
