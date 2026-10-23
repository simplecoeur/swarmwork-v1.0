import type { DatabaseSync } from 'node:sqlite';
import type { BlockedCode, ProjectStatus, TaskStatus } from '@swarm/shared';

/* ---------- 行类型（与 §5 表结构一一对应） ---------- */
export interface ApiRow {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  api_key_enc: string;
  model: string;
  price_per_m_milli: number;
  created_at: string;
}

export interface TeamRow {
  id: string;
  name: string;
  color: string;
  api_id: string | null;
  created_at: string;
  deleted_at: string | null;
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
}

export interface ProjectRow {
  id: string;
  name: string;
  brief: string;
  team_id: string;
  client_name: string;
  status: ProjectStatus;
  created_at: string;
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
}

export interface PurchaseRow {
  id: number;
  api_id: string;
  amount_milli: number;
  created_at: string;
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
}

const now = () => new Date().toISOString();

/**
 * 仓储层。约束（ADR-004）：ledger 仓储只提供 insert 与查询聚合，
 * 本类中不存在任何 update/delete ledger 的方法。
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
  listApis(): ApiRow[] {
    return this.db.prepare('SELECT * FROM apis ORDER BY created_at, id').all() as unknown as ApiRow[];
  }
  getApi(id: string): ApiRow | undefined {
    return this.db.prepare('SELECT * FROM apis WHERE id = ?').get(id) as unknown as ApiRow | undefined;
  }
  insertApi(row: ApiRow): void {
    this.db
      .prepare(
        'INSERT INTO apis (id, name, provider, base_url, api_key_enc, model, price_per_m_milli, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.name, row.provider, row.base_url, row.api_key_enc, row.model, row.price_per_m_milli, row.created_at);
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
  listTeams(): TeamRow[] {
    return this.db
      .prepare('SELECT * FROM teams WHERE deleted_at IS NULL ORDER BY created_at, id')
      .all() as unknown as TeamRow[];
  }
  getTeam(id: string): TeamRow | undefined {
    const r = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as unknown as TeamRow | undefined;
    return r && !r.deleted_at ? r : undefined;
  }
  insertTeam(row: TeamRow): void {
    this.db
      .prepare('INSERT INTO teams (id, name, color, api_id, created_at, deleted_at) VALUES (?,?,?,?,?,NULL)')
      .run(row.id, row.name, row.color, row.api_id, row.created_at);
  }
  updateTeam(row: TeamRow): void {
    this.db
      .prepare('UPDATE teams SET name=?, color=?, api_id=? WHERE id=?')
      .run(row.name, row.color, row.api_id, row.id);
  }
  softDeleteTeam(id: string): void {
    this.db.prepare('UPDATE teams SET deleted_at=? WHERE id=?').run(now(), id);
  }
  listMembers(): MemberRow[] {
    return this.db
      .prepare(
        'SELECT m.* FROM members m JOIN teams t ON t.id = m.team_id WHERE t.deleted_at IS NULL ORDER BY m.team_id, m.id',
      )
      .all() as unknown as MemberRow[];
  }
  getMember(id: string): MemberRow | undefined {
    return this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as unknown as MemberRow | undefined;
  }
  teamMember(teamId: string, role: string): MemberRow | undefined {
    return this.db
      .prepare('SELECT * FROM members WHERE team_id = ? AND role = ? ORDER BY id LIMIT 1')
      .get(teamId, role) as unknown as MemberRow | undefined;
  }
  insertMember(row: MemberRow): void {
    this.db
      .prepare(
        'INSERT INTO members (id, team_id, name, role, persona, prompt, skill_tags, color) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.team_id, row.name, row.role, row.persona, row.prompt, row.skill_tags, row.color);
  }
  updateMemberPrompt(id: string, name: string, prompt: string): void {
    this.db.prepare('UPDATE members SET name=?, prompt=? WHERE id=?').run(name, prompt, id);
  }

  /* ----- projects ----- */
  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as unknown as ProjectRow[];
  }
  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
  }
  insertProject(row: ProjectRow): void {
    this.db
      .prepare('INSERT INTO projects (id, name, brief, team_id, client_name, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, row.name, row.brief, row.team_id, row.client_name, row.status, row.created_at);
  }
  updateProjectStatus(id: string, status: ProjectStatus): void {
    this.db.prepare('UPDATE projects SET status=? WHERE id=?').run(status, id);
  }

  /* ----- tasks ----- */
  listTasks(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as unknown as TaskRow[];
  }
  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  }
  insertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, team_id, assignee_id, title, type, brief, status, result,
          review_note, reject_reason, reject_count, blocked_reason, blocked_code, adjudicated,
          idempotency_key, total_tokens, total_cost_milli, heartbeat_at, injected_kb_ids, created_at, claimed_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.project_id, row.team_id, row.assignee_id, row.title, row.type, row.brief, row.status,
        row.result, row.review_note, row.reject_reason, row.reject_count, row.blocked_reason, row.blocked_code,
        row.adjudicated, row.idempotency_key, row.total_tokens, row.total_cost_milli, row.heartbeat_at,
        row.injected_kb_ids, row.created_at, row.claimed_at, row.finished_at,
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
  countByStatus(status: TaskStatus): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE status=?').get(status) as { c: number };
    return r.c;
  }

  /* ----- ledger（append-only） ----- */
  insertLedger(row: Omit<LedgerRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO ledger_entries (task_id, team_id, api_id, stage, prompt_tokens, completion_tokens,
          total_tokens, cost_milli, estimated, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.task_id, row.team_id, row.api_id, row.stage, row.prompt_tokens, row.completion_tokens,
        row.total_tokens, row.cost_milli, row.estimated, row.created_at,
      );
    return Number(r.lastInsertRowid);
  }
  listLedger(): LedgerRow[] {
    return this.db.prepare('SELECT * FROM ledger_entries ORDER BY id').all() as unknown as LedgerRow[];
  }
  ledgerSumByApi(apiId: string): { totalTokens: number; costMilli: number; calls: number; estimatedTokens: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli,
          COUNT(*) AS calls, COALESCE(SUM(CASE WHEN estimated=1 THEN total_tokens ELSE 0 END),0) AS estimatedTokens
         FROM ledger_entries WHERE api_id=?`,
      )
      .get(apiId) as { totalTokens: number; costMilli: number; calls: number; estimatedTokens: number };
    return r;
  }
  ledgerSumByTeam(teamId: string): { totalTokens: number; costMilli: number } {
    return this.db
      .prepare(
        'SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli FROM ledger_entries WHERE team_id=?',
      )
      .get(teamId) as { totalTokens: number; costMilli: number };
  }
  ledgerSumByTask(taskId: string): { totalTokens: number; costMilli: number } {
    return this.db
      .prepare(
        'SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli FROM ledger_entries WHERE task_id=?',
      )
      .get(taskId) as { totalTokens: number; costMilli: number };
  }
  ledgerTotals(): { totalTokens: number; costMilli: number; estimatedTokens: number } {
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_milli),0) AS costMilli,
          COALESCE(SUM(CASE WHEN estimated=1 THEN total_tokens ELSE 0 END),0) AS estimatedTokens FROM ledger_entries`,
      )
      .get() as { totalTokens: number; costMilli: number; estimatedTokens: number };
  }

  /* ----- purchases ----- */
  insertPurchase(apiId: string, amountMilli: number): void {
    this.db.prepare('INSERT INTO purchases (api_id, amount_milli, created_at) VALUES (?,?,?)').run(apiId, amountMilli, now());
  }
  listPurchases(): PurchaseRow[] {
    return this.db.prepare('SELECT * FROM purchases ORDER BY id').all() as unknown as PurchaseRow[];
  }
  purchasesSumByApi(apiId: string): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(amount_milli),0) AS s FROM purchases WHERE api_id=?')
      .get(apiId) as { s: number };
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
  listKb(): KbRow[] {
    return this.db.prepare('SELECT * FROM kb_entries ORDER BY created_at, id').all() as unknown as KbRow[];
  }
  getKb(id: string): KbRow | undefined {
    return this.db.prepare('SELECT * FROM kb_entries WHERE id = ?').get(id) as unknown as KbRow | undefined;
  }
  insertKb(row: KbRow): void {
    this.db
      .prepare(
        'INSERT INTO kb_entries (id, title, body, scope, scope_id, tags, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(row.id, row.title, row.body, row.scope, row.scope_id, row.tags, row.enabled, row.created_at, row.updated_at);
  }
  updateKb(row: KbRow): void {
    this.db
      .prepare(
        'UPDATE kb_entries SET title=?, body=?, scope=?, scope_id=?, tags=?, enabled=?, updated_at=? WHERE id=?',
      )
      .run(row.title, row.body, row.scope, row.scope_id, row.tags, row.enabled, row.updated_at, row.id);
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

  /* ----- settings ----- */
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    if (!r) return fallback;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return fallback;
    }
  }
  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value ?? null));
  }
}
