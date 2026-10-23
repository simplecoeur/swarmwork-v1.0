# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，格式参考 Keep a Changelog。

## [0.5.0] - 2026-10-23

M5 业务流程补全一期（P0 五项）：项目制前端补齐、成员管理补全、API 测试连接、任务后悔药、数据备份下载。设计文档 §6/§7/§15.2 已同步补记 M5 扩展。

### Added

- 项目制前端：发布区新增模式切换「单任务 | 方案下发（项目）」，方案模式填标题/说明/目标小组/甲方后走 POST /api/projects；新增「项目」视图（子任务进度 x/y、进度条、项目总账=子任务账本+拆单那笔、状态聚合按 §15.2 展示），项目卡可展开子任务列表并点击定位到任务墙卡片（滚动+闪烁）。
- 成员管理补全：后端 POST /api/members/save（新建/编辑/换组，工种变更时人设跟随工种默认）与 POST /api/members/delete（删除守卫：名下有未完成任务时回 MEMBER_HAS_ACTIVE_TASKS）；设置页「小组管理」内按组列出成员，可新建（选工种）、编辑（名字/工种/提示词）、换组、删除；办公室像素小人随 /api/state 自动反映。
- API 测试连接：后端 POST /api/apis/test（已存 id 或表单配置二选一，Key 留空回退已存），直连 Provider 发一次最小 chat（max_tokens=1、超时 15s），返回 { ok, latencyMs, message }，失败回厂商原文摘要（401/超时/地区不可用等）；不走网关、不记账、不扣余额、不触发熔断。llm 层 ChatRequest 新增可选 maxTokens/timeoutMs 并在 OpenAI 兼容/Anthropic 两实现透传。设置页每条 API 加「测试连接」按钮与结果提示。
- 任务后悔药：状态机新增终态「已取消」（shared 枚举 + 迁移表）；POST /api/tasks/:id/cancel（仅待领取/被打回/停工中的待审核可取消，执行中拒绝）、POST /api/tasks/:id/retry（仅停工任务，清 blocked 原因回队列；已取消不可重试）、POST /api/tasks/:id/delete（仅已完成/已取消，只删任务行、账本保留不删）。任务墙卡片按状态显示裁决/重试/取消/删除按钮，操作前均 confirm 二次确认。
- 数据备份：GET /api/backup 先 WAL checkpoint(TRUNCATE) 再以附件返回当前 SQLite 单文件；设置页「数据管理」加「下载备份」按钮。

### Changed

- 项目聚合口径扩展（§15.2）：已取消子任务为终态、不阻塞「已交付」判定（全部未取消子任务完成且至少一个完成 → 已交付；全部子任务被取消时保持进行中）；refreshProjectStatus 与取消/删除动作联动刷新。
- 设置页文案修正：「数据管理」段落改为如实口径（数据存储在服务器应用数据目录的 SQLite 单文件 swarm.db + WAL/日志文件，备份=下载快照或整目录拷贝，恢复=放回数据目录改名 swarm.db）；API 配置卡片头去掉过时的「Key 只保存在本机 data/settings.json」说法，改为「Key 加密保存在服务器数据库中，页面只显示掩码」。

### Tests

- 新增单元 15 项（已取消迁移合法性、cancelTask/retryTask/deleteTask 口径、项目聚合已取消扩展）与集成 2 项（成员 CRUD+删除守卫+停工重试/取消/删除+备份文件可被 sqlite 打开；apis/test 成功/404/不可达/无 Key 四路且不记账、已完成任务取消被拒与删除保留账本）。全量 53 项全过（原 36 项零回退）。

## [0.4.0] - 2026-10-23

UI 恢复：把用户认可的原型（模拟测试版 space）像素办公室与视觉语言搬回工程版，并修正部署形态文案。后端与 API 零改动。

### Changed

- 办公室页恢复像素办公室：新增 `PixelOffice` canvas 组件，移植原型的世界网格（32 列、顶部共享带 + 小组瓷砖分区、随组数向下生长）、老板办公室、任务墙（进行中任务按类型贴彩色便签）、审核桌（座位 + 「审核标准 N 条」牌，条数取真实审核标准行数）、交付台（已完成任务数变包裹堆）、绿植与大门装饰；每位成员一个像素小人（按工种配衫色/发型、肤色由成员 id 稳定派生、审核员戴眼镜），工位桌摆在本组分区内、审核员统一坐审核桌；头顶名牌 + 状态气泡由真实任务驱动（💻 执行中 / 📋 审核中 / 📋 待命审核 / 💤 待命，口径与原 memberStatus 一致）；点小人仍打开成员档案编辑；恢复小地图（分区色块 + 视口框 + 点击跳转）与缩放控件（＋/－/全景、滚轮缩放、拖动画布平移）。
- 全站视觉对齐原型：底色/面板/墨色粗边/硬阴影/品牌红（#d93a2b）/琥珀色焦点，方角替代圆角；跟随系统深色模式（与原型一致的深色变量）。发布任务/审核标准/任务墙/成果/成本中心/设置后台/知识库功能与结构不变，仅换肤。
- 文案修正：标题改「干活蜂群」，去掉「本地版」「数据全部存在本机」「Key 只存本地」等与服务器部署不符的表述（页面副标题、index 标题、README、根 package.json 描述同步）。

### Removed

- 办公室旧文字卡片成员墙（红字名牌方块）由像素办公室取代；成员档案编辑功能保留。

## [0.3.0] - 2026-10-23

M3 知识库一期（见 docs/技术设计文档.md §10、§15.1、§13）。

### Added

- 知识库数据与接口：迁移 `002_kb.sql` 将 kb_entries 重建为新字段口径（title/body/scope(company|team|member)/scope_id/tags/enabled/created_at/updated_at），001 存量数据折算迁入（content→body、team_id→scope_id）；tasks 新增 `injected_kb_ids` 注入审计列。API：GET/POST `/api/kb`、PUT/DELETE `/api/kb/:id`（zod 校验 + scope/scopeId 一致性与目标存在性校验）、POST `/api/kb/from-task/:taskId` 成果回流（标题=任务标题、scope 默认任务所属组、正文=成果全文）、GET `/api/tasks/:id` 任务详情（含 injectedKbIds）。shared 补 KbEntryDto / KbCreateDto / KbUpdateDto、KB_SCOPES 与 KB_INJECTION 常量，TaskDto 增 injectedKbIds。
- 执行时注入（domain/kbService + engine）：组装执行 prompt 时检索知识库——公司级全文注入，小组/成员级按任务标题/类型/说明关键词命中（标题/tags/正文）；优先级「公司 > 本组 > 本人 > 他组」，禁用条目排除、他人成员级不注入；注入总量上限 = 任务剩余预算的 30%（无预算上限时 8k token），按优先级整条纳入、超限跳过续选；实际注入条目 ids 落库（多次执行尝试取并集），任务详情/任务墙可查。
- 前端「知识库」页签：条目按范围分组展示与筛选、新建/编辑/删除、启用开关、标签编辑；成果列表新增「存入知识库」按钮；任务墙在任务卡上展示本单注入的知识条目。
- 测试：新增单元 8 项（关键词抽取/命中、范围优先级、截断上限与跳过续选）与集成 1 项（KB CRUD→发单→以 mock `/__requests` 回显断言注入内容确实到达模型侧→injectedKbIds 落库→成果回流生成条目）；mock-llm 新增 `/__requests` 回显接口。
- ADR-006（产品形态定版 Web 端，主代理补录）随本次提交一并入库。

### Changed

- 前端 types.ts 切换为 import `@swarm/shared` 契约别名（M2 偏差 #4 落实），DTO 唯一事实来源收敛到 shared；web 包新增 `@swarm/shared` 依赖；Context 新增 send（PUT/DELETE）通道。

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
