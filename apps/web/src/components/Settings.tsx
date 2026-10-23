import { useState } from 'react';
import { useApp } from '../context';
import type { ApiItem, Team } from '../types';

const PROVIDERS = ['deepseek', 'openai', 'anthropic', 'custom'];

/* ---------------- API 表单 ---------------- */
function ApiForm({
  api,
  onDone,
}: {
  api: ApiItem | null; // null = 新增草稿
  onDone: () => Promise<void>;
}) {
  const { presets, post, toast } = useApp();
  const [name, setName] = useState(api ? api.name : '');
  const [provider, setProvider] = useState(api ? api.provider : 'deepseek');
  const [baseUrl, setBaseUrl] = useState(api ? api.baseUrl : '');
  const [model, setModel] = useState(api ? api.model : '');
  const [apiKey, setApiKey] = useState('');
  const [pricePerM, setPricePerM] = useState<string>(String(api ? api.pricePerM : 2));

  function onProviderChange(p: string) {
    setProvider(p as ApiItem['provider']);
    // 与原生版 presetFill 一致：预设有值才带出
    const preset = presets[p];
    if (!preset) return;
    if (preset.baseUrl) setBaseUrl(preset.baseUrl);
    if (preset.model) setModel(preset.model);
  }

  async function saveApi() {
    try {
      await post('/api/apis/save', {
        api: {
          id: api ? api.id : undefined,
          name: name.trim(),
          provider,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          pricePerM: parseFloat(pricePerM) || 0,
          apiKey,
        },
      });
    } catch { return; }
    toast('API 已保存');
    await onDone();
  }
  async function clearApiKey() {
    if (!api) return;
    try {
      await post('/api/apis/save', { api: { id: api.id, name: api.name, clearKey: true } });
    } catch { return; }
    toast('Key 已清除');
    await onDone();
  }
  async function deleteApi() {
    if (!api) return;
    if (!window.confirm('删除这条 API？')) return;
    try {
      await post('/api/apis/delete', { id: api.id });
    } catch { return; }
    await onDone();
  }

  return (
    <div className="apicard">
      <div className="row">
        <div>
          <label>名称</label>
          <input value={name} placeholder="如：DeepSeek 主力" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>服务商预设</label>
          <select value={provider} onChange={(e) => onProviderChange(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div>
          <label>Base URL（预设自动带出，可改）</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <label>模型</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div>
          <label>API Key（密码框；留空 = 不修改）</label>
          <input
            type="password"
            placeholder={api && api.hasKey ? `已保存：${api.apiKeyMasked}` : '尚未填写'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label>采购单价（元/百万 token）</label>
          <input type="number" step="0.01" min="0" value={pricePerM} onChange={(e) => setPricePerM(e.target.value)} />
        </div>
        <div>
          <label>余额（元，到成本中心充值）</label>
          <input value={api ? api.balanceYuan : 0} disabled readOnly />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={saveApi}>保存</button>{' '}
        {api && (
          <>
            <button className="btn small gray" onClick={clearApiKey}>清除 Key</button>{' '}
            <button className="btn small gray" onClick={deleteApi}>删除</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- 小组表单 ---------------- */
function TeamForm({
  team,
  onDone,
}: {
  team: Team | null; // null = 新建草稿
  onDone: () => Promise<void>;
}) {
  const { S, post, toast } = useApp();
  const [name, setName] = useState(team ? team.name : '');
  const [color, setColor] = useState(team ? team.color || '#e2574c' : '#5b8def');
  const [apiId, setApiId] = useState(team ? team.apiId || '' : '');
  if (!S) return null;

  async function saveTeam() {
    try {
      await post('/api/teams/save', {
        team: {
          id: team ? team.id : undefined,
          name: name.trim(),
          color,
          apiId: apiId || null,
        },
      });
    } catch { return; }
    toast('小组已保存');
    await onDone();
  }
  async function deleteTeam() {
    if (!team) return;
    if (!window.confirm('删除该小组及其成员？（已产生的任务与账本保留）')) return;
    try {
      await post('/api/teams/delete', { id: team.id });
    } catch { return; }
    await onDone();
  }

  return (
    <div className="apicard">
      <div className="row">
        <div>
          <label>组名</label>
          <input value={name} placeholder={team ? undefined : '如：内容组'} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>地毯颜色</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
        <div>
          <label>使用 API</label>
          <select value={apiId} onChange={(e) => setApiId(e.target.value)}>
            <option value="">跟随公司默认</option>
            {S.apis.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn small blue" onClick={saveTeam}>{team ? '保存' : '创建小组'}</button>{' '}
        {team && (
          <button className="btn small gray" onClick={deleteTeam}>删除小组</button>
        )}
      </div>
    </div>
  );
}

/* ---------------- 设置后台整页 ---------------- */
export default function Settings() {
  const { S, post, refresh, toast } = useApp();
  // 与原生版一致：设置页内保存/删除后，按服务端最新数据整体重渲染表单
  const [epoch, setEpoch] = useState(0);
  const [apiDrafts, setApiDrafts] = useState<number[]>([]);
  const [teamDrafts, setTeamDrafts] = useState<number[]>([]);
  const [draftSeq, setDraftSeq] = useState(1);
  const [defaultApi, setDefaultApi] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState<string | null>(null);
  const [budget, setBudget] = useState<string | null>(null);

  if (!S) return null;

  const rerender = async () => {
    await refresh();
    setEpoch((e) => e + 1);
    setDefaultApi(null);
    setConcurrency(null);
    setBudget(null);
  };

  async function saveDefaultApi() {
    try {
      await post('/api/settings/default-api', { apiId: defaultApi ?? S!.defaultApiId });
    } catch { return; }
    toast('默认 API 已保存');
    refresh();
  }
  async function saveParams() {
    try {
      await post('/api/settings/params', {
        concurrency: parseInt(concurrency ?? String(S!.params.concurrency), 10),
        taskBudgetTokens: parseInt(budget ?? String(S!.params.taskBudgetTokens), 10),
      });
    } catch { return; }
    toast('参数已保存');
    refresh();
  }

  return (
    <>
      <div className="card">
        <h2>API 配置 <span className="tag">至少填一个 API 的 Key 才能开工 · Key 只保存在本机 data/settings.json，请勿外传该文件夹</span></h2>
        <div>
          {S.apis.map((a) => (
            <ApiForm key={`api-${a.id}-${epoch}`} api={a} onDone={rerender} />
          ))}
          {apiDrafts.map((d) => (
            <ApiForm
              key={`apidraft-${d}`}
              api={null}
              onDone={async () => {
                setApiDrafts((ds) => ds.filter((x) => x !== d));
                await rerender();
              }}
            />
          ))}
        </div>
        <button
          className="btn gray"
          onClick={() => {
            setApiDrafts((ds) => [...ds, draftSeq]);
            setDraftSeq((n) => n + 1);
          }}
        >
          ＋ 新增一条 API
        </button>
      </div>

      <div className="card">
        <h2>小组管理</h2>
        <div>
          {S.teams.map((t) => (
            <TeamForm key={`team-${t.id}-${epoch}`} team={t} onDone={rerender} />
          ))}
          {teamDrafts.map((d) => (
            <TeamForm
              key={`teamdraft-${d}`}
              team={null}
              onDone={async () => {
                setTeamDrafts((ds) => ds.filter((x) => x !== d));
                await rerender();
              }}
            />
          ))}
        </div>
        <button
          className="btn gray"
          onClick={() => {
            setTeamDrafts((ds) => [...ds, draftSeq]);
            setDraftSeq((n) => n + 1);
          }}
        >
          ＋ 新建小组
        </button>
        <label style={{ marginTop: 14 }}>公司默认 API（小组未单独指定时使用）</label>
        <div className="row">
          <select
            value={defaultApi ?? S.defaultApiId ?? ''}
            onChange={(e) => setDefaultApi(e.target.value)}
          >
            {S.apis.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button className="btn blue" style={{ flex: '0 0 120px' }} onClick={saveDefaultApi}>保存默认</button>
        </div>
      </div>

      <div className="card">
        <h2>运行参数</h2>
        <div className="row">
          <div>
            <label>全公司同时执行任务上限（并发闸门）</label>
            <input
              type="number"
              min="1"
              value={concurrency ?? String(S.params.concurrency)}
              onChange={(e) => setConcurrency(e.target.value)}
            />
          </div>
          <div>
            <label>单任务 token 预算上限（0 = 不限，超了停工待裁决）</label>
            <input
              type="number"
              min="0"
              value={budget ?? String(S.params.taskBudgetTokens)}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn blue" onClick={saveParams}>保存参数</button>
        </div>
      </div>

      <div className="card">
        <h2>数据管理</h2>
        <p className="hint">全部数据都在本机 data/ 目录的 JSON 文件里（settings.json / tasks.json / ledger.json / purchases.json）。备份 = 复制整个 data 文件夹；迁移 = 把文件夹拷到新电脑同一位置。没有云端副本，删了就没了。</p>
      </div>
    </>
  );
}
