import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppProvider, useApp, type ActiveDialog } from './context';
import Office from './components/Office';
import { MemberEditor } from './components/Office';
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
import StylePanel from './components/StylePanel';
import TalentLibrary from './components/TalentLibrary';
import MessagesPanel from './components/Messages';
import ResourceCenter from './components/ResourceCenter';
import { AuthGate, ChangePasswordGate } from './components/AuthGate';
import { Button, Card, Dialog, DropdownMenu, Select, Spinner } from './components/ui';
import type { TabKey } from './types';

/* ---------- v1.3.0 E：Hash 深链（弹窗 ↔ location.hash 双向同步；独立页不走 hash） ---------- */

function hashForDialog(d: ActiveDialog | null): string {
  if (!d) return '#/';
  switch (d.name) {
    case 'publish': return '#/publish';
    case 'tasks':
      if (d.section === 'projects') return '#/projects';
      if (d.section === 'results') return '#/results';
      return '#/tasks';
    case 'skills': return '#/skills';
    case 'assets': return '#/assets';
    case 'kb': return '#/kb';
    case 'cost': return '#/cost';
    case 'schedules': return '#/schedules';
    case 'settings': return '#/settings';
    case 'style': return '#/style';
    case 'talents': return '#/talents';
    case 'resources': return '#/resources';
    case 'messages': return '#/messages';
    case 'member': return `#/member/${encodeURIComponent(d.memberId ?? '')}`;
  }
}

function parseHash(hash: string): ActiveDialog | null {
  const h = hash.replace(/^#\/?/, '');
  if (!h) return null;
  if (h === 'publish') return { name: 'publish' };
  if (h === 'tasks') return { name: 'tasks', section: 'taskwall' };
  if (h === 'projects') return { name: 'tasks', section: 'projects' };
  if (h === 'results') return { name: 'tasks', section: 'results' };
  if (h === 'skills') return { name: 'skills' };
  if (h === 'assets') return { name: 'assets' };
  if (h === 'kb') return { name: 'kb' };
  if (h === 'cost') return { name: 'cost' };
  if (h === 'schedules') return { name: 'schedules' };
  if (h === 'settings') return { name: 'settings' };
  if (h === 'style') return { name: 'style' };
  if (h === 'talents') return { name: 'talents' };
  if (h === 'resources') return { name: 'resources' };
  if (h === 'messages') return { name: 'messages' };
  if (h.startsWith('member/')) {
    const id = decodeURIComponent(h.slice('member/'.length));
    return id ? { name: 'member', memberId: id } : null;
  }
  return null;
}

function sameDialog(a: ActiveDialog | null, b: ActiveDialog | null): boolean {
  if (!a || !b) return a === b;
  return a.name === b.name && a.memberId === b.memberId && a.section === b.section;
}

/** 大弹窗（sheet 变体）：ui Dialog 打底，.sheet-content 皮肤在 styles.css（桌面大窗、移动全屏、内部纵向滚动） */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog open onClose={onClose} title={title}>
      <div className="sheet-content">
        <div className="sheet-body">{children}</div>
      </div>
    </Dialog>
  );
}

/** tasks 弹窗：项目 + 任务墙 + 成果库依次堆叠，section 打开后滚动到对应锚点 */
function TasksSheetBody({ section }: { section?: ActiveDialog['section'] }) {
  useEffect(() => {
    const anchor =
      section === 'projects' ? 'projects-anchor' : section === 'results' ? 'results-anchor' : 'taskwall-anchor';
    const t = window.setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
    }, 50);
    return () => window.clearTimeout(t);
  }, [section]);
  return (
    <>
      <div id="projects-anchor">
        <Projects />
      </div>
      <div id="taskwall-anchor">
        <TaskWall />
      </div>
      <div id="results-anchor">
        <Results />
      </div>
    </>
  );
}

function Shell() {
  const {
    S, tab, setTab,
    authStatus, user, workspaces, currentWorkspace, impersonation,
    switchWorkspace, logout, toast, post, refresh, refreshAuth,
    dialog, openDialog, closeDialog,
  } = useApp();
  const [showNewWs, setShowNewWs] = useState(false);
  // G-05 全站反馈弹窗 / G-03 移动端通知中心（全屏）
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  // G-09 全局搜索：结果页关键词（顶栏搜索回车进入）
  const [searchQuery, setSearchQuery] = useState('');

  /* ----- Hash 深链：dialog → hash（写入时置抑制旗，避免 hashchange 回环） ----- */
  const suppressHashRef = useRef(false);
  // 冷开修复（v1.3.0 验收发现）：初始 hash 必须先被 hash→dialog 应用一次，
  // 否则 dialog=null 的首轮写入会把 #/skills 等深链冲成 #/（两 effect 同批执行的竞态）。
  const hashInitRef = useRef(false);
  const dialogRef = useRef<ActiveDialog | null>(null);
  dialogRef.current = dialog;
  useEffect(() => {
    if (authStatus !== 'authed') return;
    if (!hashInitRef.current) return;
    const target = hashForDialog(dialog);
    if (window.location.hash !== target) {
      suppressHashRef.current = true;
      window.location.hash = target;
    }
  }, [dialog, authStatus]);
  /* ----- Hash 深链：hash → dialog（初始加载 + hashchange，如浏览器前进/后退/外部改链） ----- */
  useEffect(() => {
    if (authStatus !== 'authed') return;
    const apply = () => {
      if (suppressHashRef.current) {
        suppressHashRef.current = false;
        return;
      }
      const parsed = parseHash(window.location.hash);
      if (!sameDialog(parsed, dialogRef.current)) {
        if (parsed) openDialog(parsed.name, { memberId: parsed.memberId, section: parsed.section });
        else closeDialog();
      }
      hashInitRef.current = true;
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [authStatus, openDialog, closeDialog]);

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

  /* v1.3.0 E：主场景恒为办公室；独立页只有 office/admin/help/account/search（tab），其余功能全走弹窗 */
  const goPage = (t: TabKey) => {
    closeDialog();
    setTab(t);
  };
  const navBtn = (t: TabKey, label: string) => (
    <Button variant="nav" className={tab === t && !dialog ? 'on' : ''} onClick={() => goPage(t)}>{label}</Button>
  );

  const goOfficeTop = () => {
    closeDialog();
    setTab('office');
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 80);
  };
  const moreActive =
    dialog?.name === 'assets' || dialog?.name === 'kb' || dialog?.name === 'cost' ||
    dialog?.name === 'schedules' || dialog?.name === 'settings' ||
    tab === 'admin' || tab === 'help' || tab === 'account';

  /* G-09 搜索命中跳转：按类型落到对应弹窗/独立页 */
  const goSearchItem = (item: SearchItem) => {
    setTab('office');
    if (item.type === 'task') {
      openDialog('tasks', { section: 'taskwall' });
      window.setTimeout(() => {
        document.getElementById(`task-${item.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 220);
    } else if (item.type === 'result') openDialog('tasks', { section: 'results' });
    else if (item.type === 'project') openDialog('tasks', { section: 'projects' });
    else if (item.type === 'kb') openDialog('kb');
    else if (item.type === 'asset') openDialog('assets');
    else if (item.type === 'skill') openDialog('skills');
    else if (item.type === 'talent') openDialog('talents');
  };
  const showSearchResults = (q: string) => {
    setSearchQuery(q);
    goPage('search');
  };

  /* G-14 退出代入：清 session 代入态并切回管理员默认空间，随后整页刷新登录态与数据 */
  async function exitImpersonation() {
    try {
      await post('/api/admin/impersonate/stop');
    } catch { return; }
    toast('已退出代入查看');
    await refreshAuth();
    await refresh();
  }

  async function onSwitch(id: string) {
    if (!id || id === currentWorkspace?.id) return;
    try {
      await switchWorkspace(id);
      toast('已切换空间');
    } catch (e) {
      toast('切换失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const sheetTitle: Record<Exclude<ActiveDialog['name'], 'member'>, string> = {
    publish: '发单',
    tasks: '任务',
    skills: '技能',
    assets: '资产库',
    kb: '知识库',
    cost: '成本中心',
    schedules: '定时任务',
    settings: '设置后台',
    style: '装修',
    talents: '人才库',
    resources: '资源中心',
    messages: '平台消息',
  };

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
              { label: '👤 账号设置', onSelect: () => goPage('account') },
              { label: '＋ 开新公司', onSelect: () => setShowNewWs(true) },
              { label: '❓ 帮助中心', onSelect: () => goPage('help') },
              { label: '✉️ 意见反馈', onSelect: () => setFeedbackOpen(true) },
              { label: '退出登录', onSelect: () => void logout() },
            ]}
          />
        </div>
      </header>

      {showNewWs && <NewWorkspaceModal onClose={() => setShowNewWs(false)} />}
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      <NotificationCenterDialog open={notifOpen} onClose={() => setNotifOpen(false)} />

      {impersonation && (
        <div className="banner-impersonation" role="alert">
          <span>
            <b>平台管理员代入查看中（只读）</b> · 正在查看空间「{impersonation.workspaceName}」
            （所有者 {impersonation.ownerEmail}），写操作已被禁用；该空间既存任务照常运行，不受代入影响。
          </span>
          <Button size="small" variant="gray" onClick={() => void exitImpersonation()}>退出代入</Button>
        </div>
      )}

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
              </section>
            )}
            {tab === 'account' && (
              <section>
                <Account />
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

          {/* v1.3.0 E 功能弹窗层：内容组件自身逻辑零改动，整体搬进 sheet */}
          {dialog?.name === 'publish' && (
            <Sheet title={sheetTitle.publish} onClose={closeDialog}>
              <PublishForm />
              <Standards />
            </Sheet>
          )}
          {dialog?.name === 'tasks' && (
            <Sheet title={sheetTitle.tasks} onClose={closeDialog}>
              <TasksSheetBody section={dialog.section} />
            </Sheet>
          )}
          {dialog?.name === 'skills' && (
            <Sheet title={sheetTitle.skills} onClose={closeDialog}>
              <Skills />
            </Sheet>
          )}
          {dialog?.name === 'assets' && (
            <Sheet title={sheetTitle.assets} onClose={closeDialog}>
              <Assets />
            </Sheet>
          )}
          {dialog?.name === 'kb' && (
            <Sheet title={sheetTitle.kb} onClose={closeDialog}>
              <KnowledgeBase />
            </Sheet>
          )}
          {dialog?.name === 'cost' && (
            <Sheet title={sheetTitle.cost} onClose={closeDialog}>
              <CostCenter />
            </Sheet>
          )}
          {dialog?.name === 'schedules' && (
            <Sheet title={sheetTitle.schedules} onClose={closeDialog}>
              <Schedules />
            </Sheet>
          )}
          {dialog?.name === 'settings' && (
            <Sheet title={sheetTitle.settings} onClose={closeDialog}>
              <Settings />
            </Sheet>
          )}
          {dialog?.name === 'style' && (
            <Sheet title={sheetTitle.style} onClose={closeDialog}>
              <StylePanel />
            </Sheet>
          )}
          {dialog?.name === 'talents' && (
            <Sheet title={sheetTitle.talents} onClose={closeDialog}>
              <TalentLibrary />
            </Sheet>
          )}
          {dialog?.name === 'messages' && (
            <Sheet title={sheetTitle.messages} onClose={closeDialog}>
              <MessagesPanel />
            </Sheet>
          )}
          {dialog?.name === 'resources' && (
            <Sheet title={sheetTitle.resources} onClose={closeDialog}>
              <ResourceCenter />
            </Sheet>
          )}
          {dialog?.name === 'member' && dialog.memberId && (
            <Dialog open onClose={closeDialog} title="成员档案">
              <MemberEditor memberId={dialog.memberId} onClose={closeDialog} />
            </Dialog>
          )}
        </>
      )}

      {/* v1.3.0 F：办公室场景悬浮「装修」按钮（无弹窗打开时才显示；移动端抬到底部导航之上） */}
      {currentWorkspace && tab === 'office' && !dialog && (
        <button type="button" className="style-fab" onClick={() => openDialog('style')}>
          🎨 装修
        </button>
      )}

      {/* v1.1.0/v1.3.0 移动端底部固定栏（≤768px 才显示）：办公室/发单/任务墙/技能/更多 */}
      {currentWorkspace && (
        <div className="bottomnav" role="navigation" aria-label="移动端主导航">
          <button
            type="button"
            className={`bottomnav-item${tab === 'office' && !dialog && !moreActive ? ' on' : ''}`}
            onClick={goOfficeTop}
          >
            办公室
          </button>
          <button
            type="button"
            className={`bottomnav-item${dialog?.name === 'publish' ? ' on' : ''}`}
            onClick={() => openDialog('publish')}
          >
            发单
          </button>
          <button
            type="button"
            className={`bottomnav-item${dialog?.name === 'tasks' ? ' on' : ''}`}
            onClick={() => openDialog('tasks', { section: 'taskwall' })}
          >
            任务墙
          </button>
          <button
            type="button"
            className={`bottomnav-item${dialog?.name === 'skills' ? ' on' : ''}`}
            onClick={() => openDialog('skills')}
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
              { label: '项目', onSelect: () => openDialog('tasks', { section: 'projects' }) },
              { label: '成果库', onSelect: () => openDialog('tasks', { section: 'results' }) },
              { label: '定时任务', onSelect: () => openDialog('schedules') },
              { label: '资产库', onSelect: () => openDialog('assets') },
              { label: '知识库', onSelect: () => openDialog('kb') },
              { label: '成本中心', onSelect: () => openDialog('cost') },
              { label: '设置后台', onSelect: () => openDialog('settings') },
              { label: '账号设置', onSelect: () => goPage('account') },
              { label: '帮助中心', onSelect: () => goPage('help') },
              { label: '意见反馈', onSelect: () => setFeedbackOpen(true) },
              ...(user?.isPlatformAdmin
                ? [{ label: '管理台', onSelect: () => goPage('admin') }]
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
