import { TradingPreset } from "../config/trading_config";

export type PlanInput = { side: "long" | "short"; entryPrice: number; positionUsd: number; preset: TradingPreset; };
export type Targets   = { stopPrice: number; tpPrices: number[]; };

function calcRiskPercentUSD(riskUsd: number, notionalUsd: number) {
  if (notionalUsd <= 0) throw new Error("positionUsd must be > 0");
  return riskUsd / notionalUsd;
}

/**
 * Рассчитать SL и TP.
 * TP рассчитываются как кратное расстояние от entry до SL (1:3, 1:5, 1:7 и т.д.)
 */
export function planTargets({ side, entryPrice, positionUsd, preset }: PlanInput): Targets {
  const r = calcRiskPercentUSD(preset.trade_risk, positionUsd);
  const stopPrice = side === "long" ? entryPrice * (1 - r) : entryPrice * (1 + r);
  
  // ✅ ИСПРАВЛЕНО: TP рассчитываются от расстояния до SL, а не от r
  // Это гарантирует что TP1 = 1:3 от SL, TP2 = 1:5 от SL и т.д.
  const slDistance = Math.abs(entryPrice - stopPrice);
  const tpPrices = preset.take_profit.map((mult: number) =>
    side === "long" ? entryPrice + slDistance * mult : entryPrice - slDistance * mult
  );
  
  return { stopPrice, tpPrices };
}

/**
 * ✅ НОВОЕ: Рассчитать TP от заданного SL (когда SL уже известен)
 * Используется когда SL рассчитан через calcDesiredSLByRiskUsd
 */
export function planTPFromSL(
  side: "long" | "short",
  entryPrice: number,
  stopPrice: number,
  tpMultipliers: number[]
): number[] {
  const slDistance = Math.abs(entryPrice - stopPrice);
  return tpMultipliers.map((mult: number) =>
    side === "long" ? entryPrice + slDistance * mult : entryPrice - slDistance * mult
  );
}
