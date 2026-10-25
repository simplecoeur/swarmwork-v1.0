-- 011_schedules.sql —— G-10 定时任务（v1.2.0 施工设计 G-10）
-- schedules：计划只是「到点替老板按下发单钮」——kind 区分 skill 发单 / 流水线 / 普通任务，
-- params JSON 存对应发单参数快照（skill 参数 / 流水线公共参数 / 资产引用 assetRefs）。
-- next_run_at 为 UTC ISO 时刻，由服务端按 timezone + time_local + freq/weekday 计算（Intl，不引库）；
-- 调度器 30s 扫描 enabled=1 且 next_run_at<=now 的行，先推进 next_run_at 再发单（防重复发单）。
-- last_result: dispatched（已发单）| blocked（被守卫拦截，如零余额）| failed（目标失效等）；成功不逐次通知。
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task',
  skill_id TEXT,
  pipeline_template_id TEXT,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '文案',
  params TEXT NOT NULL DEFAULT '{}',
  freq TEXT NOT NULL DEFAULT 'daily',
  weekday INTEGER,
  time_local TEXT NOT NULL DEFAULT '09:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_task_id TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_ws ON schedules(workspace_id, created_at);
