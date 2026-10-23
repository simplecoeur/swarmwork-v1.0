-- 002_kb.sql —— M3 知识库一期（设计 §10，任务规格字段口径）
-- kb_entries 由 001 的 (scope/team_id/owner_member_id/kind/content) 重建为
-- (title/body/scope(company|team|member)/scope_id/tags/enabled/created_at/updated_at)；
-- 001 存量数据折算迁入：content→body、team_id→scope_id、启用默认开、updated_at=created_at。
CREATE TABLE kb_entries_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'company',
  scope_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO kb_entries_new (id, title, body, scope, scope_id, tags, enabled, created_at, updated_at)
SELECT id, title, content,
  CASE WHEN scope = 'team' THEN 'team' ELSE 'company' END,
  team_id, tags, 1, created_at, created_at
FROM kb_entries;

DROP TABLE kb_entries;
ALTER TABLE kb_entries_new RENAME TO kb_entries;
CREATE INDEX IF NOT EXISTS idx_kb_scope ON kb_entries(scope, scope_id);

-- 注入审计（§10）：任务实际注入的知识库条目 ids（JSON 数组，多次尝试取并集）
ALTER TABLE tasks ADD COLUMN injected_kb_ids TEXT NOT NULL DEFAULT '[]';
