import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchAgentTemplates, recruitAgentTemplate, type AgentTemplateItem } from '../api';
import MarkdownView from './MarkdownView';
import { Badge, Button, EmptyState, Input, Select, Spinner } from './ui';

/**
 * v1.4.0 J 官方人才库（弹窗内容）：GitHub 同步 + 管理员过审后的智能体模板。
 * 数据组件内自拉 GET /api/agent-templates（与 StylePanel 自拉风格一致），只见已上架 pub 快照。
 * 招募 = 选本空间小组 → POST recruit 生成真成员（人设全文落库）→ toast + refresh 全局 state。
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

  const teams = S?.teams ?? [];
  const kw = keyword.trim().toLowerCase();
  const visible = items.filter(
    (t) =>
      !kw ||
      t.name.toLowerCase().includes(kw) ||
      t.specialty.toLowerCase().includes(kw) ||
      t.division.toLowerCase().includes(kw),
  );

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

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        平台官方智能体库：从开源仓库同步、经平台管理员审核上架。招募后即成为你空间里的真成员（人设全文落库），
        之后与自建成员一样派活、改提示词。
      </p>
      <Input
        placeholder="搜名字 / 专长 / 分组…"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        aria-label="搜索人才库"
      />
      {!loaded && (
        <p>
          <Spinner label="加载中…" />
        </p>
      )}
      {loaded && visible.length === 0 && (
        <EmptyState>{items.length === 0 ? '人才库暂无已上架智能体' : '没有符合搜索的智能体'}</EmptyState>
      )}
      <div style={{ marginTop: 10 }}>
        {visible.map((t) => {
          const open = openId === t.id;
          const teamId = teamByTpl[t.id] || teams[0]?.id || '';
          return (
            <div className="task" key={t.id}>
              <span className="tt">{t.name}</span>{' '}
              <Badge>{t.role}</Badge>{' '}
              <Badge>{t.language === 'zh' ? '中文' : '英文'}</Badge>{' '}
              <Badge>{t.division}</Badge>{' '}
              <Badge variant="done">已招募 {t.recruitCount} 次</Badge>
              <div className="meta">
                {t.specialty || '（无专长说明）'}
                <br />
                来源：{t.sourceRepo} · {t.sourceAuthor} · {t.license} 许可证
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
        })}
      </div>
      <div style={{ marginTop: 8 }}>
        <Button size="small" variant="gray" onClick={load}>
          刷新
        </Button>
      </div>
    </div>
  );
}
