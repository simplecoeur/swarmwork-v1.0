import { TaskStatus } from '@swarm/shared';
import type { BriefingRow, Repos, TaskRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { maybeMailDaily, notifyOwner } from './notify';
import { workspaceTimezone, zonedDayStartUtc } from './scheduleService';
import { getDailySettings } from './dailySettings';

/**
 * 总经理晨报（v1.3.0 G）：按空间时区的本地日期生成，同日幂等。
 * 内容三段：昨日未完成事项 / 今日开工提醒 / 热点新闻（RSS）。
 * 状态分组映射（TaskStatus 真实枚举）：
 * - 进行中组 = 执行中 + 待领取
 * - 待审核组 = 待审核
 * - 待裁决组 = 待裁决
 * - 被打回组 = 被打回（状态组优先归类；另在组后单独计数「曾被打回 reject_count>0」一项，可与状态组重叠）
 * 终态（已完成/已取消）不计入未完成。
 */

export const TERMINAL_STATUSES: string[] = [TaskStatus.DONE, TaskStatus.CANCELLED];

export interface BriefingResult {
  briefing: BriefingRow;
  created: boolean;
}

interface NewsItem {
  title: string;
  link: string;
  source: string;
}

interface FeedSource {
  name: string;
  url: string;
}

/** 内置 RSS 源（每主题 2 个国内可直连的公开源）；可用环境变量 SWARM_NEWS_FEEDS_JSON 覆盖（测试/运维）：
 *  形状 { "<topic>": [{name, url}, ...] } 或全体共用 [{name, url}, ...]。 */
export const DEFAULT_NEWS_FEEDS: Record<string, FeedSource[]> = {
  short_drama: [
    { name: '36氪', url: 'https://36kr.com/feed' },
    { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  ],
  film: [
    { name: '36氪', url: 'https://36kr.com/feed' },
    { name: '少数派', url: 'https://sspai.com/feed' },
  ],
  ai: [
    { name: '36氪', url: 'https://36kr.com/feed' },
    { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  ],
  general: [
    { name: '36氪', url: 'https://36kr.com/feed' },
    { name: '少数派', url: 'https://sspai.com/feed' },
  ],
};

/** 主题关键词过滤（general 不过滤） */
export const NEWS_TOPIC_KEYWORDS: Record<string, string[]> = {
  short_drama: ['短剧', '影视', '剧集', '娱乐', '票房'],
  film: ['电影', '影视', '票房', '剧集'],
  ai: ['AI', '人工智能', '大模型', '智能体'],
  general: [],
};

export function newsFeedsFor(topic: string): FeedSource[] {
  const raw = process.env.SWARM_NEWS_FEEDS_JSON;
  if (raw) {
    try {
      const v = JSON.parse(raw) as unknown;
      const pick = (x: unknown): FeedSource[] =>
        Array.isArray(x)
          ? x
              .filter(
                (f): f is FeedSource =>
                  !!f && typeof f === 'object' && typeof (f as FeedSource).url === 'string',
              )
              .map((f) => ({ name: f.name || 'RSS', url: f.url }))
          : [];
      if (Array.isArray(v)) {
        const all = pick(v);
        if (all.length) return all;
      } else if (v && typeof v === 'object') {
        const byTopic = pick((v as Record<string, unknown>)[topic]);
        if (byTopic.length) return byTopic;
      }
    } catch {
      /* 覆盖配置损坏时回退内置源 */
    }
  }
  return DEFAULT_NEWS_FEEDS[topic] ?? DEFAULT_NEWS_FEEDS.general;
}

function stripCdata(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function parseRssItems(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  for (const b of blocks) {
    const title = stripCdata(/<title>([\s\S]*?)<\/title>/.exec(b)?.[1] ?? '');
    const link = stripCdata(/<link>([\s\S]*?)<\/link>/.exec(b)?.[1] ?? '');
    if (title && link) items.push({ title, link, source });
  }
  return items;
}

/** 拉取并过滤热点：全部失败或无条目返回空数组（调用方写「今日热点暂不可用」） */
export async function fetchNews(topic: string): Promise<NewsItem[]> {
  const feeds = newsFeedsFor(topic);
  const keywords = NEWS_TOPIC_KEYWORDS[topic] ?? [];
  const merged: NewsItem[] = [];
  const seen = new Set<string>();
  await Promise.all(
    feeds.map(async (f) => {
      try {
        const res = await fetch(f.url, {
          signal: AbortSignal.timeout(5_000),
          headers: { 'user-agent': 'agent-swarm-briefing/1.3' },
        });
        if (!res.ok) return;
        const xml = await res.text();
        for (const it of parseRssItems(xml, f.name)) {
          if (keywords.length && !keywords.some((k) => it.title.includes(k))) continue;
          const key = it.link || it.title;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(it);
        }
      } catch {
        /* 单源失败不影响其他源 */
      }
    }),
  );
  return merged.slice(0, 5);
}

const GREETINGS = [
  '新的一天，先处理待裁决与待审核，再开新单。',
  '晨光正好，把昨日未完成的先清一清，团队随时待命。',
  '开工先看板：裁决、审核、进行中，按这个顺序过一遍。',
  '今天也稳扎稳打，先收尾再开新局。',
  '早，任务队列已经排好，从最要紧的一件开始。',
];

function dateHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const GROUP_CAP = 20;

function groupLines(label: string, tasks: TaskRow[]): string[] {
  if (!tasks.length) return [];
  const lines = [`### ${label}（${tasks.length}）`];
  for (const t of tasks.slice(0, GROUP_CAP)) lines.push(`- ${t.title}（${t.status}）`);
  if (tasks.length > GROUP_CAP) lines.push(`- …等共 ${tasks.length} 项`);
  return lines;
}

/**
 * 生成某空间某本地日期的晨报；同日已存在直接返回（幂等，created=false）。
 * dateStr 为空间时区下的本地日期（YYYY-MM-DD）。
 */
export async function generateBriefing(
  repos: Repos,
  workspaceId: string,
  dateStr: string,
): Promise<BriefingResult> {
  const existing = repos.getBriefing(workspaceId, dateStr);
  if (existing) return { briefing: existing, created: false };

  const tz = workspaceTimezone(repos, workspaceId);
  const dayStartIso = zonedDayStartUtc(dateStr, tz).toISOString();
  const settings = getDailySettings(repos, workspaceId);
  const all = repos.listTasks(workspaceId);
  const unfinished = all.filter((t) => !TERMINAL_STATUSES.includes(t.status));
  const yesterday = unfinished.filter((t) => t.created_at < dayStartIso);

  const inProgress = yesterday.filter(
    (t) => t.status === TaskStatus.RUNNING || t.status === TaskStatus.PENDING,
  );
  const reviewing = yesterday.filter((t) => t.status === TaskStatus.REVIEWING);
  const adjudication = yesterday.filter((t) => t.status === TaskStatus.ADJUDICATION);
  const rejected = yesterday.filter((t) => t.status === TaskStatus.REJECTED);
  const everRejected = yesterday.filter((t) => t.reject_count > 0).length;

  /* ---- 第一段：昨日未完成事项 ---- */
  const sec1: string[] = ['## 昨日未完成事项'];
  if (!yesterday.length) {
    sec1.push('昨日无未完成事项，全部清零。');
  } else {
    sec1.push(...groupLines('进行中', inProgress));
    sec1.push(...groupLines('待审核', reviewing));
    sec1.push(...groupLines('待裁决', adjudication));
    sec1.push(...groupLines('被打回', rejected));
    if (everRejected > 0) sec1.push(`其中曾被打回（打回次数 > 0）的共 ${everRejected} 项。`);
  }

  /* ---- 第二段：今日开工提醒 ---- */
  const curAdjudication = unfinished.filter((t) => t.status === TaskStatus.ADJUDICATION).length;
  const curReviewing = unfinished.filter((t) => t.status === TaskStatus.REVIEWING).length;
  const sec2: string[] = ['## 今日开工提醒'];
  sec2.push(`当前待裁决 ${curAdjudication} 件、待审核 ${curReviewing} 件，请优先处理。`);
  const supervision = settings.supervisionItems
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (supervision.length) {
    sec2.push('总经理督促事项：');
    for (const s of supervision) sec2.push(`- ${s}`);
  }
  sec2.push(GREETINGS[dateHash(dateStr) % GREETINGS.length]);

  /* ---- 第三段：热点新闻 ---- */
  const news = await fetchNews(settings.newsTopic);
  const sec3: string[] = ['## 热点新闻'];
  if (!news.length) {
    sec3.push('今日热点暂不可用');
  } else {
    for (const n of news) sec3.push(`- [${n.title}](${n.link})（${n.source}）`);
  }

  const contentMd = [`# 总经理晨报 · ${dateStr}`, '', ...sec1, '', ...sec2, '', ...sec3, ''].join('\n');
  const row: BriefingRow = {
    id: uid('brief'),
    workspace_id: workspaceId,
    date: dateStr,
    content_md: contentMd,
    created_at: nowIso(),
  };
  repos.insertBriefing(row);
  // 并发/重入下唯一约束可能已让另一行落库：以库内为准
  const saved = repos.getBriefing(workspaceId, dateStr) ?? row;
  const created = saved.id === row.id;

  if (created) {
    const summary =
      `昨日未完成共 ${yesterday.length} 项` +
      `（进行中 ${inProgress.length} · 待审核 ${reviewing.length} · 待裁决 ${adjudication.length} · 被打回 ${rejected.length}）`;
    try {
      notifyOwner(repos, workspaceId, 'daily_briefing', `总经理晨报 · ${dateStr}`, summary, null);
    } catch {
      /* 通知失败不影响晨报落库 */
    }
    maybeMailDaily(repos, workspaceId, `总经理晨报 · ${dateStr}`, summary);
  }
  return { briefing: saved, created };
}
