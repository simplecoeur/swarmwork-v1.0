import { useEffect, useRef, useState } from 'react';
import { fetchSearch } from '../api';
import { Badge, Button, Card, EmptyState, Input, Spinner } from './ui';
import type { SearchItem, SearchResponse } from '../types';

export const SEARCH_TYPE_LABELS: Record<SearchItem['type'], string> = {
  task: '任务',
  result: '成果',
  kb: '知识',
  asset: '资产',
  skill: '技能',
  talent: '人才',
  project: '项目',
};

/**
 * 全局搜索（G-09）：顶栏搜索框（组件层 Input）+ 分组下拉（防抖 300ms），
 * 回车进搜索结果页（同 /api/search 接口全量渲染）；移动端顶栏只留搜索图标，
 * 点击展开全屏搜索层（≤768px 规则在 styles.css）。
 */
export function GlobalSearch({
  onShowResults,
  onNavigate,
}: {
  onShowResults: (q: string) => void;
  onNavigate: (item: SearchItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖 300ms：输入停顿后才查；序号防竞态（后发先至时丢弃旧响应）
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++seqRef.current;
    const t = window.setTimeout(async () => {
      try {
        const r = await fetchSearch(q);
        if (seqRef.current === seq) setData(r);
      } catch {
        if (seqRef.current === seq) setData({ groups: [], results: [] });
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [query]);

  // 点组件外关闭下拉
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const submit = () => {
    const q = query.trim();
    if (!q) return;
    setOpen(false);
    setMobileOpen(false);
    onShowResults(q);
  };

  const resultList = (inOverlay: boolean) => (
    <div className={inOverlay ? 'gs-panel gs-panel--overlay' : 'gs-panel'}>
      {loading && (
        <p className="gs-hint">
          <Spinner label="搜索中…" />
        </p>
      )}
      {!loading && data && data.results.length === 0 && (
        <p className="gs-hint">没有找到「{query.trim()}」相关内容，换个词试试。</p>
      )}
      {!loading &&
        data?.groups.map((g) => (
          <div key={g.type} className="gs-group">
            <div className="gs-group-title">{SEARCH_TYPE_LABELS[g.type]}</div>
            {g.items.map((it) => (
              <button
                key={`${it.type}-${it.id}`}
                type="button"
                className="gs-item"
                onClick={() => {
                  setOpen(false);
                  setMobileOpen(false);
                  onNavigate(it);
                }}
              >
                <span className="gs-item-title">{it.title}</span>
                {it.snippet ? <span className="gs-item-snippet">{it.snippet}</span> : null}
              </button>
            ))}
          </div>
        ))}
      {!loading && data && data.results.length > 0 && (
        <button type="button" className="gs-item gs-item--all" onClick={submit}>
          查看全部结果 →
        </button>
      )}
    </div>
  );

  return (
    <div className="globalsearch" ref={boxRef}>
      <div className="gs-desktop">
        <Input
          value={query}
          placeholder="🔍 搜任务 / 成果 / 知识 / 资产 / 技能 / 项目"
          aria-label="全局搜索"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        {open && query.trim() ? resultList(false) : null}
      </div>
      <Button
        variant="mini"
        className="gs-toggle"
        aria-label="打开搜索"
        onClick={() => setMobileOpen(true)}
      >
        🔍
      </Button>
      {mobileOpen && (
        <div className="gs-overlay" role="dialog" aria-label="全局搜索">
          <div className="gs-overlay-bar">
            <Input
              value={query}
              placeholder="搜任务 / 成果 / 知识 / 资产 / 技能 / 项目"
              aria-label="全局搜索"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') setMobileOpen(false);
              }}
            />
            <Button variant="gray" onClick={() => setMobileOpen(false)}>
              关闭
            </Button>
          </div>
          {query.trim() ? resultList(true) : <p className="gs-hint">输入关键词，搜遍任务、成果、知识、资产、技能与项目。</p>}
        </div>
      )}
    </div>
  );
}

/** 搜索结果页（G-09）：与下拉同一接口，六组全量渲染；回车从顶栏搜索进入 */
export function SearchResultsPage({
  query,
  onNavigate,
}: {
  query: string;
  onNavigate: (item: SearchItem) => void;
}) {
  const [data, setData] = useState<SearchResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    fetchSearch(query)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  return (
    <Card>
      <h2>
        搜索结果 <span className="tag">关键词「{query}」· 覆盖任务 / 成果 / 知识 / 资产 / 技能 / 项目</span>
      </h2>
      {!data && !failed && (
        <p>
          <Spinner label="搜索中…" />
        </p>
      )}
      {failed && <p className="hint">搜索失败，请稍后重试。</p>}
      {data && data.results.length === 0 && (
        <EmptyState>没有找到与「{query}」相关的内容，换个更短的关键词试试。</EmptyState>
      )}
      {data?.groups.map((g) => (
        <div key={g.type} style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>
            {SEARCH_TYPE_LABELS[g.type]} <Badge>{g.items.length}</Badge>
          </div>
          {g.items.map((it) => (
            <button
              key={`${it.type}-${it.id}`}
              type="button"
              className="gs-item gs-item--page"
              onClick={() => onNavigate(it)}
            >
              <span className="gs-item-title">{it.title}</span>
              {it.snippet ? <span className="gs-item-snippet">{it.snippet}</span> : null}
              <span className="gs-item-snippet">{it.updatedAt.slice(0, 16).replace('T', ' ')}</span>
            </button>
          ))}
        </div>
      ))}
    </Card>
  );
}
