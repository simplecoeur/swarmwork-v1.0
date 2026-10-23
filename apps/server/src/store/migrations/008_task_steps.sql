-- 008_task_steps.sql —— G-04 任务过程时间线（v1.2.0 施工设计 G-04）
-- 任务步骤流：引擎/domain 在领取、注入、每次 Provider 调用返回、拆单、停工、回收、裁决等
-- 触点旁路落步，只做记录、不参与状态机与回账决策（状态机 §6/§15.2 不动）。
-- call_key 为该步的幂等键：UNIQUE(task_id, call_key) 保证引擎重试/回收路径下不产生重复步；
-- 拆单步的 task_id 记项目 id（与拆单账本行同口径，账本 task_id = 项目 id）。
CREATE TABLE IF NOT EXISTS task_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  workspace_id TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  actor_member_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  call_key TEXT NOT NULL,
  duration_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_milli INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_steps_call_key ON task_steps(task_id, call_key);
CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, id);
