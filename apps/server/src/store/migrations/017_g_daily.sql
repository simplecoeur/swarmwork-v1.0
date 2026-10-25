-- 017_g_daily.sql —— v1.3.0 G 总经理晨报与每日签到。
-- checkins：用户在空间内的每日签到（date 为空间时区下的本地日期 YYYY-MM-DD，唯一约束保证幂等）。
-- briefings：空间每日晨报（date 同口径，唯一约束保证同日只生成一份）。
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, workspace_id, date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_user_ws ON checkins(user_id, workspace_id, date);

CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  date TEXT NOT NULL,
  content_md TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, date)
);
CREATE INDEX IF NOT EXISTS idx_briefings_ws ON briefings(workspace_id, date);
