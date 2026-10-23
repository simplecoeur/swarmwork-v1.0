import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import { fetchNotifications, requestRaw } from '../api';
import type { AppNotification } from '../types';

function fmtTime(iso: string): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

/**
 * 顶栏提醒铃铛（M8 §9）：未读数角标，每 5 秒自刷；
 * 点开面板列提醒，可单条已读 / 全部已读。数据走 GET /api/notifications。
 */
export default function NotificationBell() {
  const { toast } = useApp();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchNotifications();
      setItems(r.notifications);
      setUnread(r.unread);
    } catch {
      /* 轮询失败静默，下个周期重试 */
    }
  }, []);

  useEffect(() => {
    load();
    const iv = window.setInterval(load, 5000);
    return () => window.clearInterval(iv);
  }, [load]);

  // 点面板外关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open ]);

  async function markRead(id: number) {
    try {
      const j = await requestRaw('POST', `/api/notifications/${id}/read`);
      setUnread(Number(j.unread ?? 0));
      setItems((xs) => xs.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)));
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function markAllRead() {
    try {
      await requestRaw('POST', '/api/notifications/read-all');
      setUnread(0);
      setItems((xs) => xs.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      toast('提醒已全部标为已读');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <div className="bell-wrap" ref={wrapRef}>
      <button className="mini-btn" onClick={() => setOpen((o) => !o)} title="站内提醒">
        🔔 提醒
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <b>站内提醒</b>
            <span className="hint">未读 {unread} 条</span>
            <button className="btn small gray" style={{ marginLeft: 'auto' }} onClick={markAllRead}>
              全部已读
            </button>
            <button className="btn small gray" onClick={load}>刷新</button>
          </div>
          {items.length === 0 && <p className="hint">暂无提醒。</p>}
          {items.slice(0, 30).map((n) => (
            <div className={`bell-item${n.readAt ? '' : ' unread'}`} key={n.id}>
              <div>
                {n.readAt ? '' : '● '}{n.title}
              </div>
              {n.body && <div className="hint">{n.body}</div>}
              <div className="hint">
                {fmtTime(n.createdAt)}
                {!n.readAt && (
                  <>
                    {' · '}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        markRead(n.id);
                      }}
                    >
                      标为已读
                    </a>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
