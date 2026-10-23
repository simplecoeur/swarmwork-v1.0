-- 015_v130.sql —— v1.3.0 A3 任务模板表 + B 生态（skills 精选/署名/上架时间列）
-- skills 增列：
-- - featured/featured_at：管理员「官方精选」晋升标记与时间（仅用户上架 skill 可设，路由层校验）。
-- - listed_at：上架（审核通过）时间，「最新动态」公示口径。
-- - contributor_name/contributor_workspace_name：公开署名快照，approve 时落定；
--   源用户改名/注销后仍显示快照（DTO 层 contributorOf 优先读快照、皆空才实时回退）。
ALTER TABLE skills ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN featured_at TEXT;
ALTER TABLE skills ADD COLUMN listed_at TEXT;
ALTER TABLE skills ADD COLUMN contributor_name TEXT;
ALTER TABLE skills ADD COLUMN contributor_workspace_name TEXT;

-- 任务模板（A3）：scope=official 平台官方（workspace_id 空）/ industry 行业包（industry_pack_id）/
-- workspace 本空间自建。可见集 = 本空间 + official + 本空间行业包的 industry（路由层拼装）。
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  scope TEXT NOT NULL,
  industry_pack_id TEXT,
  name TEXT NOT NULL,
  type_id TEXT NOT NULL,
  brief_template TEXT NOT NULL DEFAULT '',
  suggested_role TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_templates_scope ON task_templates(scope, industry_pack_id, workspace_id);
