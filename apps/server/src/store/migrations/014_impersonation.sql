-- 014_impersonation.sql —— v1.2.0 批次三 G-14：管理员代入查看。
-- sessions 增 impersonation JSON 列（nullable）：代入期间写入
-- { adminUserId, workspaceId, startedAt }，退出代入时清回 NULL。
-- 不新建会话类型表——代入是同一会话的临时只读视角（会话当前空间切到目标空间），
-- 只读守卫在 api 层全局 preHandler 单点判定本列（见 routes.ts onRequest）。
ALTER TABLE sessions ADD COLUMN impersonation TEXT;
