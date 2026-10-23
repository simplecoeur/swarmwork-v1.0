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
import Schedules from './components/Schedules';
import Account, { PendingDeletionPage } from './components/Account';
import Assets from './components/Assets';
import HelpCenter from './components/HelpCenter';
import { GlobalSearch, SearchResultsPage } from './components/GlobalSearch';
import type { SearchItem } from './types';
import FeedbackDialog from './components/FeedbackDialog';
import NotificationBell, { NotificationCenterDialog } from './components/NotificationBell';
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
  // G-05 全站反馈弹窗 / G-03 移动端通知中心（全屏）
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  // v1.1.0 移动端底部栏高亮：office tab 内含办公室/发单/任务墙三段，用它区分当前落点
  const [mNav, setMNav] = useState<'office' | 'publish' | 'tasks'>('office');
  // G-09 全局搜索：结果页关键词（顶栏搜索回车进入）
  const [searchQuery, setSearchQuery] = useState('');

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
  /* G-11：注销冷静期账号登录后只达「注销待生效」页（服务端 onRequest 同口径收口） */
  if (user?.status === 'pending_deletion') return <PendingDeletionPage />;

  const usable = S?.apis.some((a) => a.hasKey);
  const wsName = currentWorkspace?.name ?? S?.workspace?.name ?? '';

  const navBtn = (t: TabKey, label: string) => (
    <Button variant="nav" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</Button>
  );

  /* v1.1.0 移动端导航：TabKey 只有 7 个，发单(PublishForm)/任务墙/项目/成果库都是 office 页内区块，
     故底部栏这几项 = 切到 office tab + 滚动到区块锚点（锚点见下方 office section）。 */
  const scrollToAnchor = (id: string) => {
    window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  };
  const goOfficeTop = () => {
    setMNav('office');
    setTab('office');
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 80);
  };
  const goOfficeSection = (key: 'publish' | 'tasks', anchor: string) => {
    setMNav(key);
    setTab('office');
    scrollToAnchor(anchor);
  };
  const goMoreSection = (anchor: string) => {
    // 成果库/项目同为 office 页内区块：从「更多」进入后高亮回落到办公室段
    setMNav('office');
    setTab('office');
    scrollToAnchor(anchor);
  };
  const moreActive =
    tab === 'assets' || tab === 'kb' || tab === 'cost' || tab === 'settings' || tab === 'admin' || tab === 'help' || tab === 'schedules' || tab === 'account';

  /* G-09 搜索命中跳转：按类型落到对应页面/区块 */
  const goSearchItem = (item: SearchItem) => {
    if (item.type === 'task') goOfficeSection('tasks', 'taskwall-anchor');
    else if (item.type === 'result') goMoreSection('results-anchor');
    else if (item.type === 'project') goMoreSection('projects-anchor');
    else if (item.type === 'kb') setTab('kb');
    else if (item.type === 'asset') setTab('assets');
    else if (item.type === 'skill') setTab('skills');
  };
  const showSearchResults = (q: string) => {
    setSearchQuery(q);
    setTab('search');
  };

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
        <div className="brand-block">
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
        <GlobalSearch onShowResults={showSearchResults} onNavigate={goSearchItem} />
        <nav>
          {navBtn('office', '办公室')}
          {navBtn('skills', '技能')}
          {navBtn('schedules', '定时任务')}
          {navBtn('assets', '资产库')}
          {navBtn('kb', '知识库')}
          {navBtn('cost', '成本中心')}
          {navBtn('settings', '设置后台')}
          {navBtn('help', '帮助')}
          {user?.isPlatformAdmin && navBtn('admin', '管理台')}
        </nav>
        <NotificationBell />
        <div className="userinfo">
          <DropdownMenu
            ariaLabel="账号菜单"
            trigger={
              <Button variant="mini">
                {user && (
                  <img
                    className="avatar-img"
                    src={`/api/users/${user.id}/avatar`}
                    alt=""
                    style={{ marginRight: 6 }}
                  />
                )}
                {user?.displayName}（{user?.email}）{user?.isPlatformAdmin ? ' · 平台管理员' : ''} ▾
              </Button>
            }
            items={[
              { label: '👤 账号设置', onSelect: () => setTab('account') },
              { label: '＋ 开新公司', onSelect: () => setShowNewWs(true) },
              { label: '❓ 帮助中心', onSelect: () => setTab('help') },
              { label: '✉️ 意见反馈', onSelect: () => setFeedbackOpen(true) },
              { label: '退出登录', onSelect: () => void logout() },
            ]}
          />
        </div>
      </header>

      {showNewWs && <NewWorkspaceModal onClose={() => setShowNewWs(false)} />}
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      <NotificationCenterDialog open={notifOpen} onClose={() => setNotifOpen(false)} />

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
                <div className="row" id="publish-anchor" style={{ alignItems: 'flex-start' }}>
                  <PublishForm />
                  <Standards />
                </div>
                <div id="projects-anchor">
                  <Projects />
                </div>
                <div id="taskwall-anchor">
                  <TaskWall />
                </div>
                <div id="results-anchor">
                  <Results />
                </div>
              </section>
            )}
            {tab === 'skills' && (
              <section>
                <Skills />
              </section>
            )}
            {tab === 'schedules' && (
              <section>
                <Schedules />
              </section>
            )}
            {tab === 'account' && (
              <section>
                <Account />
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
            {tab === 'help' && (
              <section>
                <HelpCenter />
              </section>
            )}
            {tab === 'search' && (
              <section>
                <SearchResultsPage query={searchQuery} onNavigate={goSearchItem} />
              </section>
            )}
          </main>
        </>
      )}

      {/* v1.1.0 移动端底部固定栏（≤768px 才显示，桌面隐藏）：办公室/发单/任务墙/技能/更多 */}
      {currentWorkspace && (
        <div className="bottomnav" role="navigation" aria-label="移动端主导航">
          <button
            type="button"
            className={`bottomnav-item${tab === 'office' && mNav === 'office' && !moreActive ? ' on' : ''}`}
            onClick={goOfficeTop}
          >
            办公室
          </button>
          <button
            type="button"
            className={`bottomnav-item${tab === 'office' && mNav === 'publish' ? ' on' : ''}`}
            onClick={() => goOfficeSection('publish', 'publish-anchor')}
          >
            发单
          </button>
          <button
            type="button"
            className={`bottomnav-item${tab === 'office' && mNav === 'tasks' ? ' on' : ''}`}
            onClick={() => goOfficeSection('tasks', 'taskwall-anchor')}
          >
            任务墙
          </button>
          <button
            type="button"
            className={`bottomnav-item${tab === 'skills' ? ' on' : ''}`}
            onClick={() => setTab('skills')}
          >
            技能
          </button>
          <DropdownMenu
            ariaLabel="更多页面"
            align="end"
            trigger={
              <Button variant="mini" className={`bottomnav-item${moreActive ? ' on' : ''}`}>
                更多 ▾
              </Button>
            }
            items={[
              { label: '通知中心', onSelect: () => setNotifOpen(true) },
              { label: '定时任务', onSelect: () => setTab('schedules') },
              { label: '资产库', onSelect: () => setTab('assets') },
              { label: '知识库', onSelect: () => setTab('kb') },
              { label: '成本中心', onSelect: () => setTab('cost') },
              { label: '成果库', onSelect: () => goMoreSection('results-anchor') },
              { label: '项目', onSelect: () => goMoreSection('projects-anchor') },
              { label: '设置后台', onSelect: () => setTab('settings') },
              { label: '帮助中心', onSelect: () => setTab('help') },
              { label: '意见反馈', onSelect: () => setFeedbackOpen(true) },
              ...(user?.isPlatformAdmin
                ? [{ label: '管理台', onSelect: () => setTab('admin') }]
                : []),
            ]}
          />
        </div>
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
