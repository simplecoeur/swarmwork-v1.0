# ADR-008：多租户 workspace 隔离（M6）

- 状态：已采纳（2026-10-23）
- 出处：多用户平台产品方案 §1–§6、§8.1、§9 M6、§10、§12；技术设计文档 §16

## 背景

产品从单人版升级为多用户平台（一人公司 OPC）：多位空间所有者共用同一服务，
每人的小组、成员、API、账本、知识库必须互不可见。越权访问（多租户 IDOR）是最大风险。

## 决策

- **隔离边界 = workspace**：全部业务表加 `workspace_id` 并回填默认空间 `ws_default`；
  平台级行（平台公共知识、平台体验 API）以 `workspace_id IS NULL` 表达。
- **当前空间只取自服务端 session**：`sessions.current_workspace_id` 是唯一事实来源，
  前端传入的任何 `workspace_id` 一律忽略；切换空间走专门接口校验 membership 后改 session。
- **store 层强制过滤**：仓储 list 方法签名带 workspaceId 强制过滤；按 id 单查带 workspaceId 时
  不匹配即查无，api 层统一回 404（不回 403，不暴露数据存在性）。
- **会话**：服务端 session + HttpOnly/SameSite=Lax Cookie（Secure 可配），库里只存 token 哈希，
  7 天滑动续期；登出与管理员停用即时吊销全部 session。密码 argon2id 哈希。
- **权限两档**：平台管理员 / 空间所有者（OPC 定版）；memberships 仅作预留与归属校验，
  一期不实现空间内多人类协作与细粒度 RBAC。
- **备份口径**：GET /api/backup 仍是整库文件（含全部空间），改为仅平台管理员可用、
  响应头 `x-backup-scope: full-database-all-workspaces` 注明范围，且下载动作落 audit_logs。

## 理由

- 隔离只动 store 过滤与 api 会话解析，domain 状态机/账本/注入机制零推翻（方案 §0 口径），
  M5 成果平移不返工；服务端 session 支持停用即时踢下线，JWT 做不到干净吊销。

## 代价

- 每个新端点都必须走带空间的仓储方法，评审 checklist 第一条即「是否走隔离仓储」；
  越权矩阵测试进合并门禁（§10 清单），缺一不过。
