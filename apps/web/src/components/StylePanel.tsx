import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import {
  applyStyleTemplate,
  createStyleTemplate,
  fetchStyleTemplates,
  putOfficeStyle,
  submitStyleTemplateReview,
  uploadStyleImage,
  type StyleTemplateItem,
} from '../api';
import type { OfficeStyleConfig } from '../types';
import { Badge, Button, Field, Input, RadioGroup, RadioItem, Select, Spinner } from './ui';
import {
  DEFAULT_OFFICE_STYLE,
  FLOOR_PATTERN_OPTIONS,
  FURNITURE_SLOTS,
  PALETTE_SWATCHES,
  STYLE_COMBOS,
  type StyleCombo,
} from './styleCatalog';

/**
 * F 装修面板（v1.3.0）：办公室风格定制弹窗内容。
 * 预览机制：本地 draft 每次变化即 setOfficeStyle(draft) 写入 context（仅本地、不落库），
 * 画布实时预览；点「保存风格」才 PUT 落库并置 savedRef，关弹窗/取消时若未保存，
 * 组件卸载 cleanup 调 refreshOfficeStyle() 从服务端回滚。套用模板是服务端即时生效，
 * 不走回滚（savedRef 同样置真）。
 */
const VISIBILITY_LABEL: Record<string, string> = {
  private: '未公开',
  workspace: '空间内可见',
  pending_review: '审核中',
  public: '已上架',
};

function cloneStyle(s: OfficeStyleConfig): OfficeStyleConfig {
  return JSON.parse(JSON.stringify(s)) as OfficeStyleConfig;
}

export default function StylePanel() {
  const { officeStyle, setOfficeStyle, refreshOfficeStyle, toast, currentWorkspace } = useApp();
  const [draft, setDraft] = useState<OfficeStyleConfig>(() => cloneStyle(officeStyle ?? DEFAULT_OFFICE_STYLE));
  const savedRef = useRef(false);
  const refreshRef = useRef(refreshOfficeStyle);
  refreshRef.current = refreshOfficeStyle;
  const [saving, setSaving] = useState(false);
  const [tplName, setTplName] = useState('');
  const [storingTpl, setStoringTpl] = useState(false);
  const [combo, setCombo] = useState<StyleCombo | null>(null);
  const [mine, setMine] = useState<StyleTemplateItem[]>([]);
  const [library, setLibrary] = useState<StyleTemplateItem[]>([]);
  const [tplLoaded, setTplLoaded] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [uploading, setUploading] = useState('');

  /* 即时预览：draft → context（不落库） */
  useEffect(() => {
    setOfficeStyle(draft);
  }, [draft, setOfficeStyle]);

  /* 关弹窗未保存 → 回滚服务端风格 */
  useEffect(() => {
    return () => {
      if (!savedRef.current) void refreshRef.current();
    };
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const r = await fetchStyleTemplates();
      setMine(r.mine);
      setLibrary(r.library);
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setTplLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const setPalette = (key: 'wall' | 'floor' | 'accent', hex: string) =>
    setDraft((d) => ({ ...d, palette: { ...d.palette, [key]: hex } }));
  const setFurniture = (slot: string, v: string) =>
    setDraft((d) => ({ ...d, furniture: { ...d.furniture, [slot]: v === '' ? null : v } }));

  async function onUpload(kind: 'poster' | 'sign', file: File | undefined) {
    if (!file) return;
    setUploading(kind);
    try {
      const { fileId } = await uploadStyleImage(file);
      if (kind === 'poster') setDraft((d) => ({ ...d, poster: { imageFileId: fileId } }));
      else setDraft((d) => ({ ...d, sign: { ...d.sign, mode: 'image', imageFileId: fileId } }));
      toast('图片已上传（保存风格后生效）');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setUploading('');
    }
  }

  function shuffleCombo() {
    let next = STYLE_COMBOS[Math.floor(Math.random() * STYLE_COMBOS.length)];
    if (combo && STYLE_COMBOS.length > 1) {
      while (next.name === combo.name) {
        next = STYLE_COMBOS[Math.floor(Math.random() * STYLE_COMBOS.length)];
      }
    }
    setCombo(next);
  }

  function useCombo() {
    if (!combo) return;
    setDraft((d) => ({
      ...cloneStyle(combo.style),
      // 一键搭配只换配色/纹样/家具：保留用户已上传的海报与图片招牌不被冲掉
      poster: d.poster,
      sign: d.sign.mode === 'image' ? d.sign : cloneStyle(combo.style).sign,
    }));
    toast(`已套用「${combo.name}」到预览，点保存风格生效`);
  }

  async function save() {
    setSaving(true);
    try {
      await putOfficeStyle(draft);
    } catch (e) {
      setSaving(false);
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    setSaving(false);
    savedRef.current = true;
    await refreshOfficeStyle();
    toast('风格已保存');
  }

  async function storeTemplate() {
    const name = tplName.trim();
    if (!name) return toast('先给风格模板起个名字');
    setStoringTpl(true);
    try {
      // 「存为模板」以已保存的当前风格为准：先落库当前 draft 再建模板
      await putOfficeStyle(draft);
      savedRef.current = true;
      await createStyleTemplate(name, draft);
    } catch (e) {
      setStoringTpl(false);
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    setStoringTpl(false);
    setTplName('');
    toast(`风格模板「${name}」已保存（未公开，可在下方提交审核上架平台库）`);
    await refreshOfficeStyle();
    loadTemplates();
  }

  async function applyTpl(t: StyleTemplateItem) {
    setBusyId(t.id);
    try {
      const style = await applyStyleTemplate(t.id);
      savedRef.current = true; // 套用是服务端即时生效，不回滚
      setDraft(cloneStyle(style));
      await refreshOfficeStyle();
      toast(`已套用风格「${t.name}」`);
      loadTemplates();
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId('');
    }
  }

  async function submitReview(t: StyleTemplateItem) {
    setBusyId(t.id);
    try {
      await submitStyleTemplateReview(t.id);
      toast(`「${t.name}」已提交审核，管理员通过后上架平台库`);
      loadTemplates();
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId('');
    }
  }

  const tplCard = (t: StyleTemplateItem, kind: 'official' | 'platform' | 'mine') => (
    <div className="style-tpl-card" key={t.id}>
      <div className="style-tpl-head">
        <span className="style-tpl-name">{t.name}</span>
        {kind === 'official' && <Badge variant="adj">官方</Badge>}
        {kind === 'mine' && <Badge>{VISIBILITY_LABEL[t.visibility] ?? t.visibility}</Badge>}
      </div>
      <div className="style-tpl-swatches">
        <span style={{ background: t.config.palette.wall }} title="墙面" />
        <span style={{ background: t.config.palette.floor }} title="地板" />
        <span style={{ background: t.config.palette.accent }} title="点缀" />
        <span className="style-tpl-pattern">{FLOOR_PATTERN_OPTIONS.find((o) => o.value === t.config.floorPattern)?.label ?? t.config.floorPattern}</span>
      </div>
      {kind === 'platform' && (
        <div className="hint">
          由 {t.contributorWorkspaceName ?? ''} · {t.contributorName ?? ''} 贡献 · 已被套用 {t.applyCount} 次
        </div>
      )}
      {kind === 'official' && <div className="hint">已被套用 {t.applyCount} 次</div>}
      <div className="style-tpl-actions">
        <Button size="small" variant="green" disabled={busyId === t.id} onClick={() => applyTpl(t)}>
          套用
        </Button>
        {kind === 'mine' && (t.visibility === 'private' || t.visibility === 'workspace') && (
          <Button size="small" variant="gray" disabled={busyId === t.id} onClick={() => submitReview(t)}>
            提交审核
          </Button>
        )}
        {kind === 'mine' && t.visibility === 'public' && <span className="hint">已上架平台库</span>}
        {kind === 'mine' && t.visibility === 'pending_review' && <span className="hint">等待管理员审核</span>}
      </div>
    </div>
  );

  const colorRow = (key: 'wall' | 'floor' | 'accent', label: string) => (
    <div className="style-color-row">
      <span className="style-color-label">{label}</span>
      <span className="style-swatches">
        {PALETTE_SWATCHES[key].map((s) => (
          <button
            key={s.hex}
            type="button"
            className={`style-swatch${draft.palette[key] === s.hex ? ' on' : ''}`}
            style={{ background: s.hex }}
            title={s.name}
            aria-label={`${label}：${s.name}`}
            onClick={() => setPalette(key, s.hex)}
          />
        ))}
      </span>
      <input
        type="color"
        className="style-color-input"
        value={draft.palette[key]}
        onChange={(e) => setPalette(key, e.target.value)}
        aria-label={`${label}自定义颜色`}
      />
      <span className="style-color-hex">{draft.palette[key]}</span>
    </div>
  );

  const officials = library.filter((t) => t.ownerType === 'platform');
  const platform = library.filter((t) => t.ownerType !== 'platform');

  return (
    <div className="style-panel">
      <p className="hint">所有改动都会即时在办公室画布预览；点「保存风格」才正式生效，关掉面板未保存的改动会自动还原。</p>

      {/* ① 配色 */}
      <h3 className="style-sec">配色与地板</h3>
      {colorRow('wall', '墙面')}
      {colorRow('floor', '地板')}
      {colorRow('accent', '点缀')}
      <Field label="地板纹样">
        <Select
          value={draft.floorPattern}
          onValueChange={(v) => setDraft((d) => ({ ...d, floorPattern: v }))}
          options={FLOOR_PATTERN_OPTIONS}
        />
      </Field>

      {/* ② 家具装饰 */}
      <h3 className="style-sec">家具装饰</h3>
      {FURNITURE_SLOTS.map((def) => (
        <div className="style-furn-row" key={def.slot}>
          <span className="style-furn-label">{def.label}</span>
          <Select
            value={draft.furniture[def.slot] ?? ''}
            onValueChange={(v) => setFurniture(def.slot, v)}
            emptyLabel="无"
            options={Object.entries(def.styles).map(([value, label]) => ({ value, label }))}
            ariaLabel={def.label}
          />
        </div>
      ))}

      {/* ③ 海报与招牌 */}
      <h3 className="style-sec">海报与招牌</h3>
      <div className="style-upload-row">
        <span className="style-furn-label">墙面海报</span>
        {draft.poster.imageFileId ? (
          <img className="style-thumb" src={`/api/style-images/${draft.poster.imageFileId}`} alt="海报预览" />
        ) : (
          <span className="hint">未设置</span>
        )}
        <input
          type="file"
          accept="image/*"
          disabled={uploading === 'poster'}
          onChange={(e) => {
            void onUpload('poster', e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {draft.poster.imageFileId && (
          <Button size="small" variant="gray" onClick={() => setDraft((d) => ({ ...d, poster: { imageFileId: null } }))}>
            移除
          </Button>
        )}
      </div>
      <Field label="招牌形式">
        <RadioGroup
          value={draft.sign.mode}
          onValueChange={(v) => setDraft((d) => ({ ...d, sign: { ...d.sign, mode: v === 'image' ? 'image' : 'text' } }))}
          ariaLabel="招牌形式"
        >
          <RadioItem value="text">文字招牌</RadioItem>
          <RadioItem value="image">图片招牌</RadioItem>
        </RadioGroup>
      </Field>
      {draft.sign.mode === 'text' ? (
        <Field label="招牌文字（留空 = 用公司名）">
          <Input
            value={draft.sign.text}
            onChange={(e) => setDraft((d) => ({ ...d, sign: { ...d.sign, text: e.target.value } }))}
            placeholder={currentWorkspace?.name ?? '公司名'}
          />
        </Field>
      ) : (
        <div className="style-upload-row">
          <span className="style-furn-label">招牌图</span>
          {draft.sign.imageFileId ? (
            <img className="style-thumb" src={`/api/style-images/${draft.sign.imageFileId}`} alt="招牌预览" />
          ) : (
            <span className="hint">未设置</span>
          )}
          <input
            type="file"
            accept="image/*"
            disabled={uploading === 'sign'}
            onChange={(e) => {
              void onUpload('sign', e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {/* ④ 一键生成搭配 */}
      <h3 className="style-sec">一键生成搭配（站内预设随机组合）</h3>
      <div className="style-combo-row">
        <Button variant="gray" onClick={shuffleCombo}>换一套</Button>
        {combo && (
          <>
            <span className="style-combo-name">{combo.name}</span>
            <span className="style-tpl-swatches">
              <span style={{ background: combo.style.palette.wall }} />
              <span style={{ background: combo.style.palette.floor }} />
              <span style={{ background: combo.style.palette.accent }} />
            </span>
            <Button variant="blue" onClick={useCombo}>就用这套</Button>
          </>
        )}
        {!combo && <span className="hint">从 {STYLE_COMBOS.length} 套站内预设里随机抽一套配色 + 家具组合</span>}
      </div>

      {/* ⑤ 保存与存模板 */}
      <h3 className="style-sec">保存</h3>
      <div className="style-save-row">
        <Button variant="green" disabled={saving} onClick={save}>保存风格</Button>
      </div>
      <div className="style-save-row">
        <Input
          value={tplName}
          onChange={(e) => setTplName(e.target.value)}
          placeholder="风格模板名称，如：我的森系办公室"
        />
        <Button variant="gray" disabled={storingTpl} onClick={storeTemplate}>存为风格模板</Button>
      </div>

      {/* ⑥ 模板库 */}
      <h3 className="style-sec">风格模板库</h3>
      {!tplLoaded && <p><Spinner label="加载模板库…" /></p>}
      {tplLoaded && (
        <>
          <div className="style-tpl-group">官方模板</div>
          {officials.length === 0 && <p className="hint">暂无官方模板。</p>}
          <div className="style-tpl-grid">{officials.map((t) => tplCard(t, 'official'))}</div>
          <div className="style-tpl-group">平台库（用户贡献）</div>
          {platform.length === 0 && <p className="hint">暂无用户贡献模板。</p>}
          <div className="style-tpl-grid">{platform.map((t) => tplCard(t, 'platform'))}</div>
          <div className="style-tpl-group">我的模板</div>
          {mine.length === 0 && <p className="hint">还没有自建模板，把当前风格存为模板后会出现在这里。</p>}
          <div className="style-tpl-grid">{mine.map((t) => tplCard(t, 'mine'))}</div>
        </>
      )}
    </div>
  );
}
