import { useEffect, useRef, useState } from 'react';
import type { HairStyle } from '@swarm/shared';
import { useApp } from '../context';
import { fetchAnnouncements, fetchReviewCenter, fetchThreadUnread, type AnnouncementItem } from '../api';
import PixelOffice, { autoAppearanceOf, drawMemberPreview } from './PixelOffice';
import { HAIR_PALETTE, HAIR_STYLES, SHIRT_PALETTE, SKINS } from './appearanceCatalog';
import CheckinCard from './CheckinCard';
import BriefingCard from './BriefingCard';
import { CapabilitiesShelf, OnboardingCard } from './Onboarding';
import { VisitLinksCard } from './Settings';
import { yuan } from '../utils';
import { Button, Input, RadioGroup, RadioItem, Select, Textarea } from './ui';

/** 成员档案编辑器（v1.3.0 起由 App 的 member 弹窗承载，Office 画布点小人 → openDialog('member')） */
export function MemberEditor({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const { S, post, refresh, toast } = useApp();
  const m = S?.members.find((x) => x.id === memberId);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [apiId, setApiId] = useState('');
  // v1.4.0 I 外观表单：初值 = 已定制字段 ?? 自动推导（展示用）；未实际改过前提交仍送原值，不把打开弹窗变成定制
  const [skin, setSkin] = useState('');
  const [shirt, setShirt] = useState('');
  const [hairColor, setHairColor] = useState('');
  const [hairStyle, setHairStyle] = useState<HairStyle>('short');
  const [appearanceTouched, setAppearanceTouched] = useState(false);
  const [appearanceCleared, setAppearanceCleared] = useState(false);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const role = m?.role ?? '';

  // 打开编辑器时把该成员的现有名字/提示词灌进表单（与原生版点击时渲染表单一致）
  useEffect(() => {
    if (m) {
      setName(m.name);
      setPrompt(m.prompt || '');
      setApiId(m.apiId || '');
      const auto = autoAppearanceOf(m);
      setSkin(m.appearance?.skin ?? auto.skin);
      setShirt(m.appearance?.shirt ?? auto.shirt);
      setHairColor(m.appearance?.hairColor ?? auto.hairColor);
      setHairStyle(m.appearance?.hairStyle ?? auto.hairStyle);
      setAppearanceTouched(false);
      setAppearanceCleared(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  // 外观预览：选择即重绘（与办公室小人同一绘制口径）
  useEffect(() => {
    if (previewRef.current && skin && shirt && hairColor) {
      drawMemberPreview(previewRef.current, { skin, shirt, hairColor, hairStyle, role });
    }
  }, [skin, shirt, hairColor, hairStyle, role, memberId]);

  if (!S || !m) return null;

  // 任一外观控件被实际改动 → 本次保存送完整外观对象；点「恢复自动」→ 送 null 清除（之后再改又回到送对象）
  const pickSkin = (v: string) => { setSkin(v); setAppearanceTouched(true); setAppearanceCleared(false); };
  const pickShirt = (v: string) => { setShirt(v); setAppearanceTouched(true); setAppearanceCleared(false); };
  const pickHairColor = (v: string) => { setHairColor(v); setAppearanceTouched(true); setAppearanceCleared(false); };
  const pickHairStyle = (v: HairStyle) => { setHairStyle(v); setAppearanceTouched(true); setAppearanceCleared(false); };
  const restoreAuto = () => {
    const auto = autoAppearanceOf(m);
    setSkin(auto.skin);
    setShirt(auto.shirt);
    setHairColor(auto.hairColor);
    setHairStyle(auto.hairStyle);
    setAppearanceTouched(false);
    setAppearanceCleared(true);
  };
  const swatches = (
    palette: Array<{ hex: string; name: string }>,
    cur: string,
    pick: (v: string) => void,
    label: string,
  ) => (
    <span className="style-swatches">
      {palette.map((s) => (
        <button
          key={s.hex}
          type="button"
          className={`style-swatch${cur === s.hex ? ' on' : ''}`}
          style={{ background: s.hex }}
          title={s.name}
          aria-label={`${label}：${s.name}`}
          onClick={() => pick(s.hex)}
        />
      ))}
    </span>
  );

  // 当前生效模型（成员绑定 → 小组绑定 → 空间默认，与服务端解析同口径；查不到不显示）
  const team = S.teams.find((t) => t.id === m.teamId);
  const effectiveApiId = m.apiId || team?.apiId || S.defaultApiId;
  const effectiveApi = effectiveApiId ? S.apis.find((a) => a.id === effectiveApiId) : undefined;

  async function save() {
    try {
      // v1.4.0 H：改走 members/save 一次提交全部字段（工种不变时服务端保留人设，与旧 prompt 端点等价）；
      // apiId 空串 = 跟随小组（与小组编辑「跟随公司默认」同口径，提交时转 null 清除成员级绑定）
      await post('/api/members/save', {
        member: {
          id: m!.id,
          name,
          role: m!.role,
          teamId: m!.teamId,
          prompt,
          apiId: apiId || null,
          // v1.4.0 I：与 apiId 同一次提交——恢复自动送 null、实际改过送完整对象、没改过送原值（不改）
          appearance: appearanceCleared
            ? null
            : appearanceTouched
              ? { skin, shirt, hairColor, hairStyle }
              : m!.appearance,
        },
      });
    } catch { return; }
    onClose();
    toast('成员已更新');
    refresh();
  }

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        {m.name}（{m.role}）
        {effectiveApi ? ` · 当前模型：${effectiveApi.model}` : ''}
      </p>
      <label>名字</label>
      <Input value={name} onChange={(e) => setName(e.target.value)} />
      <label>驱动模型</label>
      <Select
        value={apiId}
        onValueChange={setApiId}
        emptyLabel="跟随小组"
        options={S.apis.map((a) => ({ value: a.id, label: `${a.name} · ${a.model}` }))}
      />
      <label>外观</label>
      <div className="appearance-wrap">
        <div className="appearance-controls">
          <div className="style-color-row">
            <span className="style-color-label">肤色</span>
            {swatches(SKINS.map((hex) => ({ hex, name: hex })), skin, pickSkin, '肤色')}
          </div>
          <div className="style-color-row">
            <span className="style-color-label">衬衫</span>
            {swatches(SHIRT_PALETTE, shirt, pickShirt, '衬衫')}
          </div>
          <div className="style-color-row">
            <span className="style-color-label">发色</span>
            {swatches(HAIR_PALETTE, hairColor, pickHairColor, '发色')}
          </div>
          <div className="style-color-row">
            <span className="style-color-label">发型</span>
            <RadioGroup
              className="appearance-hair-group"
              value={hairStyle}
              onValueChange={(v) => pickHairStyle(v as HairStyle)}
              ariaLabel="发型"
            >
              {HAIR_STYLES.map((s) => (
                <RadioItem key={s.value} value={s.value}>
                  {s.label}
                </RadioItem>
              ))}
            </RadioGroup>
          </div>
          <div style={{ marginTop: 6 }}>
            <Button size="small" variant="gray" onClick={restoreAuto}>恢复自动</Button>{' '}
            <span className="hint">
              {appearanceCleared
                ? '保存后恢复自动推导'
                : appearanceTouched
                  ? '已定制（未保存）'
                  : m.appearance
                    ? '已定制'
                    : '未定制 · 按工种/编号自动推导'}
            </span>
          </div>
        </div>
        <canvas ref={previewRef} className="appearance-preview" width={96} height={126} aria-label="外观预览" />
      </div>
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
  const { S, openDialog, user, setTab } = useApp();
  /* v1.5.0 F：管理员额外聚合「同步待审」（审核中心队列数），普通用户为 0 */
  const [adminPending, setAdminPending] = useState(0);
  const isAdmin = !!user?.isPlatformAdmin;
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchReviewCenter()
      .then((items) => {
        if (!cancelled) setAdminPending(items.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);
  if (!S) return null;
  const balance = S.apis.reduce((sum, a) => sum + (a.balanceYuan || 0), 0);
  const running = S.tasks.filter((t) => t.status === '执行中').length;
  const reviewing = S.tasks.filter((t) => t.status === '待审核').length;
  const adjudicating = S.tasks.filter((t) => t.status === '待裁决').length;
  const goTasks = () => openDialog('tasks', { section: 'taskwall' });
  const pendingTotal = reviewing + adjudicating + (isAdmin ? adminPending : 0);
  const goPending = () => {
    // 直达锚点：任务侧有待处理先去任务墙，全是平台待审则去管理台审核中心
    if (reviewing + adjudicating > 0 || !isAdmin) goTasks();
    else setTab('admin');
  };
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
      <button
        type="button"
        className="shell-live-item"
        onClick={goPending}
        title={isAdmin ? '待审核 + 待裁决 + 平台待审（审核中心）' : '待审核 + 待裁决'}
      >
        <span>待你处理</span>
        <b>{pendingTotal}</b>
      </button>
    </div>
  );
}

/** 平台公告区（v1.5.0 L）：办公室首页展示当前空间命中的已发布公告（最新 3 条） */
function AnnouncementBar() {
  const { currentWorkspace, openDialog } = useApp();
  const [items, setItems] = useState<AnnouncementItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAnnouncements()
      .then((list) => {
        if (!cancelled) setItems(list.slice(0, 3));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentWorkspace?.id]);
  if (items.length === 0) return null;
  return (
    <div className="card" style={{ borderLeft: '4px solid #b78a2e' }} aria-label="平台公告">
      {items.map((a) => (
        <div key={a.id} style={{ marginBottom: 6 }}>
          <b>📢 {a.title}</b>{' '}
          <span className="hint">{a.publishedAt ? new Date(a.publishedAt).toLocaleString() : ''}</span>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{a.body}</div>
        </div>
      ))}
      <Button size="small" variant="gray" onClick={() => openDialog('messages')}>
        有问题？回复平台管理员
      </Button>
    </div>
  );
}

/** 功能坞（v1.3.0 E）：全部功能改走弹窗，项目/成果库走 tasks 弹窗对应 section */
function Dock() {
  const { openDialog, currentWorkspace, dialog } = useApp();
  const [msgUnread, setMsgUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchThreadUnread()
      .then((n) => {
        if (!cancelled) setMsgUnread(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentWorkspace?.id, dialog?.name]);
  const items: Array<{ label: string; icon: string; badge?: number; onClick: () => void }> = [
    { label: '发单', icon: '📝', onClick: () => openDialog('publish') },
    { label: '任务墙', icon: '📌', onClick: () => openDialog('tasks', { section: 'taskwall' }) },
    { label: '项目', icon: '🗂️', onClick: () => openDialog('tasks', { section: 'projects' }) },
    { label: '成果库', icon: '🏆', onClick: () => openDialog('tasks', { section: 'results' }) },
    { label: '资源中心', icon: '🧰', onClick: () => openDialog('resources') },
    { label: '技能', icon: '🧩', onClick: () => openDialog('skills') },
    { label: '人才库', icon: '🧑‍💼', onClick: () => openDialog('talents') },
    { label: '资产库', icon: '🗄️', onClick: () => openDialog('assets') },
    { label: '知识库', icon: '📚', onClick: () => openDialog('kb') },
    { label: '消息', icon: '💬', badge: msgUnread, onClick: () => openDialog('messages') },
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
          {it.badge ? <span className="dock-badge">{it.badge}</span> : null}
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
      {/* v1.5.0 L：平台公告区（有公告才出现） */}
      <AnnouncementBar />
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
