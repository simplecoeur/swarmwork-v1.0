import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { doCheckin, fetchCheckin, type CheckinState } from '../api';
import { Button } from './ui';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

/** 总经理鼓励语（模板文案，只带 streak 数字，不编业务数据） */
function encouragement(streak: number): string {
  if (streak <= 1) return '早上好，老板！签到成功，今天咱们开工大吉。';
  if (streak <= 6) return `早上好，老板！已连续签到 ${streak} 天，势头正好，今天继续推进。`;
  if (streak <= 29) return `早上好，老板！连续签到 ${streak} 天，自律的老板最可怕，团队已就位。`;
  return `早上好，老板！连续签到 ${streak} 天，这个坚持值得一块奖牌，今天也一起加油。`;
}

/**
 * 每日签到卡（v1.3.0 G）：办公室场景卡，总经理桌视觉。
 * 未签到 → 大按钮「签到上班」；已签到 → 连续天数 + 本月迷你月历（monthDays 打勾）。
 * 签到成功后卡内出现总经理气泡反馈，并刷新状态。
 */
export default function CheckinCard() {
  const { toast } = useApp();
  const [state, setState] = useState<CheckinState | null>(null);
  const [busy, setBusy] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await fetchCheckin());
    } catch {
      /* 服务端未就绪时静默，卡片显示加载态 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function checkin() {
    setBusy(true);
    try {
      const next = await doCheckin();
      setState(next);
      setBubble(encouragement(next.streak));
      toast(next.created === false ? '今天已经签到过了' : '签到成功');
    } catch (e) {
      toast('出错：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=周日
  const checked = new Set((state?.monthDays ?? []).map((d) => d.slice(0, 10)));
  const todayKey = dateKey(year, month, now.getDate());
  const cells: Array<{ key: string; day: number | null }> = [
    ...Array.from({ length: firstWeekday }, (_, i) => ({ key: `blank-${i}`, day: null })),
    ...Array.from({ length: daysInMonth }, (_, i) => ({
      key: dateKey(year, month, i + 1),
      day: i + 1,
    })),
  ];

  return (
    <div className="card">
      <h2>
        🐝 总经理桌 <span className="tag">每日签到 · 总经理在这儿等你开工</span>
      </h2>
      {!state && <p className="hint">签到状态加载中…</p>}
      {state && !state.checkedToday && (
        <>
          <p className="hint">新的一天，先签个到，总经理会记下你的连续出勤。</p>
          <div style={{ marginTop: 8 }}>
            <Button onClick={checkin} disabled={busy}>
              {busy ? '签到中…' : '签到上班'}
            </Button>
          </div>
        </>
      )}
      {state && state.checkedToday && (
        <>
          <p style={{ fontWeight: 800, margin: '4px 0' }}>
            ✓ 已签到 · 连续 {state.streak} 天
          </p>
          <div
            aria-label="本月签到日历"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 28px)',
              gap: 4,
              marginTop: 8,
            }}
          >
            {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
              <span key={w} className="hint" style={{ textAlign: 'center', fontWeight: 700 }}>
                {w}
              </span>
            ))}
            {cells.map((c) =>
              c.day == null ? (
                <span key={c.key} />
              ) : (
                <span
                  key={c.key}
                  title={c.key}
                  style={{
                    textAlign: 'center',
                    fontSize: 12,
                    lineHeight: '24px',
                    borderRadius: 6,
                    fontWeight: c.key === todayKey ? 900 : 400,
                    background: checked.has(c.key) ? 'var(--teal)' : 'transparent',
                    color: checked.has(c.key) ? '#fff' : 'inherit',
                    outline: c.key === todayKey ? '2px solid var(--ink)' : 'none',
                  }}
                >
                  {checked.has(c.key) ? '✓' : c.day}
                </span>
              ),
            )}
          </div>
        </>
      )}
      {bubble && (
        <div
          style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 12,
            background: 'var(--paper, #fff8e6)',
            border: '2px solid var(--line)',
            maxWidth: 520,
          }}
        >
          <b>总经理 🐝：</b> {bubble}
        </div>
      )}
    </div>
  );
}
