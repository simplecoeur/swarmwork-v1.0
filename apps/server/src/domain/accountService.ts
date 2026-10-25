import * as fs from 'fs';
import * as path from 'path';
import { AVATAR_LIMITS } from '@swarm/shared';
import type { Logger } from '../logger';
import type { Repos, UserRow } from '../store/repositories';
import { nowIso } from '../util';

/**
 * 账号设置域服务（G-11）：头像落盘口径 + 注销到期匿名化处理。
 * - 头像：文件名只用 <user_id>.<白名单扩展>（扩展名由 MIME 映射、绝不取用户文件名），
 *   落 DATA_DIR/avatars/；读取/删除前一律 basename 归一 + 目录包含校验，防目录穿越。
 * - 注销到期处理由调度 tick 按日节流调用（与 G-10 共用定时基础设施，勿另起进程）：
 *   status='deleted'、email 改写 deleted-<id>@invalid、display_name 改「已注销用户」、
 *   删头像文件、物理删 user_preferences 与其 personal KB、清 memberships 与残余会话。
 */

/** MIME → 扩展名白名单（服务端只认这四种图片类型） */
export const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
export const AVATAR_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function avatarsDir(dataDir: string): string {
  return path.join(dataDir, 'avatars');
}

/** 头像文件绝对路径（basename 归一 + 必须落在 avatars 目录内，否则返回 null） */
export function avatarFilePath(dataDir: string, fileName: string): string | null {
  const base = path.basename(fileName);
  if (!base || base !== fileName) return null;
  const dir = avatarsDir(dataDir);
  const full = path.join(dir, base);
  return full.startsWith(dir + path.sep) ? full : null;
}

export function saveAvatarFile(dataDir: string, userId: string, ext: string, buffer: Buffer): string {
  const dir = avatarsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${userId}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return fileName;
}

export function deleteAvatarFile(dataDir: string, user: UserRow): void {
  if (!user.avatar_file) return;
  const full = avatarFilePath(dataDir, user.avatar_file);
  if (full && fs.existsSync(full)) {
    try {
      fs.unlinkSync(full);
    } catch {
      /* 文件删除失败不阻断账号处理主流程 */
    }
  }
}

export function avatarUrlOf(user: UserRow): string | null {
  return user.avatar_file ? `/api/users/${user.id}/avatar` : null;
}

/** UA 摘要：截断长串（会话列表展示用，完整 UA 仍在 sessions.user_agent） */
export function uaSummary(ua: string): string {
  const s = (ua || '').trim();
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/**
 * 注销到期处理（冷静期 7 天已过）：逐个用户单事务匿名化，返回本次处理的用户 id 列表。
 * 前置口径：其自有空间已在申请阶段被阻塞（须先转让/删除），此处 memberships 应只剩
 * 他人空间的普通成员关系——一并清除（账号已死，成员资格不保留）。
 */
export function processDueDeletions(repos: Repos, dataDir: string, logger?: Logger): string[] {
  const due = repos.listDuePendingDeletions(nowIso());
  const done: string[] = [];
  for (const u of due) {
    let kbDeleted = 0;
    repos.tx(() => {
      const fresh = repos.getUser(u.id);
      if (!fresh || fresh.status !== 'pending_deletion') return;
      deleteAvatarFile(dataDir, fresh);
      kbDeleted = repos.deletePersonalKbByUser(fresh.id);
      repos.deletePreferencesByUser(fresh.id);
      repos.deleteMembershipsByUser(fresh.id);
      repos.deleteSessionsByUser(fresh.id);
      repos.updateUser({
        ...fresh,
        status: 'deleted',
        email: `deleted-${fresh.id}@invalid`,
        display_name: '已注销用户',
        avatar_file: null,
      });
    });
    const fresh = repos.getUser(u.id);
    if (fresh?.status === 'deleted') {
      repos.insertAudit({
        workspace_id: null,
        user_id: u.id,
        action: 'account_deleted',
        target_type: 'user',
        target_id: u.id,
        detail: `冷静期到期自动注销：personal KB 删除 ${kbDeleted} 条`,
        ip: '',
      });
      logger?.info('account', `账号 ${u.id} 注销到期已匿名化（personal KB 删除 ${kbDeleted} 条）`);
      done.push(u.id);
    }
  }
  return done;
}

export { AVATAR_LIMITS };
