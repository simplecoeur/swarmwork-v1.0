# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，格式参考 Keep a Changelog。

## [0.2.0] - 2026-10-23

M2 工程基建 + 后端迁移（见 docs/技术设计文档.md §13、§15）。

### Added

- Monorepo 工程基线：npm workspaces（apps/web、apps/server、packages/shared），五道根脚本 dev/build/test/lint/typecheck 与 GitHub Actions CI 门禁。
- 共享契约包 `@swarm/shared`：任务状态机、错误码、金额（厘）换算、温度等常量，前后端共同引用。
- 后端重写为 Fastify + TypeScript 分层架构（api/domain/engine/llm/store），存储换 SQLite（node:sqlite）+ 编号迁移脚本。
- 账本 append-only、余额由 purchases − ledger 推导、金额整数（厘）运算，杜绝账本与余额对不上。
- LLM 适配层：Provider 接口 + OpenAI 兼容 / Anthropic 两实现；超时 120s、指数退避重试 ≤2 次（幂等键防重复记账）、连续失败 ≥3 次熔断 5 分钟（半开试探恢复）、usage 缺失按中英文字数估算并标记 estimated。
- 调度引擎：DB 为准的队列、1s tick FIFO + 守卫领取（Key/余额/并发/预算）；执行/审核两阶段落库可续跑；running/reviewing 每 30s 心跳，>10 分钟无心跳回收。
- 项目制（方案下发）：POST /api/projects 由组长以温度 0.3 拆子任务；项目状态按子任务聚合（任一待裁决→待裁决，全部完成→已交付）。
- 总经理汇报接口 GET /api/cost/report：组/API/项目排行、最贵一单、余额续航估算、估算 token 占比、待裁决/裁决通过统计。
- 旧数据迁移工具 tools/migrate-from-json.js：v0 JSON 数据一键导入 SQLite 并输出对账摘要。
- ADR 文档 docs/adr/（ADR-001～005）。

### Changed

- 前端从 local-app/frontend 平移至 apps/web（功能与行为不变），构建产物输出到 apps/server/public 由后端静态托管。
- 统一错误结构为 `{ ok:false, error:{ code, message } }`，入参 zod 校验。

## [0.1.0] - 2026-10-23

- 原型（v0 基线，保留在 ../local-app）：Node 零依赖单文件后端 + JSON 存储 + React 前端，验证发任务→执行→审核→交付→记账闭环。
