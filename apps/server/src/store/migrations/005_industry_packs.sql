-- 005_industry_packs.sql —— M6 行业包（方案 §12.1）
-- 包本体以 JSON manifest 存 content；平台内置包种子由启动 bootstrap 写入（内容在包模块中维护）。
CREATE TABLE IF NOT EXISTS industry_packs (
  id TEXT PRIMARY KEY,
  industry TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'platform',
  content TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
