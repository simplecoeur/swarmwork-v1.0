import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchNotifications, requestRaw } from '../api';
import { Badge, Button, Dialog, Popover } from './ui';
import type { AppNotification } from '../types';

function fmtTime(iso: string): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

/** G-03 通知类型中文名（既有 4 类 + 扩展 5 类） */
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  adjudication: '待裁决',
  balance: '余额耗尽',
  trial_exhausted: '体验额度耗尽',
  reject_max: '打回满次',
  balance_low: '余额预警',
  schedule_result: '定时任务结果',
  webhook_failed: 'Webhook 投递失败',
  impersonation: '管理员代入查看',
  transfer: '空间所有权转让',
  skill_featured: '技能精选',
  skill_unfeatured: '取消精选',
  checkin_reminder: '签到提醒',
  daily_briefing: '总经理晨报',
  announcement: '平台公告',
  skill_pushed: '技能下发',
  admin_message: '平台消息',
  agent_sync_alert: '同步告警',
};

export function notificationTypeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABELS[type] ?? type;
}

/** 通知类型全集（与 shared NOTIFICATION_TYPES 同序同值；web 端不引 shared 运行时值，故本地列一份） */
export const NOTIFICATION_TYPE_ORDER = Object.keys(NOTIFICATION_TYPE_LABELS);

const PAGE_SIZE = 20;

/**
 * 通知中心列表（G-03，铃铛面板与移动端全屏共用）：
 * 按类型分组、未读数、单条已读、全部已读、点带任务的通知跳目标任务、分页加载更多。
 * 数据走 GET /api/notifications（分页 + type 过滤在服务端）。
 */
export function NotificationList({ onNavigate }: { onNavigate?: () => void }) {
  const { toast, setTab, openDialog } = useApp();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const load = useCallback(async (p = 1) => {
    try {
      const r = await fetchNotifications({ page: p, pageSize: PAGE_SIZE });
      setItems((prev) => (p === 1 ? r.notifications : [...prev, ...r.notifications]));
      setUnread(r.unread);
      setTotal(r.total);
      setPage(p);
    } catch {
      /* 轮询失败静默，下个周期重试 */
    }
  }, []);

  useEffect(() => {
    load(1);
    const iv = window.setInterval(() => load(1), 5000);
    return () => window.clearInterval(iv);
  }, [load]);

  async function markRead(id: number) {
    try {
      const j = await requestRaw('POST', `/api/notifications/${id}/read`);
      setUnread(Number(j.unread ?? 0));
      setItems((xs) =>
        xs.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)),
      );
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function markAllRead() {
    try {
      await requestRaw('POST', '/api/notifications/read-all');
      setUnread(0);
      setItems((xs) => xs.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      toast('通知已全部标为已读');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 跳目标任务：打开任务弹窗（taskwall 区段）后再滚动定位对应任务卡（范式同 App.tsx goSearchItem） */
  function jumpToTask(n: AppNotification) {
    if (!n.taskId) return;
    void markRead(n.id);
    onNavigate?.();
    setTab('office');
    openDialog('tasks', { section: 'taskwall' });
    window.setTimeout(() => {
      document
        .getElementById(`task-${n.taskId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 220);
  }

  const groups = new Map<string, AppNotification[]>();
  for (const n of items) {
    const arr = groups.get(n.type) ?? [];
    arr.push(n);
    groups.set(n.type, arr);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <b>通知中心</b>
        <span className="hint">未读 {unread} 条</span>
        <Button size="small" variant="gray" style={{ marginLeft: 'auto' }} onClick={markAllRead}>
          全部已读
        </Button>
        <Button size="small" variant="gray" onClick={() => load(1)}>
          刷新
        </Button>
      </div>
      {items.length === 0 && <p className="hint">暂无通知。</p>}
      {[...groups.entries()].map(([type, arr]) => (
        <div key={type}>
          <div className="hint" style={{ margin: '8px 0 2px', fontWeight: 700 }}>
            {notificationTypeLabel(type)}（{arr.length}）
          </div>
          {arr.map((n) => (
            <div className={`bell-item${n.readAt ? '' : ' unread'}`} key={n.id}>
              <div>
                {n.readAt ? '' : '● '}
                {n.taskId ? (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      jumpToTask(n);
                    }}
                  >
                    {n.title}
                  </a>
                ) : (
                  n.title
                )}
                <Badge>{notificationTypeLabel(n.type)}</Badge>
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
                {n.taskId ? ' · 点标题跳到任务' : ''}
              </div>
            </div>
          ))}
        </div>
      ))}
      {items.length < total && (
        <div style={{ marginTop: 8 }}>
          <Button size="small" variant="gray" onClick={() => load(page + 1)}>
            加载更多（已显示 {items.length}/{total}）
          </Button>
        </div>
      )}
    </div>
  );
}

/** 移动端通知中心（G-03）：底部导航「更多」打开的全屏列表，与铃铛面板共用 NotificationList */
export function NotificationCenterDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} title="通知中心">
      <NotificationList onNavigate={onClose} />
    </Dialog>
  );
}

/**
 * 顶栏提醒铃铛（M8 §9 + G-03 通知中心）：未读数角标，每 5 秒自刷；
 * 点开 Popover 通知中心面板（分组/已读/跳任务）。未读数独立轻量轮询，保持角标新鲜。
 */
export default function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const loadUnread = useCallback(async () => {
    try {
      const r = await fetchNotifications({ page: 1, pageSize: 1 });
      setUnread(r.unread);
    } catch {
      /* 静默重试 */
    }
  }, []);

  useEffect(() => {
    loadUnread();
    const iv = window.setInterval(loadUnread, 5000);
    return () => window.clearInterval(iv);
  }, [loadUnread]);

  return (
    <div className="bell-wrap">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) loadUnread();
        }}
        className="ui-popover-panel"
        trigger={
          <Button variant="mini" style={{ position: 'relative' }} title="通知中心">
            🔔 通知
            {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
          </Button>
        }
      >
        <NotificationList onNavigate={() => setOpen(false)} />
      </Popover>
    </div>
  );
}
