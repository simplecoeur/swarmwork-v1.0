import type { AppState, Presets } from './types';

// 接口返回 ok:false 时抛错，由调用方（Context 的 post 包装）统一 toast。
// 错误结构为新后端统一契约 { ok:false, error:{ code, message } }（兼容旧版字符串 error）。
export async function postRaw(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!j.ok) {
    const e = j.error as { message?: string } | string | undefined;
    throw new Error(typeof e === 'string' ? e : e?.message || String(r.status));
  }
  return j;
}

export async function fetchState(): Promise<AppState> {
  const r = await fetch('/api/state');
  return (await r.json()) as AppState;
}

export async function fetchPresets(): Promise<Presets> {
  const r = await fetch('/api/presets');
  return (await r.json()) as Presets;
}
