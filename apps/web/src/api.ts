import type {
  AppState,
  AppNotification,
  Asset,
  AssetImportConfirm,
  AssetImportPreview,
  AssetType,
  AuthUser,
  ChannelInfo,
  ChannelPush,
  Delivery,
  Impersonation,
  IndustryPack,
  KbEntry,
  KbImportConfirm,
  KbImportPreview,
  LedgerViewItem,
  PipelineTemplate,
  Presets,
  RegistryRole,
  RegistryTaskType,
  ResultItem,
  SkillListItem,
  TaskTimelineData,
  Workspace,
} from './types';

// 接口返回 ok:false 时抛错，由调用方（Context 的 post/send 包装）统一 toast。
// 错误结构为新后端统一契约 { ok:false, error:{ code, message } }（兼容旧版字符串 error）。
export async function requestRaw(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const r = await fetch(path, {
    method,
    // 无 body 时不带 content-type：否则 Fastify 会把空 body 按 JSON 解析并拒绝（DELETE 吊销等无体请求）
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!j.ok) {
    const e = j.error as { message?: string } | string | undefined;
    throw new Error(typeof e === 'string' ? e : e?.message || String(r.status));
  }
  return j;
}

export async function postRaw(path: string, body?: unknown): Promise<Record<string, unknown>> {
  return requestRaw('POST', path, body);
}

export async function fetchState(): Promise<AppState> {
  const r = await fetch('/api/state');
  return (await r.json()) as AppState;
}

export async function fetchPresets(): Promise<Presets> {
  const r = await fetch('/api/presets');
  return (await r.json()) as Presets;
}

/** 知识库条目不在 /api/state 快照内，单独拉取（知识库页与任务墙注入展示共用） */
export async function fetchKb(): Promise<KbEntry[]> {
  const j = await requestRaw('GET', '/api/kb');
  return (j.entries as KbEntry[]) ?? [];
}

/* ---------- M6 多用户 ---------- */

export interface MeResult {
  user: AuthUser;
  workspace: Workspace | null;
  workspaces: Workspace[];
  /** G-14 代入态（非代入时为 null） */
  impersonation: Impersonation | null;
}

/** 未登录时 requestRaw 抛 401 的后端 message，调用方据此进登录页 */
export async function fetchMe(): Promise<MeResult> {
  const j = await requestRaw('GET', '/api/auth/me');
  return {
    user: j.user as AuthUser,
    workspace: (j.workspace as Workspace | null) ?? null,
    workspaces: (j.workspaces as Workspace[]) ?? [],
    impersonation: (j.impersonation as Impersonation | null) ?? null,
  };
}

/** G-15 转让页：按邮箱精确查用户（只读补口；查不到抛 404 的后端 message） */
export async function lookupUserByEmail(
  email: string,
): Promise<{ id: string; email: string; displayName: string; status: string }> {
  const j = await requestRaw('GET', `/api/users/lookup?email=${encodeURIComponent(email)}`);
  return j.user as { id: string; email: string; displayName: string; status: string };
}

export interface RegistryResult {
  roles: RegistryRole[];
  taskTypes: RegistryTaskType[];
}

/** 工种/任务类型注册表（当前空间可见：系统 + 行业包 + 本空间自定义） */
export async function fetchRegistry(): Promise<RegistryResult> {
  const j = await requestRaw('GET', '/api/registry');
  return {
    roles: (j.roles as RegistryRole[]) ?? [],
    taskTypes: (j.taskTypes as RegistryTaskType[]) ?? [],
  };
}

/** 行业包列表（需登录；开新公司选包用） */
export async function fetchIndustryPacks(): Promise<IndustryPack[]> {
  const j = await requestRaw('GET', '/api/industry-packs');
  return (j.packs as IndustryPack[]) ?? [];
}

/* ---------- M7/M8 ---------- */

/** 本空间 skill + 平台库合并列表（行带 installedCopyId） */
export async function fetchSkills(): Promise<SkillListItem[]> {
  const j = await requestRaw('GET', '/api/skills');
  return (j.skills as SkillListItem[]) ?? [];
}

export async function fetchAssetTypes(): Promise<AssetType[]> {
  const j = await requestRaw('GET', '/api/asset-types');
  return (j.assetTypes as AssetType[]) ?? [];
}

export async function fetchAssets(): Promise<Asset[]> {
  const j = await requestRaw('GET', '/api/assets');
  return (j.assets as Asset[]) ?? [];
}

export interface NotificationsResult {
  notifications: AppNotification[];
  unread: number;
  total: number;
  page: number;
  pageSize: number;
}

/** G-03：通知分页 + 按 type 过滤；无参数 = 第一页（服务端默认 20 条） */
export async function fetchNotifications(opts?: {
  type?: string;
  page?: number;
  pageSize?: number;
}): Promise<NotificationsResult> {
  const qs = new URLSearchParams();
  if (opts?.type) qs.set('type', opts.type);
  if (opts?.page) qs.set('page', String(opts.page));
  if (opts?.pageSize) qs.set('pageSize', String(opts.pageSize));
  const s = qs.toString();
  const j = await requestRaw('GET', '/api/notifications' + (s ? `?${s}` : ''));
  return {
    notifications: (j.notifications as AppNotification[]) ?? [],
    unread: Number(j.unread ?? 0),
    total: Number(j.total ?? 0),
    page: Number(j.page ?? 1),
    pageSize: Number(j.pageSize ?? 20),
  };
}

/* ---------- G-02/G-03 偏好（onboarding / notifyPrefs 走 GET/PUT /api/preferences） ---------- */

export async function fetchPreferences(): Promise<Record<string, unknown>> {
  const j = await requestRaw('GET', '/api/preferences');
  return (j.preferences as Record<string, unknown>) ?? {};
}

export async function putPreference(key: string, value: unknown): Promise<void> {
  await requestRaw('PUT', '/api/preferences', { key, value });
}

/* ---------- G-08 预估 / 摘要 / 阈值 ---------- */

export async function fetchCostEstimate(opts?: {
  type?: string;
  skillId?: string;
}): Promise<import('./types').CostEstimate> {
  const qs = new URLSearchParams();
  if (opts?.type) qs.set('type', opts.type);
  if (opts?.skillId) qs.set('skillId', opts.skillId);
  const s = qs.toString();
  const j = await requestRaw('GET', '/api/cost/estimate' + (s ? `?${s}` : ''));
  return j.estimate as import('./types').CostEstimate;
}

export interface CostSettingsResult {
  lowBalanceThresholdYuan: number | null;
  effectiveThresholdYuan: number | null;
  summary: import('./types').CostSummary;
}

export async function fetchCostSettings(): Promise<CostSettingsResult> {
  const j = await requestRaw('GET', '/api/cost/settings');
  const s = j.settings as { lowBalanceThresholdYuan: number | null; effectiveThresholdYuan: number | null };
  return { ...s, summary: j.summary as import('./types').CostSummary };
}

/** 成果库（飞轮）：q 关键词 / verifiedOnly 只看已验证有效 */
export async function fetchResults(q: string, verifiedOnly: boolean): Promise<ResultItem[]> {
  const qs = new URLSearchParams();
  if (q.trim()) qs.set('q', q.trim());
  if (verifiedOnly) qs.set('verified', '1');
  const s = qs.toString();
  const j = await requestRaw('GET', '/api/results' + (s ? `?${s}` : ''));
  return (j.results as ResultItem[]) ?? [];
}

export async function fetchDeliveries(): Promise<Delivery[]> {
  const j = await requestRaw('GET', '/api/deliveries');
  return (j.deliveries as Delivery[]) ?? [];
}

/** 参观链接列表（G-13：与交付页同一 DTO，kind='visit'） */
export async function fetchVisitLinks(): Promise<Delivery[]> {
  const j = await requestRaw('GET', '/api/visit-links');
  return (j.visitLinks as Delivery[]) ?? [];
}

export async function fetchChannels(): Promise<ChannelInfo[]> {
  const j = await requestRaw('GET', '/api/channels');
  return (j.channels as ChannelInfo[]) ?? [];
}

export async function fetchChannelPushes(): Promise<ChannelPush[]> {
  const j = await requestRaw('GET', '/api/channels/pushes');
  return (j.pushes as ChannelPush[]) ?? [];
}

export async function fetchPipelineTemplates(): Promise<PipelineTemplate[]> {
  const j = await requestRaw('GET', '/api/pipelines/templates');
  return (j.templates as PipelineTemplate[]) ?? [];
}

export async function fetchLedgerView(): Promise<LedgerViewItem[]> {
  const j = await requestRaw('GET', '/api/ledger-view');
  return (j.timeline as LedgerViewItem[]) ?? [];
}

/* ---------- G-06 文件导入（两段式：multipart 预览 → JSON 确认落库） ---------- */

/** multipart POST：与 requestRaw 同错误口径（ok:false 抛后端 message） */
async function postForm(path: string, form: FormData): Promise<Record<string, unknown>> {
  const r = await fetch(path, { method: 'POST', body: form });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!j.ok) {
    const e = j.error as { message?: string } | string | undefined;
    throw new Error(typeof e === 'string' ? e : e?.message || String(r.status));
  }
  return j;
}

export async function previewKbImport(
  file: File,
  scope: string,
  scopeId: string | null,
): Promise<KbImportPreview> {
  const form = new FormData();
  form.append('scope', scope);
  if (scopeId) form.append('scopeId', scopeId);
  form.append('file', file);
  const j = await postForm('/api/kb/import/preview', form);
  return { filename: String(j.filename ?? file.name), drafts: (j.drafts as KbImportPreview['drafts']) ?? [] };
}

export async function confirmKbImport(
  body: KbImportConfirm,
): Promise<{ created: number; failed: number }> {
  const j = await requestRaw('POST', '/api/kb/import/confirm', body);
  return { created: Number(j.created ?? 0), failed: Number(j.failed ?? 0) };
}

export async function previewAssetImport(file: File, typeId: string): Promise<AssetImportPreview> {
  const form = new FormData();
  form.append('typeId', typeId);
  form.append('file', file);
  const j = await postForm('/api/assets/import/preview', form);
  return {
    filename: String(j.filename ?? file.name),
    name: String(j.name ?? ''),
    sections: (j.sections as AssetImportPreview['sections']) ?? [],
  };
}

export async function confirmAssetImport(body: AssetImportConfirm): Promise<Asset> {
  const j = await requestRaw('POST', '/api/assets/import/confirm', body);
  return j.asset as Asset;
}

/* ---------- G-07 开放 API（Token / Webhook 管理面，走会话） ---------- */

export async function fetchApiTokens(): Promise<import('./types').ApiToken[]> {
  const j = await requestRaw('GET', '/api/tokens');
  return (j.tokens as import('./types').ApiToken[]) ?? [];
}

export async function fetchWebhooks(): Promise<import('./types').WebhookItem[]> {
  const j = await requestRaw('GET', '/api/webhooks');
  return (j.webhooks as import('./types').WebhookItem[]) ?? [];
}

export async function fetchWebhookDeliveries(
  webhookId: string,
): Promise<import('./types').WebhookDelivery[]> {
  const j = await requestRaw('GET', `/api/webhooks/${webhookId}/deliveries`);
  return (j.deliveries as import('./types').WebhookDelivery[]) ?? [];
}

/* ---------- G-09 全局搜索 ---------- */

export async function fetchSearch(
  q: string,
  types?: string[],
): Promise<import('./types').SearchResponse> {
  const qs = new URLSearchParams();
  qs.set('q', q);
  if (types?.length) qs.set('types', types.join(','));
  const j = await requestRaw('GET', `/api/search?${qs.toString()}`);
  return {
    groups: (j.groups as import('./types').SearchResponse['groups']) ?? [],
    results: (j.results as import('./types').SearchItem[]) ?? [],
  };
}

/* ---------- G-11 账号设置 ---------- */

export async function fetchAccount(): Promise<import('./types').AccountInfo> {
  const j = await requestRaw('GET', '/api/account');
  return j.account as import('./types').AccountInfo;
}

export async function fetchSessions(): Promise<import('./types').SessionItem[]> {
  const j = await requestRaw('GET', '/api/auth/sessions');
  return (j.sessions as import('./types').SessionItem[]) ?? [];
}

/** 头像上传（multipart 直传；裁剪在 AvatarUploader 组件内完成后以 Blob 传入） */
export async function uploadAvatar(blob: Blob): Promise<{ avatarUrl: string | null }> {
  const fd = new FormData();
  fd.append('file', blob, 'avatar.jpg');
  const r = await fetch('/api/account/avatar', { method: 'POST', body: fd });
  const j = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    avatarUrl?: string | null;
    error?: { message?: string };
  };
  if (!j.ok) throw new Error(j.error?.message || `上传失败（${r.status}）`);
  return { avatarUrl: j.avatarUrl ?? null };
}

/* ---------- G-10 定时任务 ---------- */

export async function fetchSchedules(): Promise<import('./types').ScheduleItem[]> {
  const j = await requestRaw('GET', '/api/schedules');
  return (j.schedules as import('./types').ScheduleItem[]) ?? [];
}

/** G-04 任务过程时间线：步骤流 + 状态流水（执行中轮询增量刷新、已完成即回放，同一接口） */
export async function fetchTaskTimeline(taskId: string): Promise<TaskTimelineData> {
  const j = await requestRaw('GET', `/api/tasks/${taskId}/timeline`);
  return {
    steps: (j.steps as TaskTimelineData['steps']) ?? [],
    events: (j.events as TaskTimelineData['events']) ?? [],
  };
}

/* ---------- v1.3.0 A3 任务模板 / B3 生态公示 / F 办公室风格 ---------- */

export async function fetchTemplates(): Promise<import('./types').TaskTemplate[]> {
  const j = await requestRaw('GET', '/api/templates');
  return (j.templates as import('./types').TaskTemplate[]) ?? [];
}

export async function createTemplate(body: {
  name: string;
  typeId: string;
  briefTemplate: string;
  suggestedRole?: string;
}): Promise<import('./types').TaskTemplate> {
  const j = await requestRaw('POST', '/api/templates', body);
  return j.template as import('./types').TaskTemplate;
}

/** 任务墙「存为模板」：以既有任务为蓝本生成本空间模板（taskId 走路径、无 body） */
export async function createTemplateFromTask(
  taskId: string,
): Promise<import('./types').TaskTemplate> {
  const j = await requestRaw('POST', `/api/templates/from-task/${taskId}`);
  return j.template as import('./types').TaskTemplate;
}

export async function deleteTemplate(id: string): Promise<void> {
  await requestRaw('DELETE', `/api/templates/${id}`);
}

/** B3 平台库最新动态（上架/精选公示） */
export async function fetchSkillActivity(): Promise<import('./types').SkillActivityItem[]> {
  const j = await requestRaw('GET', '/api/skills/activity');
  return (j.activity as import('./types').SkillActivityItem[]) ?? [];
}

/** 管理员官方精选晋升/取消（平台管理员专用） */
export async function adminFeatureSkill(id: string, featured: boolean): Promise<void> {
  await requestRaw('POST', `/api/admin/skills/${id}/feature`, { featured });
}

/** F 当前空间办公室风格 */
export async function fetchOfficeStyle(): Promise<import('./types').OfficeStyleConfig> {
  const j = await requestRaw('GET', '/api/office-style');
  return j.style as import('./types').OfficeStyleConfig;
}

export async function putOfficeStyle(
  style: import('./types').OfficeStyleConfig,
): Promise<import('./types').OfficeStyleConfig> {
  const j = await requestRaw('PUT', '/api/office-style', style);
  return (j.style as import('./types').OfficeStyleConfig) ?? style;
}

/** F 风格模板 DTO（GET /api/style-templates 的行：config 与 style 同义双字段） */
export interface StyleTemplateItem {
  id: string;
  name: string;
  config: import('./types').OfficeStyleConfig;
  style: import('./types').OfficeStyleConfig;
  visibility: string;
  applyCount: number;
  contributorName: string | null;
  contributorWorkspaceName: string | null;
  ownerType: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt?: string;
  workspaceId?: string | null;
}

export interface StyleTemplatesResult {
  mine: StyleTemplateItem[];
  library: StyleTemplateItem[];
}

/** F 风格模板库：GET /api/style-templates → { mine, library } */
export async function fetchStyleTemplates(): Promise<StyleTemplatesResult> {
  const j = await requestRaw('GET', '/api/style-templates');
  return {
    mine: (j.mine as StyleTemplateItem[]) ?? [],
    library: (j.library as StyleTemplateItem[]) ?? [],
  };
}

/** F 存为风格模板（visibility 初始 private，提交审核后管理员过审进平台库） */
export async function createStyleTemplate(
  name: string,
  config: import('./types').OfficeStyleConfig,
): Promise<StyleTemplateItem> {
  const j = await requestRaw('POST', '/api/style-templates', { name, config });
  return j.template as StyleTemplateItem;
}

export async function submitStyleTemplateReview(id: string): Promise<void> {
  await requestRaw('POST', `/api/style-templates/${id}/submit-review`);
}

/** 套用风格模板：服务端直接写入当前空间风格并计 applyCount，返回套用后的风格 */
export async function applyStyleTemplate(
  id: string,
): Promise<import('./types').OfficeStyleConfig> {
  const j = await requestRaw('POST', `/api/style-templates/${id}/apply`);
  return j.style as import('./types').OfficeStyleConfig;
}

/** F 管理员：待审核风格模板（服务端第二阶段端点） */
export async function fetchAdminStyleTemplatesPending(): Promise<StyleTemplateItem[]> {
  const j = await requestRaw('GET', '/api/admin/style-templates/pending');
  return (j.templates as StyleTemplateItem[]) ?? [];
}

export async function adminApproveStyleTemplate(id: string): Promise<void> {
  await requestRaw('POST', `/api/admin/style-templates/${id}/approve`);
}

export async function adminRejectStyleTemplate(id: string, reason: string): Promise<void> {
  await requestRaw('POST', `/api/admin/style-templates/${id}/reject`, { reason });
}

/** F 风格图片上传（multipart，字段名 'file' 与头像上传一致）→ { fileId, url } */
export async function uploadStyleImage(file: File): Promise<{ fileId: string; url: string }> {
  const form = new FormData();
  form.append('file', file);
  const j = await postForm('/api/style-images', form);
  return { fileId: String(j.fileId ?? ''), url: String(j.url ?? '') };
}

/* ---------- v1.3.0 G 晨报与签到 ---------- */

export interface CheckinState {
  checkedToday: boolean;
  streak: number;
  /** 本月已签到日期（YYYY-MM-DD） */
  monthDays: string[];
  lastCheckinDate: string | null;
  /** POST /api/checkin 专用：本次是否新建签到 */
  created?: boolean;
}

export async function fetchCheckin(): Promise<CheckinState> {
  const j = await requestRaw('GET', '/api/checkin');
  return {
    checkedToday: Boolean(j.checkedToday),
    streak: Number(j.streak ?? 0),
    monthDays: (j.monthDays as string[]) ?? [],
    lastCheckinDate: (j.lastCheckinDate as string | null) ?? null,
  };
}

export async function doCheckin(): Promise<CheckinState> {
  const j = await requestRaw('POST', '/api/checkin');
  return {
    checkedToday: Boolean(j.checkedToday),
    streak: Number(j.streak ?? 0),
    monthDays: (j.monthDays as string[]) ?? [],
    lastCheckinDate: (j.lastCheckinDate as string | null) ?? null,
    created: Boolean(j.created),
  };
}

export interface BriefingItem {
  id: string;
  date: string;
  contentMd: string;
  createdAt: string;
}

export async function fetchTodayBriefing(): Promise<BriefingItem | null> {
  const j = await requestRaw('GET', '/api/briefings/today');
  return (j.briefing as BriefingItem | null) ?? null;
}

/** 往期晨报（最近 7 份） */
export async function fetchBriefings(): Promise<BriefingItem[]> {
  const j = await requestRaw('GET', '/api/briefings');
  return (j.briefings as BriefingItem[]) ?? [];
}

export type NewsTopic = 'short_drama' | 'film' | 'ai' | 'general';

export interface DailySettings {
  briefingEnabled: boolean;
  briefingTime: string;
  checkinReminderEnabled: boolean;
  checkinReminderTime: string;
  newsTopic: NewsTopic;
  supervisionItems: string;
  mailStatus: 'not_configured' | 'configured';
}

export async function fetchDailySettings(): Promise<DailySettings> {
  const j = await requestRaw('GET', '/api/daily-settings');
  return j.settings as DailySettings;
}

export async function putDailySettings(settings: Partial<DailySettings>): Promise<DailySettings> {
  const j = await requestRaw('PUT', '/api/daily-settings', { settings });
  return j.settings as DailySettings;
}

/* ---------- v1.3.0 C2 注册问卷 ---------- */

export interface QuestionnaireApi {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Questionnaire {
  api: QuestionnaireApi | null;
  industry: string;
  job: string;
  uses: string[];
  problems: string;
  checkinReminderEnabled: boolean;
  checkinReminderTime: string;
  briefingEnabled: boolean;
  briefingTime: string;
  supervisionItems: string;
}

/** 问卷第 1 步「测试连接」：无空间上下文的探活，失败抛后端原文 message */
export async function testApiConnection(body: QuestionnaireApi): Promise<void> {
  await requestRaw('POST', '/api/apis/test-connection', body);
}

export async function fetchQuestionnaire(): Promise<Questionnaire | null> {
  const j = await requestRaw('GET', '/api/questionnaire');
  const q = j.questionnaire as (Questionnaire & { uses?: string | string[] }) | null;
  if (!q) return null;
  return {
    ...q,
    uses: Array.isArray(q.uses) ? q.uses : q.uses ? [q.uses] : [],
  };
}

export async function putQuestionnaire(questionnaire: Questionnaire): Promise<void> {
  await requestRaw('PUT', '/api/questionnaire', { questionnaire });
}

/* ---------- v1.4.0 J 智能体人才库 ---------- */

/** 用户侧人才库条目：仅已上架 pub 快照 + 署名（仓库·作者·许可证） */
export interface AgentTemplateItem {
  id: string;
  name: string;
  specialty: string;
  persona: string;
  role: string;
  division: string;
  language: string;
  sourceRepo: string;
  sourceAuthor: string;
  license: string;
  recruitCount: number;
}

export async function fetchAgentTemplates(): Promise<AgentTemplateItem[]> {
  const j = await requestRaw('GET', '/api/agent-templates');
  return (j.templates as AgentTemplateItem[]) ?? [];
}

export async function recruitAgentTemplate(id: string, teamId: string): Promise<string> {
  const j = await requestRaw('POST', `/api/agent-templates/${id}/recruit`, { teamId });
  return String(j.memberId ?? '');
}

/** 管理台模板全量（draft/pub 双份 + 状态） */
export interface AdminAgentTemplateItem {
  id: string;
  sourceRepo: string;
  sourcePath: string;
  division: string;
  draftName: string;
  draftSpecialty: string;
  draftPersona: string;
  draftRole: string;
  pubName: string | null;
  pubSpecialty: string | null;
  pubPersona: string | null;
  pubRole: string | null;
  language: string;
  sourceAuthor: string;
  license: string;
  status: 'pending_review' | 'public' | 'rejected';
  hasPendingUpdate: boolean;
  rejectReason: string;
  recruitCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSyncSourceItem {
  id: string;
  repo: string;
  branch: string;
  license: string;
  author: string;
}

export interface AgentSyncResult {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export async function fetchAdminAgentTemplates(): Promise<AdminAgentTemplateItem[]> {
  const j = await requestRaw('GET', '/api/admin/agent-templates');
  return (j.templates as AdminAgentTemplateItem[]) ?? [];
}

export async function fetchAgentSyncSources(): Promise<AgentSyncSourceItem[]> {
  const j = await requestRaw('GET', '/api/admin/agent-sources');
  return (j.sources as AgentSyncSourceItem[]) ?? [];
}

export async function saveAgentSyncSources(sources: AgentSyncSourceItem[]): Promise<AgentSyncSourceItem[]> {
  const j = await requestRaw('POST', '/api/admin/agent-sources', { sources });
  return (j.sources as AgentSyncSourceItem[]) ?? [];
}

export async function runAgentSync(sourceId: string): Promise<AgentSyncResult> {
  const j = await requestRaw('POST', '/api/admin/agent-sync', { sourceId });
  return {
    fetched: Number(j.fetched ?? 0),
    created: Number(j.created ?? 0),
    updated: Number(j.updated ?? 0),
    unchanged: Number(j.unchanged ?? 0),
    failed: Number(j.failed ?? 0),
  };
}
