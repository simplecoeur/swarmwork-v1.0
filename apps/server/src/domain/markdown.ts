/**
 * 服务端 Markdown → HTML（G-12）：交付页（/d/:token）与参观页（/v/:token）等服务端渲染面共用。
 *
 * 前端 apps/web/src/components/MarkdownView.tsx 是同一口径的另一份实现
 * （逐行成块解析为 React 节点）——两边代码各一份、行为对齐，这是设计明确要求的有意重复，
 * 不是疏漏：服务端渲染拿不到 React 运行时，前端则绝不走 innerHTML。两边共享同一组
 * 测试用例文本（见下方 MD_CANONICAL_CASE），各自在自己的测试里断言渲染结果一致口径。
 *
 * 安全口径（与前端同一条线）：先对全文做 HTML 全量转义，再在转义后的文本上做轻量
 * 块/行内解析——原文中的 <script>、<img onerror> 等只会以 &lt;script&gt; 实体出现，
 * 绝无任何透传原始 HTML 的路径；链接仅放行 http/https，其余协议按纯文本呈现。
 * 语法集（与前端一致）：标题 #~######、段落、粗体、斜体、行内代码、
 * 代码块 ```、有序/无序列表、表格（| 列 + --- 分隔行）、分隔线、链接。
 * 超范围语法按纯文本呈现，不吞字、不崩。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 双端共享的规范测试用例文本（前端 MarkdownView 的对应测试/走查使用同一段文本） */
export const MD_CANONICAL_CASE = [
  '# 一级标题',
  '',
  '普通段落，含 **粗体** 与 *斜体* 与 `行内代码`。',
  '',
  '- 无序一',
  '- 无序二',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 甲 | 乙 |',
  '',
  '```',
  'const x = 1 < 2;',
  '```',
  '',
  '---',
  '',
  '[链接](https://example.com) 与 <script>alert(1)</script> 与 <img src=x onerror=alert(1)>',
].join('\n');

/** 行内解析（入参已 HTML 转义）：行内代码 → 链接 → 粗体 → 斜体，顺序即优先级 */
function renderInlineEscaped(text: string): string {
  // 先按行内代码切分：代码内不再做任何格式化
  const segments = text.split(/(`[^`]+`)/g);
  return segments
    .map((seg) => {
      if (seg.length >= 2 && seg.startsWith('`') && seg.endsWith('`')) {
        return `<code>${seg.slice(1, -1)}</code>`;
      }
      let out = seg;
      // 链接 [text](url)：仅 http/https；url 中不许有空白/括号（已转义文本里 & 为 &amp; 可正常入 href）
      out = out.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" rel="noreferrer">$1</a>',
      );
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
      out = out.replace(/_([^_\n]+)_/g, '<em>$1</em>');
      return out;
    })
    .join('');
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

/** markdown → 安全 HTML（先全量转义再解析；输出只含本函数生成的标签） */
export function markdownToHtml(source: string): string {
  const esc = escapeHtml(source.replace(/\r\n/g, '\n'));
  const lines = esc.split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // 代码块
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        buf.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const head = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      const thead = `<thead><tr>${head.map((c) => `<th>${renderInlineEscaped(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInlineEscaped(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      blocks.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push('<hr/>');
      i++;
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(`<h${h[1]!.length}>${renderInlineEscaped(h[2]!)}</h${h[1]!.length}>`);
      i++;
      continue;
    }
    // 列表（连续同类行）
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.、)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.、)]\s+/.test(line);
      const items: string[] = [];
      while (
        i < lines.length &&
        (/^\s*[-*+]\s+/.test(lines[i]!) || /^\s*\d+[.、)]\s+/.test(lines[i]!))
      ) {
        items.push(lines[i]!.replace(/^\s*(?:[-*+]|\d+[.、)])\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(
        `<${tag}>${items.map((it) => `<li>${renderInlineEscaped(it)}</li>`).join('')}</${tag}>`,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // 段落（合并相邻普通行）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.、)]\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('```') &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!) &&
      !(lines[i]!.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(`<p>${renderInlineEscaped(buf.join(' '))}</p>`);
  }
  return blocks.join('\n');
}
