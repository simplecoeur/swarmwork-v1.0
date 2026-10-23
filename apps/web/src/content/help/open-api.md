# 开放 API（预留）

开放 API 与 Webhook 正在路上，本章先占位，接口定稿后在此补齐：

- 用 API Token 在外部系统里发单、查状态、取成果（Token 只在创建时显示一次明文）
- 任务状态变化通过 Webhook 推送到你的服务（带 HMAC 签名，可验签防伪造）

```
POST /api/open/tasks        （规划中）
GET  /api/open/tasks/:id    （规划中）
```

在正式开放前，所有发单都请在页面内完成；你在外部系统攒的需求可以先通过「意见反馈」告诉我们。
