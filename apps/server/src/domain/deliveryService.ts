import { milliToYuan } from '@swarm/shared';
import type { ProjectRow, Repos, TaskRow } from '../store/repositories';

/**
 * 成果交付（方案 §11.2）：导出文档/表格 + 只读交付页内容组装。
 * 交付页只呈现被交付的那一份（任务或项目），不带空间内任何其他数据。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/** 交付页正文（服务端渲染的只读 HTML；内容全部转义，成果按纯文本分段呈现） */
export function renderDeliveryHtml(title: string, bodyMarkdownish: string, metaLine: string): string {
  const paras = escapeHtml(bodyMarkdownish)
    .split(/\n{2,}/)
    .map((p) => `<div class="blk">${p.replace(/\n/g, '<br/>')}</div>`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} · 交付页</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f1e7;color:#2b2620;margin:0;padding:32px 16px}
.wrap{max-width:820px;margin:0 auto;background:#fffdf7;border:2px solid #2b2620;border-radius:14px;padding:28px 30px;box-shadow:4px 4px 0 #2b2620}
h1{font-size:22px;margin:0 0 6px}.meta{color:#8a7f6d;font-size:13px;margin-bottom:18px}
.blk{margin:0 0 14px;line-height:1.75;word-break:break-word}
.foot{margin-top:24px;padding-top:12px;border-top:1px dashed #cbbfa5;color:#8a7f6d;font-size:12px}
@media (max-width:600px){body{padding:16px 8px}.wrap{padding:18px 16px}h1{font-size:19px}}
</style></head>
<body><div class="wrap"><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(metaLine)}</div>
${paras}
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
