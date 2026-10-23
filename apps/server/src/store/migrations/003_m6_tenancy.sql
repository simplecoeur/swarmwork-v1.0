-- 003_m6_tenancy.sql —— M6 多用户平台：账号体系 + workspace 全量隔离 + 审计/事件底座
-- 口径（方案 §3/§12）：业务表加 workspace_id 并回填默认空间 ws_default；
-- settings 主键改 (workspace_id, key) 复合（重建表）；kb scope 扩 personal/platform；
-- purchases 加 type 标记（purchase|trial_grant）。默认空间与管理员用户行在此落位，
-- 管理员密码哈希由启动 bootstrap 按环境变量/随机口令文件写入（代码与 SQL 不含明文口令）。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  registration_ip TEXT NOT NULL DEFAULT '',
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  industry_pack_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  current_workspace_id TEXT,
  expires_at TEXT NOT NULL,
  created_ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  email TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  workspace_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'engine',
  actor_id TEXT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_logs(workspace_id, created_at);

-- 默认空间（§3.4）：现有单人数据整体收编于此；owner 为 bootstrap 创建的管理员 user_admin
INSERT OR IGNORE INTO workspaces (id, name, owner_user_id, status, industry_pack_id, created_at)
VALUES ('ws_default', 'MJ 蜂群', 'user_admin', 'active', 'pack_short_drama', '2026-10-23T00:00:00.000Z');
INSERT OR IGNORE INTO memberships (user_id, workspace_id, role, status, joined_at)
VALUES ('user_admin', 'ws_default', 'owner', 'active', '2026-10-23T00:00:00.000Z');

-- 业务表加 workspace_id 并回填默认空间
ALTER TABLE apis ADD COLUMN workspace_id TEXT;
ALTER TABLE apis ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0;
UPDATE apis SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

ALTER TABLE teams ADD COLUMN workspace_id TEXT;
UPDATE teams SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

ALTER TABLE members ADD COLUMN workspace_id TEXT;
UPDATE members SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

ALTER TABLE projects ADD COLUMN workspace_id TEXT;
UPDATE projects SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

ALTER TABLE tasks ADD COLUMN workspace_id TEXT;
ALTER TABLE tasks ADD COLUMN created_by_user_id TEXT;
ALTER TABLE tasks ADD COLUMN skill_id TEXT;
ALTER TABLE tasks ADD COLUMN skill_version INTEGER;
UPDATE tasks SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

ALTER TABLE ledger_entries ADD COLUMN workspace_id TEXT;
UPDATE ledger_entries SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

ALTER TABLE purchases ADD COLUMN workspace_id TEXT;
ALTER TABLE purchases ADD COLUMN type TEXT NOT NULL DEFAULT 'purchase';
UPDATE purchases SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

ALTER TABLE kb_entries ADD COLUMN workspace_id TEXT;
ALTER TABLE kb_entries ADD COLUMN owner_user_id TEXT;
UPDATE kb_entries SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;
-- 旧 member 范围折算为 personal：scope_id 仍保留原 AI 成员 id 作尽力映射，owner_user_id 可空
UPDATE kb_entries SET scope = 'personal' WHERE scope = 'member';

CREATE INDEX IF NOT EXISTS idx_apis_ws ON apis(workspace_id);
CREATE INDEX IF NOT EXISTS idx_teams_ws ON teams(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_members_ws ON members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_ws ON ledger_entries(workspace_id, api_id);
CREATE INDEX IF NOT EXISTS idx_purchases_ws ON purchases(workspace_id, api_id);
CREATE INDEX IF NOT EXISTS idx_kb_ws ON kb_entries(workspace_id, scope);

-- settings 主键改 (workspace_id, key) 复合（重建表迁移，现值整体归默认空间）
CREATE TABLE settings_new (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
INSERT INTO settings_new (workspace_id, key, value) SELECT 'ws_default', key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;
