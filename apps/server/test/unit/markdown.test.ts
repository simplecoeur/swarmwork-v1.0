import { describe, expect, it } from 'vitest';
import { MD_CANONICAL_CASE, markdownToHtml } from '../../src/domain/markdown';

/**
 * G-12 服务端 md→html 单元断言（与前端 MarkdownView 共享同一组用例文本 MD_CANONICAL_CASE，
 * 双端行为对齐口径）：表格/列表/代码块渲染正确；<script>/<img onerror> 只以转义实体出现；
 * 链接仅 http/https 且带 rel=noreferrer。
 */
describe('G-12 markdownToHtml（规范用例）', () => {
  const html = markdownToHtml(MD_CANONICAL_CASE);

  it('标题/粗斜体/行内代码渲染', () => {
    expect(html).toContain('<h1>一级标题</h1>');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<code>行内代码</code>');
  });

  it('无序/有序列表与表格行列正确', () => {
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>无序一</li>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>有序二</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>列A</th>');
    expect(html).toContain('<td>甲</td>');
    expect(html).toContain('<td>乙</td>');
  });

  it('代码块内容被转义（< 不成标签）', () => {
    expect(html).toContain('<pre><code>');
    expect(html).toContain('const x = 1 &lt; 2;');
  });

  it('分隔线与链接（仅 http/https、rel=noreferrer）', () => {
    expect(html).toContain('<hr/>');
    expect(html).toContain('<a href="https://example.com" rel="noreferrer">链接</a>');
    const js = markdownToHtml('[x](javascript:alert(1))');
    expect(js).not.toContain('<a ');
    expect(js).toContain('javascript:');
  });

  it('XSS 口径：script/img onerror 只以实体出现、无可执行标签', () => {
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });

  it('超范围语法不崩不吞字', () => {
    const html2 = markdownToHtml('> 引用行\n\n::: weird\n普通结尾');
    expect(html2).toContain('引用行');
    expect(html2).toContain('普通结尾');
  });
});
