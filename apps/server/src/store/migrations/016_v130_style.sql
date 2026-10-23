-- 016_v130_style.sql —— v1.3.0 F 公司风格：风格模板表。
-- 当前空间正在用的风格不入本表，走 settings(key='officeStyle', workspace 维度)；
-- 本表只存「模板」：owner_type=platform 为官方 6 套（workspace_id 空、visibility='public'），
-- workspace 为用户自建（visibility: private 仅自己 / workspace 空间内 / pending_review 待审 / public 已过审进平台库）。
-- config 为 OfficeStyle 配置 JSON 原文（palette/floorPattern/furniture/poster/sign）；
-- contributor_* 为提交者署名快照（建模板时落定，进平台库公示用）。
-- config 引用的图片文件可见性由 GET /api/style-images/:fileId 把关：
-- 仅文件属本空间、或被某个 visibility='public' 模板引用时可读（未过审模板的图片不公示）。
CREATE TABLE IF NOT EXISTS style_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  owner_type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  apply_count INTEGER NOT NULL DEFAULT 0,
  contributor_name TEXT,
  contributor_workspace_name TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_style_templates_ws ON style_templates(workspace_id, visibility);
CREATE INDEX IF NOT EXISTS idx_style_templates_public ON style_templates(visibility, owner_type);
