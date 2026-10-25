import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../context';
import { fetchAgentTemplates, recruitAgentTemplate, type AgentTemplateItem } from '../api';
import MarkdownView from './MarkdownView';
import { Badge, Button, EmptyState, Input, Select, Spinner } from './ui';

type SortMode = 'featured' | 'heat' | 'recent';

const HEAT_FORMULA_TEXT =
  '热度榜口径：榜单分 = 0.5 × 源仓库 stars 对数分 + 0.3 × 90 天新鲜度 + 0.2 × 平台内有效招募对数分' +
  '（有效招募 = 招募后 7 天成员仍在职、同空间去重），按月快照。';

/**
 * v1.4.0 J 官方人才库（弹窗内容）：GitHub 同步 + 管理员过审后的智能体模板。
 * 数据组件内自拉 GET /api/agent-templates（与 StylePanel 自拉风格一致），只见已上架 pub 快照。
 * 招募 = 选本空间小组 → POST recruit 生成真成员（人设全文落库）→ toast + refresh 全局 state。
 * v1.5.0 B/C：排序三档（精选榜/热度榜/最近更新）、「本月上新」区、卡片补源仓 stars/最近同步/待审更新灰标。
 */
export default function TalentLibrary() {
  const { S, toast, refresh, openDialog } = useApp();
  const [items, setItems] = useState<AgentTemplateItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [openId, setOpenId] = useState('');
  const [teamByTpl, setTeamByTpl] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState('');
  const [recruited, setRecruited] = useState<{ tplId: string; memberId: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await fetchAgentTemplates());
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const [sort, setSort] = useState<SortMode>('featured');
  const teams = S?.teams ?? [];
  const kw = keyword.trim().toLowerCase();
  const filtered = items.filter(
    (t) =>
      !kw ||
      t.name.toLowerCase().includes(kw) ||
      t.specialty.toLowerCase().includes(kw) ||
      t.division.toLowerCase().includes(kw),
  );
  const visible = useMemo(() => {
    const arr = [...filtered];
    if (sort === 'heat') arr.sort((a, b) => (b.heatScore ?? -1) - (a.heatScore ?? -1) || b.recruitCount - a.recruitCount);
    else if (sort === 'recent') arr.sort((a, b) => (b.pubAt ?? '').localeCompare(a.pubAt ?? ''));
    else arr.sort((a, b) => b.recruitCount - a.recruitCount || a.name.localeCompare(b.name));
    return arr;
  }, [filtered, sort]);
  const newThisMonth = filtered.filter((t) => t.isNewThisMonth);

  async function recruit(t: AgentTemplateItem) {
    const teamId = teamByTpl[t.id] || teams[0]?.id || '';
    if (!teamId) {
      toast('先建一个小组再招募');
      return;
    }
    setBusyId(t.id);
    try {
      const memberId = await recruitAgentTemplate(t.id, teamId);
      setRecruited({ tplId: t.id, memberId, name: t.name });
      toast(`已招募「${t.name}」进 ${teams.find((x) => x.id === teamId)?.name ?? '小组'}`);
      await refresh();
      await load();
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId('');
    }
  }

  const row = (t: AgentTemplateItem) => {
    const open = openId === t.id;
    const teamId = teamByTpl[t.id] || teams[0]?.id || '';
    return (
      <div className="task res-card" key={t.id}>
        <span className="tt">{t.name}</span>{' '}
        <Badge>{t.role}</Badge>{' '}
        <Badge>{t.language === 'zh' ? '中文' : '英文'}</Badge>{' '}
        <Badge>{t.division}</Badge>{' '}
        <Badge variant="done">已招募 {t.recruitCount} 次</Badge>
        {t.isNewThisMonth && <Badge variant="adj">本月上新</Badge>}
        {t.hasPendingUpdate && <Badge>有新版待平台审核</Badge>}
        <div className="meta">
          {t.specialty || '（无专长说明）'}
          <br />
          来源：{t.sourceRepo} · {t.sourceAuthor} · {t.license} 许可证
          {t.sourceStars !== null && <> · 源仓 ★ {t.sourceStars}</>}
          {t.heatScore !== null && <> · 热度分 {t.heatScore.toFixed(2)}</>}
          {t.lastSyncAt && <> · 最近同步 {t.lastSyncAt.slice(0, 10)}</>}
        </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button size="small" variant="gray" onClick={() => setOpenId(open ? '' : t.id)}>
                  {open ? '收起人设' : '看人设'}
                </Button>
                <Select
                  value={teamId}
                  onValueChange={(v) => setTeamByTpl((m) => ({ ...m, [t.id]: v }))}
                  options={teams.map((x) => ({ value: x.id, label: x.name }))}
                  placeholder="（暂无小组）"
                  ariaLabel="招募到的小组"
                />
                <Button size="small" variant="blue" disabled={busyId === t.id || teams.length === 0} onClick={() => recruit(t)}>
                  {busyId === t.id ? '招募中…' : '招募'}
                </Button>
                {recruited?.tplId === t.id && (
                  <Button
                    size="small"
                    variant="gray"
                    onClick={() => openDialog('member', { memberId: recruited.memberId })}
                  >
                    去看「{recruited.name}」
                  </Button>
                )}
              </div>
        {open && (
          <div style={{ marginTop: 8 }}>
            <MarkdownView source={t.persona} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        平台官方智能体库：从开源仓库同步、经平台管理员审核上架。招募后即成为你空间里的真成员（人设全文落库），
        之后与自建成员一样派活、改提示词。
      </p>
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
        <div style={{ flex: '1 1 220px' }}>
          <Input
            placeholder="搜名字 / 专长 / 分组…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="搜索人才库"
          />
        </div>
        <div style={{ flex: '0 0 190px' }}>
          <label>排序</label>
          <Select
            value={sort}
            onValueChange={(v) => setSort(v as SortMode)}
            options={[
              { value: 'featured', label: '精选榜（招募量）' },
              { value: 'heat', label: '热度榜' },
              { value: 'recent', label: '最近更新' },
            ]}
            ariaLabel="人才库排序"
          />
        </div>
      </div>
      {sort === 'heat' && <p className="hint" style={{ margin: '0 0 8px' }}>{HEAT_FORMULA_TEXT}</p>}
      {!loaded && (
        <p>
          <Spinner label="加载中…" />
        </p>
      )}
      {loaded && visible.length === 0 && (
        <EmptyState>{items.length === 0 ? '人才库暂无已上架智能体' : '没有符合搜索的智能体'}</EmptyState>
      )}
      {loaded && newThisMonth.length > 0 && (
        <>
          <div className="hint" style={{ fontWeight: 600, margin: '8px 0 4px' }}>🆕 本月上新</div>
          <div className="talent-list">{newThisMonth.map(row)}</div>
        </>
      )}
      {loaded && visible.length > 0 && (
        <>
          <div className="hint" style={{ fontWeight: 600, margin: '10px 0 4px' }}>全部智能体</div>
          <div className="talent-list">{visible.map(row)}</div>
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="gray" onClick={load}>
          刷新
        </Button>
      </div>
    </div>
  );
}
