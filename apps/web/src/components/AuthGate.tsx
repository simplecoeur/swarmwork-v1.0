import { useState } from 'react';
import { useApp } from '../context';
import { postRaw } from '../api';
import { Button, Field, Input, Tabs } from './ui';

/**
 * 鉴权门（M6）：未登录只见登录/注册页；mustChangePassword 时强制改密页。
 * 登录/注册失败把后端 message 原文红字展示（含账号锁定、待审核、已停用）。
 * v1.1.0：表单换自有组件层（Tabs 切换登录/注册、Field+Input+Button）。
 */
export function AuthGate() {
  const { login, refreshAuth, toast } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [err, setErr] = useState('');
  const [pendingMsg, setPendingMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function doLogin() {
    setErr('');
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRegister() {
    setErr('');
    setBusy(true);
    let res: Record<string, unknown>;
    try {
      res = await postRaw('/api/auth/register', {
        email: email.trim(),
        password,
        displayName: displayName.trim(),
        workspaceName: workspaceName.trim() || undefined,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (res.pending) {
      // 待审核：无会话，停在本页提示（行业包在管理员开通/登录后开公司时再选）
      setPendingMsg('已提交，等待管理员审核开通。开通后用刚才的邮箱密码登录即可。');
      return;
    }
    toast('注册成功，公司已开通');
    await refreshAuth(); // 即时开通：register 已下发会话 Cookie，拉 me 直达主界面
  }

  const emailField = (
    <Field label="邮箱">
      <Input
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
      />
    </Field>
  );

  return (
    <div className="auth-wrap">
      <div className="card">
        <div style={{ textAlign: 'center', marginBottom: 6 }}>
          <span className="logo-badge">🐝 干活蜂群</span>
          <h2 style={{ justifyContent: 'center', marginTop: 10 }}>
            {mode === 'login' ? '登录' : '注册新账号'}
          </h2>
          <p className="hint">一人公司老板台：登录后进入你的 AI 办公室。</p>
        </div>

        {pendingMsg ? (
          <>
            <p className="okmsg">{pendingMsg}</p>
            <div style={{ marginTop: 12 }}>
              <Button
                variant="gray"
                onClick={() => {
                  setPendingMsg('');
                  setMode('login');
                }}
              >
                回登录页
              </Button>
            </div>
          </>
        ) : (
          <Tabs
            value={mode}
            onValueChange={(v) => {
              setErr('');
              setMode(v as 'login' | 'register');
            }}
            ariaLabel="登录或注册"
            tabs={[
              {
                value: 'login',
                label: '登录',
                content: (
                  <>
                    {emailField}
                    <Field label="密码">
                      <Input
                        type="password"
                        placeholder="登录密码"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') doLogin();
                        }}
                      />
                    </Field>
                    {err && <p className="err">{err}</p>}
                    <div style={{ marginTop: 12 }}>
                      <Button style={{ width: '100%' }} onClick={doLogin} disabled={busy}>
                        {busy ? '登录中…' : '登录'}
                      </Button>
                    </div>
                  </>
                ),
              },
              {
                value: 'register',
                label: '注册新账号',
                content: (
                  <>
                    {emailField}
                    <Field label="密码">
                      <Input
                        type="password"
                        placeholder="至少 8 位"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </Field>
                    <Field label="显示名（你的称呼）">
                      <Input
                        placeholder="如：王老板"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                      />
                    </Field>
                    <Field label="空间名 / 公司名（选填，不填用「显示名 的空间」）">
                      <Input
                        placeholder="如：星尘短剧"
                        value={workspaceName}
                        onChange={(e) => setWorkspaceName(e.target.value)}
                      />
                    </Field>
                    <p className="hint">行业包不用现在选：开通后在顶栏「＋开新公司」里挑（短剧包等）。</p>
                    {err && <p className="err">{err}</p>}
                    <div style={{ marginTop: 12 }}>
                      <Button style={{ width: '100%' }} onClick={doRegister} disabled={busy}>
                        {busy ? '提交中…' : '注册'}
                      </Button>
                    </div>
                  </>
                ),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}

/** 强制改密页：管理员重置/初始密码登录后 mustChangePassword=true，改完才进主界面 */
export function ChangePasswordGate() {
  const { user, refreshAuth, logout, toast } = useApp();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr('');
    if (newPassword.length < 8) return setErr('新密码至少 8 位');
    setBusy(true);
    try {
      await postRaw('/api/auth/change-password', { currentPassword, newPassword });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    toast('密码已修改');
    await refreshAuth(); // mustChangePassword 已清零 → 进主界面
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h2>先修改初始密码</h2>
        <p className="hint">
          账号 {user?.email} 正在使用初始/临时密码，按平台规则改完密码才能继续使用。
        </p>
        <Field label="当前密码（初始/临时密码）">
          <Input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="新密码（至少 8 位）">
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </Field>
        {err && <p className="err">{err}</p>}
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Button onClick={submit} disabled={busy}>
            {busy ? '提交中…' : '改密并进入'}
          </Button>
          <Button variant="gray" onClick={logout}>退出登录</Button>
        </div>
      </div>
    </div>
  );
}
