import type { ReactNode } from 'react';

/**
 * 最小 Markdown 渲染（G-05；与 G-12 同一条 XSS 安全线）：
 * 只支持标题 / 段落 / 有序无序列表 / 代码块 / 行内代码 / 粗体。
 * 安全口径——绝不透传原始 HTML：全文按纯文本解析成 React 节点（React 渲染时自动转义），
 * 文中的 <script> 等只会以字面文本出现。超范围语法按纯文本呈现，不吞字。
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // 行内代码 `code` 与粗体 **bold**，其余一律纯文本
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      parts.push(<code key={`${keyPrefix}-c${i++}`}>{tok.slice(1, -1)}</code>);
    } else {
      parts.push(<strong key={`${keyPrefix}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function MarkdownView({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码块 ``` 围栏
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      blocks.push(
        <pre key={key++}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    // 标题
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      if (level === 1) blocks.push(<h1 key={key++}>{renderInline(text, `h${key}`)}</h1>);
      else if (level === 2) blocks.push(<h2 key={key++}>{renderInline(text, `h${key}`)}</h2>);
      else blocks.push(<h3 key={key++}>{renderInline(text, `h${key}`)}</h3>);
      i++;
      continue;
    }
    // 列表（连续的 - 或 1. 行）
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.、]\s+/.test(line)) {
      const ordered = /^\s*\d+[.、]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.、]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+[.、])\s+/, ''));
        i++;
      }
      const lis = items.map((it, j) => <li key={j}>{renderInline(it, `li${key}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={key++}>{lis}</ol> : <ul key={key++}>{lis}</ul>);
      continue;
    }
    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }
    // 段落（合并相邻普通行）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.、]\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('```')
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(buf.join(' '), `p${key}`)}</p>);
  }
  return <div className="help-md">{blocks}</div>;
}
