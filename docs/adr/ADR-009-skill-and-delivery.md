# ADR-009：skill 取代任务模板、快照安装与交付闭环（M7/M8）

- 状态：已采纳（2026-10-23）
- 出处：多用户平台产品方案 §7、§11、§12.3/§12.4；技术设计文档 §17/§18

## 背景

P1 缺口清单原有「任务模板」一项：一段预设 brief 的复用。产品方案 §7 定版 skill 系统后，
模板只是 skill 的退化形态（无参数、无知识绑定、visibility=private 的 skill）。
同时成果需要能离开系统交付（导出/只读页/渠道直推），且跨空间分享不能让源头改动
悄悄改变已装空间的产出标准。

## 决策

- **skill 取代任务模板，不再单独开发模板功能**：发布页「存为模板」心智直接落为
  「存为我的 skill（私有）」。skill 渲染成普通任务（title/brief/type）进入现有状态机与账本，
  引擎、审核、打回、裁决机制全部复用，不新造执行链。
- **安装 = 快照复制**：安装平台库/他人 skill 时整份复制为本空间 skill，记
  source_skill_id 与 source_version；源头升级不回灌，空间侧显式「升级」才覆盖内容并 +1 版。
  一期不做引用式订阅。
- **平台库成员口径**：visibility='public' 且 status='published' 即平台库成员
  （含官方 owner_type='platform' 与用户经管理员上架审核通过的）；提交上架走
  visibility='pending_review' 中间态，管理员 approve/reject。
- **版本口径**：skill 内容变更必须带 changelog 且 version+1；已产生任务不受影响
  （任务落 skill_id + skill_version + skill_params 快照）。一期不做多版本内容回滚。
- **交付三出口**：导出（Markdown/CSV）、只读交付页（token 只存哈希，可设口令/有效期/撤销，
  公开路径 /d/:token 不走会话，只呈现被交付的那一份）、渠道直推。
- **渠道适配器接口先行**：外部平台对接收敛为 ChannelAdapter（authBind/pushPublish/fetchMetrics），
  MJ 为第一个适配器；推送结果一律落 channel_pushes 账，失败如实记 failed 与原因，不假装成功。
- **资产版本快照**：资产本体只存当前版，asset_versions 留每版内容快照；任务引用在发单时
  锁定版本号（task_asset_refs），引擎按锁定版本注入，资产升版不影响历史任务复现。

## 理由

- 模板与 skill 两套资产并存会造成长期心智混乱（「存哪」问题）；合并为一套后，
  私有 skill 即模板，流水线编排、交付、飞轮沉淀全部挂在同一资产上。
- OPC 业务是对甲方交付，产出标准被他人静默改动不可接受，快照复制简单、可控、可审计。
- 交付页与渠道推送是「一人公司卖成套交付」的出口，接口先行保证后续接 YouTube 等渠道时内核零改动。
