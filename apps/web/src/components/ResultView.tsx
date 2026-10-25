import { useState } from 'react';
import MarkdownView from './MarkdownView';
import { Button } from './ui';

/**
 * 成果结构化预览（G-12）：成果正文统一走 MarkdownView 渲染（全站唯一一套 md 渲染）。
 * output_spec 声明结构化（或正文自身带 md 结构）的成果默认以渲染视图打开，
 * 附「看原文」切换回纯文本原文（含复制等既有动作不受影响，原文即 result 全文）。
 */

/** 正文是否带可结构化渲染的 md 结构（标题/列表/代码块/表格/分隔线任一） */
export function looksStructured(text: string): boolean {
  return (
    /(^|\n)(#{1,6}\s|[-*+]\s|\d+[.、)]\s|```|---\s*$)/.test(text) || /\n\s*\|?[-\s:|]+\|/.test(text)
  );
}

export default function ResultView({
  result,
  structured,
  taskId,
}: {
  result: string;
  /** output_spec 声明结构化时传 true；不传则按正文结构自动判定 */
  structured?: boolean;
  /** 传入 done 任务 id 时附「分享卡」按钮（G-13，新窗口打开 SVG 卡图） */
  taskId?: string;
}) {
  const isStructured = structured ?? looksStructured(result);
  const [raw, setRaw] = useState(!isStructured);
  return (
    <div>
      {raw ? (
        <pre className="result">{result}</pre>
      ) : (
        <div className="result result-md">
          <MarkdownView source={result} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        <Button size="small" variant="gray" onClick={() => setRaw((v) => !v)}>
          {raw ? '看渲染视图' : '看原文'}
        </Button>
        {taskId ? (
          <a
            className="btn small gray"
            href={`/api/tasks/${taskId}/share-card`}
            target="_blank"
            rel="noreferrer"
          >
            分享卡
          </a>
        ) : null}
      </div>
    </div>
  );
}
