-- 023_v150_aiops.sql —— v1.5.0 M：AI 平台运营官（一期）。
-- 运营 run：原始指令全文 + 结构化计划（步骤 JSON，含每步状态/结果/回滚数据）+ 执行报告 JSON。
-- 每步的管理动作另行写 audit_logs（action 以 ai_ops_ 前缀，detail 关联 run id 与指令），本表是回看/回滚的载体。
CREATE TABLE ai_ops_runs (
  id TEXT PRIMARY KEY,
  instruction TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '{"steps":[]}',
  status TEXT NOT NULL DEFAULT 'planned',
  created_by TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  report TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_ai_ops_runs_created ON ai_ops_runs(created_at DESC);
