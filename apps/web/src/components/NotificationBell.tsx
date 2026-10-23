import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchNotifications, requestRaw } from '../api';
import { Button, Popover } from './ui';
import type { AppNotification } from '../types';

function fmtTime(iso: string): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

/**
 * 顶栏提醒铃铛（M8 §9）：未读数角标，每 5 秒自刷；
 * 点开面板列提醒，可单条已读 / 全部已读。数据走 GET /api/notifications。
 * v1.1.0：弹层换 Radix Popover（点外关闭/Esc 由原语负责）。
 */
export default function NotificationBell() {
  const { toast } = useApp();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

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
    <div className="bell-wrap">
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="ui-popover-panel"
        trigger={
          <Button variant="mini" style={{ position: 'relative' }} title="站内提醒">
            🔔 提醒
            {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
          </Button>
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <b>站内提醒</b>
          <span className="hint">未读 {unread} 条</span>
          <Button size="small" variant="gray" style={{ marginLeft: 'auto' }} onClick={markAllRead}>
            全部已读
          </Button>
          <Button size="small" variant="gray" onClick={load}>刷新</Button>
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
      </Popover>
    </div>
  );
}
