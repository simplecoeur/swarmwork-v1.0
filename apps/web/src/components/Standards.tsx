import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import { Button, Textarea } from './ui';

export default function Standards() {
  const { S, post, refresh, toast } = useApp();
  const [points, setPoints] = useState('');
  const [clientNeeds, setClientNeeds] = useState('');
  const pointsRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<HTMLTextAreaElement>(null);

  // 与原生版一致：轮询回来的最新标准只在输入框未聚焦时回填，避免冲掉正在输入的内容
  useEffect(() => {
    if (!S) return;
    if (document.activeElement !== pointsRef.current) setPoints(S.reviewStandards.points || '');
    if (document.activeElement !== clientRef.current) setClientNeeds(S.reviewStandards.clientNeeds || '');
  }, [S]);

  async function saveStandards() {
    try {
      await post('/api/settings/review', { points, clientNeeds });
    } catch { return; }
    toast('审核标准已保存，即刻生效');
    refresh();
  }

  return (
    <div className="card" style={{ flex: 1 }}>
      <h2>审核标准 <span className="tag">总经理/审核员按此把关，保存即生效</span></h2>
      <label>审核要点（一行一条）</label>
      <Textarea
        ref={pointsRef}
        rows={4}
        placeholder={'如：标题必须带数字\n不能出现夸大词\n结尾要有悬念'}
        value={points}
        onChange={(e) => setPoints(e.target.value)}
      />
      <label>甲方需求</label>
      <Textarea
        ref={clientRef}
        rows={3}
        placeholder="甲方偏好、品牌口径、交付格式要求……"
        value={clientNeeds}
        onChange={(e) => setClientNeeds(e.target.value)}
      />
      <div style={{ marginTop: 10 }}>
        <Button variant="blue" onClick={saveStandards}>保存审核标准</Button>
      </div>
    </div>
  );
}
