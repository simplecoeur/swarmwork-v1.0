-- 001_init.sql —— 干活蜂群初始 schema（设计 §5）
-- 金额一律整数（厘）；时间一律 ISO8601 文本（UTC）。
CREATE TABLE IF NOT EXISTS apis (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  price_per_m_milli INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5b8def',
  api_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  skill_tags TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  team_id TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '进行中',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  team_id TEXT NOT NULL,
  assignee_id TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '待领取',
  result TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  reject_reason TEXT NOT NULL DEFAULT '',
  reject_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT NOT NULL DEFAULT '',
  blocked_code TEXT,
  adjudicated INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_milli INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

-- 账本：append-only（仓储层不提供 UPDATE/DELETE，ADR-004）
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  api_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_milli INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_api ON ledger_entries(api_id);
CREATE INDEX IF NOT EXISTS idx_ledger_task ON ledger_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_ledger_team ON ledger_entries(team_id);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_id TEXT NOT NULL,
  amount_milli INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- LLM 调用幂等登记：同键已完成的调用直接复用结果，防重复记账（§8）
CREATE TABLE IF NOT EXISTS llm_calls (
  idempotency_key TEXT PRIMARY KEY,
  api_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  result_text TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS kb_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'company',
  team_id TEXT,
  owner_member_id TEXT,
  kind TEXT NOT NULL DEFAULT '资料',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
