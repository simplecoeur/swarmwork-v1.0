import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, Presets, TabKey } from './types';
import { fetchPresets, fetchState, requestRaw } from './api';

interface AppContextValue {
  S: AppState | null;
  presets: Presets;
  tab: TabKey;
  setTab: (t: TabKey) => void;
  toast: (msg: string) => void;
  refresh: () => Promise<void>;
  /** 语义与原生版 post() 一致：失败时先 toast「出错：…」再抛错 */
  post: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
  /** 任意方法版（知识库 PUT/DELETE 用），失败同样先 toast 再抛错 */
  send: (method: 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<Record<string, unknown>>;
  apiName: (id: string | null | undefined) => string;
  teamName: (id: string) => string;
  memberName: (id: string | null | undefined) => string;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [S, setS] = useState<AppState | null>(null);
  const [presets, setPresets] = useState<Presets>({});
  const [tab, setTab] = useState<TabKey>('office');
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 2200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setS(await fetchState());
    } catch {
      /* 服务重启瞬间忽略，与原生版一致 */
    }
  }, []);

  const post = useCallback(
    async (path: string, body?: unknown) => {
      try {
        return await requestRaw('POST', path, body);
      } catch (e) {
        toast('出错：' + (e instanceof Error ? e.message : String(e)));
        throw e;
      }
    },
    [toast],
  );

  const send = useCallback(
    async (method: 'PUT' | 'DELETE', path: string, body?: unknown) => {
      try {
        return await requestRaw(method, path, body);
      } catch (e) {
        toast('出错：' + (e instanceof Error ? e.message : String(e)));
        throw e;
      }
    },
    [toast],
  );

  useEffect(() => {
    fetchPresets().then(setPresets).catch(() => {});
    refresh();
    // 每 2 秒轮询；在设置后台时不刷新，避免冲掉正在编辑的表单（与原生版一致）
    const iv = window.setInterval(() => {
      if (tabRef.current !== 'settings') refresh();
    }, 2000);
    return () => window.clearInterval(iv);
  }, [refresh]);

  const apiName = useCallback(
    (id: string | null | undefined) => S?.apis.find((a) => a.id === id)?.name || '（已删除）',
    [S],
  );
  const teamName = useCallback(
    (id: string) => S?.teams.find((t) => t.id === id)?.name || '（已删除组）',
    [S],
  );
  const memberName = useCallback(
    (id: string | null | undefined) => S?.members.find((m) => m.id === id)?.name || '—',
    [S],
  );

  return (
    <AppContext.Provider
      value={{ S, presets, tab, setTab, toast, refresh, post, send, apiName, teamName, memberName }}
    >
      {children}
      {toastMsg && <div className="toast" style={{ display: 'block' }}>{toastMsg}</div>}
    </AppContext.Provider>
  );
}
