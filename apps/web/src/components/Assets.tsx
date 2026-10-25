import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { confirmAssetImport, fetchAssets, fetchAssetTypes, previewAssetImport } from '../api';
import { Badge, Button, Checkbox, Dialog, EmptyState, Input, Select, Textarea } from './ui';
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
  /* G-06 文件导入（两段式 Dialog：选类型+文件 → 预览勾选/改 title → 确认生成资产 v1） */
  const [impOpen, setImpOpen] = useState(false);
  const [impTypeId, setImpTypeId] = useState('');
  const [impFile, setImpFile] = useState<File | null>(null);
  const [impFilename, setImpFilename] = useState('');
  const [impName, setImpName] = useState('');
  const [impSections, setImpSections] = useState<Array<AssetSection & { include: boolean }>>([]);
  const [impBusy, setImpBusy] = useState(false);

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

  async function runAssetPreview() {
    if (!impFile) return toast('先选择文件');
    if (!impTypeId) return toast('先选资产类型');
    setImpBusy(true);
    try {
      const pv = await previewAssetImport(impFile, impTypeId);
      setImpFilename(pv.filename);
      setImpName(pv.name);
      setImpSections(pv.sections.map((s) => ({ ...s, include: true })));
      if (!pv.sections.length) toast('没有解析出分段');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setImpBusy(false);
    }
  }

  async function runAssetConfirm() {
    if (!impName.trim()) return toast('先填资产名称');
    const picked = impSections.filter((s) => s.include);
    if (!picked.length) return toast('至少勾选一段');
    setImpBusy(true);
    try {
      const saved = await confirmAssetImport({
        filename: impFilename,
        name: impName.trim(),
        typeId: impTypeId,
        sections: picked.map((s) => ({ key: s.key, title: s.title, body: s.body })),
      });
      toast(`资产已导入，当前版本 v${saved.version}（共 ${picked.length} 个分段）`);
      setImpOpen(false);
      setImpSections([]);
      setImpFile(null);
      load();
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setImpBusy(false);
    }
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
            <Badge>{typeSource(t)}</Badge>
            {t.industry && <Badge>{t.industry}</Badge>}
            <div className="meta">typeId：{t.typeId}</div>
          </div>
        ))}
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <div>
            <label>新增类型名称</label>
            <Input value={newTypeName} onChange={(e) => setNewTypeName(e.target.value)} placeholder="如：剧目档案" />
          </div>
          <div style={{ flex: '0 0 130px' }}>
            <Button variant="blue" onClick={addType}>新增类型</Button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>资产 <span className="tag">结构化内容（摘要 + 分段），改内容自动升版本；发单时可整份或按分段引用</span></h2>
        <div style={{ marginBottom: 10 }}>
          <Button onClick={startCreate}>＋ 新建资产</Button>{' '}
          <Button variant="gray" onClick={() => { setImpTypeId((cur) => cur || types[0]?.typeId || ''); setImpOpen(true); }}>文件导入</Button>{' '}
          <Button variant="gray" onClick={load}>刷新</Button>
        </div>
        {loaded && assets.length === 0 && (
          <EmptyState
            example={<>示例资产：《龙王归来》剧目档案 v1 · 分段：ep1 梗概 / ep2 梗概 / 人物小传</>}
            action={
              <Button size="small" onClick={startCreate}>
                ＋ 新建资产
              </Button>
            }
          >
            暂无资产。新建一份（如剧目档案、品牌手册），发单时引用给干活的成员当参考，引用会按当时版本落快照。
          </EmptyState>
        )}
        {assets.map((a) => (
          <div className="task" key={a.id}>
            <span className="tt">{a.name}</span>
            <Badge>{typeName(a.typeId)}</Badge>
            <Badge>v{a.version}</Badge>
            <div className="meta">
              {(a.content?.sections ?? []).length} 个分段 · 更新于 {a.updatedAt.slice(0, 16).replace('T', ' ')}
              {a.content?.summary ? <><br />{a.content.summary}</> : null}
            </div>
            <div style={{ marginTop: 6 }}>
              <Button size="small" variant="gray" onClick={() => startEdit(a)}>编辑</Button>
            </div>
          </div>
        ))}
      </div>

      {editorOpen && (
        <Dialog open onClose={() => setEditorOpen(false)} title={editingId ? '编辑资产' : '新建资产'} wide={720}>
            <div className="row">
              <div>
                <label>名称</label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：《龙王归来》剧目档案" />
              </div>
              <div>
                <label>类型</label>
                <Select
                  value={form.typeId}
                  onValueChange={(v) => setForm({ ...form, typeId: v })}
                  placeholder="请选择类型"
                  options={types.map((t) => ({ value: t.typeId, label: `${t.name}（${typeSource(t)}）` }))}
                />
              </div>
            </div>
            <label>摘要 summary</label>
            <Textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="一句话说清这份资产是什么" />
            <label>分段 sections（key 是发单时按段引用的标识）</label>
            {form.sections.map((s, i) => (
              <div className="apicard" key={i}>
                <div className="row">
                  <div>
                    <Input placeholder="key（如 selling-points）" value={s.key} onChange={(e) => {
                      const sections = [...form.sections];
                      sections[i] = { ...s, key: e.target.value };
                      setForm({ ...form, sections });
                    }} />
                  </div>
                  <div>
                    <Input placeholder="分段标题" value={s.title} onChange={(e) => {
                      const sections = [...form.sections];
                      sections[i] = { ...s, title: e.target.value };
                      setForm({ ...form, sections });
                    }} />
                  </div>
                  <div style={{ flex: '0 0 64px' }}>
                    <Button
                      size="small"
                      variant="gray"
                      onClick={() => setForm({ ...form, sections: form.sections.filter((_, x) => x !== i) })}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                <Textarea
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
            <Button
              size="small"
              variant="gray"
              onClick={() => setForm({ ...form, sections: [...form.sections, { key: '', title: '', body: '' }] })}
            >
              ＋ 加一段
            </Button>
            <div style={{ marginTop: 12 }}>
              <Button onClick={saveAsset}>保存（改内容自动升版）</Button>{' '}
              <Button variant="gray" onClick={() => setEditorOpen(false)}>取消</Button>
            </div>
        </Dialog>
      )}

      {impOpen && (
        <Dialog open onClose={() => setImpOpen(false)} title="文件导入资产" wide={720}>
          <p className="hint">
            支持 .txt / .md / .docx，单文件 ≤5MB、单次 ≤200 个分段。带「第N集/话/回」行首标记的按集拆段
            （key=epN），无标记则整文件作一段（key=full）。先预览，确认后生成资产并落 v1 版本。
          </p>
          <div className="row">
            <div>
              <label>资产类型</label>
              <Select
                value={impTypeId}
                onValueChange={setImpTypeId}
                placeholder="请选择类型"
                options={types.map((t) => ({ value: t.typeId, label: `${t.name}（${typeSource(t)}）` }))}
              />
            </div>
            <div>
              <label>资产名称（预览后按文件名预填，可改）</label>
              <Input value={impName} onChange={(e) => setImpName(e.target.value)} placeholder="如：《龙王归来》剧本" />
            </div>
          </div>
          <label>选择文件</label>
          <Input
            type="file"
            accept=".txt,.md,.markdown,.docx"
            onChange={(e) => { setImpFile(e.target.files?.[0] ?? null); setImpSections([]); }}
          />
          <div style={{ marginTop: 10 }}>
            <Button size="small" variant="blue" onClick={runAssetPreview} disabled={impBusy || !impFile}>
              {impBusy ? '解析中…' : '解析预览'}
            </Button>
          </div>
          {impSections.length > 0 && (
            <>
              <div className="hint" style={{ margin: '10px 0 6px', fontWeight: 600 }}>
                预览共 {impSections.length} 段，已勾选 {impSections.filter((s) => s.include).length} 段（可逐段改标题）
              </div>
              {impSections.map((s, i) => (
                <div className="apicard" key={i}>
                  <Checkbox
                    checked={s.include}
                    onCheckedChange={(on) => {
                      const next = [...impSections];
                      next[i] = { ...s, include: on };
                      setImpSections(next);
                    }}
                    label={s.key}
                  />
                  <Input
                    value={s.title}
                    onChange={(e) => {
                      const next = [...impSections];
                      next[i] = { ...s, title: e.target.value };
                      setImpSections(next);
                    }}
                    placeholder="分段标题"
                  />
                  <div className="meta">{s.body.slice(0, 140)}</div>
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <Button onClick={runAssetConfirm} disabled={impBusy}>确认导入（生成 v1）</Button>{' '}
                <Button variant="gray" onClick={() => setImpOpen(false)}>取消</Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
