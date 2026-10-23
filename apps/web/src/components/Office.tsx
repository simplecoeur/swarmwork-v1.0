import { useEffect, useState } from 'react';
import { useApp } from '../context';
import PixelOffice from './PixelOffice';
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
  const { S } = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!S) return null;
  return (
    <div className="card office-card">
      <h2>
        🐝 办公室实况{' '}
        <span className="tag">像素办公室 · 小人状态由真实任务驱动 · 点小人可改他的专属提示词</span>
      </h2>
      <PixelOffice onEdit={setEditingId} />
      {editingId && <MemberEditor memberId={editingId} onClose={() => setEditingId(null)} />}
    </div>
  );
}
