import { AppProvider, useApp } from './context';
import Office from './components/Office';
import PublishForm from './components/PublishForm';
import Standards from './components/Standards';
import TaskWall from './components/TaskWall';
import Results from './components/Results';
import CostCenter from './components/CostCenter';
import Settings from './components/Settings';
import type { TabKey } from './types';

function Shell() {
  const { S, tab, setTab } = useApp();
  const usable = S?.apis.some((a) => a.hasKey);

  const navBtn = (t: TabKey, label: string) => (
    <button className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>
  );

  return (
    <>
      <header>
        <span className="logo">MJ 蜂群</span>
        <div>
          <h1>干活蜂群 · 本地版</h1>
          <div className="sub">真干活的 AI 办公室 · 数据全部存在本机 data/ 目录 · Key 只存本地</div>
        </div>
        <nav>
          {navBtn('office', '办公室')}
          {navBtn('cost', '成本中心')}
          {navBtn('settings', '设置后台')}
        </nav>
      </header>

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
            <TaskWall />
            <Results />
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
      </main>
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
