-- 010_open_api.sql —— G-07 对外开放 API + Webhook（v1.2.0 施工设计 G-07）
-- api_tokens：对外开放面凭证。明文 Token 只在创建响应返回一次，库里只存 sha256 哈希 +
-- 前 8 位 prefix（展示/识别用）；scopes 为 JSON 数组（['dispatch','read'] 子集）；
-- revoked_at 非空即吊销（Token 守卫回 401）。归属 = user_id + workspace_id：
-- 守卫解析 workspace 时校验 token 所属用户仍是该空间 active 成员（G-15 转让后失格口径预留于此）。
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_ws ON api_tokens(workspace_id, created_at);

-- webhooks：任务终态事件外推订阅。secret_enc 为 AES-256-GCM 加密后的 HMAC 密钥
-- （store/crypto 既有口径，响应只回掩码）；events 为 JSON 数组
-- （['task.done','task.adjudication','task.failed'] 子集）；enabled=0 时不生成投递。
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_ws ON webhooks(workspace_id, created_at);

-- webhook_deliveries：每次外推一条投递行（test 事件亦走此表）。status 流转：
-- pending（待投/待重试）→ success（2xx）/ failed（重试 3 次仍失败，终败并通知所有者）。
-- attempts 为已尝试次数；next_retry_at 为下次可投时间（退避 1m/5m/15m）。
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  task_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, id);
