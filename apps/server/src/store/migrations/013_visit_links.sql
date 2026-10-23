-- 013_visit_links.sql —— v1.2.0 批次三 G-13：delivery_links 增 kind 列。
-- kind='delivery' 为既有交付页（存量行默认 delivery）；kind='visit' 为办公室参观链接，
-- visit 行 scope='workspace'（target 即空间本身，target_id 语义 = workspace_id 列），
-- task_id/project_id 均为 NULL。token 哈希 / 口令 argon2 / 有效期 / 撤销 / 浏览计数全部
-- 复用交付页同一套字段与 domain 函数（createDeliveryLink 扩 kind 参数），不另起令牌机制。
ALTER TABLE delivery_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'delivery';
CREATE INDEX IF NOT EXISTS idx_delivery_kind ON delivery_links(workspace_id, kind, created_at);
