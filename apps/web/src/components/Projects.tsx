import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchPipelineTemplates } from '../api';
import { yuan } from '../utils';
import { Badge, Button, Input, Select, type BadgeVariant } from './ui';
import type { PipelineTemplate } from '../types';

const projChipCls: Record<string, BadgeVariant> = {
  '已交付': 'done',
  '待裁决': 'adj',
  '进行中': 'run',
};

const taskChipCls: Record<string, BadgeVariant> = {
  '已完成': 'done',
  '执行中': 'run',
  '待审核': 'rev',
  '被打回': 'rej',
  '待裁决': 'adj',
  '已取消': 'can',
};

/** 点子任务行 → 滚动到任务墙对应卡片并闪烁定位 */
function jumpToTask(taskId: string) {
  const el = document.getElementById(`task-${taskId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  window.setTimeout(() => el.classList.remove('flash'), 1600);
}

/**
 * 项目视图（M5）：方案下发的项目制容器。
 * 进度 = 子任务完成数/总数；总账取服务端聚合（子任务账本 + 拆单调用那笔，见 state.projects）；
 * 状态聚合与 §15.2 一致（任一子任务待裁决→待裁决，全部完成→已交付），由服务端维护、前端只展示。
 */
export default function Projects() {
  const { S } = useApp();
  if (!S) return null;
  return (
    <>
      <PipelineCard />
      <ProjectList />
    </>
  );
}

/**
 * 成套流水线入口（M8 §11.1）：选模板 → 按 commonParams 渲染公共参数表单 → 一键生成项目 + 子任务。
 * 模板步骤的 available 由服务端按本空间可见 skill 标注，缺 skill 的步骤标红提示（先去技能页安装）。
 */
function PipelineCard() {
  const { S, post, toast, refresh } = useApp();
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [name, setName] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const ts = await fetchPipelineTemplates();
      setTemplates(ts);
      setTemplateId((cur) => (cur && ts.some((t) => t.id === cur) ? cur : ts[0]?.id ?? ''));
    } catch {
      /* 拉取失败保持空 */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (S && S.teams.length && !S.teams.some((t) => t.id === teamId)) {
      setTeamId(S.teams[0].id);
    }
  }, [S, teamId]);

  if (!S) return null;
  const tpl = templates.find((t) => t.id === templateId) ?? null;

  async function run() {
    if (!tpl) return toast('先选流水线模板');
    if (!teamId) return toast('先选小组');
    for (const p of tpl.commonParams) {
      if (p.required && !(params[p.key] ?? '').trim()) return toast(`公共参数「${p.label}」必填`);
    }
    let res: Record<string, unknown>;
    try {
      res = await post('/api/pipelines/run', {
        templateId: tpl.id,
        teamId,
        name: name.trim() || undefined,
        params,
      });
    } catch { return; }
    const n = Array.isArray(res.taskIds) ? res.taskIds.length : 0;
    toast(`流水线「${tpl.name}」已启动：生成 1 个项目 + ${n} 个子任务`);
    setName('');
    refresh();
  }

  return (
    <div className="card">
      <h2>成套流水线 <span className="tag">选模板填公共参数，一键生成整套项目与子任务（每步是一个 skill）</span></h2>
      {templates.length === 0 && <p className="hint">暂无流水线模板（或加载失败）。</p>}
      {templates.length > 0 && (
        <>
          <div className="row">
            <div>
              <label>流水线模板</label>
              <Select
                value={templateId}
                onValueChange={(v) => {
                  setTemplateId(v);
                  setParams({});
                }}
                options={templates.map((t) => ({
                  value: t.id,
                  label: `${t.name}${t.industry ? `（${t.industry}）` : ''}`,
                }))}
              />
            </div>
            <div>
              <label>交给哪个小组</label>
              <Select
                value={teamId}
                onValueChange={setTeamId}
                options={S.teams.map((t) => ({ value: t.id, label: t.name }))}
              />
            </div>
            <div>
              <label>项目名（可空，默认用模板名）</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tpl ? tpl.name : ''} />
            </div>
          </div>
          {tpl && (
            <>
              <p className="hint" style={{ marginTop: 6 }}>{tpl.description}</p>
              <div>
                {tpl.steps.map((s, i) => (
                  <div className="subtask" key={`${s.skillSlug}-${i}`} style={{ cursor: 'default' }}>
                    <span style={{ fontWeight: 700 }}>
                      {i + 1}. {s.title}
                    </span>
                    <Badge>{s.skillSlug}</Badge>
                    {s.available ? (
                      <Badge variant="done">skill 就绪</Badge>
                    ) : (
                      <Badge variant="rej">缺 skill · 先去技能页安装</Badge>
                    )}
                  </div>
                ))}
              </div>
              {tpl.commonParams.map((p) => (
                <div key={p.key}>
                  <label>
                    {p.label}
                    {p.required ? ' *' : ''}
                  </label>
                  <Input
                    value={params[p.key] ?? ''}
                    onChange={(e) => setParams({ ...params, [p.key]: e.target.value })}
                    placeholder={p.key}
                  />
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <Button onClick={run}>启动流水线</Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ProjectList() {
  const { S, teamName } = useApp();
  const [openId, setOpenId] = useState<string | null>(null);
  if (!S || !S.projects.length) return null;

  return (
    <div className="card">
      <h2>项目 <span className="tag">方案下发 · 组长拆单 · 进度与总账按子任务聚合</span></h2>
      <div>
        {[...S.projects].reverse().map((p) => {
          const children = S.tasks.filter((t) => t.projectId === p.id);
          const done = children.filter((t) => t.status === '已完成').length;
          const cancelled = children.filter((t) => t.status === '已取消').length;
          const pct = children.length ? Math.round((done / children.length) * 100) : 0;
          const open = openId === p.id;
          return (
            <div className="task" key={p.id}>
              <span className="tt">{p.name}</span>
              <Badge variant={projChipCls[p.status] ?? 'default'}>{p.status}</Badge>
              <div className="meta">
                {teamName(p.teamId)}
                {p.clientName ? ` · 甲方：${p.clientName}` : ''}
                {` · 子任务进度 ${done}/${children.length} 完成`}
                {cancelled ? `（含 ${cancelled} 个已取消）` : ''}
                {` · 项目总账 ${p.totalTokens || 0} token / ${yuan(p.totalCost)}（含拆单调用）`}
                {p.brief ? <><br />方案说明：{p.brief}</> : null}
              </div>
              <div className="pbar"><div style={{ width: `${pct}%` }} /></div>
              <div style={{ marginTop: 6 }}>
                <Button size="small" variant="gray" onClick={() => setOpenId(open ? null : p.id)}>
                  {open ? '收起子任务' : `展开子任务（${children.length}）`}
                </Button>
              </div>
              {open && (
                <div style={{ marginTop: 4 }}>
                  {children.length ? (
                    children.map((t) => (
                      <div
                        className="subtask"
                        key={t.id}
                        onClick={() => jumpToTask(t.id)}
                        title="点击定位到任务墙卡片"
                      >
                        <span style={{ fontWeight: 700 }}>{t.title}</span>
                        <Badge variant={taskChipCls[t.status] ?? 'default'}>{t.status}</Badge>
                        <Badge>{t.type}</Badge>
                        <span className="meta">{` · ${t.totalTokens || 0} token / ${yuan(t.totalCost)}`}</span>
                      </div>
                    ))
                  ) : (
                    <p className="hint">暂无子任务。</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
