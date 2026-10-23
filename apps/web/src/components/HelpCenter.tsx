import { useState } from 'react';
import MarkdownView from './MarkdownView';
import FeedbackDialog from './FeedbackDialog';
import { ReopenGuideButton } from './Onboarding';
import { Button, Card } from './ui';
import gettingStarted from '../content/help/getting-started.md?raw';
import faq from '../content/help/faq.md?raw';
import openApi from '../content/help/open-api.md?raw';

const SECTIONS = [
  { id: 'getting-started', label: '快速上手', source: gettingStarted },
  { id: 'faq', label: '高频问题', source: faq },
  { id: 'open-api', label: '开放 API', source: openApi },
] as const;

/**
 * 帮助中心（G-05，/help 语义，站内 tab 呈现）：内容源 = apps/web/src/content/help/*.md 随前端打包，
 * MarkdownView 最小渲染（先转义后渲染）。含反馈表单入口与「重走新手引导」（重置 onboarding）。
 */
export default function HelpCenter() {
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('getting-started');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <>
      <Card>
        <h2>
          帮助中心 <span className="tag">使用说明与高频问题；遇到问题也可以直接给我们留言</span>
        </h2>
        <div className="help-toc">
          {SECTIONS.map((s) => (
            <Button
              key={s.id}
              variant={s.id === section ? 'primary' : 'gray'}
              size="small"
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </Button>
          ))}
          <Button variant="blue" size="small" onClick={() => setFeedbackOpen(true)}>
            ✉️ 意见反馈
          </Button>
        </div>
        <div id={`help-${cur.id}`}>
          <MarkdownView source={cur.source} />
        </div>
        {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      </Card>
      <Card>
        <h2>新手引导 <span className="tag">「🚀 快速开始」五步卡：认识团队 → 让团队能开工 → 发第一单 → 看时间线 → 收第一份成果</span></h2>
        <p className="hint" style={{ marginBottom: 8 }}>
          跳过或走完引导后想再走一遍，点下方按钮重置，回到办公室顶部就能重新看到快速开始卡。
        </p>
        <ReopenGuideButton />
      </Card>
    </>
  );
}
