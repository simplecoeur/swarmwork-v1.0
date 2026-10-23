import { useEffect, useState } from 'react';
import { useApp } from '../context';
import PixelOffice from './PixelOffice';
import CheckinCard from './CheckinCard';
import BriefingCard from './BriefingCard';
import { CapabilitiesShelf, OnboardingCard } from './Onboarding';
import { VisitLinksCard } from './Settings';
import { yuan } from '../utils';
import { Button, Input, Textarea } from './ui';

/** 成员档案编辑器（v1.3.0 起由 App 的 member 弹窗承载，Office 画布点小人 → openDialog('member')） */
export function MemberEditor({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const { S, post, refresh, toast } = useApp();
  const m = S?.members.find((x) => x.id === memberId);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  // 打开编辑器时把该成员的现有名字/提示词灌进表单（与原生版点击时渲染表单一致）
  useEffect(() => {
    if (m) {
      setName(m.name);
      setPrompt(m.prompt || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  if (!S || !m) return null;

  async function save() {
    try {
      await post('/api/members/prompt', { memberId, name, prompt });
    } catch { return; }
    onClose();
    toast('成员已更新');
    refresh();
  }

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        {m.name}（{m.role}）
      </p>
      <label>名字</label>
      <Input value={name} onChange={(e) => setName(e.target.value)} />
      <label>专属提示词（只对这个成员生效，会拼进他的干活指令）</label>
      <Textarea
        rows={3}
        placeholder="如：文风幽默搞笑，标题爱用反问句……"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="blue" onClick={save}>保存</Button>{' '}
        <Button size="small" variant="gray" onClick={onClose}>关闭</Button>
      </div>
    </div>
  );
}

/** 实况状态栏（v1.3.0 E）：余额/进行中/待审核/待裁决全部取真实 state（S.apis / S.tasks） */
function LiveStatusBar() {
  const { S, openDialog } = useApp();
  if (!S) return null;
  const balance = S.apis.reduce((sum, a) => sum + (a.balanceYuan || 0), 0);
  const running = S.tasks.filter((t) => t.status === '执行中').length;
  const reviewing = S.tasks.filter((t) => t.status === '待审核').length;
  const adjudicating = S.tasks.filter((t) => t.status === '待裁决').length;
  const goTasks = () => openDialog('tasks', { section: 'taskwall' });
  return (
    <div className="shell-livebar" role="status" aria-label="办公室实况">
      <button type="button" className="shell-live-item" onClick={() => openDialog('cost')}>
        <span>余额</span>
        <b>{yuan(balance)}</b>
      </button>
      <button type="button" className="shell-live-item" onClick={goTasks}>
        <span>进行中</span>
        <b>{running}</b>
      </button>
      <button type="button" className="shell-live-item" onClick={goTasks}>
        <span>待审核</span>
        <b>{reviewing}</b>
      </button>
      <button type="button" className="shell-live-item" onClick={goTasks}>
        <span>待裁决</span>
        <b>{adjudicating}</b>
      </button>
    </div>
  );
}

/** 功能坞（v1.3.0 E）：全部功能改走弹窗，项目/成果库走 tasks 弹窗对应 section */
function Dock() {
  const { openDialog } = useApp();
  const items: Array<{ label: string; icon: string; onClick: () => void }> = [
    { label: '发单', icon: '📝', onClick: () => openDialog('publish') },
    { label: '任务墙', icon: '📌', onClick: () => openDialog('tasks', { section: 'taskwall' }) },
    { label: '项目', icon: '🗂️', onClick: () => openDialog('tasks', { section: 'projects' }) },
    { label: '成果库', icon: '🏆', onClick: () => openDialog('tasks', { section: 'results' }) },
    { label: '技能', icon: '🧩', onClick: () => openDialog('skills') },
    { label: '资产库', icon: '🗄️', onClick: () => openDialog('assets') },
    { label: '知识库', icon: '📚', onClick: () => openDialog('kb') },
    { label: '成本', icon: '💰', onClick: () => openDialog('cost') },
    { label: '定时任务', icon: '⏰', onClick: () => openDialog('schedules') },
    { label: '设置', icon: '⚙️', onClick: () => openDialog('settings') },
  ];
  return (
    <div className="shell-dock" aria-label="功能坞">
      {items.map((it) => (
        <button key={it.label} type="button" className="shell-dock-btn" onClick={it.onClick}>
          <span aria-hidden="true">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** 快速发单条（v1.3.0 E）：一行大输入，回车/点按钮 → 预填 brief 并打开发单弹窗（不在此处直接发单） */
function QuickPublish() {
  const { openDialog, setPublishPrefill } = useApp();
  const [text, setText] = useState('');
  const go = () => {
    setPublishPrefill({ brief: text });
    setText('');
    openDialog('publish');
  };
  return (
    <div className="shell-quick">
      <Input
        className="shell-quick-input"
        placeholder="想让团队做什么？写一句，回车打开发单…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go();
        }}
        aria-label="快速发单"
      />
      <Button onClick={go}>发单</Button>
    </div>
  );
}

export default function Office() {
  const { S, openDialog } = useApp();
  if (!S) return null;
  // v1.1.0 移动端任务状态摘要：计数直接由 S.tasks 按状态过滤（状态值见 shared 状态机），无现成聚合字段
  const running = S.tasks.filter((t) => t.status === '执行中').length;
  const reviewing = S.tasks.filter((t) => t.status === '待审核').length;
  const adjudicating = S.tasks.filter((t) => t.status === '待裁决').length;
  const goTaskWall = () => openDialog('tasks', { section: 'taskwall' });
  return (
    <>
      {/* v1.3.0 E：实况状态栏 + 功能坞 + 快速发单条（办公室顶部中枢） */}
      <LiveStatusBar />
      <Dock />
      <QuickPublish />
      {/* v1.3.0 G：签到卡 + 晨报卡（实况栏之后、新手卡之前） */}
      <CheckinCard />
      <BriefingCard />
      {/* G-02：新手三步卡（顶部）+ 能力货架（画布下方新区块，画布本身不碰） */}
      <OnboardingCard />
      <div className="card office-card office-hero">
      <h2>
        🐝 办公室实况{' '}
        <span className="tag">像素办公室 · 小人状态由真实任务驱动 · 点小人可改他的专属提示词</span>
      </h2>
      <PixelOffice onEdit={(memberId) => openDialog('member', { memberId })} />
      {/* 移动端专属（CSS 控制显隐，桌面不显示）：画布下方任务状态摘要条，点击打开任务墙弹窗 */}
      <div className="mobile-summary">
        <button type="button" className="mobile-summary-item" onClick={goTaskWall}>
          进行中 <b>{running}</b>
        </button>
        <button type="button" className="mobile-summary-item" onClick={goTaskWall}>
          待审核 <b>{reviewing}</b>
        </button>
        <button type="button" className="mobile-summary-item" onClick={goTaskWall}>
          待裁决 <b>{adjudicating}</b>
        </button>
      </div>
      </div>
      {/* G-10 办公室入口：打开定时任务弹窗（画布外的普通区块，不碰 PixelOffice） */}
      <div className="card">
        <h2>⏰ 定时任务 <span className="tag">每天/每周到点自动发单，和手动发单走同一条路径</span></h2>
        <p className="hint">把重复的活设成计划，到点自动进任务墙（平台运行期间生效）。</p>
        <div style={{ marginTop: 8 }}>
          <Button size="small" onClick={() => openDialog('schedules')}>去定时任务</Button>
        </div>
      </div>
      <CapabilitiesShelf />
      {/* G-13：参观链接管理卡（与设置页同一组件）：把办公室门面分享给外部看 */}
      <VisitLinksCard />
    </>
  );
}
