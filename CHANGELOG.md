# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，格式参考 Keep a Changelog。

## [1.3.0] - 2026-10-24

引导 + 生态 + 体验版，并入老板追加的 E（办公室中枢与功能弹窗化）/ F（公司风格定制）/ G（总经理晨报与每日签到）/ C2（注册问卷与团队生成）四条工作流；原 A1（发单区在办公室页内上移）被 E 取代，未按原案施工。新迁移 015–018；测试 126 → 150 项全过、既有零回退。设计补记见技术设计文档 §20。

### Added

- **A2/A3 发单体验**：单任务与方案下发的「说明」输入区加大（min-height 160px、可纵向拖拽）；任务模板（迁移 015 task_templates）——官方通用 4 个 + 短剧行业 6 个种子（随空间行业包可见）、个人模板建/删、任务墙「存为模板」、发单区模板行一键套用（只预填标题/类型/说明，不直接发单）。模板上架/分享本版不做（分享路径由 skill 生态覆盖）。
- **B skill 生态增量**：平台库公开署名——上架审核通过时落定贡献者与贡献空间快照（源用户/空间注销后署名以快照保留不悬空，存量未落快照者 DTO 回退实时查）；官方精选晋升——管理员对已上架用户 skill 再做晋升/取消精选（POST /api/admin/skills/:id/feature，写审计 + 新通知类型 skill_featured/skill_unfeatured 通知贡献者），平台库新增精选区置顶展示；公示与安装量——库卡片公开 install_count、技能页「最新动态」（GET /api/skills/activity，上架/精选事件倒序）、贡献者可见自己已上架 skill 的安装量。
- **C 快速开始引导**：G-02 三步卡扩展为五步（认识团队 → 让团队能开工 → 发第一单 → 看任务时间线 → 审核并收第一份成果），与真实行为联动打勾（任一 API 余额 > 0 / 已有任务 / 已有已完成任务自动判定，手动步靠按钮推进）；进度仍存 user_preferences.onboarding 且旧三步进度有兼容映射；新空间默认展开、可跳过、帮助页与设置页可重置重开。
- **C2 注册问卷 + 按问卷生成默认团队**：开公司改为五步向导（公司信息 → 接入你的 AI → 关于你 → 提醒与督促 → 确认），全程可跳过（跳过与旧开公司流程逐字段等价）。问卷第 1 步即 API 步——服务商预设带出 Base URL 与默认模型（可改）、只粘一个 Key、当场测试连接（POST /api/apis/test-connection 裸配置端点，与设置页共用 domain/apiTest 实现）、跳过或测试未通也放行；提交后落既有 apis 表并设为空间默认 API（与设置页同一写路径），Key 加密存储、回显掩码。问卷答案落 questionnaire_responses（迁移 018，**不存 apiKey 明文**，api 段仅 provider/model/apiId/掩码）。默认团队由 teamForge 按「行业包底 × 职能模板」规则生成（落普通 teams/members、生成后可任意改删，**不接 LLM 人设**）；已有团队的空间不自动重组；提醒答案直写 G 的 dailySettings；督促事项在晨报「今日开工提醒」段原样回显。设置页「我的问卷」可查看/修改（提醒即时生效、行业/工作仅存档，PUT 不碰 apis 表）。
- **E 办公室实况中枢 + 功能弹窗化**：像素办公室成为唯一主场景——顶部实况状态栏（余额 = Σapis balanceYuan、进行中/待审核/待裁决数，全取真实 state）、功能坞、顶部常驻快速发单条（回车直达发单弹窗、可预填）；成员状态气泡与轻动画（执行中小人 bob + 气泡浮动、待命呼吸位移，幅度 ≤1.5px，数据全部源自真实任务状态，无游戏物理/寻路）。任务墙/项目/成果库/技能/资产/知识库/成本/定时任务/设置/成员详情全部改为从办公室以大弹窗打开（桌面近全屏 Sheet、移动端全屏，Esc/遮罩/关闭钮三路可关），既有页面组件整体复用、功能无删减；hash 深链（#/publish、#/tasks、#/projects、#/results、#/skills、#/assets、#/kb、#/cost、#/schedules、#/settings、#/member/<id>、#/style）；登录/注册、平台管理台、帮助、账号、公开交付页与参观页保持独立页。全站导航残留（setTab/锚点）已统一改走 openDialog。
- **F 公司风格定制**：当前风格存 settings.officeStyle，画布三层定制——配色（墙面/地板/点缀 + 地板纹样 plain/wood/tile/checker）、像素家具目录按九个预设锚点槽位摆放（代码绘制、避开工位与动线、无自由拖拽）、用户上传图片作墙面海报与公司招牌（走既有文件存储口径，图片仅在本空间场景使用）；装修面板「一键生成搭配」为站内预设的和谐随机组合（**不接 AI 生图**，文案如实）。风格模板（迁移 016 style_templates）分私有/本空间/提交上架三级，管理员审核（驳回必填原因，审核含上传图片内容——未过审模板的图片不进库展示、文件读取端按引用方公开性把关）后进平台风格模板库公示，公开标注来源（与 B 的 skill 署名同口径），一键套用且套用计数公开。官方模板种子 6 套（极简整洁/樱粉梦境/科技蓝调/原木暖阳/绿植森系/赛博霓虹）。**默认风格与 v1.2.0 画布像素级一致**（checker 地板 + 左右原有绿植），未定制零变化。
- **G 总经理晨报 + 每日签到**：迁移 017（checkins 用户×空间×日期唯一、briefings 空间×日期唯一）。签到入口在办公室中枢（总经理桌卡）：每日一签、连续天数 streak 与本月签到日历、签到后总经理气泡反馈；未签到提醒可配时间（默认 10:00 空间时区），到点未签只发一条站内通知（checkin_remindedDate 标记 + 未读去重双保险）。晨报每日可配时间（默认 09:00）由总经理生成，三段——昨日未完成事项（空间时区自然日口径、真实任务表、状态分组计数 + 逐条标题状态）、今日开工提醒（待裁决/待审核置顶 + 督促事项清单原样回显 + 模板开工语）、热点新闻（服务端抓取公开 RSS、主题可配默认短剧/影视娱乐/AI、每主题双源、抓不到如实标「今日热点暂不可用」不编造）；办公室晨报卡 + 通知中心留档（新类型 daily_briefing）+ 往期可回看；调度为独立 30s tick、生成幂等。空间设置新增晨报/签到提醒开关与时间、新闻主题。**邮件仅预留接入点**：复用 v1.2.0 的 notifyConfig/mailer 预留结构（maybeMailDaily 空实现），未配 SMTP 时静默跳过、站内全量可用，设置页如实展示邮件通道「未接入」——待 G-01 的 SMTP 配置到位后自动启用，本版未写第二套发信实现。
- **D help 文案修正**：content/help/getting-started.md 的整库备份句改为管理员专属口径，并指引空间所有者走 G-16 空间全量导出。

### Fixed

- 验收发现的深链冷开竞态：直接打开/刷新 `#/skills`、`#/member/<id>`、`#/tasks` 等深链时弹窗不打开且 hash 被冲回 `#/`——App 里 dialog→hash 与 hash→dialog 两 effect 同批执行，初始 dialog=null 的写入抢先覆盖 URL；已加初始化门（hash 首次被解析应用前禁止反向写入），冷开三条深链复测全通，热切换与 Esc 回 `#/` 不受影响。

### Changed

- 服务商预设补齐通义/智谱（shared PROVIDER_PRESETS 六家，PROVIDERS 元组同步），问卷与设置页预设同源（前端初始值常量与服务端预设逐项同值：web 无法值导入 shared 的 CJS 桶文件，Rollup 静态解析限制，属已知口径）。
- 修复（C2 联调发现）：POST /api/workspaces 切换当前空间后请求内 authCtx 缓存未刷新，问卷 API 可能被建到旧空间——updateSession 后同步刷新 req.authCtx。

### Notes

- A1 未施工（被 E 取代）；模板分享未做（理由见 A3）；MJ 生产联调与邮件发送（G-01）仍未做，口径与 v1.2.0 一致。

## [1.2.0] - 2026-10-23

对标补齐版（对标 Coze/Manus/Marvis 缺口分析 G-02…G-17 共 16 条；施工图 `~/workspace/agent-swarm/v120-施工设计-2026-10-23.md`，设计补记见技术设计文档 §19）。三批次交付：门槛批（G-02/03站内/04/05/06/08）→ 批次二（G-07/09/10/11/15 接口）→ P2 批（G-12/13/14/15 页面/16/17）。新迁移 008–014；测试 62 → 126 项全过、零回退。

### Added

- **G-02 新手引导闭环**：注册首跑自动定位首空间；办公室 Onboarding 三步卡（发第一单→看成果→扩建团队，状态源自真实行为、完成即隐藏）；空状态三件套（EmptyState variant=guide/illustrated + Stepper）替换六处主要空态；state 增 capabilities 段供能力货架（AI 智能升级）识别新老用户。skill 货架、一键带参数跳转本版已有，未重复造轮子。
- **G-03 通知中心（站内）**：通知类型扩至 9 类（新增 task_done/task_failed/schedule_result/impersonation），notifyPrefs 真开关（按空间+类型，关则不落行），NotificationCenterView（筛选/全标已读/空态/跳转）；通知分发结构预留 channel 维度——**邮件触达暂缓**（见 Notes）。
- **G-04 任务过程时间线**：迁移 008 task_steps；引擎关键点埋点（拆解/注入/执行/审查/重试/阻塞/恢复/裁决），执行步成本与账本同事务同源同口径；TaskTimeline 过程视图（进行中实时刷新、注入名单可点、折叠聚合；任务墙卡面默认摘要行收起）。既有 task_events 与账本零改动。
- **G-05 用量预估与预警**：costService 同口径预估退级链（同 skill 近 5 单→同类型→空间均值→无样本）+ 单发/批量发单预估展示与「按预估校验余额」；低于阈值时升级报价卡；余额下穿阈值（默认 5 元）自动站内通知 + 顶部横幅（上穿自动消失、重复下穿不再发）。
- **G-06 文件导入**：知识库/资产库两段式导入（preview 解析差异预览→confirm 提交；txt/md/docx/csv；上限 5MB/500 条/200 sections 以 shared 常量为唯一口径）；逐条可摘、可改归属与类型；批量沉淀（成果库多选→飞轮沉淀 KB/skill）。新依赖 @fastify/multipart + mammoth。
- **G-07 开放 API 与 Webhook**：迁移 010 api_tokens（仅存 SHA-256 + prefix 显示，Token 鉴权含 membership 校验）/webhooks（secret 加密存储）/webhook_deliveries；Token 管理面（建/列表/吊销）+ 令牌自助（发单/查任务/能力清单）；事件 delivered/blocked 两类、HMAC-SHA256 签名（`x-swarm-signature`）、失败自动重试 1m/5m/15m、SSRF 共用守卫校验出站 URL。
- **G-08 帮助与反馈**：/help 页（入门指引/计费说明/常见问题，前端内容源 Markdown、无悬空路由）；迁移 009 feedback（类型/内容/联系方式）+ 提反馈入口（顶栏「更多」→ Dialog）+ 管理台反馈处理（处理/关闭）。
- **G-09 全局搜索**：GET /api/search（任务/成果/资产/skill/KB/项目六类并行，LIKE 已转义防通配注入，摘要不出正文）；顶栏搜索入口 + `/` 快捷键 + SearchOverlay（键盘全程可用、上下选、回车直达）。
- **G-10 定时任务**：迁移 011 schedules；scheduleService 以 Intl 按空间时区计算 next_run_at（daily/weekly/interval_hours，带 jitter 防整点扎堆）；每 30s 按手动发单同一路径（含余额校验、source='schedule'）创建；无可用 API/余额不足记失败并通知；设置页定时任务卡（新建/启停/删/上次结果）。
- **G-11 账号设置与安全**：迁移 012（users.avatar_file/deletion_at）；ProfileCard（头像上传校验类型/≤2MB、显示名、邮箱只读、改密入口）；会话管理（当前+其他会话列表、定向吊销/一键全吊）；账号注销 7 天冷静期（仅所有者且名下无空间，PendingDeletionPage 期内可撤销，到期自动匿名化、空间与账本保留）。**邮箱验证小块暂缓**（见 Notes）。
- **G-12 内容渲染统一**：MarkdownView 全站唯一渲染源收编（补齐全语法集、锚点锚定与性能守卫、字符照旧转义、无 innerHTML）；服务端同口径解析（domain/markdown.ts + 共享规范用例双端断言）；成果可下载 .md；任务分享卡 SVG（品牌红模板、标题/状态/耗时/成本，可嵌入公开交付页）。
- **G-13 参观链接**：迁移 013 delivery_links.kind（delivery/visit）；visit/revoke 与交付链接同构（独立生成/撤销/过期/口令）；参观页服务端渲染、字段白名单（公司名/团队/成员状态/已交付成果标题与时间/空间简介）——**绝不含**余额、成本、API 配置、未交付成果、内部备注；访问落既有链接访问日志（以 scope='workspace' 表达空间级目标）。
- **G-14 管理员代入查看**：迁移 014 sessions.impersonation；POST /api/admin/impersonate/:workspaceId 与 /stop；全局只读守卫单点（代入态写操作一律 403 IMPERSONATION_READ_ONLY，GET/通知已读/退出白名单）；起止双审计 + 所有者即时通知；管理台「代入查看」钮 + 顶栏红色横幅（含退出钮）。
- **G-15 空间所有权转让**：POST /api/workspaces/:id/transfer（接口批次二先行：全校验链——仅所有者/目标存在且非停用/非本人/目标非空间成员/当前密码复核，membership 增删与 owner_user_id 双写同事务，原所有者 Token 随 membership 失效自动失权，双侧审计+通知）；设置页转让卡（邮箱精确查、目标确认、验密 Dialog、成功后 me 刷新）+ 只读补口 GET /api/users/lookup。
- **G-16 数据导出**：POST /api/workspaces/:id/export（仅所有者）一次性 zip（manifest/README/账本 CSV/任务与成果/知识库/资产/skill/审计，文件名与结构固定）；**API 密钥零明文**（仅掩码与指纹）；>50MB 回 VALIDATION 不产半成品；审计 export_workspace。新依赖 jszip。
- **G-17 通用 Webhook 渠道**：ChannelAdapter 注册表新增 generic_webhook（与 MJ 并列）：绑定探活 bind.ping、成果推送 delivered（标题/成果全文/交付页链接/用量摘要）、fetchMetrics 明示不支持；签名与 SSRF 守卫与 G-07 共用同一函数，未另写。渠道即插件足点，新增渠道=新适配器+登记一行。

### Changed

- 灌水防线沿用：Token 鉴权与开放面发单沿用既有守卫/限流口径，未新增第二套。
- 任务墙卡面默认收起过程摘要一行（信息密度口径不变，展开看完整时间线）。

### Notes（暂缓项，如实标注）

- **G-01（邮件通道/邮箱验证/密码自助找回）整条暂缓**：待用户提供 SMTP 发信邮箱与授权码后补；本版只保留既有配置位（settings.notifyConfig，mailChannel='reserved-not-implemented'）与接回结构，未写任何发信实现。
- **G-03 的邮件触达部分暂缓**：同上；通知分发结构已预留 channel 维度，SMTP 到位后邮件渠道并入分发即可。
- **G-11 的邮箱验证小块暂缓**：同上；账号其余部分（头像/会话/注销）已全量交付。
- MJ 直推生产联调不在本版范围（MJ 适配器在 stub 契约下全绿）。

## [1.1.0] - 2026-10-23

前端体验版：自有组件层（Radix 无头原语 + 既有视觉 token）全站换装 + 移动端（≤768px）适配。桌面布局与视觉基线不变，后端逻辑零改动（唯一例外：只读交付页的服务端模板内 CSS，见 Changed）。

### Added

- 组件层（apps/web/src/components/ui/，业务统一从 barrel 导入）：以 Radix UI 无头原语打底行为——@radix-ui/react-select 2.4.1、react-dialog 1.3.1、react-dropdown-menu 2.2.1、react-switch 1.4.1、react-tabs 1.2.1、react-tooltip 1.4.1、react-checkbox 1.4.1、react-radio-group 1.5.1、react-popover 1.3.1（选型理由：只借焦点管理/键盘导航/弹层定位/Esc 等行为、零自带样式，皮肤 100% 用既有 token，不带进第二套视觉）。组件清单：Button、Input、Textarea、Select、Dialog（+ useConfirm 钩子）、DropdownMenu、Popover、Switch、Tabs、Tooltip、Checkbox、RadioGroup、Badge、Card、EmptyState、Spinner、Field；样式只引用既有设计 token（纸面底/墨边/硬阴影/品牌红/方角），全部交互组件有 :focus-visible 可见焦点。
- 移动端底部固定导航：办公室 / 发单 / 任务墙 / 技能 / 更多。实际 TabKey 只有 7 个，发单（PublishForm)、任务墙、项目、成果库是办公室页内区块——底部栏对应项以「切到办公室 tab + 锚点滚动」实现（publish/taskwall/projects/results 四锚点）；「更多」（Radix DropdownMenu）收纳资产库、知识库、成本中心、成果库、项目、设置后台、管理台（仅平台管理员，与桌面一致）。
- 办公室移动专属任务状态摘要条（画布下方，桌面隐藏）：进行中（状态「执行中」）/ 待审核 / 待裁决三项计数（S.tasks 按状态过滤），点击滚到本页任务墙区块。

### Changed

- 全站表单与高频交互换装（登录/注册/改密、顶栏空间切换与账号菜单、通知铃铛、发布任务三模式、任务墙与项目操作、技能建参/试运行/安装/上架审核、资产库与引用选择、知识库、成本中心、成果库/交付、管理台、设置后台全部卡片）：**原生 `<select>` 全站清零**；弹窗统一 Radix Dialog（焦点陷阱、Esc/点遮罩关闭）；全部 window.confirm/prompt（11 处）改为自有确认弹窗/输入弹窗（Admin 驳回原因改为弹窗内输入）；顶栏用户信息改 DropdownMenu；NotificationBell 改 Popover；KnowledgeBase 启用/停用改 Switch；AuthGate 登录/注册切换改 Tabs；状态 chip 统一 Badge。
- 移动端布局（全部隔离在 `@media (max-width: 768px)`，桌面规则零改动）：输入类控件字号 ≥16px（防 iOS 聚焦缩放）、min-height 44px；按钮/菜单项/Select 项/Tabs 触发器触控高度 ≥44px；body `overflow-x: clip` 整页禁横滚；main 内边距收窄且底部让位 92px 防底部栏遮挡；.card 单列、内边距与阴影收窄（风格不变）；.row 子项全宽堆叠；顶栏双行（第一行品牌/铃铛/账号，第二行空间切换 Select 撑满 + 开新公司）；桌面 nav 隐藏。宽表格统一「容器内横向滚动」（.table-wrap，表格 min-width 560px，整页不横滚）：Admin 用户管理表、空间总览表，CostCenter 按 API 拆账表、小组排行表、任务账本表，共 5 张。
- 只读交付页移动优化（apps/server/src/domain/deliveryService.ts 两个渲染模板的 `<style>` 纯 CSS 改动，无逻辑/结构变化；该页为服务端渲染，此为本版唯一触及 server 的文件）：正文页新增 `@media (max-width:600px)` 收窄 body/.wrap 内边距与标题字号；口令页输入框 font-size 16px 且 min-height 44px、按钮 min-height 44px，并新增同断点内边距收窄。

### Fixed

- 移动端发单区双列挤压：PublishForm/Standards 卡片的内联 flex 配比（1.2/1，桌面用）压过移动媒体查询的堆叠规则——媒体查询内 `.row > *` 以 `!important` 强制全宽堆叠（仅 ≤768px 生效，桌面配比不变）。双视口验收实测发现并修复。

### Notes（保留的原生控件及理由）

- CostCenter 台账导出 `<input type="month">`：Radix 无月份选择原语，保留原生以不丢浏览器月份选择器。
- Skills 工种输入的 `<datalist>` 内 `<option>`：HTML 规范里 datalist 只能用原生 option（挂在已组件化 Input 的 list 属性上做联想）。
- 展示型例外（非表单控件）：Settings/CostCenter/Results 的下载直链 `<a class="btn">`（备份/导出）是链接不是按钮控件；各页 `<label>` 保留作字段标题；PixelOffice 的 canvas 与小地图按基线纪律未动（其缩放按钮已换组件版 Button + Tooltip，仅 DOM 层）。

## [1.0.1] - 2026-10-23

### Fixed

- 批量发单不落资产引用快照：taskBatchSchema 补 assetRefs 字段、批量路由透传至共用建单路径，批量单现与单发一致生成 task_asset_refs 快照并锁定版本、引擎按快照注入；新增 M8 集成断言覆盖（批量两单带 assetRefs → 每单注入记录锁定 @1、资产升版后不漂移）。

## [1.0.0] - 2026-10-23

多用户平台全量版（产品方案 v2 的 M6 补齐 + M7 + M8）：在 v0.6.0 多用户后端之上补齐前端，并落地 skill 系统、交付闭环、数据飞轮、资产库、成套流水线与站内提醒。设计补记见技术设计文档 §17/§18 与 ADR-009。

### Added

- M6 前端补齐（v0.6.0 仅有后端，本版补上）：AuthGate 登录/注册（pending 待审核提示、mustChangePassword 强制改密）、空间感知顶栏（当前空间名取自会话、空间切换、「开新公司」弹窗含行业包选择）、管理台 Tab（用户审核/停用/重置密码、体验 API 配置、体验额度发放、空间聚合、行业包只读列表）、设置页工种/任务类型注册表卡、PublishForm 任务类型改注册表驱动。
- skill 系统（M7，§7）：skills 表（迁移 006）；创建（可视化参数表/kb_binding/输出规格）→ 试运行（示例参数真跑一单、is_skill_test 标记、照常记账）→ 发布；一键发单渲染 brief（{{参数}} 替换 + 输出规格段）并落 skill_id/skill_version/skill_params 快照；项目内调用（dispatch 带 projectId）；分享三级（private → workspace → 提交上架 pending_review → 管理员审核 public）；安装为快照复制（source_skill_id/source_version，源头升版 hasNewerSource 提示、手动升级）；6 个官方 skill 种库（爆款标题生成/剧本卖点提炼/分集钩子/封面文案/评论区话术/多语言简介），选短剧包开公司时快照装入；引擎注入并入 skill 的 kb_binding（entryIds/tags 强制入选、scopes 限定层级）。
- 交付闭环（M7，§11.2）：成果/项目导出 Markdown/CSV；只读交付页（token 只存哈希、可设口令/有效期/撤销、浏览计数，公开 /d/:token 只呈现被交付的一份）；渠道适配器 ChannelAdapter 接口（authBind/pushPublish/fetchMetrics）与 MJ 适配器（按 MJ 侧接口契约实现，stub 模拟验证通过；MJ 生产侧接口尚未实现，生产联调未做），推送落 channel_pushes 账、失败如实记录。
- 数据飞轮一期（M8，§11.5）：成果结构化标记（有效/无效 + 指标）；达标成果一键沉淀为知识条目（打「爆款规律」标签，注入优先级高于未验证历史成果）或给源 skill 追加已验证做法备注（再发单时拼入 brief）；成果库（搜索/按 skill/只看已验证有效、一键再发带原参数）；工作台账（task_events + audit_logs 时间线 + 按月 ledger CSV 对账导出）。
- 资产库（M8，§11.4/§12.3）：资产类型注册表（剧本等为短剧包注册类型，可自定义）；资产整份结构化内容（按集分段）+ 版本快照；发单/skill 发单可按资产与分段引用，引用锁定版本号、引擎按锁定版本注入、tasks.injected_assets 可追溯。
- 成套流水线（M8，§11.1）：「短剧上线包」模板一键生成项目 + 6 条 skill 子任务（卖点提炼→标题组→简介→封面文案→分集钩子→评论区话术），公共参数一次填写、全量校验后生成；子任务按 seq 顺序门控串行，上游成果自动注入下游。
- 站内提醒（M8）：待裁决/打回满次/余额耗尽（含体验额度专用分型）三类提醒直达空间所有者，未读去重、已读流转；邮件通道仅留配置位（notifyConfig），本版不发信。
- P1 补齐：批量发单（一行一单，POST /api/tasks/batch，≤100 单）与任务参考资料（references 以【参考资料】段拼入 brief）。

### Fixed

- 体验额度发放口径收紧（§8.1）：单笔上限 ¥10、每空间一次性不可续发叠加（此前可重复发放）。
- 引擎个人审核偏好此前读出后未真正拼入审核 prompt，现按「附加要点 + 冲突时空间标准为准」口径拼入。

### Tests

- 新增 M7 集成（skill 全链路/装包/版本与 changelog/试运行记账/kb_binding 强制注入与对照/上架审核/快照安装与升级/交付页口令与撤销与篡改/导出与跨空间 404/MJ 适配器 stub 推送回查/P1 批量与参考资料）与 M8 集成（资产版本与按集注入与追溯/飞轮标记沉淀再发命中/成果库筛选再发/流水线 6 环节整包交付/三类提醒与台账导出）；全量 61 项集成测试通过，五门禁全绿。

## [0.6.0] - 2026-10-23

M6 多用户平台后端（产品方案 §1–§6、§8.1、§9 M6、§10、§12；ADR-008）：账号体系 + workspace 全量隔离 + 工种/任务类型注册表 + 行业包 + 体验额度 + 审计/任务事件底座。前端本轮未动，API 契约完整可用。

### Added

- 账号与会话：users/workspaces/memberships/sessions/login_logs/user_preferences（迁移 003）；argon2id 密码哈希；服务端 session（库里只存哈希、HttpOnly/SameSite=Lax Cookie、Secure 可配、7 天滑动续期）；登录失败 5 次锁定 15 分钟且成败落 login_logs；登出/管理员停用即时吊销全部会话。接口：POST /api/auth/register|login|logout|change-password|switch-workspace、GET /api/auth/me；注册两档开通（个人空间即时开通，异常特征——同 IP 10 分钟 ≥3 次或全局 requireApproval 开关——走 pending）；管理员种子读 SWARM_ADMIN_EMAIL/SWARM_ADMIN_PASSWORD，未设密码时随机口令落 DATA_DIR/admin-initial-password.txt（0600），must_change_password 强制改密（未改密前除改密/登出/me 外 403）。
- 管理台（仅平台管理员）：GET /api/admin/users、POST /api/admin/users/:id/approve|disable|reset-password（临时密码一次性返回）、GET /api/admin/workspaces（各空间聚合用量，不给明细）、POST /api/admin/trial-grants、GET/POST /api/admin/trial-api、GET/POST /api/admin/industry-packs。
- 注册表：roles/task_types 两表（迁移 004），五工种与 TYPE_ROLE 映射作种子迁入（组长/审核 is_system）；GET /api/registry、POST /api/registry/roles|task-types（空间自定义工种/任务类型）；引擎派单改查注册表；shared 的 ROLES/TASK_TYPES 退役为种子默认值，DTO 的 role/type 放宽为 string。
- 行业包：industry_packs 表（迁移 005，manifest JSON 存 content）；内置「短剧公司」包（short_drama：短剧文案组/选题调研组/审片组 + 示例知识种子 + 官方 skill slug 清单占位，skill 本体 M7 落地）；POST /api/workspaces 选包快照装入，不选包只装通用种子（通用小组 + 五工种默认人设，零行业词）；GET /api/industry-packs 列已上架包。
- 体验额度（§8.1）：平台级体验 API（apis 行 is_trial=1、workspace_id=NULL，管理员经 /api/admin/trial-api 维护）；发放落 purchases type=trial_grant；引擎 resolveApi 守卫链末位挂体验 API（自备优先），消费走正常 ledger，余额按空间 Σtrial_grant − Σledger 推导；耗尽停工文案为「体验额度已用完，请到设置后台填自己的 API Key」；管理员聚合视图可见各空间发放与消耗。
- 审计与事件底座：task_events（状态机统一函数落，actor_type=user/engine/ai_member）与 audit_logs（登录/采购/裁决/改 API/改审核标准/成员增删/备份/管理员动作）；user_preferences 与 GET/PUT /api/preferences，个人提示词拼入执行 prompt 个人段、个人审核偏好以附加要点并入审核 prompt（空间标准为硬约束）。

### Changed

- 全量隔离：业务表（apis/teams/members/projects/tasks/ledger_entries/purchases/kb_entries）加 workspace_id 回填默认空间「MJ 蜂群」（ws_default，视为已选短剧包）；settings 主键改 (workspace_id, key) 复合；tasks 加 created_by_user_id/skill_id/skill_version；kb_entries 加 owner_user_id、scope 扩为 company|team|personal|platform（旧 member 折算 personal）；仓储 list 强制带空间过滤、按 id 单查不匹配回 404；除 /api/auth/* 与健康检查外无会话一律 401，当前空间只取自 session（忽略前端传入的 workspace_id）；引擎按空间迭代队列，各空间并发/预算守卫互不影响；/api/state、/api/cost/report 只含当前空间（汇报新增按发单人维度）。
- 备份口径：GET /api/backup 改为仅平台管理员可用（仍为整库文件、含全部空间，响应头 x-backup-scope 注明），下载落审计。
- 旧数据迁移工具 tools/migrate-from-json.js 同步写 workspace_id（落默认空间）与 settings 复合主键。

### Tests

- 存量集成测试夹具改造为「管理员登录带 Cookie + 强制改密后操作」，断言口径不变；新增 M6 集成 3 组：账号全流程（锁定/pending 审核/重置强制改密/登出与停用吊销）、越权矩阵（跨空间 task/project/kb/api/member 直查全 404、state 与 cost 零串数据、备份仅管理员、个人 KB 在他人会话下不可见且不被注入——查注入记录）、体验额度发放→消耗→耗尽、注册表自定义工种端到端跑通一单（mock-llm）、行业包三组与知识种子/不选包零短剧字样、迁移对账（001/002 存量库逐项数量与金额一致）。

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
