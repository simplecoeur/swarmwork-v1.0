// 金额格式化：与原生版 yuan() 完全一致（4 位小数、去掉尾随 0）
export function yuan(n: unknown): string {
  return '¥' + Number(n || 0).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
}
