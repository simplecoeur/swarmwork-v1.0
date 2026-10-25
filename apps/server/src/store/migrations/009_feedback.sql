-- 009_feedback.sql —— G-05 产品内反馈（v1.2.0 施工设计 G-05）
-- 反馈只落库 + 管理台可见，不做工单流转/回复通知（回复通道随邮件暂缓，contact 字段保留供线下联系）。
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  content TEXT NOT NULL DEFAULT '',
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  admin_note TEXT,
  created_at TEXT NOT NULL,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_time ON feedback(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, id);
