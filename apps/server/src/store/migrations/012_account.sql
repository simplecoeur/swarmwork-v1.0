-- 012_account.sql —— G-11 账号设置（v1.2.0 施工设计 G-11）
-- users 增头像文件与注销冷静期字段：avatar_file 只存文件名（<user_id>.<白名单扩展>，
-- 落盘 DATA_DIR/avatars/，防目录穿越）；status 枚举扩 pending_deletion（冷静期）与 deleted
-- （到期匿名化终态）——status 为 TEXT 列、无 CHECK 约束，枚举扩展靠应用层口径，无需改列。
-- deletion_at = 冷静期到期时刻（申请时 = now + 7 天），到期扫描据此处理。
-- sessions 表核查（003）：已有 created_ip 与 user_agent 两列，会话列表展示所需字段齐备，本迁移不补列。
ALTER TABLE users ADD COLUMN avatar_file TEXT;
ALTER TABLE users ADD COLUMN deletion_at TEXT;
