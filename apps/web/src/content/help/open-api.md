# 开放 API

把蜂群接进你自己的系统：用 **API Token** 在外部程序里发单、查状态、取成果；任务状态变化时，蜂群会通过 **Webhook** 主动推送到你的服务。

Token 与 Webhook 都在「设置后台 → 开放 API」卡里管理。Token 明文只在创建时显示一次（服务端只存哈希，丢了只能吊销重建）；Webhook 的签名密钥加密保存，页面只显示掩码。

## 鉴权

所有开放接口都走请求头鉴权，不需要登录会话：

```
Authorization: Bearer <你的 Token 明文>
```

- Token 有两个权限位：`dispatch`（发单）与 `read`（查询）。权限不足返回 403。
- Token 被吊销、所属账号停用、或你已不是该空间成员时，返回 401。
- Token 只能访问它所属空间的数据；查别的空间的任务 id 返回 404（不泄漏存在性）。

## 发单

```
POST /api/open/tasks
Content-Type: application/json
Authorization: Bearer <token>

{
  "title": "给新品写一条种草文案",
  "type": "文案",
  "brief": "卖点是……",
  "references": "参考链接或资料说明（可选，会拼进任务说明）",
  "teamId": "小组 id（在页面发单处可见）",
  "assetRefs": [{ "assetId": "资产 id", "sections": ["ep5"] }]
}
```

与页面发单完全同一条路径：同样的类型校验、资产引用快照、记账与熔断口径。成功返回任务 id 与任务视图（含 `source: "api"` 来源标记）。

## 查状态与取成果

```
GET /api/open/tasks/<任务 id>          任务状态 + 基本信息 + 累计用量
GET /api/open/tasks/<任务 id>/result   任务完成后取成果全文 + 用量（未完成时返回提示）
```

## Webhook 事件推送

在「开放 API」卡里新建 Webhook（接收地址必须是 https；本机、内网与云元数据地址会被安全守卫拒绝），可订阅三类任务终态事件：

- `task.done`：任务已完成
- `task.adjudication`：任务转待裁决，需要老板处理
- `task.failed`：任务终局失败（已取消终态）

每次事件会 POST 一段 JSON 到你的地址，请求头带签名：

```
X-Swarm-Signature: sha256=<HMAC-SHA256(secret, 原始请求体) 的 hex>
X-Swarm-Event: task.done
```

验签方法：用你保存的 secret 对收到的原始 body 算一遍 HMAC-SHA256，与签名头比对一致才可信。投递超时 10 秒，失败自动重试共 3 次（间隔 1 分钟、5 分钟、15 分钟递增）；连续失败后该投递标记失败，空间所有者会收到一条站内通知。在 Webhook 列表里可以随时启停、删除，或点「测试投递」发一条 `test` 事件验证你的端点是否接通。
