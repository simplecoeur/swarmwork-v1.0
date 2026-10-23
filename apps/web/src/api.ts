import type {
  AppState,
  AuthUser,
  IndustryPack,
  KbEntry,
  Presets,
  RegistryRole,
  RegistryTaskType,
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
    headers: { 'content-type': 'application/json' },
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
}

/** 未登录时 requestRaw 抛 401 的后端 message，调用方据此进登录页 */
export async function fetchMe(): Promise<MeResult> {
  const j = await requestRaw('GET', '/api/auth/me');
  return {
    user: j.user as AuthUser,
    workspace: (j.workspace as Workspace | null) ?? null,
    workspaces: (j.workspaces as Workspace[]) ?? [],
  };
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
