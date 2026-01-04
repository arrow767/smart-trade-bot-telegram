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
    const isStop = t.includes("STOP") || t.includes("TAKE_PROFIT");
    
    // Проверяем closePosition в разных местах (обычные ордера и Algo Orders)
    const cp = o?.closePosition === true || o?.closePosition === "true" || 
               o?.info?.closePosition === true || o?.info?.closePosition === "true";
    
    // ✅ ИСПРАВЛЕНО: Algo Orders имеют strategyType и могут не иметь closePosition явно
    // Если это STOP/STOP_MARKET Algo Order без quantity — это closePosition SL
    const isAlgoSL = (o?.strategyType === "STOP" || o?.strategyType === "STOP_MARKET") && 
                     (!o?.quantity || o?.quantity === "0" || Number(o?.quantity) === 0);
    
    if (isStop && cp) return true;
    if (isAlgoSL) return true;
    
    // Любой STOP_MARKET с closePosition считаем SL
    if (t === "STOP_MARKET" || t === "STOP") {
      const hasCP = o?.closePosition || o?.info?.closePosition;
      if (hasCP === true || hasCP === "true") return true;
    }
  }
  return false;
}

function hasAnyReduceOnlyTP(orders: any[]): boolean {
  for (const o of orders) {
    const t = String(o?.type || o?.strategyType || "").toUpperCase();
    const isLimit = t.includes("LIMIT") && !t.includes("STOP");
    const ro = o?.reduceOnly === true || o?.reduceOnly === "true" || 
               o?.info?.reduceOnly === true || o?.info?.reduceOnly === "true";
    const cp = o?.closePosition === true || o?.closePosition === "true" || 
               o?.info?.closePosition === true || o?.info?.closePosition === "true";
    if (isLimit && ro && !cp) return true;
  }
  return false;
}

// ✅ НОВОЕ: Проверка кода ошибки Binance
function isKnownAlgoError(e: any): { code: number; ignore: boolean } {
  const code = Number(e?.code ?? e?.info?.code ?? NaN);
  const msg = String(e?.message || "");
  
  // -4509: TIF GTE can only be used with open positions (нет позиции)
  if (code === -4509 || /GTE.*can only be used with open positions/i.test(msg)) {
    return { code: -4509, ignore: true };
  }
  // -4130: An open stop or take profit order already exists
  if (code === -4130 || /open stop.*existing|closePosition.*existing/i.test(msg)) {
    return { code: -4130, ignore: true };
  }
  // -2022: ReduceOnly Order is rejected (нет позиции для TP)
  if (code === -2022 || /ReduceOnly.*rejected/i.test(msg)) {
    return { code: -2022, ignore: true };
  }
  // ✅ НОВОЕ: 429 / -1003: Rate limit - игнорируем, будет retry
  if (code === -1003 || /429|Too Many Requests|-1003/i.test(msg)) {
    return { code: -1003, ignore: true };
  }
  return { code: 0, ignore: false };
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
  book: TaskBook,
  task: Task,
  pos: { contracts: number; entryPrice: number; side: "long" | "short" },
  log: (msg: string) => void
) {
  const symbol = task.symbolCcxt;
  const filters = ex.getSymbolFilters(symbol);
  const minQty = filters.minQty || 0;
  
  // ✅ КРИТИЧНО: Перепроверяем позицию актуально (pos может быть устаревшим)
  let actualPosSize = Math.abs(pos.contracts || 0);
  let entryAvg = Number(pos.entryPrice || 0) || 0;
  
  try {
    const freshPos = Math.abs(await ex.fetchPositionSize(symbol));
    if (freshPos < minQty * 0.5) {
      // Позиция уже закрыта — не ставим SL/TP
      return;
    }
    actualPosSize = freshPos;
  } catch {
    // Если не удалось получить — используем переданные данные
  }
  
  if (!(actualPosSize > minQty * 0.5) || !(entryAvg > 0)) return;

  // ✅ НОВОЕ: Обновляем статус задачи если она была в waiting_fill
  // Это критично для корректной работы после рестарта бота
  if (task.status === "waiting_fill" || task.status === "filled" || task.status === "placing_bracket") {
    book.set(task, "live");
    // Обновляем taskEntry если ещё не было
    if (!task.taskEntryAvg || !task.taskEntryQty) {
      book.setTaskEntry(task, entryAvg, actualPosSize);
    }
    log(`🔄 Recovery: задача #${task.id} ${symbol} переведена в live (pos=${fmtQty5(actualPosSize)} @ ${entryAvg})`);
  }

  // ✅ НОВОЕ: Если noPreset=true — не ставим SL/TP
  if (task.noPreset) {
    log(`⏭️ Recovery: задача #${task.id} ${symbol} с noPreset — SL/TP не выставляем`);
    return;
  }

  const tick = await ex.fetchTicker(symbol);
  const mark = Number(tick.last ?? tick.mark ?? (tick as any)?.info?.markPrice);

  // ✅ ИСПРАВЛЕНО: Принудительно обновляем ордера (без кэша)
  const open = (await ex.fetchOpenOrders(symbol, { force: true })) as any[];
  let algo: any[] = [];
  try { algo = await ex.fetchOpenAlgoOrders(symbol); } catch {}
  const all = [...open, ...algo];

  const hasSL = hasClosePositionSL(all);
  
  // ✅ УЛУЧШЕНО: Проверяем TP более детально — сумма qty должна соответствовать позиции
  let hasTP = hasAnyReduceOnlyTP(all);
  let needRecalcTP = false;
  
  if (hasTP) {
    // Проверяем что сумма TP ≈ размеру позиции
    const tpOrders = open.filter((o: any) => {
      const t = String(o?.type || "").toUpperCase();
      const isLimit = t.includes("LIMIT") && !t.includes("STOP");
      const ro = o?.reduceOnly === true || o?.reduceOnly === "true" || 
                 o?.info?.reduceOnly === true || o?.info?.reduceOnly === "true";
      const cp = o?.closePosition === true || o?.closePosition === "true" || 
                 o?.info?.closePosition === true || o?.info?.closePosition === "true";
      return isLimit && ro && !cp;
    });
    
    const totalTPQty = tpOrders.reduce((sum: number, o: any) => {
      return sum + (Number(o.amount ?? o.info?.origQty ?? 0) || 0);
    }, 0);
    
    // Если сумма TP отличается от позиции более чем на 10% — пересчитываем
    const diff = Math.abs(totalTPQty - actualPosSize) / Math.max(actualPosSize, 1e-12);
    if (diff > 0.1) {
      needRecalcTP = true;
      // Снимаем старые TP
      for (const o of tpOrders) {
        if (o.id) {
          try { await ex.cancelOrder(symbol, o.id); } catch {}
        }
      }
      hasTP = false;
      log(`🔄 Recovery: TP пересчитываются для #${task.id} ${symbol} (diff=${(diff * 100).toFixed(1)}%)`);
    }
  }

  const preset = await getPreset(task.presetName || DEFAULT_PRESET);
  const side = task.side || pos.side;
  const sideExit = side === "long" ? "sell" : "buy";

  // ✅ КЛЮЧЕВОЕ: Для SL используем данные ЭТОЙ task, а не всей позиции (важно для цепочки)
  const slEntryAvg = task.taskEntryAvg && task.taskEntryAvg > 0 ? task.taskEntryAvg : entryAvg;
  const slEntryQty = task.taskEntryQty && task.taskEntryQty > 0 ? task.taskEntryQty : actualPosSize;
  
  // ✅ НОВОЕ: Проверяем нужно ли пересчитать SL (если он на неправильном расстоянии)
  let needRecalcSL = false;
  if (hasSL && task.taskEntryAvg && task.taskEntryAvg > 0) {
    // Найти текущую цену SL
    const currentSLOrder = all.find((o: any) => {
      const t = String(o?.type || o?.orderType || "").toUpperCase();
      const cp = o?.closePosition === true || o?.closePosition === "true" || 
                 o?.info?.closePosition === true || o?.info?.closePosition === "true";
      return (t.includes("STOP") && !t.includes("TAKE_PROFIT")) && cp;
    });
    const currentSLPrice = Number(currentSLOrder?.stopPrice || currentSLOrder?.triggerPrice || currentSLOrder?.price || 0);
    
    if (currentSLPrice > 0) {
      // Рассчитать правильную цену SL
      const taskUsdForCheck = slEntryQty * slEntryAvg;
      const baseRiskForCheck = (typeof task.riskUsd === "number" && task.riskUsd > 0) ? task.riskUsd : preset.trade_risk;
      const factorForCheck = Math.min(1, taskUsdForCheck / Math.max(1, task.totalUsd ?? taskUsdForCheck));
      const correctSL = calcDesiredSLByRiskUsd(side, slEntryAvg, slEntryQty, baseRiskForCheck * factorForCheck);
      
      // Если отличается более чем на 1% — пересчитываем
      const diff = Math.abs(currentSLPrice - correctSL) / Math.max(correctSL, 1e-12);
      if (diff > 0.01) {
        needRecalcSL = true;
        // Снимаем старый SL
        if (currentSLOrder?.id || currentSLOrder?.algoId) {
          const orderId = String(currentSLOrder.algoId || currentSLOrder.id);
          try { await ex.cancelAlgoOrder(symbol, orderId); } catch {}
          try { await ex.cancelOrder(symbol, orderId); } catch {}
        }
        log(`🔄 Recovery: SL пересчитывается для #${task.id} ${symbol} (${currentSLPrice} → ${correctSL.toFixed(4)}, diff=${(diff * 100).toFixed(1)}%)`);
      }
    }
  }
  
  // ✅ ИСПРАВЛЕНО: Возвращаемся только если ОБА есть И не нужен пересчёт
  if (hasSL && !needRecalcSL && hasTP) {
    return;
  }
  
  const positionUsd = actualPosSize * entryAvg;
  const taskUsd = slEntryQty * slEntryAvg;
  const totalPlannedUsd = task.totalUsd ?? taskUsd;
  const baseRisk =
    (typeof task.riskUsd === "number" && Number.isFinite(task.riskUsd) && task.riskUsd > 0)
      ? task.riskUsd
      : (Number.isFinite(preset.trade_risk) && preset.trade_risk > 0 ? preset.trade_risk : 0);
  // ✅ factor от объёма ЭТОЙ task
  const factor = Math.min(1, taskUsd / Math.max(1, totalPlannedUsd));
  const effectiveRiskUsd = baseRisk * factor;

  if (!hasSL || needRecalcSL) {
    // ✅ КРИТИЧНО: Ещё раз проверяем что позиция существует перед размещением SL
    try {
      const checkPos = Math.abs(await ex.fetchPositionSize(symbol));
      if (checkPos < minQty * 0.5) {
        // Позиция закрыта — не ставим SL
        return;
      }
    } catch {
      // При ошибке — не ставим SL чтобы избежать -4509
      return;
    }
    
    // ✅ SL: от средней и объёма ЭТОЙ task
    const desiredSL = calcDesiredSLByRiskUsd(side, slEntryAvg, slEntryQty, effectiveRiskUsd);
    const precSL = Number(ex.priceToPrecision(symbol, desiredSL));
    const safeSL0 = adjustStopForMark(side, precSL, mark, filters.tickSize || 0.0001);
    const safeSL = Number(ex.priceToPrecision(symbol, safeSL0));
    if (Number.isFinite(safeSL) && safeSL > 0) {
      const keep = new Set((task.entryOrderIds || []).map(String));
      await cancelOnlySL(ex, symbol, keep).catch(() => {});
      try {
        const slResult = await ex.createStopMarketClose(symbol, sideExit as any, safeSL);
        // ✅ ИСПРАВЛЕНО: Не логируем если SL был skipped (уже существует или нет позиции)
        const wasSkipped = slResult?.info?.skipped === true || 
                           String(slResult?.id || "").startsWith("skipped");
        if (!wasSkipped) {
          log(`🧯 Recovery: SL выставлен для #${task.id} ${symbol} (${side}) @ ${safeSL}`);
        }
      } catch (slErr: any) {
        const known = isKnownAlgoError(slErr);
        if (known.ignore) {
          // -4509: нет позиции, -4130: SL уже есть — не спамим
        } else {
          throw slErr; // Пробрасываем неизвестные ошибки
        }
      }
    }
  }

  if (!hasTP) {
    // ✅ КРИТИЧНО: Проверяем позицию перед размещением TP
    let currentPosSize = actualPosSize;
    try {
      const checkPos = Math.abs(await ex.fetchPositionSize(symbol));
      if (checkPos < minQty * 0.5) {
        return;
      }
      currentPosSize = checkPos;
    } catch (e: any) {
      console.warn(`[WARN] Recovery TP: ошибка получения позиции для ${symbol}: ${e?.message}`);
    }
    
    const positionUsd = currentPosSize * entryAvg;
    // ✅ КРИТИЧНО: Используем риск из задачи, а не из текущего пресета
    const planningPreset = { ...preset, trade_risk: effectiveRiskUsd } as any;
    const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset: planningPreset });
    
    let tpQtys = splitQtyToStep(currentPosSize, preset.take_profit_ratio, filters.stepSize);
    tpQtys = mergeDustToPrev(tpQtys, filters.minQty, filters.stepSize);
    tpQtys = tpQtys.map((q) => Number(ex.amountToPrecision(symbol, q)));

    let placed = 0;
    let errors: string[] = [];
    for (let i = 0; i < re.tpPrices.length; i++) {
      const q = tpQtys[i];
      if (!(q > 0) || q < filters.minQty) continue;
      const p = Number(ex.priceToPrecision(symbol, re.tpPrices[i]));
      try {
        const result = await ex.createReduceOnlyLimit(symbol, sideExit as any, q, p);
        // ✅ Проверяем что ордер реально создан
        const wasSkipped = result?.info?.skipped === true || String(result?.id || "").startsWith("skipped");
        if (!wasSkipped) {
          placed++;
        } else {
          errors.push(`TP${i+1} skipped`);
        }
      } catch (tpErr: any) {
        const known = isKnownAlgoError(tpErr);
        if (known.ignore) {
          errors.push(`TP${i+1}: ${known.code}`);
          break;
        }
        errors.push(`TP${i+1}: ${tpErr?.message?.slice(0, 50)}`);
      }
    }
    if (placed > 0) {
      log(`🧯 Recovery: TP выставлены для #${task.id} ${symbol} (${side}) — ${placed} ордеров (pos≈${fmtQty5(currentPosSize)})`);
    } else if (errors.length > 0) {
      console.warn(`[WARN] Recovery TP: не удалось выставить TP для #${task.id} ${symbol}: ${errors.join(", ")}`);
    }
  }
}

export function startTaskRecoveryLoop(
  ex: BinanceFutures,
  book: TaskBook,
  log: (msg: string) => void,
  intervalMs = Number(process.env.RECOVERY_INTERVAL_MS || 10_000),
  notify?: (msg: string) => void // ✅ НОВОЕ: опциональная отправка в Telegram
) {
  const enabled = String(process.env.RECOVERY_ENABLED || "true").toLowerCase() === "true" || String(process.env.RECOVERY_ENABLED || "true") === "1";
  if (!enabled) return { stop: () => {} };

  const orphanEnabled = String(process.env.RECOVERY_ORPHAN_ENABLED || "true").toLowerCase() === "true" || String(process.env.RECOVERY_ORPHAN_ENABLED || "true") === "1";
  const orphanGraceMs = Number(process.env.RECOVERY_ORPHAN_GRACE_MS || 60_000);
  const emptySinceBySymbol = new Map<string, number>();

  // ✅ НОВОЕ: Задержка между обработкой задач для rate limiting
  const taskDelayMs = Number(process.env.RECOVERY_TASK_DELAY_MS || 500);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // ✅ НОВОЕ: Включить очистку ордеров если задач нет
  const cleanupOrphanOrdersEnabled = String(process.env.RECOVERY_CLEANUP_ORPHAN_ORDERS || "true").toLowerCase() === "true" 
    || String(process.env.RECOVERY_CLEANUP_ORPHAN_ORDERS || "true") === "1";
  const symbolsWithOrphansGrace = new Map<string, number>(); // symbol → timestamp когда заметили

  // ✅ КРИТИЧНО: Основная логика recovery вынесена в отдельную функцию
  const runRecoveryCheck = async () => {
    try {
      const allTasks = book.list();
      
      // ✅ НОВОЕ: Немедленная очистка завершённых задач (done, canceled, superseded)
      // Храним только активные задачи: waiting_fill, filled, placing_bracket, live
      const terminalTasks = allTasks.filter((t) => 
        t.status === "done" || t.status === "canceled" || t.supersededBy
      );
      for (const t of terminalTasks) {
        book.remove(t.id);
      }
      if (terminalTasks.length > 0) {
        log(`🧹 Recovery: удалено ${terminalTasks.length} завершённых задач (done/canceled/superseded)`);
      }
      
      // Фильтруем оставшиеся активные задачи
      const activeTasks = allTasks.filter((t) => t.status !== "done" && t.status !== "canceled" && !t.supersededBy);
      const errorTasks = allTasks.filter((t) => t.status === "error" && !t.supersededBy);
      const tasks = activeTasks; // для обратной совместимости
      
      // ✅ Очистка задач с ошибками (если нет позиции и ордеров)
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
        
        // ✅ Rate limiting: задержка между задачами
        await sleep(taskDelayMs);
      }
      
      // ✅ КРИТИЧНО: Проверка статуса entry ордеров для waiting_fill задач
      // Это работает ПОСТОЯННО (не только при старте) — отслеживает отмену/исполнение ордеров
      //
      // Binance статусы ордеров:
      // - NEW: ордер создан, ожидает исполнения
      // - PARTIALLY_FILLED: частично исполнен (filled > 0, remaining > 0)
      // - FILLED: полностью исполнен
      // - CANCELED: отменен пользователем
      // - EXPIRED: истек (IOC/FOK не исполнился, или время истекло)
      // - REJECTED: отклонен биржей
      //
      const waitingFillTasks = activeTasks.filter(t => t.status === "waiting_fill" && t.entryOrderIds?.length);
      
      
      for (const task of waitingFillTasks) {
        try {
          const symbol = task.symbolCcxt;
          if (!symbol) continue;
          
          const entryIds = task.entryOrderIds || [];
          if (entryIds.length === 0) continue;
          
          // Сначала проверяем есть ли ордера в открытых
          const openOrders = (await ex.fetchOpenOrders(symbol)) as any[];
          let algoOrders: any[] = [];
          let algoFetchError = "";
          try { 
            algoOrders = await ex.fetchOpenAlgoOrders(symbol); 
          } catch (e: any) {
            algoFetchError = e?.message || "unknown";
          }
          
          const allOpenIds = new Set<string>();
          for (const o of [...openOrders, ...algoOrders]) {
            const ids = [
              String(o.id || ""),
              String(o.orderId || ""),
              String(o.clientOrderId || ""),
              String(o.clientAlgoId || ""),
              String(o.newClientOrderId || ""),
              String(o.info?.orderId || ""),
              String(o.algoId || ""),
            ].filter(x => x && x !== "undefined" && x !== "null");
            ids.forEach(id => allOpenIds.add(id));
          }
          
          // Проверяем сколько entry ордеров еще открыто
          const stillOpen = entryIds.filter(id => allOpenIds.has(String(id)));
          
          // Если все entry ордера еще открыты — задача ждёт
          if (stillOpen.length === entryIds.length) continue;
          
          // ✅ ИСПРАВЛЕНО: Проверяем позицию СРАЗУ, это главный индикатор
          const filters = ex.getSymbolFilters(symbol);
          const posSize = Math.abs(await ex.fetchPositionSize(symbol).catch(() => 0));
          const hasPosition = posSize > (filters?.minQty || 0) * 0.5;
          
          // Если есть открытые ордера — ждём
          if (stillOpen.length > 0) {
            // Но если уже есть позиция — переводим в live
            if (hasPosition) {
              book.set(task, "live");
              log(`🔄 Recovery: задача #${task.id} ${symbol} → live (позиция открыта, ждём остальные входы)`);
            }
            continue;
          }
          
          // Нет открытых entry ордеров — проверяем что случилось
          
          // Если есть позиция — значит ордера исполнились
          if (hasPosition) {
            book.set(task, "live");
            log(`🔄 Recovery: задача #${task.id} ${symbol} → live (entry исполнен, pos=${fmtQty5(posSize)})`);
            continue;
          }
          
          // Нет позиции И нет открытых entry ордеров → task отменён
          book.set(task, "canceled");
          book.remove(task.id);
          const msg = `🚫 Задача #${task.id} ${symbol} отменена (entry ордера сняты, позиции нет)`;
          log(msg);
          notify?.(msg);
          
        } catch (e: any) {
          // Не ломаем recovery если одна задача упала
          console.warn(`[WARN] Recovery: ошибка проверки entry ордеров для #${task.id}: ${e?.message || e}`);
        }
        
        // ✅ Rate limiting: задержка между задачами
        await sleep(taskDelayMs);
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
            // ✅ НОВОЕ: Инициализируем taskEntryAvg/taskEntryQty для старых задач
            // Если поля не заполнены - берём данные с биржи (для совместимости со старыми задачами)
            const posSize = Math.abs(pos.contracts ?? 0);
            const entryAvg = Number(pos.entryPrice ?? 0);
            if ((!task.taskEntryAvg || task.taskEntryAvg <= 0) && entryAvg > 0 && posSize > 0) {
              book.setTaskEntry(task, entryAvg, posSize);
              log(`🔄 Recovery: инициализированы entry данные для #${task.id} ${symbol}: avg=${entryAvg}, qty=${fmtQty5(posSize)}`);
            }
            
            try {
              await ensureBracketsForTask(ex, book, task, pos, log);
            } catch (e: any) {
              // ✅ ИСПРАВЛЕНО: Не спамим известными ошибками
              const known = isKnownAlgoError(e);
              if (!known.ignore) {
                console.warn(`[WARN] Recovery: ensureBracketsForTask failed for #${task.id} ${symbol}: ${e?.message || e}`);
              }
            }
          }
          // ✅ Rate limiting: задержка между символами
          await sleep(taskDelayMs);
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
              // ✅ НОВОЕ: Проверяем что задача реально удалена
              const stillExists = book.get(t.id);
              if (stillExists) {
                console.warn(`[WARN] Recovery: task #${t.id} still exists after remove!`);
              }
              const msg = `🧹 Позиция ${symbol} закрыта вручную — задача #${t.id} удалена`;
              log(msg);
              notify?.(msg);
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
        
        // ✅ Rate limiting: задержка между символами
        await sleep(taskDelayMs);
      }
    } catch {}
  };

  // ✅ КРИТИЧНО: Немедленная проверка при старте (не ждём intervalMs)
  // Это гарантирует что существующие задачи будут обработаны сразу после перезапуска
  log(`🔄 Recovery: запуск (interval=${intervalMs}ms, taskDelay=${taskDelayMs}ms)...`);
  runRecoveryCheck().then(() => {
    log(`✅ Recovery: начальная проверка завершена`);
  }).catch((e) => {
    console.error(`[ERROR] Recovery initial check failed: ${e?.message || e}`);
  });

  // Затем запускаем периодическую проверку
  const timer = setInterval(runRecoveryCheck, Math.max(2_000, intervalMs));

  return { stop: () => clearInterval(timer) };
}


