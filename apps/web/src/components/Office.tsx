import { useEffect, useState } from 'react';
import { useApp } from '../context';
import PixelOffice from './PixelOffice';
import { CapabilitiesShelf, OnboardingCard } from './Onboarding';
import { VisitLinksCard } from './Settings';
import { Button, Input, Textarea } from './ui';

function MemberEditor({ memberId, onClose }: { memberId: string; onClose: () => void }) {
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
    <div className="card" style={{ marginTop: 10 }}>
      <h2>成员档案：{m.name}（{m.role}）</h2>
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

export default function Office() {
  const { S, setTab } = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!S) return null;
  // v1.1.0 移动端任务状态摘要：计数直接由 S.tasks 按状态过滤（状态值见 shared 状态机），无现成聚合字段
  const running = S.tasks.filter((t) => t.status === '执行中').length;
  const reviewing = S.tasks.filter((t) => t.status === '待审核').length;
  const adjudicating = S.tasks.filter((t) => t.status === '待裁决').length;
  const goTaskWall = () => {
    document.getElementById('taskwall-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <>
      {/* G-02：新手三步卡（顶部）+ 能力货架（画布下方新区块，画布本身不碰） */}
      <OnboardingCard />
      <div className="card office-card">
      <h2>
        🐝 办公室实况{' '}
        <span className="tag">像素办公室 · 小人状态由真实任务驱动 · 点小人可改他的专属提示词</span>
      </h2>
      <PixelOffice onEdit={setEditingId} />
      {/* 移动端专属（CSS 控制显隐，桌面不显示）：画布下方任务状态摘要条，点击滚到本页任务墙区块 */}
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
      {editingId && <MemberEditor memberId={editingId} onClose={() => setEditingId(null)} />}
      </div>
      {/* G-10 办公室入口：跳定时任务页（画布外的普通区块，不碰 PixelOffice） */}
      <div className="card">
        <h2>⏰ 定时任务 <span className="tag">每天/每周到点自动发单，和手动发单走同一条路径</span></h2>
        <p className="hint">把重复的活设成计划，到点自动进任务墙（平台运行期间生效）。</p>
        <div style={{ marginTop: 8 }}>
          <Button size="small" onClick={() => setTab('schedules')}>去定时任务页</Button>
        </div>
      </div>
      <CapabilitiesShelf />
      {/* G-13：参观链接管理卡（与设置页同一组件）：把办公室门面分享给外部看 */}
      <VisitLinksCard />
    </>
  );
}
