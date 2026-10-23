import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchPipelineTemplates, fetchRegistry, fetchSchedules, fetchSkills } from '../api';
import AssetRefPicker from './AssetRefPicker';
import {
  SkillParamFields,
  cleanSkillParams,
  defaultSkillParams,
  type ParamValue,
} from './SkillParamFields';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  RadioGroup,
  RadioItem,
  Select,
  Switch,
  Textarea,
  useConfirm,
} from './ui';
import type {
  AssetRef,
  PipelineTemplate,
  RegistryTaskType,
  ScheduleItem,
  SkillListItem,
} from '../types';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
/** 组件层暂无 TimePicker：以 Select 组合时/分实现（分钟 5 分钟步进，见表单下注） */
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

const RESULT_LABEL: Record<string, { text: string; variant: 'done' | 'rej' | 'adj' }> = {
  dispatched: { text: '上次已发单', variant: 'done' },
  blocked: { text: '上次被拦截', variant: 'adj' },
  failed: { text: '上次发单失败', variant: 'rej' },
};

/** 下次运行的人话呈现：按计划时区格式化（如「周六 10月24日 09:00」） */
function fmtNextRun(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

interface FormState {
  kind: 'skill' | 'pipeline' | 'task';
  skillId: string;
  templateId: string;
  teamId: string;
  title: string;
  brief: string;
  type: string;
  params: Record<string, ParamValue>;
  assetRefs: AssetRef[];
  freq: 'daily' | 'weekly';
  weekday: number;
  hour: string;
  minute: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  kind: 'skill',
  skillId: '',
  templateId: '',
  teamId: '',
  title: '',
  brief: '',
  type: '文案',
  params: {},
  assetRefs: [],
  freq: 'daily',
  weekday: 1,
  hour: '09',
  minute: '00',
  enabled: true,
};

/**
 * 定时任务页（G-10）：计划列表（下次运行人话呈现/启停/删除）+ 新建/编辑表单。
 * 到点由服务端调度器按与手动完全相同的路径发单；定时单与手动单在状态机/守卫/账本上零区别。
 * 注意：计划仅在平台运行期间生效（服务停机期间到点不发，恢复后只补最近一次）。
 */
export default function Schedules() {
  const { S, post, send, toast, teamName, schedulePrefill, clearSchedulePrefill } = useApp();
  const { ask, confirmNode } = useConfirm();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [taskTypes, setTaskTypes] = useState<RegistryTaskType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleItem | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const load = useCallback(async () => {
    try {
      setSchedules(await fetchSchedules());
    } catch {
      /* 拉取失败保持空列表，下方有空态 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    fetchSkills().then(setSkills).catch(() => setSkills([]));
    fetchPipelineTemplates().then(setTemplates).catch(() => setTemplates([]));
    fetchRegistry().then((r) => setTaskTypes(r.taskTypes)).catch(() => setTaskTypes([]));
  }, [load]);

  useEffect(() => {
    if (S && S.teams.length) {
      setForm((f) => (S.teams.some((t) => t.id === f.teamId) ? f : { ...f, teamId: S.teams[0].id }));
    }
  }, [S]);

  const publishedSkills = skills.filter(
    (s) => s.status === 'published' && (s.workspaceId === S?.workspace?.id || !!s.installedCopyId),
  );
  const formSkill = skills.find((s) => s.id === form.skillId) ?? null;
  const formTemplate = templates.find((t) => t.id === form.templateId) ?? null;

  /* ---------- 表单打开（新建 / 预填 / 编辑） ---------- */
  function openCreate() {
    setEditing(null);
    let f: FormState = { ...EMPTY_FORM, teamId: S?.teams[0]?.id ?? '' };
    if (schedulePrefill) {
      const p = schedulePrefill;
      f = {
        ...f,
        kind: p.kind,
        skillId: p.skillId ?? '',
        templateId: p.pipelineTemplateId ?? '',
        teamId: p.teamId ?? f.teamId,
        assetRefs: p.assetRefs ?? [],
        params: Object.fromEntries(
          Object.entries(p.params ?? {}).filter(
            (e): e is [string, ParamValue] =>
              typeof e[1] === 'string' || typeof e[1] === 'number' || typeof e[1] === 'boolean',
          ),
        ),
      };
      clearSchedulePrefill();
    }
    if (f.kind === 'skill' && !f.skillId && publishedSkills.length) {
      f.skillId = publishedSkills[0].id;
      const sk = publishedSkills[0];
      f.params = { ...defaultSkillParams(sk.inputSchema ?? []), ...f.params };
    }
    if (f.kind === 'pipeline' && !f.templateId && templates.length) f.templateId = templates[0].id;
    setForm(f);
    setFormOpen(true);
  }

  function openEdit(s: ScheduleItem) {
    setEditing(s);
    const [hour = '09', minute = '00'] = s.timeLocal.split(':');
    const rawParams = (s.params ?? {}) as Record<string, unknown>;
    const { assetRefs, ...rest } = rawParams;
    setForm({
      kind: s.kind,
      skillId: s.skillId ?? '',
      templateId: s.pipelineTemplateId ?? '',
      teamId: s.teamId,
      title: s.title,
      brief: s.brief,
      type: s.type,
      params: Object.fromEntries(
        Object.entries(rest).filter(
          (e): e is [string, ParamValue] =>
            typeof e[1] === 'string' || typeof e[1] === 'number' || typeof e[1] === 'boolean',
        ),
      ),
      assetRefs: Array.isArray(assetRefs) ? (assetRefs as AssetRef[]) : [],
      freq: s.freq,
      weekday: s.weekday ?? 1,
      hour,
      minute,
      enabled: s.enabled,
    });
    setFormOpen(true);
  }

  async function submit() {
    if (!form.teamId) return toast('先选小组');
    const body: Record<string, unknown> = {
      kind: form.kind,
      teamId: form.teamId,
      freq: form.freq,
      weekday: form.freq === 'weekly' ? form.weekday : undefined,
      timeLocal: `${form.hour}:${form.minute}`,
      timezone: 'Asia/Shanghai',
      enabled: form.enabled,
    };
    if (form.kind === 'skill') {
      if (!formSkill) return toast('先选一个已发布的 skill');
      for (const f of formSkill.inputSchema ?? []) {
        const v = form.params[f.key];
        if (f.required && (v === '' || v === undefined)) return toast(`参数「${f.label}」必填`);
      }
      body.skillId = formSkill.id;
      body.title = form.title.trim() || undefined;
      body.params = cleanSkillParams(formSkill.inputSchema ?? [], form.params);
      body.assetRefs = form.assetRefs.length ? form.assetRefs : undefined;
    } else if (form.kind === 'pipeline') {
      if (!formTemplate) return toast('先选流水线模板');
      for (const p of formTemplate.commonParams) {
        if (p.required && !String(form.params[p.key] ?? '').trim()) {
          return toast(`公共参数「${p.label}」必填`);
        }
      }
      body.pipelineTemplateId = formTemplate.id;
      body.title = form.title.trim() || undefined;
      body.params = Object.fromEntries(
        Object.entries(form.params).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
      );
    } else {
      if (!form.title.trim()) return toast('先填任务标题');
      body.title = form.title.trim();
      body.brief = form.brief;
      body.type = form.type;
      body.assetRefs = form.assetRefs.length ? form.assetRefs : undefined;
    }
    try {
      if (editing) {
        await send('PUT', `/api/schedules/${editing.id}`, body);
        toast('定时计划已更新');
      } else {
        await post('/api/schedules', body);
        toast('定时计划已创建，到点自动发单');
      }
    } catch {
      return;
    }
    setFormOpen(false);
    setEditing(null);
    load();
  }

  async function toggle(s: ScheduleItem, enabled: boolean) {
    try {
      await send('PUT', `/api/schedules/${s.id}`, { enabled });
    } catch {
      return;
    }
    toast(enabled ? '计划已启用' : '计划已停用（停用期间到点不发单）');
    load();
  }

  function remove(s: ScheduleItem) {
    ask({
      title: '删除定时计划',
      message: `删除计划「${s.title}」？删除后到点不再发单（已发出的任务不受影响）。`,
      confirmLabel: '删除',
      onConfirm: async () => {
        try {
          await send('DELETE', `/api/schedules/${s.id}`);
        } catch {
          return;
        }
        toast('计划已删除');
        load();
      },
    });
  }

  if (!S) return null;

  const targetName = (s: ScheduleItem): string => {
    if (s.kind === 'skill') return skills.find((x) => x.id === s.skillId)?.name ?? 'skill';
    if (s.kind === 'pipeline') return templates.find((x) => x.id === s.pipelineTemplateId)?.name ?? '流水线';
    return s.type;
  };
  const freqText = (s: ScheduleItem): string =>
    s.freq === 'daily' ? `每天 ${s.timeLocal}` : `每${WEEKDAYS[s.weekday ?? 0]} ${s.timeLocal}`;

  return (
    <>
      <div className="card">
        <h2>
          定时任务{' '}
          <span className="tag">到点替你按下发单钮：定时单与手动单走同一条发单路径、同一套守卫与账本</span>
        </h2>
        <p className="hint">
          平台运行期间生效：服务停机期间到点不会发单，恢复后只补最近一次。被余额/Key
          守卫拦截时不会建单，计划上会记「被拦截」并给你发站内通知；发单成功不逐次通知。
        </p>
        <div style={{ marginTop: 10 }}>
          <Button onClick={openCreate}>＋ 新建定时计划</Button>
        </div>
        {loaded && schedules.length === 0 && (
          <EmptyState
            example={<div className="hint">例：每天 09:00 自动用「爆款标题」skill 给新剧发一单。</div>}
            action={<Button size="small" onClick={openCreate}>建第一个计划</Button>}
          >
            还没有定时计划。把每天/每周都要重复发的活设成计划，到点自动进任务墙。
          </EmptyState>
        )}
        <div>
          {schedules.map((s) => (
            <div className="task schedule-row" key={s.id}>
              <span className="tt">{s.title}</span>
              <Badge>{s.kind === 'skill' ? 'skill' : s.kind === 'pipeline' ? '流水线' : '普通任务'}</Badge>
              <Badge>{targetName(s)}</Badge>
              <span className="hint">
                {freqText(s)} · {teamName(s.teamId)} · 下次运行：{fmtNextRun(s.nextRunAt, s.timezone)}（{s.timezone}）
              </span>
              {s.lastResult && (
                <Badge variant={RESULT_LABEL[s.lastResult]?.variant ?? 'adj'}>
                  {RESULT_LABEL[s.lastResult]?.text ?? s.lastResult}
                </Badge>
              )}
              <span className="schedule-actions">
                <Switch
                  checked={s.enabled}
                  onCheckedChange={(on) => toggle(s, on)}
                  ariaLabel={`启停计划 ${s.title}`}
                />
                <Button size="small" variant="gray" onClick={() => openEdit(s)}>编辑</Button>
                <Button size="small" variant="gray" onClick={() => remove(s)}>删除</Button>
              </span>
            </div>
          ))}
        </div>
      </div>

      {formOpen && (
        <Dialog
          open
          onClose={() => setFormOpen(false)}
          title={editing ? `编辑定时计划 · ${editing.title}` : '新建定时计划'}
          wide={640}
        >
          <label>发单目标</label>
          <RadioGroup
            value={form.kind}
            onValueChange={(v) => setForm({ ...form, kind: v as FormState['kind'] })}
            ariaLabel="发单目标"
          >
            <RadioItem value="skill">用 skill 发单</RadioItem>
            <RadioItem value="pipeline">跑流水线</RadioItem>
            <RadioItem value="task">普通任务</RadioItem>
          </RadioGroup>

          {form.kind === 'skill' && (
            <>
              <label>选 skill（仅已发布）</label>
              <Select
                value={form.skillId}
                onValueChange={(v) => {
                  const sk = skills.find((x) => x.id === v);
                  setForm({
                    ...form,
                    skillId: v,
                    params: sk ? defaultSkillParams(sk.inputSchema ?? []) : {},
                    assetRefs: [],
                  });
                }}
                placeholder="请选择 skill"
                options={publishedSkills.map((s) => ({ value: s.id, label: `${s.name}（v${s.version}）` }))}
              />
              {formSkill && (
                <SkillParamFields
                  fields={formSkill.inputSchema ?? []}
                  values={form.params}
                  onChange={(params) => setForm({ ...form, params })}
                />
              )}
              <label>资产引用（可选，到点发单时按当时版本落快照注入）</label>
              <AssetRefPicker
                value={form.assetRefs}
                onChange={(assetRefs) => setForm({ ...form, assetRefs })}
              />
            </>
          )}

          {form.kind === 'pipeline' && (
            <>
              <label>选流水线模板</label>
              <Select
                value={form.templateId}
                onValueChange={(v) => setForm({ ...form, templateId: v, params: {} })}
                placeholder="请选择模板"
                options={templates.map((t) => ({ value: t.id, label: t.name }))}
              />
              {formTemplate &&
                formTemplate.commonParams.map((p) => (
                  <div key={p.key}>
                    <label>
                      {p.label}
                      {p.required ? ' *' : ''}
                    </label>
                    <Input
                      value={String(form.params[p.key] ?? '')}
                      onChange={(e) => setForm({ ...form, params: { ...form.params, [p.key]: e.target.value } })}
                      placeholder={p.key}
                    />
                  </div>
                ))}
            </>
          )}

          {form.kind === 'task' && (
            <>
              <label>任务标题 *</label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="如：每日选题汇总"
              />
              <div className="row">
                <div>
                  <label>任务类型</label>
                  <Select
                    value={form.type}
                    onValueChange={(v) => setForm({ ...form, type: v })}
                    options={(taskTypes.length ? taskTypes : [{ typeId: '文案' }]).map((t) => ({
                      value: t.typeId,
                      label: t.typeId,
                    }))}
                  />
                </div>
                <div>
                  <label>交给哪个小组</label>
                  <Select
                    value={form.teamId}
                    onValueChange={(v) => setForm({ ...form, teamId: v })}
                    options={S.teams.map((t) => ({ value: t.id, label: t.name }))}
                  />
                </div>
              </div>
              <label>任务说明</label>
              <Textarea
                rows={3}
                value={form.brief}
                onChange={(e) => setForm({ ...form, brief: e.target.value })}
              />
              <label>资产引用（可选，到点发单时按当时版本落快照注入）</label>
              <AssetRefPicker
                value={form.assetRefs}
                onChange={(assetRefs) => setForm({ ...form, assetRefs })}
              />
            </>
          )}

          {form.kind !== 'task' && (
            <>
              <label>{form.kind === 'skill' ? '计划名（可空，默认用 skill 名）' : '项目名（可空，默认用模板名）'}</label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
              <label>交给哪个小组</label>
              <Select
                value={form.teamId}
                onValueChange={(v) => setForm({ ...form, teamId: v })}
                options={S.teams.map((t) => ({ value: t.id, label: t.name }))}
              />
            </>
          )}

          <label>周期</label>
          <RadioGroup
            value={form.freq}
            onValueChange={(v) => setForm({ ...form, freq: v as FormState['freq'] })}
            ariaLabel="周期"
          >
            <RadioItem value="daily">每天</RadioItem>
            <RadioItem value="weekly">每周</RadioItem>
          </RadioGroup>
          {form.freq === 'weekly' && (
            <>
              <label>星期</label>
              <Select
                value={String(form.weekday)}
                onValueChange={(v) => setForm({ ...form, weekday: Number(v) })}
                options={WEEKDAYS.map((label, i) => ({ value: String(i), label }))}
              />
            </>
          )}
          <label>时间（时 / 分，分钟为 5 分钟步进；组件层暂无时间选择器，以组合选择实现）</label>
          <div className="row">
            <Select
              value={form.hour}
              onValueChange={(v) => setForm({ ...form, hour: v })}
              options={HOURS.map((h) => ({ value: h, label: `${h} 时` }))}
            />
            <Select
              value={form.minute}
              onValueChange={(v) => setForm({ ...form, minute: v })}
              options={MINUTES.map((m) => ({ value: m, label: `${m} 分` }))}
            />
          </div>
          <p className="hint">时区：Asia/Shanghai（随空间设置）；计划仅在平台运行期间生效。</p>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button onClick={submit}>{editing ? '保存计划' : '创建计划'}</Button>
            <Button variant="gray" onClick={() => setFormOpen(false)}>取消</Button>
            <span className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Switch
                checked={form.enabled}
                onCheckedChange={(on) => setForm({ ...form, enabled: on })}
                ariaLabel="创建后启用"
              />
              启用
            </span>
          </div>
        </Dialog>
      )}
      {confirmNode}
    </>
  );
}
