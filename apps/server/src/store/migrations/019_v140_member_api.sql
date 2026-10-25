-- 019_v140_member_api.sql —— v1.4.0 H 单个小人绑模型：成员级 API 绑定。
-- members.api_id 可空，引用本空间 apis.id；为空 = 跟随小组（teams.api_id）→ 空间默认。
-- 解析优先级（域层 apiResolve）：成员 api_id → 小组 api_id → 空间 defaultApiId → 平台体验 API。
-- 绑定的 API 被删除后 api_id 悬空：解析时查无此行即视为未绑定、继续下行（回退不阻塞执行）。
ALTER TABLE members ADD COLUMN api_id TEXT;
