import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchPreferences, fetchSkills, putPreference } from '../api';
import { Badge, Button, Card, Spinner, Stepper } from './ui';
import type { Onboarding, SkillListItem } from '../types';

const ONBOARDING_KEY = 'onboarding';

/** v1.3.0 五步（快速开始）：手动步 = 1 认识团队 / 4 看时间线；行为步 = 2 余额 / 3 已发单 / 5 已完成 */
const STEPS = [
  { label: '认识团队', description: '看看每位成员的工种与拿手活（下方能力货架）' },
  { label: '让团队能开工', description: '填自己的 API 并采购，或等管理员发体验额度，二选一' },
  { label: '发第一单', description: '用模板发一单，或一键试跑官方技能' },
  { label: '看任务的时间线', description: '打开任务墙，点开任一任务看过程时间线' },
  { label: '审核并收第一份成果', description: '任务完成后看成果，收下第一份产出' },
];
const TOTAL_STEPS = STEPS.length; // 5；step >= 5 = 已完成

/**
 * 存量条目带 v 标记区分新旧语义：v=2 为五步版写入；无 v 的旧三步存量按映射换算——
 * 旧 0→0、旧 1→2、旧 2→4；旧 step>=3 或 doneAt 非空 → 已完成（step 置满格、不展示）。
 * 结构仍与既有 {step, skipped, doneAt} 兼容，v 只是附加标记（旧代码读到会忽略）。
 */
type StoredOnboarding = Onboarding & { v?: number };
const LEGACY_STEP_MAP: Record<number, number> = { 0: 0, 1: 2, 2: 4 };

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 当前空间的引导进度（preferences.onboarding 按空间 id 分键，用户 × 空间维度） */
function readOnboarding(prefs: Record<string, unknown>, wsId: string): Onboarding {
  const map = prefs[ONBOARDING_KEY] as Record<string, StoredOnboarding> | undefined;
  const cur = map?.[wsId];
  if (!cur) return { step: 0, skipped: false, doneAt: null };
  const skipped = cur.skipped === true;
  const rawStep = typeof cur.step === 'number' ? cur.step : 0;
  if (cur.v === 2) {
    return { step: Math.min(Math.max(rawStep, 0), TOTAL_STEPS), skipped, doneAt: cur.doneAt ?? null };
  }
  // 旧三步存量映射
  if (cur.doneAt || rawStep >= 3) {
    return { step: TOTAL_STEPS, skipped, doneAt: cur.doneAt ?? null };
  }
  return { step: LEGACY_STEP_MAP[rawStep] ?? 0, skipped, doneAt: null };
}

async function saveOnboarding(prefs: Record<string, unknown>, wsId: string, next: Onboarding) {
  const map: Record<string, StoredOnboarding> = {
    ...((prefs[ONBOARDING_KEY] as Record<string, StoredOnboarding> | undefined) ?? {}),
  };
  map[wsId] = { ...next, v: 2 };
  await putPreference(ONBOARDING_KEY, map);
  return { ...prefs, [ONBOARDING_KEY]: map };
}

/**
 * 快速开始五步卡（G-02 扩展，v1.3.0）：办公室页顶部。进度存 user_preferences.onboarding（用户 × 空间），
 * 可跳过（skipped 后不再出现），帮助页/设置页可重置重开（ReopenGuideButton）。
 * 行为步自动判定：② 任一 API balanceYuan>0（自有采购或体验额度都算）/ ③ 已有任务 / ⑤ 已有已完成任务可收尾；
 * 手动步：① 滚到能力货架、④ 打开任务墙后推进。试跑走现有 skill dispatch 真任务真记账。
 */
export function OnboardingCard() {
  const { S, post, toast, refresh, currentWorkspace, openDialog } = useApp();
  const wsId = currentWorkspace?.id ?? S?.workspace?.id ?? '';
  const [prefs, setPrefs] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPrefs(await fetchPreferences());
    } catch {
      setPrefs({});
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, wsId]);

  const ob = prefs && wsId ? readOnboarding(prefs, wsId) : null;
  const hasBalance = !!S && S.apis.some((a) => a.balanceYuan > 0);
  const hasTasks = !!S && S.tasks.length > 0;
  const hasDone = !!S && S.tasks.some((t) => t.status === '已完成');

  // 行为联动：当前步的行为条件已满足时自动推进（只前进不回退；第 5 步由「完成引导」手动收尾）
  useEffect(() => {
    if (!S || !prefs || !wsId || !ob) return;
    if (ob.skipped || ob.doneAt || ob.step >= TOTAL_STEPS) return;
    if (ob.step === 1 && hasBalance) {
      saveOnboarding(prefs, wsId, { step: 2, skipped: false, doneAt: null })
        .then(setPrefs)
        .catch(() => {});
    } else if (ob.step === 2 && hasTasks) {
      saveOnboarding(prefs, wsId, { step: 3, skipped: false, doneAt: null })
        .then(setPrefs)
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [S, prefs, wsId, hasBalance, hasTasks]);

  if (!S || !wsId || prefs === null || !ob) return null;
  if (ob.skipped || ob.doneAt || ob.step >= TOTAL_STEPS) return null;

  const update = async (next: Onboarding) => {
    try {
      setPrefs(await saveOnboarding(prefs, wsId, next));
    } catch {
      toast('引导进度保存失败，稍后重试');
    }
  };
  const advanceTo = (step: number) =>
    update({
      step: Math.max(ob.step, step),
      skipped: false,
      doneAt: step >= TOTAL_STEPS ? new Date().toISOString() : ob.doneAt,
    });

  async function trialRun() {
    if (!S) return;
    setBusy(true);
    try {
      const skills = await fetchSkills();
      // 优先本空间已安装的官方技能副本，其次能力货架推荐位里已安装的
      const copy =
        skills.find((s) => s.workspaceId === wsId && s.sourceSkillId && s.status === 'published') ??
        skills.find((s) => s.workspaceId === wsId && s.status === 'published');
      const teamId = S!.teams[0]?.id;
      if (!copy || !teamId) {
        toast('还没有可试跑的技能，先到技能页安装一个官方技能');
        return;
      }
      await post(`/api/skills/${copy.id}/dispatch`, {
        params: copy.exampleInput ?? {},
        teamId,
      });
      toast(`已用「${copy.name}」的示例参数发出第一单，去任务墙看它开工`);
      await advanceTo(3);
      refresh();
    } catch {
      /* post 已 toast 后端原文 */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2>
        🚀 快速开始 <span className="tag">照着做，10 分钟跑通第一单</span>
        <Button
          size="small"
          variant="gray"
          style={{ marginLeft: 10 }}
          onClick={() => update({ ...ob, skipped: true })}
        >
          跳过引导
        </Button>
      </h2>
      <Stepper steps={STEPS} current={Math.min(ob.step, TOTAL_STEPS - 1)} />
      {ob.step === 0 && (
        <div>
          <p className="hint">先花一分钟认识团队：每位成员负责一种工种，发单时会自动派给对口的人。</p>
          <Button
            onClick={() => {
              scrollToId('capabilities-shelf');
              void advanceTo(1);
            }}
          >
            看看团队能干什么 ↓
          </Button>
        </div>
      )}
      {ob.step === 1 && (
        <div>
          <p className="hint">
            团队开工要先有可用的 API 和余额，两条路二选一：一是填自己的 API Key 并在成本中心采购充值；
            二是等平台管理员给本空间发放体验额度（已发放的话这一步会自动打勾）。
          </p>
          <Button onClick={() => openDialog('settings')}>去填 API Key</Button>{' '}
          <Button variant="gray" onClick={() => openDialog('cost')}>
            看成本中心
          </Button>
        </div>
      )}
      {ob.step === 2 && (
        <div>
          <p className="hint">
            发出你的第一单：可以用模板一键套用发单，也可以拿官方技能的示例参数一键试跑（真任务、走正常记账）。
          </p>
          <Button onClick={() => openDialog('publish')}>用模板发一单</Button>{' '}
          <Button variant="gray" onClick={trialRun} disabled={busy}>
            {busy ? <Spinner label="正在发单…" /> : '一键试跑官方技能'}
          </Button>
        </div>
      )}
      {ob.step === 3 && (
        <div>
          <p className="hint">
            打开任务墙，点开任意一个任务，就能看它的过程时间线：谁领的单、注入了哪些知识、每一步花了多少。
          </p>
          <Button
            onClick={() => {
              openDialog('tasks', { section: 'taskwall' });
              void advanceTo(4);
            }}
          >
            打开任务墙
          </Button>
        </div>
      )}
      {ob.step === 4 && (
        <div>
          <p className="hint">
            {hasDone
              ? '第一单已经完成并通过审核！去看成果，顺手给它打个「有效/无效」标记，第一圈就跑通了。'
              : '第一单还在干活或审核中，完成后成果会出现在这里。审核成员会按审核标准逐条核对，不过关会打回重做。'}
          </p>
          <Button variant="green" onClick={() => openDialog('tasks', { section: 'results' })}>
            看成果
          </Button>
          {hasDone && (
            <Button variant="gray" style={{ marginLeft: 8 }} onClick={() => void advanceTo(TOTAL_STEPS)}>
              完成引导
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * 重开引导按钮（v1.3.0）：把当前空间的引导进度重置为五步版起点，回到办公室即可重走。
 * 帮助中心与设置页共用此组件（自带取数/写回，不依赖页面状态）。
 */
export function ReopenGuideButton() {
  const { S, toast, currentWorkspace } = useApp();
  const wsId = currentWorkspace?.id ?? S?.workspace?.id ?? '';

  async function reset() {
    if (!wsId) return toast('当前没有空间');
    try {
      const prefs = await fetchPreferences();
      const map: Record<string, StoredOnboarding> = {
        ...((prefs[ONBOARDING_KEY] as Record<string, StoredOnboarding> | undefined) ?? {}),
      };
      map[wsId] = { step: 0, skipped: false, doneAt: null, v: 2 };
      await putPreference(ONBOARDING_KEY, map);
      toast('引导已重置，回到办公室就能看到');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <Button size="small" variant="gray" onClick={reset}>
      重走新手引导
    </Button>
  );
}

/**
 * 能力货架「团队能干什么」（G-02）：办公室画布下方新区块，数据来自 /api/state 的 capabilities 段。
 * 成员能力卡网格 + 官方技能推荐卡（未安装显示「安装」、已安装显示「发一单」）。
 */
export function CapabilitiesShelf() {
  const { S, post, toast, refresh, currentWorkspace, openDialog } = useApp();
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    fetchSkills().then(setSkills).catch(() => setSkills([]));
  }, [S]);

  if (!S) return null;
  const caps = S.capabilities;
  const wsId = currentWorkspace?.id ?? S.workspace?.id ?? '';

  async function install(skillId: string, name: string) {
    setBusyId(skillId);
    try {
      await post(`/api/skills/${skillId}/install`, {});
      toast(`「${name}」已安装到本空间`);
      refresh();
    } catch {
      /* post 已 toast */
    } finally {
      setBusyId('');
    }
  }

  async function dispatchOne(skillId: string, installedCopyId: string | null, name: string) {
    const copyId = installedCopyId ?? skillId;
    const skill = skills.find((s) => s.id === copyId);
    const teamId = S!.teams[0]?.id;
    if (!teamId) return toast('还没有小组，先去设置后台建组');
    setBusyId(skillId);
    try {
      await post(`/api/skills/${copyId}/dispatch`, {
        params: skill?.exampleInput ?? {},
        teamId,
      });
      toast(`已用「${name}」发了一单，去任务墙看进度`);
      refresh();
      openDialog('tasks', { section: 'taskwall' });
    } catch {
      /* post 已 toast 后端原文（含必填参数缺失等） */
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="card" id="capabilities-shelf">
      <h2>团队能干什么 <span className="tag">成员能力卡 + 官方技能推荐；安装后即可发单</span></h2>
      <h3 style={{ margin: '4px 0 8px', fontSize: 14 }}>成员能力卡（{caps?.members.length ?? 0} 人）</h3>
      {caps && caps.members.length ? (
        <div className="shelf-grid">
          {caps.members.map((m) => (
            <div className="shelf-card" key={m.memberId}>
              <span className="tt">{m.name}</span>
              <Badge>{m.roleName}</Badge>
              {m.skillTags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              <div className="meta">{m.personaFirstLine || '（暂无人设说明）'}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">暂无成员数据。</p>
      )}
      <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>官方技能推荐</h3>
      {caps && caps.recommendedSkills.length ? (
        <div className="shelf-grid">
          {caps.recommendedSkills.map((s) => (
            <div className="shelf-card" key={s.skillId}>
              <span className="tt">{s.name}</span>
              <Badge>{s.role}</Badge>
              {s.installed ? <Badge variant="done">已安装</Badge> : <Badge>平台库</Badge>}
              <div className="meta">{s.description || '（无说明）'}</div>
              <div style={{ marginTop: 8 }}>
                {s.installed ? (
                  <Button
                    size="small"
                    disabled={busyId === s.skillId}
                    onClick={() => dispatchOne(s.skillId, s.installedCopyId, s.name)}
                  >
                    发一单
                  </Button>
                ) : (
                  <Button
                    size="small"
                    variant="blue"
                    disabled={busyId === s.skillId}
                    onClick={() => install(s.skillId, s.name)}
                  >
                    安装
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">平台库暂无官方技能。</p>
      )}
      <span className="hint" style={{ display: 'none' }} data-ws={wsId} />
    </div>
  );
}
