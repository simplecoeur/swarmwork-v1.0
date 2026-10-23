-- 006_skills.sql —— M7 skill 系统（方案 §7）+ 交付页令牌（§11.2）
-- skill = 可复用的岗位作业包：渲染成普通任务进入现有状态机与账本，不新造执行链。
-- 平台库成员口径：visibility='public' 且 status='published'（含官方 owner_type='platform' 与用户上架审核通过的）；
-- 安装 = 快照复制（source_skill_id/source_version 溯源），源头改动不回灌已装副本。
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'workspace',
  owner_id TEXT,
  workspace_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '文案',
  prompt_template TEXT NOT NULL DEFAULT '',
  input_schema TEXT NOT NULL DEFAULT '[]',
  kb_binding TEXT NOT NULL DEFAULT '{}',
  output_spec TEXT NOT NULL DEFAULT '',
  example_input TEXT NOT NULL DEFAULT '{}',
  example_output TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  changelog TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT NOT NULL DEFAULT 'private',
  source_skill_id TEXT,
  source_version INTEGER,
  install_count INTEGER NOT NULL DEFAULT 0,
  verified_notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_ws ON skills(workspace_id, status, visibility);
CREATE INDEX IF NOT EXISTS idx_skills_library ON skills(visibility, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_platform_slug ON skills(slug) WHERE owner_type = 'platform';

-- 任务补列：skill 发单的参数快照（成果库一键再发/改参数再发，§5.1）与试运行标记（§7.3 试运行照常记账）
ALTER TABLE tasks ADD COLUMN skill_params TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN is_skill_test INTEGER NOT NULL DEFAULT 0;

-- 只读交付页（§11.2）：token 只存哈希；scope=task|project；可设有效期与访问口令（口令只存哈希）、可撤销
CREATE TABLE IF NOT EXISTS delivery_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'task',
  task_id TEXT,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_ws ON delivery_links(workspace_id, created_at);

-- 渠道推送记录（§11.2/§12.4）：适配器 pushPublish 的落账，状态可回查（pending|accepted|failed）
CREATE TABLE IF NOT EXISTS channel_pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  task_id TEXT,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  remote_ref TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pushes_ws ON channel_pushes(workspace_id, created_at);
