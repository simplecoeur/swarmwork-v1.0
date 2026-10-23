-- 007_m8.sql —— M8 飞轮/资产/流水线/成果库/提醒（方案 §5.1、§11.1、§11.4、§11.5、§12.3）
-- 资产类型注册表（与 roles/task_types 同构）：剧本只是短剧包注册的第一个类型示例，内核不感知类型语义。
CREATE TABLE IF NOT EXISTS asset_types (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  structure_schema TEXT NOT NULL DEFAULT '{}',
  industry TEXT,
  pack_id TEXT,
  workspace_id TEXT,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_asset_types_lookup ON asset_types(type_id, workspace_id, pack_id);

INSERT OR IGNORE INTO asset_types (id, type_id, name, structure_schema, industry, pack_id, workspace_id, created_at) VALUES
('at_doc', '通用文档', '通用文档', '{"sections":"自由分段"}', NULL, NULL, NULL, '2026-10-23T00:00:00.000Z'),
('at_script', '剧本', '剧本', '{"sections":"按集分段：key=ep{n}，title=第n集"}', 'short_drama', 'pack_short_drama', NULL, '2026-10-23T00:00:00.000Z'),
('at_synopsis', '分集梗概', '分集梗概', '{"sections":"按集分段：key=ep{n}，title=第n集"}', 'short_drama', 'pack_short_drama', NULL, '2026-10-23T00:00:00.000Z'),
('at_selling', '卖点资料', '卖点资料', '{"sections":"自由分段"}', 'short_drama', 'pack_short_drama', NULL, '2026-10-23T00:00:00.000Z'),
('at_brief', '甲方brief', '甲方 brief 原件', '{"sections":"整份单段"}', 'short_drama', 'pack_short_drama', NULL, '2026-10-23T00:00:00.000Z');

-- 资产本体（当前版）+ 版本快照（历史版本内容留存，任务注入记录按版本可追溯）
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_ws ON assets(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS asset_versions (
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, version)
);

-- 任务-资产引用：发单时落快照（资产 id + 当时版本号 + 引用分段 key 列表，空=整份）
CREATE TABLE IF NOT EXISTS task_asset_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_version INTEGER NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_asset_refs_task ON task_asset_refs(task_id);

-- 任务实际注入的资产记录（id@version 列表，引擎执行后回填）
ALTER TABLE tasks ADD COLUMN injected_assets TEXT NOT NULL DEFAULT '[]';
-- 流水线顺序位：同项目内 seq 较小者未终结（done/cancelled）时，后序任务不领取
ALTER TABLE tasks ADD COLUMN seq INTEGER;

-- 成果标记（飞轮一期 §11.5）：结构化打标 有效/无效 + 指标数字（播放/点击率/完播等，JSON）
CREATE TABLE IF NOT EXISTS outcome_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  metrics TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marks_task ON outcome_marks(task_id);
CREATE INDEX IF NOT EXISTS idx_marks_ws ON outcome_marks(workspace_id, verdict);

-- 站内提醒（§9 M8：待裁决/余额耗尽/打回满次转裁决；邮件通道仅留配置位，本表只管站内）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  user_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_ws ON notifications(workspace_id, read_at, created_at);
