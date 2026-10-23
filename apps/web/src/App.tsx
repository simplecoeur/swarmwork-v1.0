import { useState } from 'react';
import { AppProvider, useApp } from './context';
import Office from './components/Office';
import PublishForm from './components/PublishForm';
import Projects from './components/Projects';
import Standards from './components/Standards';
import TaskWall from './components/TaskWall';
import Results from './components/Results';
import CostCenter from './components/CostCenter';
import KnowledgeBase from './components/KnowledgeBase';
import Settings from './components/Settings';
import Admin from './components/Admin';
import Skills from './components/Skills';
import Assets from './components/Assets';
import NotificationBell from './components/NotificationBell';
import NewWorkspaceModal from './components/NewWorkspace';
import { AuthGate, ChangePasswordGate } from './components/AuthGate';
import { Button, Card, DropdownMenu, Select, Spinner } from './components/ui';
import type { TabKey } from './types';

function Shell() {
  const {
    S, tab, setTab,
    authStatus, user, workspaces, currentWorkspace, switchWorkspace, logout, toast,
  } = useApp();
  const [showNewWs, setShowNewWs] = useState(false);

  // 鉴权门（M6）：探活中 / 未登录 / 强制改密，三种状态都不渲染主界面
  if (authStatus === 'loading') {
    return (
      <div className="auth-wrap">
        <Card>
          <p style={{ textAlign: 'center' }}>
            <Spinner label="正在确认登录状态…" />
          </p>
        </Card>
      </div>
    );
  }
  if (authStatus === 'anon') return <AuthGate />;
  if (user?.mustChangePassword) return <ChangePasswordGate />;

  const usable = S?.apis.some((a) => a.hasKey);
  const wsName = currentWorkspace?.name ?? S?.workspace?.name ?? '';

  const navBtn = (t: TabKey, label: string) => (
    <Button variant="nav" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</Button>
  );

  async function onSwitch(id: string) {
    if (!id || id === currentWorkspace?.id) return;
    try {
      await switchWorkspace(id);
      toast('已切换空间');
    } catch (e) {
      toast('切换失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <>
      <header>
        <span className="logo">🐝 干活蜂群</span>
        <div>
          <h1>干活蜂群{wsName ? ` · ${wsName}` : ''}</h1>
          <div className="sub">真干活的 AI 办公室 · 数据存储在服务器 · Key 加密保存</div>
        </div>
        <div className="wsbar">
          <Select
            value={currentWorkspace?.id ?? ''}
            onValueChange={onSwitch}
            title="切换空间（公司）"
            ariaLabel="切换空间（公司）"
            placeholder="（暂无空间）"
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
          <Button variant="mini" onClick={() => setShowNewWs(true)}>＋开新公司</Button>
        </div>
        <nav>
          {navBtn('office', '办公室')}
          {navBtn('skills', '技能')}
          {navBtn('assets', '资产库')}
          {navBtn('kb', '知识库')}
          {navBtn('cost', '成本中心')}
          {navBtn('settings', '设置后台')}
          {user?.isPlatformAdmin && navBtn('admin', '管理台')}
        </nav>
        <NotificationBell />
        <div className="userinfo">
          <DropdownMenu
            ariaLabel="账号菜单"
            trigger={
              <Button variant="mini">
                {user?.displayName}（{user?.email}）{user?.isPlatformAdmin ? ' · 平台管理员' : ''} ▾
              </Button>
            }
            items={[
              { label: '＋ 开新公司', onSelect: () => setShowNewWs(true) },
              { label: '退出登录', onSelect: () => void logout() },
            ]}
          />
        </div>
      </header>

      {showNewWs && <NewWorkspaceModal onClose={() => setShowNewWs(false)} />}

      {!currentWorkspace ? (
        <main>
          <div className="card">
            <h2>还没有公司空间</h2>
            <p className="hint">
              你的账号还没有加入任何空间。开一家新公司（选个行业包开局），就能进办公室给 AI 团队派活了。
            </p>
            <div style={{ marginTop: 10 }}>
              <Button onClick={() => setShowNewWs(true)}>＋ 开新公司</Button>
            </div>
          </div>
        </main>
      ) : (
        <>
          {S && !usable && (
            <div className="banner">
              <b>还没有可用的 API：</b>请先到「设置后台」给至少一条 API 填上 Key，并到「成本中心」采购充值（余额大于 0 才能开工）。在此之前发布的任务会停在待分配。
            </div>
          )}

          <main>
            {tab === 'office' && (
              <section>
                <Office />
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <PublishForm />
                  <Standards />
                </div>
                <Projects />
                <TaskWall />
                <Results />
              </section>
            )}
            {tab === 'skills' && (
              <section>
                <Skills />
              </section>
            )}
            {tab === 'assets' && (
              <section>
                <Assets />
              </section>
            )}
            {tab === 'kb' && (
              <section>
                <KnowledgeBase />
              </section>
            )}
            {tab === 'cost' && (
              <section>
                <CostCenter />
              </section>
            )}
            {tab === 'settings' && (
              <section>
                <Settings />
              </section>
            )}
            {tab === 'admin' && user?.isPlatformAdmin && (
              <section>
                <Admin />
              </section>
            )}
          </main>
        </>
      )}
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
