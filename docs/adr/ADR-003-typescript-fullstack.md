# ADR-003：全栈 TypeScript

- 状态：已采纳（2026-10-23）
- 出处：技术设计文档 §14

## 背景

原型前端为原生 JS、后端为 Node 单文件，用户明确要求框架化与大厂工程标准。后端语言候选：Node / Python / Go。

## 决策

全栈 TypeScript：前端 React + TS + Vite，后端 Node + TS + Fastify，前后端共享契约包 `packages/shared`（类型、状态机、错误码、常量），接口变更先改共享类型。

## 理由

- 与负责人技能栈（JS）一致，接手维护成本最低。
- 与原底座 AI Town（TS 全栈）技术路线一致。
- 产品瓶颈在 LLM 调用延迟而非本地算力，Python 的 AI 生态优势与 Go 的高并发优势在本场景均非关键。

## 代价

- 需要构建链（tsc/Vite）与类型维护成本，由 monorepo 根脚本与 CI 门禁统一承接。
