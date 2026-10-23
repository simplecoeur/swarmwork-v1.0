import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchPreferences, fetchSkills, putPreference } from '../api';
import { Badge, Button, Card, Spinner, Stepper } from './ui';
import type { Onboarding, SkillListItem } from '../types';

const ONBOARDING_KEY = 'onboarding';

const STEPS = [
  { label: '认识你的团队', description: '看看每位成员的工种与拿手活（下方能力货架）' },
  { label: '一键试跑一单', description: '用官方技能的示例参数发一单真任务（走正常记账）' },
  { label: '查看成果', description: '任务完成后到成果库看产出' },
];

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 当前空间的引导进度（preferences.onboarding 按空间 id 分键，用户 × 空间维度） */
function readOnboarding(prefs: Record<string, unknown>, wsId: string): Onboarding {
  const map = prefs[ONBOARDING_KEY] as Record<string, Onboarding> | undefined;
  const cur = map?.[wsId];
  return {
    step: typeof cur?.step === 'number' ? cur.step : 0,
    skipped: cur?.skipped === true,
    doneAt: cur?.doneAt ?? null,
  };
}

async function saveOnboarding(prefs: Record<string, unknown>, wsId: string, next: Onboarding) {
  const map = { ...((prefs[ONBOARDING_KEY] as Record<string, Onboarding> | undefined) ?? {}) };
  map[wsId] = next;
  await putPreference(ONBOARDING_KEY, map);
  return { ...prefs, [ONBOARDING_KEY]: map };
}

/**
 * 新手三步卡（G-02）：办公室页顶部。进度存 user_preferences.onboarding（用户 × 空间），
 * 可跳过（skipped 后不再出现），帮助页可重置重开。② 试跑走现有 skill dispatch 真任务真记账。
 */
export function OnboardingCard() {
  const { S, post, toast, refresh, currentWorkspace } = useApp();
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

  if (!S || !wsId || prefs === null) return null;
  const ob = readOnboarding(prefs, wsId);
  if (ob.skipped || ob.step >= 3) return null;

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
      doneAt: step >= 3 ? new Date().toISOString() : ob.doneAt,
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
      await advanceTo(2);
      refresh();
      scrollToId('taskwall-anchor');
    } catch {
      /* post 已 toast 后端原文 */
    } finally {
      setBusy(false);
    }
  }

  const hasDone = S.tasks.some((t) => t.status === '已完成');

  return (
    <Card>
      <h2>
        👋 新手三步 <span className="tag">三步走完，你的 AI 团队就能正式开工</span>
        <Button
          size="small"
          variant="gray"
          style={{ marginLeft: 10 }}
          onClick={() => update({ ...ob, skipped: true })}
        >
          跳过引导
        </Button>
      </h2>
      <Stepper steps={STEPS} current={Math.min(ob.step, 2)} />
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
            用官方技能的示例参数发一单真任务试试水：会走正常队列与记账（有体验额度时从体验额度扣）。
          </p>
          <Button onClick={trialRun} disabled={busy}>
            {busy ? <Spinner label="正在发单…" /> : '一键试跑官方技能'}
          </Button>
        </div>
      )}
      {ob.step === 2 && (
        <div>
          <p className="hint">
            {hasDone
              ? '第一单已经完成！去成果库看看产出，顺手给它打个「有效/无效」标记。'
              : '第一单正在干活，完成后成果会进成果库。任务墙可以看实时进度与过程时间线。'}
          </p>
          <Button
            variant="green"
            onClick={() => {
              scrollToId('results-anchor');
              if (hasDone) void advanceTo(3);
            }}
          >
            去成果库看成果 ↓
          </Button>
          {hasDone && (
            <Button variant="gray" style={{ marginLeft: 8 }} onClick={() => void advanceTo(3)}>
              完成引导
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * 能力货架「团队能干什么」（G-02）：办公室画布下方新区块，数据来自 /api/state 的 capabilities 段。
 * 成员能力卡网格 + 官方技能推荐卡（未安装显示「安装」、已安装显示「发一单」）。
 */
export function CapabilitiesShelf() {
  const { S, post, toast, refresh, currentWorkspace } = useApp();
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
      scrollToId('taskwall-anchor');
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
