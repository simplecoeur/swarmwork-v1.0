import { useCallback, useEffect, useState } from 'react';
import { fetchBriefings, fetchTodayBriefing, type BriefingItem } from '../api';
import MarkdownView from './MarkdownView';
import { Button } from './ui';

/**
 * 总经理晨报卡（v1.3.0 G）：办公室场景卡。
 * 今日晨报走 GET /api/briefings/today（MarkdownView 渲染）；无则提示生成时间。
 * 底部「往期晨报」展开最近 7 份列表，点开切换显示某日内容。
 */
export default function BriefingCard() {
  const [today, setToday] = useState<BriefingItem | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  const [past, setPast] = useState<BriefingItem[]>([]);
  const [pastLoaded, setPastLoaded] = useState(false);
  const [displayed, setDisplayed] = useState<BriefingItem | null>(null);

  const load = useCallback(async () => {
    try {
      const b = await fetchTodayBriefing();
      setToday(b);
      setDisplayed(b);
    } catch {
      /* 服务端未就绪时按「暂无晨报」呈现 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePast() {
    const next = !pastOpen;
    setPastOpen(next);
    if (next && !pastLoaded) {
      try {
        setPast(await fetchBriefings());
      } catch {
        setPast([]);
      } finally {
        setPastLoaded(true);
      }
    }
  }

  return (
    <div className="card">
      <h2>
        📰 总经理晨报{' '}
        <span className="tag">昨日未完成汇总 + 开工提醒 + 热点新闻，由总经理每天定时整理</span>
      </h2>
      {!loaded && <p className="hint">晨报加载中…</p>}
      {loaded && !displayed && (
        <p className="hint">今日晨报将在设置的时间生成（默认 09:00），生成后会通过站内通知提醒你。</p>
      )}
      {displayed && (
        <div>
          <p className="hint" style={{ fontWeight: 700 }}>
            {displayed.date}
            {today && displayed.id === today.id ? '（今日）' : ''}
          </p>
          <MarkdownView source={displayed.contentMd} />
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Button size="small" variant="gray" onClick={togglePast}>
          {pastOpen ? '收起往期晨报' : '往期晨报'}
        </Button>
      </div>
      {pastOpen && (
        <div style={{ marginTop: 8 }}>
          {!pastLoaded && <p className="hint">加载中…</p>}
          {pastLoaded && past.length === 0 && <p className="hint">暂无往期晨报。</p>}
          {past.map((b) => (
            <div key={b.id} style={{ padding: '4px 0' }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setDisplayed(b);
                }}
              >
                {b.date} 的晨报
              </a>
              <span className="hint"> · {b.createdAt.slice(0, 16).replace('T', ' ')}</span>
              {displayed?.id === b.id && <span className="hint">（正在看）</span>}
            </div>
          ))}
          {today && displayed && displayed.id !== today.id && (
            <div style={{ padding: '4px 0' }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setDisplayed(today);
                }}
              >
                回到今日晨报
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
