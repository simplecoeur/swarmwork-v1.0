import type { Repos } from '../store/repositories';
import { nowIso, uid } from '../util';
import { generateBriefing } from './briefingService';
import { getDailySettings } from './dailySettings';
import { notifyOwner } from './notify';
import { workspaceTimezone, zonedDateStr, zonedTimeStr } from './scheduleService';

/**
 * 每日签到 + 晨报/提醒调度（v1.3.0 G）。
 * 日期口径与 G-10 定时任务完全一致：空间时区（settings.timezone，缺省 Asia/Shanghai）下的本地日期。
 */

export interface CheckinStatus {
  checkedToday: boolean;
  streak: number;
  monthDays: string[];
  lastCheckinDate: string | null;
  today: string;
}

/** 本地日期字符串 ± 天（按 UTC 日历运算，避免本地时区干扰） */
export function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

export function getCheckinStatus(
  repos: Repos,
  userId: string,
  workspaceId: string,
  now: Date = new Date(),
): CheckinStatus {
  const tz = workspaceTimezone(repos, workspaceId);
  const today = zonedDateStr(now, tz);
  const dates = repos.listCheckinDates(userId, workspaceId);
  const set = new Set(dates);
  const checkedToday = set.has(today);
  // streak：今日已签则从今日起、未签则从昨日起，往前数连续签到天数；断一天即断
  let streak = 0;
  let cursor = checkedToday ? today : shiftDateStr(today, -1);
  while (set.has(cursor)) {
    streak += 1;
    cursor = shiftDateStr(cursor, -1);
  }
  const monthPrefix = today.slice(0, 7);
  const monthDays = dates.filter((d) => d.startsWith(monthPrefix)).sort();
  return {
    checkedToday,
    streak,
    monthDays,
    lastCheckinDate: dates[0] ?? null,
    today,
  };
}

/** 签到（幂等）：返回签后状态与是否真新建 */
export function doCheckin(
  repos: Repos,
  userId: string,
  workspaceId: string,
  now: Date = new Date(),
): { status: CheckinStatus; created: boolean } {
  const tz = workspaceTimezone(repos, workspaceId);
  const today = zonedDateStr(now, tz);
  const created = repos.insertCheckin({
    id: uid('checkin'),
    user_id: userId,
    workspace_id: workspaceId,
    date: today,
    created_at: nowIso(),
  });
  return { status: getCheckinStatus(repos, userId, workspaceId, now), created };
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export interface DailyTickOutcome {
  workspaceId: string;
  briefingCreated: boolean;
  checkinReminded: boolean;
}

/**
 * 每日调度一轮（30s interval 只是它的壳，测试可直调）：
 * 遍历全部 active 空间——本地时间 ≥ briefingTime 且开启且今日无晨报 → 生成晨报；
 * ≥ checkinReminderTime 且开启且所有者今日未签到且今日未提醒过（setting 'checkinRemindedDate' 标记）→ 提醒并写标记。
 */
export async function runDailyTick(repos: Repos, now: Date): Promise<DailyTickOutcome[]> {
  const outcomes: DailyTickOutcome[] = [];
  for (const ws of repos.listWorkspaces()) {
    if (ws.status !== 'active') continue;
    const tz = workspaceTimezone(repos, ws.id);
    const today = zonedDateStr(now, tz);
    const nowMinutes = timeToMinutes(zonedTimeStr(now, tz));
    const settings = getDailySettings(repos, ws.id);
    let briefingCreated = false;
    let checkinReminded = false;

    if (
      settings.briefingEnabled &&
      nowMinutes >= timeToMinutes(settings.briefingTime) &&
      !repos.getBriefing(ws.id, today)
    ) {
      try {
        const r = await generateBriefing(repos, ws.id, today);
        briefingCreated = r.created;
      } catch {
        /* 单空间晨报失败不影响其他空间与提醒 */
      }
    }

    if (
      settings.checkinReminderEnabled &&
      nowMinutes >= timeToMinutes(settings.checkinReminderTime)
    ) {
      const remindedDate = repos.getSetting<string>('checkinRemindedDate', '', ws.id);
      if (remindedDate !== today) {
        const ownerId = ws.owner_user_id;
        const checked = ownerId ? repos.getCheckin(ownerId, ws.id, today) : undefined;
        if (!checked) {
          try {
            notifyOwner(
              repos,
              ws.id,
              'checkin_reminder',
              '今日还没有签到',
              '点开工作台完成今日签到，保持连续签到纪录。',
              null,
            );
            checkinReminded = true;
          } catch {
            /* 通知失败不写标记，下轮重试 */
          }
          if (checkinReminded) repos.setSetting('checkinRemindedDate', today, ws.id);
        }
      }
    }

    outcomes.push({ workspaceId: ws.id, briefingCreated, checkinReminded });
  }
  return outcomes;
}
