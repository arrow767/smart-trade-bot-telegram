import type { BinanceFutures } from "../exch/BinanceFutures";
import type { TaskBook } from "./TaskBook";
import type { Task } from "./types";
import { DEFAULT_PRESET } from "./types";
import { getPreset } from "../config/trading_config";
import { cancelOnlySL } from "./OrderUtils";
import { adjustStopForMark, calcDesiredSLByRiskUsd, fmtQty5 } from "./TradingUtils";
import { planTargets } from "./Planner";
import { mergeDustToPrev, splitQtyToStep } from "../utils/math";

function hasClosePositionSL(orders: any[]): boolean {
  for (const o of orders) {
    const t = String(o?.type || o?.strategyType || "").toUpperCase();
    const isStop = t.includes("STOP");
    const cp = o?.closePosition === true || o?.closePosition === "true" || o?.info?.closePosition === true || o?.info?.closePosition === "true";
    if (isStop && cp) return true;
  }
  return false;
}

function hasAnyReduceOnlyTP(orders: any[]): boolean {
  for (const o of orders) {
    const t = String(o?.type || o?.strategyType || "").toUpperCase();
    const isLimit = t.includes("LIMIT") && !t.includes("STOP");
    const ro = o?.reduceOnly === true || o?.reduceOnly === "true" || o?.info?.reduceOnly === true || o?.info?.reduceOnly === "true";
    const cp = o?.closePosition === true || o?.closePosition === "true" || o?.info?.closePosition === true || o?.info?.closePosition === "true";
    if (isLimit && ro && !cp) return true;
  }
  return false;
}

function pickTaskForSymbol(tasks: Task[], posSide: "long" | "short"): Task | undefined {
  const active = new Set(["waiting_fill", "filled", "placing_bracket", "live"]);
  const bySide = tasks.filter((t) => t.side === posSide && active.has(t.status));
  if (bySide.length) {
    return [...bySide].sort((a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0))[0];
  }
  const noSide = tasks.filter((t) => !t.side && active.has(t.status));
  if (noSide.length) {
    return [...noSide].sort((a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0))[0];
  }
  return undefined;
}

async function ensureBracketsForTask(
  ex: BinanceFutures,
  task: Task,
  pos: { contracts: number; entryPrice: number; side: "long" | "short" },
  log: (msg: string) => void
) {
  const symbol = task.symbolCcxt;
  const filters = ex.getSymbolFilters(symbol);
  const minQty = filters.minQty || 0;
  const posSize = Math.abs(pos.contracts || 0);
  const entryAvg = Number(pos.entryPrice || 0) || 0;
  if (!(posSize > minQty * 0.5) || !(entryAvg > 0)) return;

  const tick = await ex.fetchTicker(symbol);
  const mark = Number(tick.last ?? tick.mark ?? (tick as any)?.info?.markPrice);

  const open = (await ex.fetchOpenOrders(symbol)) as any[];
  let algo: any[] = [];
  try { algo = await ex.fetchOpenAlgoOrders(symbol); } catch {}
  const all = [...open, ...algo];

  const hasSL = hasClosePositionSL(all);
  const hasTP = hasAnyReduceOnlyTP(all); // ✅ FIX: проверяем все ордера, не только open

  if (hasSL && hasTP) return;

  const preset = await getPreset(task.presetName || DEFAULT_PRESET);
  const side = task.side || pos.side;
  const sideExit = side === "long" ? "sell" : "buy";

  const positionUsd = posSize * entryAvg;
  const totalPlannedUsd = task.totalUsd ?? positionUsd;
  const baseRisk =
    (typeof task.riskUsd === "number" && Number.isFinite(task.riskUsd) && task.riskUsd > 0)
      ? task.riskUsd
      : (Number.isFinite(preset.trade_risk) && preset.trade_risk > 0 ? preset.trade_risk : 0);
  const factor = Math.min(1, positionUsd / Math.max(1, totalPlannedUsd));
  const effectiveRiskUsd = baseRisk * factor;

  if (!hasSL) {
    const desiredSL = calcDesiredSLByRiskUsd(side, entryAvg, posSize, effectiveRiskUsd);
    const precSL = Number(ex.priceToPrecision(symbol, desiredSL));
    const safeSL0 = adjustStopForMark(side, precSL, mark, filters.tickSize || 0.0001);
    const safeSL = Number(ex.priceToPrecision(symbol, safeSL0));
    if (Number.isFinite(safeSL) && safeSL > 0) {
      const keep = new Set((task.entryOrderIds || []).map(String));
      await cancelOnlySL(ex, symbol, keep).catch(() => {});
      await ex.createStopMarketClose(symbol, sideExit as any, safeSL);
      log(`🧯 Recovery: SL выставлен для #${task.id} ${symbol} (${side}) @ ${safeSL}`);
    }
  }

  if (!hasTP) {
    const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset });
    let tpQtys = splitQtyToStep(posSize, preset.take_profit_ratio, filters.stepSize);
    tpQtys = mergeDustToPrev(tpQtys, filters.minQty, filters.stepSize);
    tpQtys = tpQtys.map((q) => Number(ex.amountToPrecision(symbol, q)));

    let placed = 0;
    for (let i = 0; i < re.tpPrices.length; i++) {
      const q = tpQtys[i];
      if (!(q > 0)) continue;
      const p = Number(ex.priceToPrecision(symbol, re.tpPrices[i]));
      await ex.createReduceOnlyLimit(symbol, sideExit as any, q, p);
      placed++;
    }
    if (placed > 0) {
      log(`🧯 Recovery: TP выставлены для #${task.id} ${symbol} (${side}) — ${placed} ордеров (pos≈${fmtQty5(posSize)})`);
    }
  }
}

export function startTaskRecoveryLoop(
  ex: BinanceFutures,
  book: TaskBook,
  log: (msg: string) => void,
  intervalMs = Number(process.env.RECOVERY_INTERVAL_MS || 10_000)
) {
  const enabled = String(process.env.RECOVERY_ENABLED || "true").toLowerCase() === "true" || String(process.env.RECOVERY_ENABLED || "true") === "1";
  if (!enabled) return { stop: () => {} };

  const orphanEnabled = String(process.env.RECOVERY_ORPHAN_ENABLED || "true").toLowerCase() === "true" || String(process.env.RECOVERY_ORPHAN_ENABLED || "true") === "1";
  const orphanGraceMs = Number(process.env.RECOVERY_ORPHAN_GRACE_MS || 60_000);
  const emptySinceBySymbol = new Map<string, number>();

  const timer = setInterval(async () => {
    try {
      const tasks = book.list().filter((t) => t.status !== "done" && t.status !== "canceled");
      if (!tasks.length) return;

      const positions = await ex.fetchAllOpenPositions().catch(() => []);
      const posArr = Array.isArray(positions) ? positions : [];

      const bySymbol = new Map<string, Task[]>();
      for (const t of tasks) {
        if (!t.symbolCcxt) continue;
        bySymbol.set(t.symbolCcxt, [...(bySymbol.get(t.symbolCcxt) || []), t]);
      }

      for (const [symbol, ts] of bySymbol.entries()) {
        const now = Date.now();
        const pos = posArr.find((p: any) => p.symbol === symbol);

        // 1) Если есть позиция — обеспечиваем SL/TP для связанной задачи
        if (pos) {
          emptySinceBySymbol.delete(symbol);
          const task = pickTaskForSymbol(ts, pos.side);
          if (task) {
            await ensureBracketsForTask(ex, task, pos, log).catch(() => {});
          }
          continue;
        }

        // 2) Если позиции нет — проверяем "висячие" tasks (нет ордеров вообще) с grace-time
        if (!orphanEnabled) {
          emptySinceBySymbol.delete(symbol);
          continue;
        }

        let open: any[] = [];
        let algo: any[] = [];
        let openFailed = false;
        let algoFailed = false;
        try { open = (await ex.fetchOpenOrders(symbol)) as any[]; } catch { openFailed = true; }
        try { algo = await ex.fetchOpenAlgoOrders(symbol); } catch { algoFailed = true; }

        // Если не удалось получить список ордеров — не принимаем решений на удаление
        if (openFailed || algoFailed) {
          emptySinceBySymbol.delete(symbol);
          continue;
        }

        const anyOrders = (open?.length || 0) + (algo?.length || 0);
        if (anyOrders > 0) {
          emptySinceBySymbol.delete(symbol);
          continue;
        }

        const emptySince = emptySinceBySymbol.get(symbol);
        if (!emptySince) {
          emptySinceBySymbol.set(symbol, now);
          continue;
        }

        if (now - emptySince >= Math.max(5_000, orphanGraceMs)) {
          // Нет позиций и нет ордеров вообще — удаляем зависшие задачи по символу
          for (const t of ts) {
            book.remove(t.id);
          }
          emptySinceBySymbol.delete(symbol);
          log(`🧹 Recovery: висячие задачи по ${symbol} удалены (нет позиций и ордеров > ${Math.round(Math.max(5_000, orphanGraceMs) / 1000)}s)`);
        }
      }
    } catch {}
  }, Math.max(2_000, intervalMs));

  return { stop: () => clearInterval(timer) };
}


