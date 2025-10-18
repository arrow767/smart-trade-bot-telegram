import { TradingPreset } from "./trading_config";

export type PlanInput = { side: "long" | "short"; entryPrice: number; positionUsd: number; preset: TradingPreset; };
export type Targets   = { stopPrice: number; tpPrices: number[]; };

function calcRiskPercentUSD(riskUsd: number, notionalUsd: number) {
  if (notionalUsd <= 0) throw new Error("positionUsd must be > 0");
  return riskUsd / notionalUsd;
}
export function planTargets({ side, entryPrice, positionUsd, preset }: PlanInput): Targets {
  const r = calcRiskPercentUSD(preset.trade_risk, positionUsd);
  const stopPrice = side === "long" ? entryPrice * (1 - r) : entryPrice * (1 + r);
  const tpPrices  = preset.take_profit.map(mult =>
    side === "long" ? entryPrice * (1 + r * mult) : entryPrice * (1 - r * mult)
  );
  return { stopPrice, tpPrices };
}
