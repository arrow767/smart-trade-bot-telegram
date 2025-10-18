export function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const k = Math.floor(value / step);
  return k * step;
}

export function splitQtyToStep(totalQty: number, ratiosPct: number[], step: number): number[] {
  const raw = ratiosPct.map(r => (totalQty * r) / 100);
  const floored = raw.map(q => roundDownToStep(q, step));
  const used = floored.reduce((a, b) => a + b, 0);
  const remainder = totalQty - used;
  if (remainder > 0) {
    floored[floored.length - 1] = roundDownToStep(floored[floored.length - 1] + remainder, step);
  }
  const sum = floored.reduce((a, b) => a + b, 0);
  if (sum > totalQty) {
    const diff = sum - totalQty;
    floored[floored.length - 1] = roundDownToStep(floored[floored.length - 1] - diff, step);
  }
  return floored;
}

export function mergeDustToPrev(tpQtys: number[], minQty: number, step: number): number[] {
  if (tpQtys.length < 2) return tpQtys;
  const last = tpQtys[tpQtys.length - 1];
  if (last >= minQty) return tpQtys;
  const prev = tpQtys[tpQtys.length - 2];
  tpQtys[tpQtys.length - 2] = roundDownToStep(prev + last, step);
  tpQtys[tpQtys.length - 1] = 0;
  return tpQtys;
}
