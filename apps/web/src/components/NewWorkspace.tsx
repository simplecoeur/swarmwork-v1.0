import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchIndustryPacks } from '../api';
import { Button, Dialog, Input, RadioGroup, RadioItem } from './ui';
import type { IndustryPack } from '../types';

/** 行业包内容简述：从 manifest 里挑老板看得懂的几项（短剧包等都走这套通用口径） */
function packSummary(pack: IndustryPack): string {
  const c = pack.content ?? {};
  const parts: string[] = [];
  const kbSeeds = c.kb_seeds;
  if (Array.isArray(kbSeeds) && kbSeeds.length) parts.push(`预置知识库 ${kbSeeds.length} 条`);
  const roleExt = c.role_extensions;
  if (Array.isArray(roleExt) && roleExt.length) parts.push(`专属工种扩展 ${roleExt.length} 个`);
  else if (roleExt && typeof roleExt === 'object' && Object.keys(roleExt).length) {
    parts.push(`专属工种扩展 ${Object.keys(roleExt).length} 个`);
  }
  const skills = c.skill_slugs;
  if (Array.isArray(skills) && skills.length) parts.push(`配套技能 ${skills.length} 个`);
  if (c.company_template) parts.push('带公司模板（小组/成员开局即备）');
  return parts.join(' · ');
}

/** 「开新公司」弹窗：公司名 + 行业包单选；提交后服务端自动切换到新空间，前端 refresh 进新空间 */
export default function NewWorkspaceModal({ onClose }: { onClose: () => void }) {
  const { post, toast, refreshAuth, refresh } = useApp();
  const [name, setName] = useState('');
  const [packs, setPacks] = useState<IndustryPack[]>([]);
  const [packsLoaded, setPacksLoaded] = useState(false);
  const [packId, setPackId] = useState(''); // '' = 不选行业包（通用开局）
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchIndustryPacks()
      .then(setPacks)
      .catch(() => setPacks([]))
      .finally(() => setPacksLoaded(true));
  }, []);

  const selected = packs.find((p) => p.id === packId) ?? null;

  async function create() {
    if (!name.trim()) return toast('先填公司名');
    setBusy(true);
    try {
      await post('/api/workspaces', { name: name.trim(), industryPackId: packId || null });
    } catch {
      setBusy(false);
      return;
    }
    await refreshAuth();
    await refresh();
    toast('新公司已开通，已切换到新空间');
    onClose();
  }

  return (
    <Dialog open onClose={onClose} title="开新公司">
      <label>公司名（空间名）</label>
      <Input
        placeholder="如：星尘短剧"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <label>行业包（选一个，公司的工种/知识/模板按包开局；之后也能在设置里补）</label>
      <RadioGroup value={packId} onValueChange={setPackId} ariaLabel="行业包">
        <RadioItem value="" className="packopt">
          <b>不选行业包（通用开局）</b>
          <span className="hint" style={{ display: 'block' }}>白纸开局：只有系统通用工种，自己慢慢配。</span>
        </RadioItem>
        {packs.map((p) => (
          <RadioItem className="packopt" key={p.id} value={p.id}>
            <b>{p.name}</b> <span className="tag">v{p.version}</span>
            <span className="hint" style={{ display: 'block' }}>{p.description}</span>
          </RadioItem>
        ))}
      </RadioGroup>
      {!packsLoaded && <p className="hint">行业包加载中…</p>}
      {packsLoaded && packs.length === 0 && (
        <p className="hint">暂无可选行业包（平台还没上架），可先通用开局。</p>
      )}
      {selected && (
        <p className="hint" style={{ fontWeight: 700 }}>
          「{selected.name}」内容：{selected.description}
          {packSummary(selected) ? `（${packSummary(selected)}）` : ''}
        </p>
      )}
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <Button onClick={create} disabled={busy}>
          {busy ? '开通中…' : '开通并进入新公司'}
        </Button>
        <Button variant="gray" onClick={onClose} disabled={busy}>取消</Button>
      </div>
    </Dialog>
  );
}
