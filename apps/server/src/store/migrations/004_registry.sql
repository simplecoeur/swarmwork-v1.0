-- 004_registry.sql —— M6 工种/任务类型注册表（方案 §12.2）
-- 现有五工种与 TYPE_ROLE 映射作种子迁入；组长/审核为系统保留位（is_system=1，流水线协议位）。
-- id 为代理主键（行唯一），role_id/type_id 为业务标识：平台通用行 workspace_id、pack_id 均为空；
-- 行业包注册行带 pack_id；空间自定义行带 workspace_id。
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  name TEXT NOT NULL,
  persona_template TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  industry TEXT,
  pack_id TEXT,
  workspace_id TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_roles_lookup ON roles(role_id, workspace_id, pack_id);

CREATE TABLE IF NOT EXISTS task_types (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  industry TEXT,
  pack_id TEXT,
  workspace_id TEXT,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_task_types_lookup ON task_types(type_id, workspace_id, pack_id);

INSERT OR IGNORE INTO roles (id, role_id, name, persona_template, color, icon, industry, pack_id, workspace_id, is_system, created_at) VALUES
('role_leader', '组长', '组长', '你是一名派单员/组长，负责理解老板的方案、拆解任务、跟进进度，表达简洁干练。', '#d93a2b', '', NULL, NULL, NULL, 1, '2026-10-23T00:00:00.000Z'),
('role_researcher', '研究员', '研究员', '你是一名研究员，擅长查资料、汇总信息、提炼要点，产出结构清晰的调研摘要，注明不确定的信息。', '#3a6fd8', '', NULL, NULL, NULL, 0, '2026-10-23T00:00:00.000Z'),
('role_writer', '文案', '文案', '你是一名文案，擅长写标题、脚本、简介、推文等文字产出，文风生动有钩子，贴合目标受众。', '#e8a13a', '', NULL, NULL, NULL, 0, '2026-10-23T00:00:00.000Z'),
('role_coder', '程序员', '程序员', '你是一名程序员，擅长写清晰、可直接运行的代码片段，并附简短的使用说明。', '#3f9e63', '', NULL, NULL, NULL, 0, '2026-10-23T00:00:00.000Z'),
('role_reviewer', '审核', '审核', '你是一名严格的审核员，只按老板给定的审核要点与甲方需求逐条核对成果，不放水也不吹毛求疵。', '#7a5fd0', '', NULL, NULL, NULL, 1, '2026-10-23T00:00:00.000Z');

INSERT OR IGNORE INTO task_types (id, type_id, name, role_id, industry, pack_id, workspace_id, created_at) VALUES
('tt_writing', '文案', '文案', '文案', NULL, NULL, NULL, '2026-10-23T00:00:00.000Z'),
('tt_research', '调研', '调研', '研究员', NULL, NULL, NULL, '2026-10-23T00:00:00.000Z'),
('tt_code', '代码', '代码', '程序员', NULL, NULL, NULL, '2026-10-23T00:00:00.000Z');
