import { useState } from 'react';
import { useApp } from '../context';
import { Button, Dialog, Input, Select, Textarea } from './ui';

const CATEGORIES = [
  { value: 'bug', label: '遇到问题（bug）' },
  { value: 'suggestion', label: '功能建议' },
  { value: 'question', label: '使用疑问' },
  { value: 'other', label: '其他' },
];

/**
 * 意见反馈弹窗（G-05）：全站顶栏菜单与帮助页共用同一表单。
 * 提交走 POST /api/feedback（10 分钟 ≤5 条，超限后端回 VALIDATION 原文 toast）。
 * 反馈只落库供平台管理员在管理台查看，不做工单流转；如需回复请留联系方式。
 */
export default function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const { post, toast } = useApp();
  const [category, setCategory] = useState('suggestion');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!content.trim()) return toast('先写点内容再提交');
    setBusy(true);
    try {
      await post('/api/feedback', {
        category,
        content: content.trim(),
        contact: contact.trim() || undefined,
      });
      toast('反馈已提交，谢谢！管理员会在管理台看到它');
      onClose();
    } catch {
      /* post 已 toast 后端原文（含频率限制） */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="意见反馈">
      <label>分类</label>
      <Select value={category} onValueChange={setCategory} options={CATEGORIES} />
      <label>内容（最长 2000 字）</label>
      <Textarea
        rows={5}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="遇到了什么问题，或者希望蜂群多会点什么…"
      />
      <label>联系方式（选填，方便我们回复你）</label>
      <Input
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder="邮箱 / 微信（选填）"
      />
      <div style={{ marginTop: 12 }}>
        <Button onClick={submit} disabled={busy}>
          提交反馈
        </Button>{' '}
        <Button variant="gray" onClick={onClose}>
          取消
        </Button>
      </div>
    </Dialog>
  );
}
