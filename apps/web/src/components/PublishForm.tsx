import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchRegistry } from '../api';
import AssetRefPicker from './AssetRefPicker';
import type { AssetRef, RegistryTaskType } from '../types';

const FALLBACK_TYPES = ['文案', '调研', '代码'];

type Mode = 'task' | 'project' | 'batch';

export default function PublishForm() {
  const { S, post, refresh, toast } = useApp();
  const [mode, setMode] = useState<Mode>('task');
  const [title, setTitle] = useState('');
  const [type, setType] = useState('文案');
  const [teamId, setTeamId] = useState('');
  const [brief, setBrief] = useState('');
  // P1：单任务参考资料 + 资产引用
  const [references, setReferences] = useState('');
  const [assetRefs, setAssetRefs] = useState<AssetRef[]>([]);
  // P1：批量发单（一行一单）
  const [batchTitles, setBatchTitles] = useState('');
  const [briefSuffix, setBriefSuffix] = useState('');
  const [batchReferences, setBatchReferences] = useState('');
  const [batchAssetRefs, setBatchAssetRefs] = useState<AssetRef[]>([]);
  // 方案下发（项目）模式字段
  const [pName, setPName] = useState('');
  const [pBrief, setPBrief] = useState('');
  const [clientName, setClientName] = useState('');
  // 任务类型改注册表驱动（M6）：拉 GET /api/registry 的 taskTypes，typeId 即提交值；拉不到回退默认三项
  const [regTypes, setRegTypes] = useState<RegistryTaskType[]>([]);

  useEffect(() => {
    fetchRegistry()
      .then((r) => setRegTypes(r.taskTypes))
      .catch(() => setRegTypes([]));
  }, []);

  // 注册表就绪后，若当前选中值不在注册表内，切到第一项
  useEffect(() => {
    if (regTypes.length && !regTypes.some((t) => t.typeId === type)) {
      setType(regTypes[0].typeId);
    }
  }, [regTypes, type]);

  // 与原生版一致：小组下拉跟随最新数据，尽量保留当前选择
  useEffect(() => {
    if (S && S.teams.length && !S.teams.some((t) => t.id === teamId)) {
      setTeamId(S.teams[0].id);
    }
  }, [S, teamId]);

  if (!S) return null;

  async function createTask() {
    if (!title.trim()) return toast('先填标题');
    try {
      await post('/api/tasks', {
        title: title.trim(),
        type,
        brief,
        references: references.trim() ? references : undefined,
        assetRefs: assetRefs.length ? assetRefs : undefined,
        teamId,
      });
    } catch { return; }
    setTitle('');
    setBrief('');
    setReferences('');
    setAssetRefs([]);
    toast('已发布，进队列了');
    refresh();
  }

  async function createBatch() {
    const titles = batchTitles
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!titles.length) return toast('先填标题（一行一单）');
    let res: Record<string, unknown>;
    try {
      res = await post('/api/tasks/batch', {
        items: titles.map((t) => ({ title: t })),
        type,
        briefSuffix,
        references: batchReferences.trim() ? batchReferences : undefined,
        assetRefs: batchAssetRefs.length ? batchAssetRefs : undefined,
        teamId,
      });
    } catch { return; }
    const n = typeof res.count === 'number' ? res.count : titles.length;
    setBatchTitles('');
    toast(`批量发单完成，一共生成 ${n} 单进队列`);
    refresh();
  }

  async function createProject() {
    if (!pName.trim()) return toast('先填方案标题');
    let res: Record<string, unknown>;
    try {
      res = await post('/api/projects', {
        name: pName.trim(),
        brief: pBrief,
        teamId,
        clientName: clientName.trim(),
      });
    } catch { return; }
    const n = Array.isArray(res.taskIds) ? res.taskIds.length : 0;
    setPName('');
    setPBrief('');
    setClientName('');
    toast(`方案已下发，组长拆成 ${n} 个子任务进队列`);
    refresh();
  }

  const modeBtn = (m: Mode, label: string) => (
    <button
      className={`btn small ${mode === m ? '' : 'gray'}`}
      onClick={() => setMode(m)}
    >
      {label}
    </button>
  );

  const typeTeamRow = (
    <div className="row">
      <div>
        <label>类型</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {regTypes.length
            ? regTypes.map((t) => (
                <option key={t.typeId} value={t.typeId}>{t.name}</option>
              ))
            : FALLBACK_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label>交给哪个小组</label>
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          {S.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
    </div>
  );

  return (
    <div className="card" style={{ flex: 1.2 }}>
      <h2>发布真任务</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        {modeBtn('task', '单任务')}
        {modeBtn('project', '方案下发（项目）')}
        {modeBtn('batch', '批量发单')}
      </div>

      {mode === 'batch' ? (
        <>
          <label>标题（一行一单，最多 100 单）</label>
          <textarea
            rows={6}
            placeholder={'给《龙王归来》第1集写英文标题\n给《龙王归来》第2集写英文标题\n给《龙王归来》第3集写英文标题'}
            value={batchTitles}
            onChange={(e) => setBatchTitles(e.target.value)}
          />
          {typeTeamRow}
          <label>统一说明后缀（拼到每单说明后面）</label>
          <textarea
            rows={2}
            placeholder="如：统一要求：标题不超过 60 字符，带悬念钩子"
            value={briefSuffix}
            onChange={(e) => setBriefSuffix(e.target.value)}
          />
          <label>参考资料（链接 / 素材说明，每单共用）</label>
          <textarea
            rows={2}
            placeholder="参考链接、原片信息、竞品标题……"
            value={batchReferences}
            onChange={(e) => setBatchReferences(e.target.value)}
          />
          <label>资产引用（每单共用，可按分段引用）</label>
          <AssetRefPicker value={batchAssetRefs} onChange={setBatchAssetRefs} />
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={createBatch}>批量发布</button>
          </div>
          <p className="hint">每行标题生成一单，共用上面的类型 / 小组 / 说明后缀 / 参考资料。</p>
        </>
      ) : mode === 'task' ? (
        <>
          <label>标题</label>
          <input
            placeholder="如：给 MJ Drama 首支视频写英文标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {typeTeamRow}
          <label>说明（越具体产出越好）</label>
          <textarea
            rows={4}
            placeholder="题材、受众、长度、风格、必须包含的内容……"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <label>参考资料（链接 / 素材说明，会以【参考资料】段拼入说明）</label>
          <textarea
            rows={2}
            placeholder="参考链接、原片信息、竞品标题……"
            value={references}
            onChange={(e) => setReferences(e.target.value)}
          />
          <label>资产引用（可按分段引用，发单时按当前版本落快照）</label>
          <AssetRefPicker value={assetRefs} onChange={setAssetRefs} />
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={createTask}>发布任务</button>
          </div>
          <p className="hint">任务会进入队列自动开工（前提：该小组的 API 已填 Key 且余额充足，否则会停在待分配并写明原因）。</p>
        </>
      ) : (
        <>
          <label>方案标题</label>
          <input
            placeholder="如：MJ Drama 首支短剧上线包"
            value={pName}
            onChange={(e) => setPName(e.target.value)}
          />
          <div className="row">
            <div>
              <label>交给哪个小组（组长负责拆单）</label>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                {S.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label>甲方（选填）</label>
              <input
                placeholder="如：内部自营"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>
          </div>
          <label>方案说明（目标、范围、交付要求，组长据此拆子任务）</label>
          <textarea
            rows={4}
            placeholder="想达成什么、包含哪几块工作、每块的交付标准……"
            value={pBrief}
            onChange={(e) => setPBrief(e.target.value)}
          />
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={createProject}>下发方案</button>
          </div>
          <p className="hint">方案会交给该组组长拆成 3–5 个子任务进队列（无可用 API 时兜底为单个子任务），进度与总账在下方「项目」区看。</p>
        </>
      )}
    </div>
  );
}
