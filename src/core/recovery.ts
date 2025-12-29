import type { BinanceFutures } from "../exch/BinanceFutures";
import type { TaskBook } from "./TaskBook";
import type { Task } from "./types";
import { DEFAULT_PRESET } from "./types";
import { getPreset } from "../config/trading_config";
import { cancelOnlySL, cancelBracketOnly } from "./OrderUtils";
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
  // ✅ НОВОЕ: Фильтруем superseded задачи
  const notSuperseded = tasks.filter((t) => !t.supersededBy);
  const bySide = notSuperseded.filter((t) => t.side === posSide && active.has(t.status));
  if (bySide.length) {
    // ✅ Сортируем по ID (более новая задача имеет приоритет)
    return [...bySide].sort((a, b) => b.id - a.id)[0];
  }
  const noSide = notSuperseded.filter((t) => !t.side && active.has(t.status));
  if (noSide.length) {
    return [...noSide].sort((a, b) => b.id - a.id)[0];
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

  // ✅ НОВОЕ: Включить очистку ордеров если задач нет
  const cleanupOrphanOrdersEnabled = String(process.env.RECOVERY_CLEANUP_ORPHAN_ORDERS || "true").toLowerCase() === "true" 
    || String(process.env.RECOVERY_CLEANUP_ORPHAN_ORDERS || "true") === "1";
  const symbolsWithOrphansGrace = new Map<string, number>(); // symbol → timestamp когда заметили

  const timer = setInterval(async () => {
    try {
      const allTasks = book.list();
      // ✅ ИСПРАВЛЕНО: Включаем задачи с ошибками для очистки, но исключаем done/canceled
      const activeTasks = allTasks.filter((t) => t.status !== "done" && t.status !== "canceled" && !t.supersededBy);
      const errorTasks = allTasks.filter((t) => t.status === "error" && !t.supersededBy);
      const tasks = activeTasks; // для обратной совместимости
      
      // ✅ НОВОЕ: Очистка задач с ошибками (если нет позиции и ордеров)
      for (const errorTask of errorTasks) {
        try {
          const symbol = errorTask.symbolCcxt;
          if (!symbol) continue;
          
          const filters = ex.getSymbolFilters(symbol);
          const minQty = filters?.minQty || 0;
          
          // Проверяем позицию
          const posSize = Math.abs(await ex.fetchPositionSize(symbol).catch(() => 0));
          const flat = posSize < minQty * 0.5;
          
          // Проверяем ордера
          const open = (await ex.fetchOpenOrders(symbol) as any[]).length;
          let algo = 0;
          try { algo = (await ex.fetchOpenAlgoOrders(symbol)).length; } catch {}
          const noOrders = open === 0 && algo === 0;
          
          if (flat && noOrders) {
            book.remove(errorTask.id);
            log(`🧹 Recovery: удалил задачу с ошибкой #${errorTask.id} по ${symbol} (нет позиций и ордеров)`);
          }
        } catch {}
      }
      
      // ✅ НОВОЕ: Проверка на orphan ордера (ордера без задач)
      if (cleanupOrphanOrdersEnabled && activeTasks.length === 0 && allTasks.length === 0) {
        // Если вообще нет задач — проверяем все позиции на наличие ордеров
        try {
          const positions = await ex.fetchAllOpenPositions();
          for (const pos of positions) {
            const symbol = pos.symbol;
            const filters = ex.getSymbolFilters(symbol);
            const minQty = filters?.minQty || 0;
            const posSize = Math.abs(pos.contracts ?? 0);
            
            // Если позиции нет — снимаем ордера
            if (posSize < minQty * 0.5) {
              try {
                const open = (await ex.fetchOpenOrders(symbol)) as any[];
                const algo = await ex.fetchOpenAlgoOrders(symbol).catch(() => []);
                const anyOrders = (open?.length || 0) + (algo?.length || 0);
                
                if (anyOrders > 0) {
                  const now = Date.now();
                  const graceStart = symbolsWithOrphansGrace.get(symbol);
                  
                  if (!graceStart) {
                    symbolsWithOrphansGrace.set(symbol, now);
                  } else if (now - graceStart > 30_000) {
                    // 30 секунд grace period прошло — снимаем ордера
                    await cancelBracketOnly(ex, symbol, new Set()).catch(() => {});
                    log(`🧹 Recovery: снял ${anyOrders} orphan ордеров по ${symbol} (задач нет)`);
                    symbolsWithOrphansGrace.delete(symbol);
                  }
                } else {
                  symbolsWithOrphansGrace.delete(symbol);
                }
              } catch {}
            }
          }
        } catch {}
      }
      
      if (!tasks.length) return;

      // ✅ ИСПРАВЛЕНО: Отслеживаем если получение позиций провалилось
      let positionsFetchFailed = false;
      let positions: any[] = [];
      try {
        const result = await ex.fetchAllOpenPositions();
        positions = Array.isArray(result) ? result : [];
      } catch (e: any) {
        positionsFetchFailed = true;
        // Не логируем каждый раз, только если не связано с сетью
        if (!/fetch|timeout|network/i.test(String(e?.message || ""))) {
          console.warn(`[WARN] Recovery: fetchAllOpenPositions failed: ${e?.message}`);
        }
      }

      const bySymbol = new Map<string, Task[]>();
      for (const t of tasks) {
        if (!t.symbolCcxt) continue;
        bySymbol.set(t.symbolCcxt, [...(bySymbol.get(t.symbolCcxt) || []), t]);
      }

      for (const [symbol, ts] of bySymbol.entries()) {
        const now = Date.now();
        const pos = positions.find((p: any) => p.symbol === symbol);

        // 1) Если есть позиция — обеспечиваем SL/TP для связанной задачи
        if (pos) {
          emptySinceBySymbol.delete(symbol);
          const task = pickTaskForSymbol(ts, pos.side);
          if (task) {
            await ensureBracketsForTask(ex, task, pos, log).catch(() => {});
          }
          continue;
        }

        // ✅ ИСПРАВЛЕНО: Если не удалось получить позиции — не принимаем решений на удаление
        if (positionsFetchFailed) {
          emptySinceBySymbol.delete(symbol);
          continue;
        }

        // ✅ ДВОЙНАЯ ПРОВЕРКА: подтверждаем что позиции нет через другой метод
        let posCheck2 = 999;
        try {
          posCheck2 = Math.abs(await ex.fetchPositionSize(symbol));
        } catch {}
        const filters = ex.getSymbolFilters(symbol);
        const minQty = filters?.minQty || 0;
        if (posCheck2 > minQty * 0.5) {
          // Позиция на самом деле есть — fetchAllOpenPositions врёт или устарел
          emptySinceBySymbol.delete(symbol);
          continue;
        }
        
        // ✅ НОВОЕ: Если позиции нет, проверяем live/filled задачи — возможно позиция закрыта вручную
        const liveTasks = ts.filter(t => t.status === "live" || t.status === "filled");
        if (liveTasks.length > 0) {
          // Проверяем ордера
          let hasOrders = false;
          try {
            const open = (await ex.fetchOpenOrders(symbol) as any[]).length;
            let algo = 0;
            try { algo = (await ex.fetchOpenAlgoOrders(symbol)).length; } catch {}
            hasOrders = (open + algo) > 0;
          } catch {}
          
          if (!hasOrders) {
            // Позиция закрыта и ордеров нет — удаляем live задачи
            for (const t of liveTasks) {
              book.remove(t.id);
              log(`🧹 Recovery: позиция ${symbol} закрыта вручную — удалил задачу #${t.id}`);
            }
            continue;
          }
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


