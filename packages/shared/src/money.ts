/**
 * 金额换算：内部一律以「厘」（1 元 = 1000 厘）整数运算，杜绝浮点误差。
 * API 出参在边界处用 milliToYuan 格式化为元（number）。
 */

/** 元 → 厘（四舍五入到整数厘） */
export function yuanToMilli(yuan: number): number {
  return Math.round(yuan * 1000);
}

/** 厘 → 元（仅用于展示/出参边界，不参与内部运算） */
export function milliToYuan(milli: number): number {
  return milli / 1000;
}

/** 一次调用的成本（厘）= 总 token × 单价（厘/百万 token）÷ 1,000,000，四舍五入到整数厘 */
export function tokenCostMilli(totalTokens: number, pricePerMMilli: number): number {
  return Math.round((totalTokens * pricePerMMilli) / 1_000_000);
}

/** 余额推导（厘）：采购合计 − 账本消耗合计（ADR-004，不存可变余额字段） */
export function deriveBalanceMilli(purchasesMilli: number[], ledgerCostMilli: number[]): number {
  const p = purchasesMilli.reduce((s, n) => s + n, 0);
  const l = ledgerCostMilli.reduce((s, n) => s + n, 0);
  return p - l;
}
