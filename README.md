# 干活蜂群 · 本地版

一个在你自己电脑上运行的「AI 公司」：组建小组、配多个大模型 API、发任务，系统按工种调度模型干活、按你的标准审核交付，并对每一次调用精确记账。数据全部存本机，不经过任何云端。

技术设计见 [docs/技术设计文档.md](docs/技术设计文档.md)，决策记录见 [docs/adr/](docs/adr/)。

## 工程结构（Monorepo）

```
apps/web/         React + TypeScript + Vite 前端（构建产物由 server 静态托管）
apps/server/      Fastify + TypeScript 后端（api/domain/engine/llm/store 分层，SQLite 存储）
packages/shared/  前后端共享契约：类型、任务状态机、错误码、金额换算、常量
tools/            mock-llm（假模型服务）、旧数据迁移工具、集成测试辅助
data/             本地运行数据（SQLite 文件与日志，不进 git）
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

首次启动自动建库并写入种子（第一小组 + 一条待填 Key 的 DeepSeek 占位 API）。先到「设置后台」给至少一条 API 填 Key，再到「成本中心」采购充值（余额大于 0 才能开工），即可发布任务。

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

## 口径说明

- **余额是推导值**：余额 = 采购充值合计 − 账本消耗合计（按 API），账本只追加不修改；金额内部以「厘」整数运算，界面显示为元。
- **Key 只存本机**：存于 SQLite 并加密落盘；接口与日志中只出现掩码。数据目录请勿外传。
- **估算 token**：厂商未返回 usage 时按文字粗估（中文约 1 字≈1 token、英文约 4 字符≈1 token），账本标记 estimated，总经理汇报单列估算占比。
