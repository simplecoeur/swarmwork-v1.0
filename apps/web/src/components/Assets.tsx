import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchAssets, fetchAssetTypes } from '../api';
import type { Asset, AssetSection, AssetType } from '../types';

/** 资产类型来源标注：行业包带入 / 本空间自定义 / 平台内置 */
function typeSource(t: AssetType): string {
  if (t.packId) return '行业包';
  if (t.workspaceId) return '自定义';
  return '平台';
}

interface AssetForm {
  name: string;
  typeId: string;
  summary: string;
  sections: AssetSection[];
}

const EMPTY_FORM: AssetForm = { name: '', typeId: '', summary: '', sections: [] };

function formFromAsset(a: Asset): AssetForm {
  return {
    name: a.name,
    typeId: a.typeId,
    summary: a.content?.summary ?? '',
    sections: (a.content?.sections ?? []).map((s) => ({ ...s })),
  };
}

/**
 * 资产库页（M8 §11.4）：资产类型注册表 + 结构化资产（summary + sections 分段）。
 * 资产改内容保存后自动升版本（后端回 asset.version，前端 toast 展示新版本号）；
 * 发单时可整份或按分段 key 引用，引用按发单时刻版本落快照。
 */
export default function Assets() {
  const { post, send, toast } = useApp();
  const [types, setTypes] = useState<AssetType[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  // 编辑器：editingId=null 且 editorOpen=false 关闭；''=新建
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>('');
  const [form, setForm] = useState<AssetForm>(EMPTY_FORM);

  const load = useCallback(async () => {
    try {
      const [ts, as] = await Promise.all([fetchAssetTypes(), fetchAssets()]);
      setTypes(ts);
      setAssets(as);
    } catch {
      /* 拉取失败保持空列表 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const typeName = (typeId: string) => types.find((t) => t.typeId === typeId)?.name || typeId;

  async function addType() {
    if (!newTypeName.trim()) return toast('先填类型名称');
    try {
      await post('/api/asset-types', { assetType: { name: newTypeName.trim(), structureSchema: {} } });
    } catch { return; }
    setNewTypeName('');
    toast('资产类型已新增');
    load();
  }

  function startCreate() {
    setForm({ ...EMPTY_FORM, typeId: types[0]?.typeId ?? '' });
    setEditingId('');
    setEditorOpen(true);
  }
  function startEdit(a: Asset) {
    setForm(formFromAsset(a));
    setEditingId(a.id);
    setEditorOpen(true);
  }

  async function saveAsset() {
    if (!form.name.trim()) return toast('先填资产名称');
    if (!form.typeId) return toast('先选资产类型');
    const payload = {
      asset: {
        typeId: form.typeId,
        name: form.name.trim(),
        content: {
          summary: form.summary,
          sections: form.sections.filter((s) => s.key.trim() || s.title.trim() || s.body.trim()),
        },
      },
    };
    let res: Record<string, unknown>;
    try {
      if (editingId) res = await send('PUT', `/api/assets/${editingId}`, payload);
      else res = await post('/api/assets', payload);
    } catch { return; }
    const saved = res.asset as Asset | undefined;
    toast(saved ? `资产已保存，当前版本 v${saved.version}` : '资产已保存');
    setEditorOpen(false);
    load();
  }

  return (
    <>
      <div className="card">
        <h2>资产类型 <span className="tag">注册表驱动：平台 / 行业包带入 / 本空间自定义；资产的新建类型必须先在此登记</span></h2>
        {!loaded && <p className="hint">加载中…</p>}
        {loaded && types.length === 0 && <p className="hint">暂无资产类型，先在下方新增一个。</p>}
        {types.map((t) => (
          <div className="task" key={t.typeId}>
            <span className="tt">{t.name}</span>
            <span className="chip">{typeSource(t)}</span>
            {t.industry && <span className="chip">{t.industry}</span>}
            <div className="meta">typeId：{t.typeId}</div>
          </div>
        ))}
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <div>
            <label>新增类型名称</label>
            <input value={newTypeName} onChange={(e) => setNewTypeName(e.target.value)} placeholder="如：剧目档案" />
          </div>
          <div style={{ flex: '0 0 130px' }}>
            <button className="btn blue" onClick={addType}>新增类型</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>资产 <span className="tag">结构化内容（摘要 + 分段），改内容自动升版本；发单时可整份或按分段引用</span></h2>
        <div style={{ marginBottom: 10 }}>
          <button className="btn" onClick={startCreate}>＋ 新建资产</button>{' '}
          <button className="btn gray" onClick={load}>刷新</button>
        </div>
        {loaded && assets.length === 0 && <p className="hint">暂无资产。新建一份（如剧目档案、品牌手册），发单时引用给干活的成员当参考。</p>}
        {assets.map((a) => (
          <div className="task" key={a.id}>
            <span className="tt">{a.name}</span>
            <span className="chip">{typeName(a.typeId)}</span>
            <span className="chip">v{a.version}</span>
            <div className="meta">
              {(a.content?.sections ?? []).length} 个分段 · 更新于 {a.updatedAt.slice(0, 16).replace('T', ' ')}
              {a.content?.summary ? <><br />{a.content.summary}</> : null}
            </div>
            <div style={{ marginTop: 6 }}>
              <button className="btn small gray" onClick={() => startEdit(a)}>编辑</button>
            </div>
          </div>
        ))}
      </div>

      {editorOpen && (
        <div className="modal show">
          <div className="box" style={{ maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>{editingId ? '编辑资产' : '新建资产'}</h2>
            <div className="row">
              <div>
                <label>名称</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：《龙王归来》剧目档案" />
              </div>
              <div>
                <label>类型</label>
                <select value={form.typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })}>
                  <option value="">请选择类型</option>
                  {types.map((t) => (
                    <option key={t.typeId} value={t.typeId}>{t.name}（{typeSource(t)}）</option>
                  ))}
                </select>
              </div>
            </div>
            <label>摘要 summary</label>
            <textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="一句话说清这份资产是什么" />
            <label>分段 sections（key 是发单时按段引用的标识）</label>
            {form.sections.map((s, i) => (
              <div className="apicard" key={i}>
                <div className="row">
                  <div>
                    <input placeholder="key（如 selling-points）" value={s.key} onChange={(e) => {
                      const sections = [...form.sections];
                      sections[i] = { ...s, key: e.target.value };
                      setForm({ ...form, sections });
                    }} />
                  </div>
                  <div>
                    <input placeholder="分段标题" value={s.title} onChange={(e) => {
                      const sections = [...form.sections];
                      sections[i] = { ...s, title: e.target.value };
                      setForm({ ...form, sections });
                    }} />
                  </div>
                  <div style={{ flex: '0 0 64px' }}>
                    <button
                      className="btn small gray"
                      onClick={() => setForm({ ...form, sections: form.sections.filter((_, x) => x !== i) })}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <textarea
                  rows={3}
                  style={{ marginTop: 6 }}
                  placeholder="分段正文"
                  value={s.body}
                  onChange={(e) => {
                    const sections = [...form.sections];
                    sections[i] = { ...s, body: e.target.value };
                    setForm({ ...form, sections });
                  }}
                />
              </div>
            ))}
            <button
              className="btn small gray"
              onClick={() => setForm({ ...form, sections: [...form.sections, { key: '', title: '', body: '' }] })}
            >
              ＋ 加一段
            </button>
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={saveAsset}>保存（改内容自动升版）</button>{' '}
              <button className="btn gray" onClick={() => setEditorOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
