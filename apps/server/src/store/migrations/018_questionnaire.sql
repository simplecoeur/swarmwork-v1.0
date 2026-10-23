-- 018_questionnaire.sql —— v1.3.0 C2 注册后问卷存档。
-- 一人一空间一份（UNIQUE workspace_id；user_id 为填写人）。answers 为 JSON 原文：
-- api 段只存脱敏形 {provider, baseUrl, model, apiId, keyMasked}，绝不存 apiKey 明文。
CREATE TABLE IF NOT EXISTS questionnaire_responses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL UNIQUE,
  answers TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questionnaire_user ON questionnaire_responses(user_id, workspace_id);
