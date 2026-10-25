-- 021_v140_agent_templates.sql —— v1.4.0 J：GitHub 智能体同步 → 官方人才库。
-- agent_templates：外部仓库同步来的智能体模板，平台级（不属于任何空间）。
-- draft_* = 最新一次同步的待审内容；published_*（pub_*）= 已过审上架快照（可空，未上架前为 NULL）。
-- 同步只写 draft_*：已上架模板有新草稿时 has_pending_update=1、pub 快照不动，等管理员复审。
-- status：pending_review（待审）/ public（已上架）/ rejected（已驳回）；(source_repo, source_path) 唯一保证同步幂等。
CREATE TABLE agent_templates (
  id TEXT PRIMARY KEY,
  source_repo TEXT NOT NULL,
  source_path TEXT NOT NULL,
  division TEXT NOT NULL DEFAULT '',
  draft_name TEXT NOT NULL DEFAULT '',
  draft_specialty TEXT NOT NULL DEFAULT '',
  draft_persona TEXT NOT NULL DEFAULT '',
  draft_role TEXT NOT NULL DEFAULT '',
  pub_name TEXT,
  pub_specialty TEXT,
  pub_persona TEXT,
  pub_role TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  source_author TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_review',
  has_pending_update INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT NOT NULL DEFAULT '',
  recruit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_repo, source_path)
);
CREATE INDEX idx_agent_templates_status ON agent_templates(status, recruit_count DESC);
