# 干活蜂群

一个部署在服务器上运行的「AI 公司」：组建小组、配多个大模型 API、发任务，系统按工种调度模型干活、按你的标准审核交付，并对每一次调用精确记账。数据存储在服务器，浏览器打开即用。

技术设计见 [docs/技术设计文档.md](docs/技术设计文档.md)，决策记录见 [docs/adr/](docs/adr/)。使用文档见 [docs/使用文档/](docs/使用文档/)：《平台使用说明》面向空间所有者（老板端），《管理使用说明》面向平台管理员。

## 工程结构（Monorepo）

```
apps/web/         React + TypeScript + Vite 前端（构建产物由 server 静态托管）
apps/server/      Fastify + TypeScript 后端（api/domain/engine/llm/store 分层，SQLite 存储）
packages/shared/  前后端共享契约：类型、任务状态机、错误码、金额换算、常量
tools/            mock-llm（假模型服务）、旧数据迁移工具、集成测试辅助
data/             运行数据（SQLite 文件与日志，不进 git；部署在服务器 data/ 目录）
```

## 环境要求

- Node.js ≥ 22（用到内置 `node:sqlite`），建议 24 LTS。

## 快速开始（使用）

```bash
npm install          # 仓库根目录，workspaces 一次装齐
npm run build        # 构建 shared → server → web
node apps/server/dist/index.js
# 浏览器打开 http://localhost:8730
```

首次启动自动建库、写入种子并创建平台管理员与默认空间。应用内登录为正门：业务接口无有效会话一律 401，数据按 workspace（空间）隔离。

- 管理员邮箱/初始密码：环境变量 `SWARM_ADMIN_EMAIL` / `SWARM_ADMIN_PASSWORD`；未设密码时随机口令写入 `DATA_DIR/admin-initial-password.txt`（0600），首次登录强制改密。
- 自助注册：邮箱 + 密码 + 显示名，个人空间即时开通并自动建空间（异常注册走管理员审核）；新空间可选行业包开局，不选包只有通用种子。
- 体验额度：管理员可经管理台给空间发放平台体验 API 的额度（用完即停，提示填自己的 Key）。

先到「设置后台」给至少一条 API 填 Key，再到「成本中心」采购充值（余额大于 0 才能开工），即可发布任务。

运行数据目录可用环境变量 `DATA_DIR` 覆盖（默认仓库根 `data/`），端口用 `PORT`（默认 8730）。

## 开发

```bash
npm run dev          # 后端 tsx watch（前端联调：cd apps/web && npm run dev，/api 已代理到 8730）
npm run lint         # ESLint
npm run typecheck    # tsc 严格模式（server + web）
npm test             # Vitest：单元 + 集成（自动起 mock-llm 与临时库）
npm run build        # 全量构建
```

五道门禁（install→lint→typecheck→test→build）在 CI 中同样执行（.github/workflows/ci.yml）。

## 从 v0（JSON 数据）迁移

旧版本（../local-app）的数据可一键迁入：

```bash
node tools/migrate-from-json.js [旧data目录] [目标DATA_DIR]
# 默认：../local-app/data → ./data；结束打印对账摘要（任务数/账本条数/总 token/总成本，迁移前后应一致）
```

## 知识库（一期）

「知识库」页签维护共享知识条目（标题/正文/标签/启用开关），每条有范围：**公司**（全公司通用）、**小组**、**成员**（个人专属）。

- **执行时注入**：成员领取任务时，系统自动检索并把相关条目拼进干活指令——公司级条目全文注入；小组/成员级条目需与任务标题/类型/说明关键词命中（标题、标签、正文均可命中）；优先级「公司 > 本组 > 本人 > 他组」，停用的条目和他人成员级条目不注入。
- **注入上限**：总量不超过该任务剩余预算的 30%（未设单任务预算时上限 8000 token），按优先级整条纳入、超限跳过。
- **注入可审计**：每单实际注入了哪些条目会记在任务上（任务墙任务卡的「本单注入知识」），可复盘"为什么这么写"。
- **成果回流**：已完成的成果可在「成果列表」点「存入知识库」一键沉淀为条目（默认归属任务所属小组），供后续任务复用。

向量检索（embedding）为二期规划，一期为关键词方案，不依赖任何外部向量服务。

## 口径说明

- **余额是推导值**：余额 = 采购充值合计 − 账本消耗合计（按 API），账本只追加不修改；金额内部以「厘」整数运算，界面显示为元。
- **Key 加密保存**：存于服务器 SQLite 并加密落盘；接口与日志中只出现掩码。数据目录请勿外传。
- **估算 token**：厂商未返回 usage 时按文字粗估（中文约 1 字≈1 token、英文约 4 字符≈1 token），账本标记 estimated，总经理汇报单列估算占比。

## 开源与致谢

本项目基于开源项目 AI Town（MIT License）的代码改造而来，在此向原作者致谢。本项目自身代码以 MIT License 开源，见 [LICENSE](LICENSE)。
