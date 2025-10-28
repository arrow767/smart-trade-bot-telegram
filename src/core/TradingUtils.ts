import { BinanceFutures } from "../exch/BinanceFutures";
import { NOTIONAL_BIAS } from "./types";

/**
 * Форматирование qty до 5 знаков
 */
export function fmtQty5(q: number): string {
  return (Math.round(q * 1e5) / 1e5).toFixed(5);
}

/**
 * Подобрать qty по шагу под целевой notional
 */
export function computeQtyForUsdSmart(
  ex: BinanceFutures,
  symbol: string,
  usdTarget: number,
  price: number,
  bias: "nearest" | "down" | "up" = NOTIONAL_BIAS
): { qty: number; usdActual: number; under: boolean; over: boolean; tooSmall: boolean } {
  const f = ex.getSymbolFilters(symbol);
  if (!(usdTarget > 0) || !(price > 0))
    return { qty: 0, usdActual: 0, under: true, over: false, tooSmall: true };

  const rawQty = usdTarget / price;
  const stepsFloat = rawQty / f.stepSize;

  const floorSteps = Math.max(0, Math.floor(stepsFloat + 1e-12));
  const ceilSteps = Math.max(floorSteps, Math.ceil(stepsFloat - 1e-12));

  const qFloor = floorSteps * f.stepSize;
  const qCeil = ceilSteps * f.stepSize;

  const usdFloor = qFloor * price;
  const usdCeil = qCeil * price;

  const diffFloor = Math.abs(usdFloor - usdTarget);
  const diffCeil = Math.abs(usdCeil - usdTarget);

  let q = qFloor, usdAct = usdFloor;
  if (bias === "down") {
    q = qFloor; usdAct = usdFloor;
  } else if (bias === "up") {
    q = qCeil; usdAct = usdCeil;
  } else {
    if (diffCeil < diffFloor) { q = qCeil; usdAct = usdCeil; }
    else { q = qFloor; usdAct = usdFloor; }
  }

  q = Number(ex.amountToPrecision(symbol, q));
  if (q < (ex.getSymbolFilters(symbol).minQty || 0) - 1e-12) {
    return { qty: 0, usdActual: 0, under: true, over: false, tooSmall: true };
  }
  return { qty: q, usdActual: usdAct, under: usdAct <= usdTarget, over: usdAct > usdTarget, tooSmall: false };
}

/**
 * Проверка, сработает ли стоп-ордер мгновенно
 */
export function wouldStopImmediatelyTrigger(side: "long" | "short", stopPrice: number, mark: number) {
  return side === "long" ? stopPrice <= mark : stopPrice >= mark;
}

/**
 * Скорректировать стоп-ордер относительно mark price
 */
export function adjustStopForMark(side: "long" | "short", desired: number, mark: number, tick: number) {
  if (side === "long") {
    const safe = mark - 2 * tick;
    return Math.min(desired, safe);
  } else {
    const safe = mark + 2 * tick;
    return Math.max(desired, safe);
  }
}

/**
 * Рассчитать желаемую цену SL по долларам риска
 */
export function calcDesiredSLByRiskUsd(
  side: "long" | "short",
  entryAvg: number,
  posSize: number,
  effectiveRiskUsd: number
): number {
  if (!(entryAvg > 0) || !(posSize > 0) || !(effectiveRiskUsd >= 0)) return entryAvg;
  const perContractLoss = effectiveRiskUsd / Math.max(1e-12, posSize);
  return side === "long" ? (entryAvg - perContractLoss) : (entryAvg + perContractLoss);
}

