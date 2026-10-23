import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAccount, fetchSessions, uploadAvatar } from '../api';
import { useApp } from '../context';
import type { AccountInfo, SessionItem } from '../types';
import { Badge, Button, Dialog, Field, Input, useConfirm } from './ui';

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * 账号设置页（G-11）：资料卡（头像/显示名/名下空间）/ 安全卡（改密 + 活跃会话定向吊销）/
 * 危险区卡（注销冷静期流程）。邮箱验证随 G-01 邮件通道暂缓——只展示占位文案，
 * 不做假状态/假按钮。全用组件层（Dialog/Input/Button），移动端单列由卡片天然堆叠保证。
 */

/** 头像上传：选图后在浏览器内 canvas 裁方缩到 256px 再上传（服务端只存 <user_id>.<ext>） */
export function AvatarUploader({ userId, onDone }: { userId: string; onDone: () => void }) {
  const { toast } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [ver, setVer] = useState(0);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('请选择图片文件');
    setBusy(true);
    try {
      const bmp = await createImageBitmap(file);
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('canvas 不可用');
      const side = Math.min(bmp.width, bmp.height);
      g.drawImage(
        bmp,
        (bmp.width - side) / 2,
        (bmp.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
      if (!blob) throw new Error('图片处理失败');
      await uploadAvatar(blob);
      setVer((v) => v + 1);
      toast('头像已更新');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <img
        className="avatar-lg"
        src={`/api/users/${userId}/avatar?v=${ver}`}
        alt="我的头像"
      />
      <div>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={onFile} />
        <Button size="small" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? '上传中…' : '更换头像'}
        </Button>
        <p className="hint">图片会自动裁成正方形并压缩（≤2MB，PNG/JPEG/WebP/GIF）。</p>
      </div>
    </div>
  );
}

function SessionsCard() {
  const { post, send, toast, refreshAuth } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  const load = useCallback(async () => {
    try {
      setSessions(await fetchSessions());
    } catch {
      /* 列表拉取失败不阻断页面 */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function revoke(s: SessionItem) {
    if (s.isCurrent) {
      ask({
        title: '吊销当前会话',
        message: '吊销当前会话将立即退出登录，继续？',
        confirmLabel: '吊销并登出',
        onConfirm: () => void doRevoke(s),
      });
      return;
    }
    void doRevoke(s);
  }

  async function doRevoke(s: SessionItem) {
    try {
      const j = await send('DELETE', `/api/auth/sessions/${s.id}`);
      if (j.loggedOut) {
        toast('当前会话已吊销，已退出登录');
        await refreshAuth();
        return;
      }
      toast('会话已吊销');
      void load();
    } catch {
      /* send 已 toast */
    }
  }

  function revokeOthers() {
    ask({
      title: '吊销其他会话',
      message: '吊销除当前外的全部登录会话？其他设备将被登出。',
      confirmLabel: '全部吊销',
      onConfirm: () => void doRevokeOthers(),
    });
  }

  async function doRevokeOthers() {
    try {
      await post('/api/auth/sessions/revoke-others', {});
      toast('其他会话已全部吊销');
      void load();
    } catch {
      /* post 已 toast */
    }
  }

  return (
    <>
      <h3 style={{ marginTop: 14 }}>活跃会话</h3>
      {sessions.length === 0 && <p className="hint">暂无会话记录。</p>}
      {sessions.map((s) => (
        <div className="task" key={s.id}>
          <div className="tt" style={{ fontSize: 13 }}>
            {s.isCurrent ? '当前设备' : '其他设备'}
            {s.isCurrent && <Badge variant="done">本会话</Badge>}
          </div>
          <div className="meta">
            登录于 {fmtTime(s.createdAt)} · 最近活跃 {fmtTime(s.lastSeenAt)} · IP {s.ip || '未知'}
            <br />
            设备：{s.userAgent || '未知'}
          </div>
          <div style={{ marginTop: 6 }}>
            <Button size="small" variant="gray" onClick={() => revoke(s)}>
              吊销此会话
            </Button>
          </div>
        </div>
      ))}
      {sessions.length > 1 && (
        <Button size="small" variant="gray" onClick={() => revokeOthers()}>
          吊销除当前外的全部会话
        </Button>
      )}
      {confirmNode}
    </>
  );
}

export default function Account() {
  const { user, post, send, toast, refreshAuth } = useApp();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [blocking, setBlocking] = useState<Array<{ id: string; name: string }>>([]);

  const load = useCallback(async () => {
    try {
      const a = await fetchAccount();
      setAccount(a);
      setDisplayName(a.displayName);
    } catch {
      /* 拉取失败不阻断 */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!user) return null;

  async function saveProfile() {
    if (!displayName.trim()) return toast('显示名必填');
    try {
      await send('PUT', '/api/account/profile', { displayName: displayName.trim() });
    } catch {
      return;
    }
    toast('资料已保存');
    await refreshAuth();
    void load();
  }

  async function changePassword() {
    try {
      await post('/api/auth/change-password', { currentPassword: curPw, newPassword: newPw });
    } catch {
      return;
    }
    setCurPw('');
    setNewPw('');
    toast('密码已修改，其他会话已下线');
  }

  async function submitDelete() {
    setDelBusy(true);
    try {
      const r = await fetch('/api/account/delete-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: delPw }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        deletionAt?: string;
        error?: { message?: string };
        blockingWorkspaces?: Array<{ id: string; name: string }>;
      };
      if (!j.ok) {
        if (j.blockingWorkspaces && j.blockingWorkspaces.length > 0) {
          setBlocking(j.blockingWorkspaces);
          return;
        }
        toast(j.error?.message || '注销申请失败');
        return;
      }
      setDelOpen(false);
      toast(`注销申请已提交，冷静期至 ${j.deletionAt ? fmtTime(j.deletionAt) : ''}，期间登录可撤销`);
      await refreshAuth();
    } finally {
      setDelBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <h2>👤 账号设置 <span className="tag">资料与头像</span></h2>
        <AvatarUploader userId={user.id} onDone={() => void refreshAuth()} />
        <div style={{ marginTop: 12 }}>
          <Field label="邮箱">
            <div>
              {account?.email ?? user.email}{' '}
              <span className="hint">（邮箱验证：邮箱通道接入后可用）</span>
            </div>
          </Field>
          <Field label="显示名">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={50} />
          </Field>
          <Button size="small" variant="blue" onClick={() => void saveProfile()}>
            保存资料
          </Button>
        </div>
        <h3 style={{ marginTop: 16 }}>我名下的空间</h3>
        {account?.workspaces.map((w) => (
          <p className="hint" key={w.id}>
            · {w.name}（{w.role === 'owner' ? '所有者' : '成员'}）
          </p>
        ))}
        {account && account.workspaces.length === 0 && <p className="hint">暂未加入任何空间。</p>}
      </div>

      <div className="card">
        <h2>🔐 安全 <span className="tag">改密与登录会话</span></h2>
        <Field label="当前密码">
          <Input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} />
        </Field>
        <Field label="新密码（至少 10 位，含字母与数字）">
          <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </Field>
        <Button
          size="small"
          variant="blue"
          onClick={() => void changePassword()}
          disabled={!curPw || !newPw}
        >
          修改密码
        </Button>
        <SessionsCard />
      </div>

      <div className="card">
        <h2>⚠️ 危险区 <span className="tag">注销账号</span></h2>
        <p className="hint">
          注销流程：提交申请后进入 7 天冷静期（期间登录可撤销）；到期后账号被匿名化，
          个人知识库与偏好将被物理删除。名下仍有自己拥有的空间时无法申请——请先在
          空间设置里转让所有权或删除空间。平台管理员账号不可自助注销。
        </p>
        <div style={{ marginTop: 8 }}>
          <Button size="small" onClick={() => { setBlocking([]); setDelPw(''); setDelOpen(true); }}>
            申请注销账号
          </Button>
        </div>
      </div>

      <Dialog open={delOpen} onClose={() => setDelOpen(false)} title="确认注销账号">
        <p className="hint">
          提交后立即退出登录并进入 7 天冷静期；冷静期内重新登录可撤销注销。
          到期未撤销将匿名化账号并删除个人知识库与偏好，此操作不可恢复。
        </p>
        {blocking.length > 0 && (
          <p className="hint" style={{ marginTop: 8 }}>
            ⛔ 你还是这些空间的所有者，暂时无法注销：
            {blocking.map((w) => `「${w.name}」`).join('、')}。请先转让或删除这些空间。
          </p>
        )}
        <Field label="输入当前密码确认">
          <Input
            type="password"
            value={delPw}
            onChange={(e) => setDelPw(e.target.value)}
            placeholder="当前密码"
          />
        </Field>
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <Button onClick={() => void submitDelete()} disabled={!delPw || delBusy}>
            {delBusy ? '提交中…' : '验密并提交注销'}
          </Button>
          <Button variant="gray" onClick={() => setDelOpen(false)}>再想想</Button>
        </div>
      </Dialog>
    </>
  );
}

/** 冷静期落地页（G-11）：pending_deletion 登录后只达此页——撤销注销或退出登录，别无其他入口 */
export function PendingDeletionPage() {
  const { user, post, toast, refreshAuth } = useApp();
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  async function cancel() {
    setBusy(true);
    try {
      await post('/api/account/delete-cancel', {});
      toast('注销已撤销，账号恢复正常');
      await refreshAuth();
    } catch {
      /* post 已 toast */
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await post('/api/auth/logout', {});
    } catch {
      /* 忽略 */
    }
    await refreshAuth();
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h2>⏳ 注销待生效</h2>
        <p className="hint">
          你的账号已申请注销
          {user.deletionAt ? `，将于 ${fmtTime(user.deletionAt)} 正式注销` : ''}。
          冷静期内账号功能已停用；到期后账号将被匿名化，个人知识库与偏好会被物理删除。
        </p>
        <p className="hint">如果这不是你本人的操作，请立即撤销注销并修改密码。</p>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="green" onClick={() => void cancel()} disabled={busy}>
            撤销注销，继续使用
          </Button>
          <Button variant="gray" onClick={() => void logout()}>
            退出登录
          </Button>
        </div>
      </div>
    </div>
  );
}
