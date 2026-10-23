import type { Repos } from '../store/repositories';

/**
 * 每日设置（v1.3.0 G）：空间 setting 单键 'dailySettings'（workspace 维度）。
 * C2 问卷的提醒字段与 G 共用同一键，写入走 saveDailySettings 的合并口径。
 */
export interface DailySettings {
  briefingEnabled: boolean;
  briefingTime: string;
  checkinReminderEnabled: boolean;
  checkinReminderTime: string;
  newsTopic: string;
  supervisionItems: string;
}

export const DAILY_SETTINGS_DEFAULTS: DailySettings = {
  briefingEnabled: true,
  briefingTime: '09:00',
  checkinReminderEnabled: true,
  checkinReminderTime: '10:00',
  newsTopic: 'short_drama',
  supervisionItems: '',
};

export const NEWS_TOPICS = ['short_drama', 'film', 'ai', 'general'] as const;

export function getDailySettings(repos: Repos, workspaceId: string): DailySettings {
  const raw = repos.getSetting<Partial<DailySettings> | null>('dailySettings', null, workspaceId);
  if (!raw || typeof raw !== 'object') return { ...DAILY_SETTINGS_DEFAULTS };
  return {
    briefingEnabled:
      typeof raw.briefingEnabled === 'boolean'
        ? raw.briefingEnabled
        : DAILY_SETTINGS_DEFAULTS.briefingEnabled,
    briefingTime:
      typeof raw.briefingTime === 'string' && /^\d{2}:\d{2}$/.test(raw.briefingTime)
        ? raw.briefingTime
        : DAILY_SETTINGS_DEFAULTS.briefingTime,
    checkinReminderEnabled:
      typeof raw.checkinReminderEnabled === 'boolean'
        ? raw.checkinReminderEnabled
        : DAILY_SETTINGS_DEFAULTS.checkinReminderEnabled,
    checkinReminderTime:
      typeof raw.checkinReminderTime === 'string' && /^\d{2}:\d{2}$/.test(raw.checkinReminderTime)
        ? raw.checkinReminderTime
        : DAILY_SETTINGS_DEFAULTS.checkinReminderTime,
    newsTopic:
      typeof raw.newsTopic === 'string' && (NEWS_TOPICS as readonly string[]).includes(raw.newsTopic)
        ? raw.newsTopic
        : DAILY_SETTINGS_DEFAULTS.newsTopic,
    supervisionItems:
      typeof raw.supervisionItems === 'string'
        ? raw.supervisionItems
        : DAILY_SETTINGS_DEFAULTS.supervisionItems,
  };
}

/** 部分字段合并保存（校验在路由层 zod 完成） */
export function saveDailySettings(
  repos: Repos,
  workspaceId: string,
  patch: Partial<DailySettings>,
): DailySettings {
  const next = { ...getDailySettings(repos, workspaceId), ...patch };
  repos.setSetting('dailySettings', next, workspaceId);
  return next;
}

/**
 * 邮件通道状态推导：notifyConfig 的真实形状 = settings(key='notifyConfig', workspace 维度)，
 * 现有字段只有 {emailEnabled?: boolean, email?: string}（notify.ts 的 mail 预留段在读），
 * 没有 SMTP 主机/发件配置字段，且无人写入。本版据实推导：必须同时具备 SMTP 主机
 * （smtpHost 或 smtp.host）与发件地址（from 或 email）才算 'configured'，否则 'not_configured'。
 */
export interface NotifyConfigShape {
  emailEnabled?: boolean;
  email?: string;
  smtpHost?: string;
  from?: string;
  smtp?: { host?: string };
}

export function mailStatusOf(repos: Repos, workspaceId: string): 'configured' | 'not_configured' {
  const cfg = repos.getSetting<NotifyConfigShape>('notifyConfig', {}, workspaceId);
  const host = cfg.smtpHost ?? cfg.smtp?.host ?? '';
  const from = cfg.from ?? cfg.email ?? '';
  return host && from ? 'configured' : 'not_configured';
}
