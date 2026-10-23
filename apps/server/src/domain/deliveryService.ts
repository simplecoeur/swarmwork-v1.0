import * as crypto from 'crypto';
import { milliToYuan } from '@swarm/shared';
import { hashPassword } from '../auth/auth';
import type { DeliveryLinkRow, ProjectRow, Repos, TaskRow } from '../store/repositories';
import { nowIso, uid } from '../util';
import { escapeHtml, markdownToHtml } from './markdown';

export { escapeHtml };

/**
 * 成果交付（方案 §11.2）：导出文档/表格 + 只读交付页内容组装。
 * 交付页只呈现被交付的那一份（任务或项目），不带空间内任何其他数据。
 */

/** token 只存哈希（sha256）——交付页与参观页（G-13）共用同一口径 */
export function deliveryTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface CreateLinkInput {
  workspaceId: string;
  /** G-13 扩 kind 参数：'delivery' 交付页 | 'visit' 参观链接，同一函数同一令牌机制 */
  kind: 'delivery' | 'visit';
  scope: string;
  taskId?: string | null;
  projectId?: string | null;
  title: string;
  password?: string;
  expiresInDays?: number | null;
  createdBy: string;
}

/**
 * 交付/参观链接创建的唯一 domain 入口（§17 + G-13）：明文 token 只在返回值出现一次，
 * 库里只存哈希；口令 argon2 哈希；有效期/撤销/浏览计数走 delivery_links 同组字段。
 */
export async function createDeliveryLink(
  repos: Repos,
  input: CreateLinkInput,
): Promise<{ row: DeliveryLinkRow; token: string; path: string }> {
  const token = crypto.randomBytes(24).toString('base64url');
  const row: DeliveryLinkRow = {
    id: uid('dlv'),
    token_hash: deliveryTokenHash(token),
    workspace_id: input.workspaceId,
    kind: input.kind,
    scope: input.scope,
    task_id: input.taskId ?? null,
    project_id: input.projectId ?? null,
    title: input.title,
    password_hash: input.password ? await hashPassword(input.password) : '',
    expires_at: input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
      : null,
    revoked: 0,
    view_count: 0,
    created_by: input.createdBy,
    created_at: nowIso(),
  };
  repos.insertDeliveryLink(row);
  return { row, token, path: `${input.kind === 'visit' ? '/v/' : '/d/'}${token}` };
}

function csvCell(v: string): string {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function taskToMarkdown(task: TaskRow): string {
  const lines = [
    `# ${task.title}`,
    '',
    `- 类型：${task.type}`,
    `- 状态：${task.status}`,
    `- 完成时间：${task.finished_at ?? ''}`,
    task.skill_id ? `- 产出 skill：${task.skill_id}（v${task.skill_version ?? ''}）` : '',
    `- 消耗：${task.total_tokens} tokens / ¥${milliToYuan(task.total_cost_milli)}`,
    '',
    '## 任务说明',
    '',
    task.brief || '（无）',
    '',
    '## 成果',
    '',
    task.result || '（暂无成果）',
    '',
  ];
  if (task.review_note) lines.push('## 审核意见', '', task.review_note, '');
  return lines.filter((l) => l !== '').join('\n') + (lines.includes('') ? '' : '\n');
}

export function projectToMarkdown(repos: Repos, project: ProjectRow): string {
  const children = repos
    .listTasks(project.workspace_id ?? undefined)
    .filter((t) => t.project_id === project.id);
  const lines = [
    `# ${project.name}`,
    '',
    `- 状态：${project.status}`,
    `- 甲方：${project.client_name || '（未填）'}`,
    `- 创建时间：${project.created_at}`,
    '',
    '## 方案说明',
    '',
    project.brief || '（无）',
    '',
    `## 子任务成果（${children.length}）`,
    '',
  ];
  for (const t of children) {
    lines.push(`### ${t.title}（${t.type} · ${t.status}）`, '', t.result || '（暂无成果）', '');
  }
  return lines.join('\n');
}

export function projectToCsv(repos: Repos, project: ProjectRow): string {
  const children = repos
    .listTasks(project.workspace_id ?? undefined)
    .filter((t) => t.project_id === project.id);
  const rows = [['任务标题', '类型', '状态', '成果', 'tokens', '成本(元)'].join(',')];
  for (const t of children) {
    rows.push(
      [t.title, t.type, t.status, t.result, String(t.total_tokens), String(milliToYuan(t.total_cost_milli))]
        .map(csvCell)
        .join(','),
    );
  }
  return rows.join('\n') + '\n';
}

export function taskToCsv(task: TaskRow): string {
  const rows = [['任务标题', '类型', '状态', '成果', 'tokens', '成本(元)'].join(',')];
  rows.push(
    [task.title, task.type, task.status, task.result, String(task.total_tokens), String(milliToYuan(task.total_cost_milli))]
      .map(csvCell)
      .join(','),
  );
  return rows.join('\n') + '\n';
}

/**
 * 交付页正文（服务端渲染的只读 HTML）。G-12 起正文走 markdownToHtml 结构化渲染
 * （先全量转义再轻量解析，与前端 MarkdownView 同口径同用例）；extraHtml 为可信的
 * 服务端自生成片段（如 G-13 分享卡图 <img>，URL 由路由层拼 token，非用户输入）。
 */
export function renderDeliveryHtml(
  title: string,
  bodyMarkdownish: string,
  metaLine: string,
  extraHtml = '',
): string {
  const body = markdownToHtml(bodyMarkdownish);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} · 交付页</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f1e7;color:#2b2620;margin:0;padding:32px 16px}
.wrap{max-width:820px;margin:0 auto;background:#fffdf7;border:2px solid #2b2620;border-radius:14px;padding:28px 30px;box-shadow:4px 4px 0 #2b2620}
h1{font-size:22px;margin:0 0 6px}.meta{color:#8a7f6d;font-size:13px;margin-bottom:18px}
.md p{margin:0 0 14px;line-height:1.75;word-break:break-word}
.md h1{font-size:20px}.md h2{font-size:17px}.md h3{font-size:15px}
.md pre{background:#2b2620;color:#f6f1e7;border-radius:8px;padding:12px 14px;overflow-x:auto;line-height:1.6}
.md code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.md table{border-collapse:collapse;margin:0 0 14px}
.md th,.md td{border:1.5px solid #2b2620;padding:5px 10px;text-align:left}
.md hr{border:none;border-top:1.5px dashed #cbbfa5;margin:16px 0}
.sharecard{width:100%;max-width:600px;border:2px solid #2b2620;border-radius:10px;margin:0 0 18px;display:block}
.foot{margin-top:24px;padding-top:12px;border-top:1px dashed #cbbfa5;color:#8a7f6d;font-size:12px}
@media (max-width:600px){body{padding:16px 8px}.wrap{padding:18px 16px}h1{font-size:19px}}
</style></head>
<body><div class="wrap"><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(metaLine)}</div>
${extraHtml}
<div class="md">
${body}
</div>
<div class="foot">由「干活蜂群」生成 · 只读交付页</div></div></body></html>`;
}

export function renderDeliveryPasswordHtml(title: string, badPassword: boolean): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} · 需要访问口令</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f1e7;color:#2b2620;margin:0;padding:48px 16px}
.wrap{max-width:420px;margin:0 auto;background:#fffdf7;border:2px solid #2b2620;border-radius:14px;padding:26px;box-shadow:4px 4px 0 #2b2620}
input{width:100%;box-sizing:border-box;padding:10px;border:2px solid #2b2620;border-radius:8px;margin:10px 0;font-size:16px;min-height:44px}
button{background:#e8a13a;border:2px solid #2b2620;border-radius:8px;padding:9px 18px;font-weight:700;cursor:pointer;min-height:44px}
.err{color:#c0392b;font-size:13px}
@media (max-width:600px){body{padding:24px 10px}.wrap{padding:18px 16px}}
</style></head>
<body><div class="wrap"><h1 style="font-size:19px;margin:0 0 6px">${escapeHtml(title)}</h1>
<p style="color:#8a7f6d;font-size:13px">这份交付物设有访问口令，输入后查看。</p>
${badPassword ? '<p class="err">口令不正确，请重试。</p>' : ''}
<form method="POST"><input type="password" name="password" placeholder="访问口令" autofocus/>
<button type="submit">查看交付物</button></form></div></body></html>`;
}
