import type { ReactNode } from 'react';

/**
 * 全站唯一的 Markdown 渲染组件（G-12 收编统一；G-05 帮助页与各成果落点共用这一套，
 * 不许再留第二套渲染）。
 *
 * 服务端 apps/server/src/domain/markdown.ts 是同一口径的另一份实现
 * （交付页/参观页等服务端渲染面用）——两边代码各一份、行为对齐，是设计明确要求的有意
 * 重复：前端逐行解析为 React 节点（React 渲染时自动转义），服务端先转义再拼 HTML 字符串。
 * 两边共享同一组测试用例文本（server 侧 MD_CANONICAL_CASE 常量为同一段文本）。
 *
 * 安全口径：绝不使用 innerHTML、绝不透传原始 HTML——文中 <script>、<img onerror> 等
 * 只会以字面文本出现；链接仅放行 http/https 且带 rel="noreferrer"，其余协议按纯文本呈现。
 * 语法集：标题 #~######、段落、粗体、斜体、行内代码、代码块、有序/无序列表、表格、
 * 分隔线、链接。超范围语法按纯文本呈现，不吞字、不崩。
 */

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith('`')) {
      parts.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      parts.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      parts.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(tok);
      if (link) {
        parts.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        parts.push(tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

const isListLine = (l: string) => /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.、)]\s+/.test(l);
const isHr = (l: string) => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l);

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
    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push(
        <table key={key++}>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>{renderInline(c, `th${key}-${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, j) => (
                  <td key={j}>{renderInline(c, `td${key}-${ri}-${j}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    // 分隔线
    if (isHr(line)) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const inner = renderInline(text, `h${key}`);
      if (level === 1) blocks.push(<h1 key={key++}>{inner}</h1>);
      else if (level === 2) blocks.push(<h2 key={key++}>{inner}</h2>);
      else if (level === 3) blocks.push(<h3 key={key++}>{inner}</h3>);
      else if (level === 4) blocks.push(<h4 key={key++}>{inner}</h4>);
      else if (level === 5) blocks.push(<h5 key={key++}>{inner}</h5>);
      else blocks.push(<h6 key={key++}>{inner}</h6>);
      i++;
      continue;
    }
    // 列表（连续同类行）
    if (isListLine(line)) {
      const ordered = /^\s*\d+[.、)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && isListLine(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.、)])\s+/, ''));
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
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !isListLine(lines[i]) &&
      !isHr(lines[i]) &&
      !lines[i].trim().startsWith('```') &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(buf.join(' '), `p${key}`)}</p>);
  }
  return <div className="help-md md-view">{blocks}</div>;
}
