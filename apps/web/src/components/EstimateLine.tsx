import { useEffect, useState } from 'react';
import { fetchCostEstimate } from '../api';
import { yuan } from '../utils';
import type { CostEstimate } from '../types';

const BASIS_LABEL: Record<CostEstimate['basis'], string> = {
  skill: '按这个技能的历史',
  type: '按同类任务的历史',
  workspace: '按全空间任务均值估算',
  none: '',
};

/**
 * 发单预估行（G-08）：同类任务近 30 天平均与区间；basis='none' 时提示暂无历史。
 * type / skillId 变化即重拉；拉取失败静默隐藏（不阻断发单）。
 */
export default function EstimateLine({
  type,
  skillId,
}: {
  type?: string;
  skillId?: string;
}) {
  const [est, setEst] = useState<CostEstimate | null>(null);

  useEffect(() => {
    let stop = false;
    setEst(null);
    fetchCostEstimate({ type, skillId })
      .then((e) => {
        if (!stop) setEst(e);
      })
      .catch(() => {
        if (!stop) setEst(null);
      });
    return () => {
      stop = true;
    };
  }, [type, skillId]);

  if (!est) return null;
  if (est.basis === 'none') {
    return <p className="hint">💰 暂无历史，跑几单后可预估成本。</p>;
  }
  return (
    <p className="hint">
      💰 预估（{BASIS_LABEL[est.basis]}，近 30 天 {est.sampleCount} 单）：平均 {yuan(est.avgYuan)}
      （区间 {yuan(est.p25Yuan)} – {yuan(est.p75Yuan)}）
    </p>
  );
}
