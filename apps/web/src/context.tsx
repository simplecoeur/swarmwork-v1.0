import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, AssetRef, AuthUser, Presets, TabKey, Workspace } from './types';

/** G-10「设为定时」快捷入口的预填（skill 发单弹窗 / 流水线入口 → 定时任务页新建表单） */
export interface SchedulePrefill {
  kind: 'skill' | 'pipeline' | 'task';
  skillId?: string;
  pipelineTemplateId?: string;
  teamId?: string;
  params?: Record<string, unknown>;
  assetRefs?: AssetRef[];
}
import { fetchMe, fetchPresets, fetchState, requestRaw } from './api';

export type AuthStatus = 'loading' | 'anon' | 'authed';

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
  /* ----- M6 多用户 ----- */
  authStatus: AuthStatus;
  user: AuthUser | null;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  /** 重新拉 /api/auth/me 刷新登录态（登录/注册/改密/开公司后调用） */
  refreshAuth: () => Promise<void>;
  /** 登录：失败抛错（message 为后端原文），由登录页红字展示，不走 toast */
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 切换当前空间：服务端切换 session 后整页数据 refresh */
  switchWorkspace: (workspaceId: string) => Promise<void>;
  /* ----- G-10 定时任务预填 ----- */
  schedulePrefill: SchedulePrefill | null;
  /** 跳到定时任务页并预填新建表单（消费后由页面 clearSchedulePrefill） */
  openSchedules: (prefill: SchedulePrefill) => void;
  clearSchedulePrefill: () => void;
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

  /* ----- M6 登录态 ----- */
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);

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

  const refreshAuth = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me.user);
      setWorkspaces(me.workspaces);
      setCurrentWorkspace(me.workspace);
      setAuthStatus('authed');
    } catch {
      setUser(null);
      setWorkspaces([]);
      setCurrentWorkspace(null);
      setAuthStatus('anon');
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      await requestRaw('POST', '/api/auth/login', { email, password });
      await refreshAuth();
    },
    [refreshAuth],
  );

  const logout = useCallback(async () => {
    try {
      await requestRaw('POST', '/api/auth/logout');
    } catch {
      /* 会话已失效也照常回登录页 */
    }
    setS(null);
    setUser(null);
    setWorkspaces([]);
    setCurrentWorkspace(null);
    setTab('office');
    setAuthStatus('anon');
  }, []);

  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      await requestRaw('POST', '/api/auth/switch-workspace', { workspaceId });
      setS(null);
      await refreshAuth();
      await refresh();
    },
    [refreshAuth, refresh],
  );

  const [schedulePrefill, setSchedulePrefill] = useState<SchedulePrefill | null>(null);
  const openSchedules = useCallback((prefill: SchedulePrefill) => {
    setSchedulePrefill(prefill);
    setTab('schedules');
  }, []);
  const clearSchedulePrefill = useCallback(() => setSchedulePrefill(null), []);

  // 启动先探登录态；未登录不拉 /api/state、不启动轮询
  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (authStatus !== 'authed') return;
    fetchPresets().then(setPresets).catch(() => {});
    refresh();
    // 每 2 秒轮询；在设置后台时不刷新，避免冲掉正在编辑的表单（与原生版一致）
    const iv = window.setInterval(() => {
      if (tabRef.current !== 'settings') refresh();
    }, 2000);
    return () => window.clearInterval(iv);
  }, [authStatus, refresh]);

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
      value={{
        S, presets, tab, setTab, toast, refresh, post, send, apiName, teamName, memberName,
        authStatus, user, workspaces, currentWorkspace, refreshAuth, login, logout, switchWorkspace,
        schedulePrefill, openSchedules, clearSchedulePrefill,
      }}
    >
      {children}
      {toastMsg && <div className="toast" style={{ display: 'block' }}>{toastMsg}</div>}
    </AppContext.Provider>
  );
}
