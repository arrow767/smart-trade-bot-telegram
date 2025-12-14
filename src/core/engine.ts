import {
  getPreset,
  listPresets,
  upsertPreset,
  deletePreset,
  getDefaultPresetName,
  setDefaultPreset,
  getDefaultPresetNameBySide,
  setDefaultPresetBySide,
  TradingPreset,
} from "../config/trading_config";
import { normalizeTickerToUsdt } from "./SymbolResolver";
import { BinanceFutures } from "../exch/BinanceFutures";
import { planTargets } from "./Planner";
import { splitQtyToStep, mergeDustToPrev } from "../utils/math";
import {
  UIMode,
  formatPreview,
  formatPlan,
  formatDeposit,
  formatPositions,
  formatTasks,
  formatPreset,
  formatPresetList,
  formatTaskInfo,
  formatOrders,
} from "./format";
import { 
  ParsedCmd, 
  DEFAULT_PRESET,
  TradeLeg,
} from "./types";
import { TaskBook } from "./TaskBook";
import { 
  isStopOrder, 
  isLimitOrder, 
  collectSymbolsForOrders,
  cancelOnlySL,
  cancelBracketOnly,
  closePositionPercent 
} from "./OrderUtils";
import {
  fmtQty5,
  computeQtyForUsdSmart,
  wouldStopImmediatelyTrigger,
  adjustStopForMark,
  calcDesiredSLByRiskUsd,
  safeEntryOrderType
} from "./TradingUtils";
import { buildHelp } from "./HelpText";
import { parseLine } from "./CommandParser";

// Реэкспорт для внешних модулей
export { DEFAULT_PRESET } from "./types";
export { TaskBook } from "./TaskBook";
export { parseLine } from "./CommandParser";
export type { ParsedCmd } from "./types";
// Флаг: фиксировать риск после завершения набора позиции (env)
const RISK_LOCK_AFTER_FILL = String(process.env.RISK_LOCK_AFTER_FILL || "").toLowerCase() === "1"
  || String(process.env.RISK_LOCK_AFTER_FILL || "").toLowerCase() === "true";

// ✅ НОВОЕ: Максимальная дальность отложек от текущей цены (в %)
// Если отложка дальше, чем MAX_ENTRY_DISTANCE_PCT% от текущей цены — предупреждаем
const MAX_ENTRY_DISTANCE_PCT = Number(process.env.MAX_ENTRY_DISTANCE_PCT || 15); // по умолчанию 15%

// ✅ НОВОЕ: Автоочистка tasks со status=error старше N дней
const AUTO_CLEANUP_ERROR_TASKS_DAYS = Number(process.env.AUTO_CLEANUP_ERROR_TASKS_DAYS || 3);

export async function runCommand(
  ex: BinanceFutures,
  book: TaskBook,
  parsed: ParsedCmd,
  log: (msg: string) => void,
  info: (msg: string) => void,
  mode: UIMode = "console"
) {
  if (parsed.kind === "help") {
    info(mode === "console" ? buildHelp(mode) : `<pre>${buildHelp(mode)}</pre>`);
    return;
  }

  // Порог для дробления крупных ног + динамические границы из фильтров
  const ENV_CAP_USD = Number(process.env.SPLIT_ENTRY_USD_MAX || process.env.MAX_USD_PER_ENTRY || 0);
  const ALIGN_TO_CURRENT_LEV = String(process.env.SPLIT_ALIGN_TO_CURRENT_LEV || "").toLowerCase() === "1" || String(process.env.SPLIT_ALIGN_TO_CURRENT_LEV || "").toLowerCase() === "true";
  let tierCapUsdForAlign: number | undefined;
  
  // ✅ УЛУЧШЕНО: calcBoundsUsd теперь учитывает minNotional корректно
  function calcBoundsUsd(price: number) {
    const f: any = ex.getSymbolFilters(symbolCcxt) as any;
    const minQtyUsd = (Number(f.minQty) || 0) * price;
    const minNotional = Number(f.minNotional) || 0;
    
    // minUsd = максимум из minQty*price и minNotional
    const minUsd = Math.max(minQtyUsd, minNotional);
    
    const maxQtyUsd = f.maxQty ? Number(f.maxQty) * price : Infinity;
    const envCap = ENV_CAP_USD > 0 ? ENV_CAP_USD : Infinity;
    
    let maxUsd = Math.min(envCap, Number.isFinite(maxQtyUsd) && maxQtyUsd > 0 ? maxQtyUsd : Infinity);
    
    // ✅ НОВОЕ: если включен режим выравнивания по плечу — учитываем notionalCap
    if (ALIGN_TO_CURRENT_LEV && Number.isFinite(tierCapUsdForAlign as number)) {
      maxUsd = Math.min(maxUsd, tierCapUsdForAlign as number);
    }
    
    return { minUsd, maxUsd: Number.isFinite(maxUsd) ? maxUsd : (envCap > 0 ? envCap : Infinity) };
  }
  const splitLegsByUsd = (legsIn: TradeLeg[]): TradeLeg[] => {
    const out: TradeLeg[] = [];
    for (const leg of legsIn) {
      const price = Number(leg.price);
      const { minUsd, maxUsd } = calcBoundsUsd(price);
      let remain = Number(leg.usd);
      const effMax = Math.max(maxUsd, minUsd || 0);
      if (!(effMax > 0) || !Number.isFinite(effMax)) { out.push(leg); continue; }

      if (remain < minUsd) {
        out.push({ usd: remain, price });
      continue;
    }
      while (remain > effMax + 1e-9) {
        out.push({ usd: effMax, price });
        remain -= effMax;
      }
      if (remain > 1e-9) {
        if (remain < minUsd && out.length && out[out.length - 1].price === price) {
          out[out.length - 1].usd += remain;
  } else {
          out.push({ usd: remain, price });
        }
      }
    }
    return out;
  };

  // --- НОВОЕ: просмотр ордеров ---
  if (parsed.kind === "orders") {
    const rows: Array<{
      id: string; symbol: string; kind: "LIMIT"|"STOP"|"MARKET"; side: "buy"|"sell";
      qty: number; price?: number; stopPrice?: number; reduceOnly?: boolean;
      closePosition?: boolean; datetime?: string; status?: string;
    }> = [];
    
    // Хелпер для парсинга Algo Order в общий формат
    const parseAlgoOrder = (ao: any, sym?: string) => {
      let datetime = "";
      try {
        const timestamp = Number(ao.bookTime || ao.updateTime || ao.time || 0);
        if (timestamp > 0) {
          datetime = new Date(timestamp).toISOString().slice(0,19).replace("T"," ");
        }
      } catch {}
      
      const orderType = String(ao.type || ao.strategyType || "").toUpperCase();
      return {
        id: String(ao.algoId || ao.clientAlgoId || ao.orderId || ""),
        symbol: sym || String(ao.symbol || ""),
        kind: orderType.includes("STOP") ? "STOP" as const : (orderType.includes("LIMIT") ? "LIMIT" as const : "MARKET" as const),
        side: (String(ao.side || "buy").toLowerCase() === "buy" ? "buy" : "sell") as "buy" | "sell",
        qty: Number(ao.quantity || ao.origQty || 0) || 0,
        price: Number(ao.price || 0) || undefined,
        stopPrice: Number(ao.triggerPrice || ao.stopPrice || 0) || undefined,
        reduceOnly: (ao.reduceOnly === true || ao.reduceOnly === "true"),
        closePosition: (ao.closePosition === true || ao.closePosition === "true"),
        datetime,
        status: String(ao.algoStatus || ao.status || ""),
      };
    };
    
    try {
      // Если указан символ - запрашиваем только его ордера
      if (parsed.symbol) {
        // Обычные ордера
        const open = (await ex.fetchOpenOrders(parsed.symbol)) as any[];
        for (const o of open) {
          rows.push({
            id: String(o.id || o.info?.orderId || ""),
            symbol: parsed.symbol,
            kind: isStopOrder(o) ? "STOP" : (isLimitOrder(o) ? "LIMIT" : "MARKET"),
            side: (String(o.side||"buy").toLowerCase() === "buy" ? "buy" : "sell"),
            qty: Number(o.amount ?? o.info?.origQty ?? 0) || 0,
            price: Number(o.price ?? o.info?.price ?? 0) || undefined,
            stopPrice: Number(o.info?.stopPrice ?? 0) || undefined,
            reduceOnly: (o.info?.reduceOnly === true || o.info?.reduceOnly === "true"),
            closePosition: (o.info?.closePosition === true || o.info?.closePosition === "true"),
            datetime: (o.datetime || (o.lastTradeTimestamp ? new Date(o.lastTradeTimestamp).toISOString().slice(0,19).replace("T"," ") : "")),
            status: String(o.status || o.info?.status || ""),
          });
        }
        
        // ✅ НОВОЕ: Algo Orders (STOP_MARKET, TAKE_PROFIT_MARKET и т.д.)
        try {
          const algoOrders = await ex.fetchOpenAlgoOrders(parsed.symbol);
          for (const ao of algoOrders) {
            rows.push(parseAlgoOrder(ao, parsed.symbol));
          }
        } catch {}
      } else {
        // Запрашиваем ВСЕ ордера со всех символов
        const allOrders = await ex.fetchAllOpenOrdersAcrossSymbols();
        for (const o of allOrders) {
          // Парсим время безопасно
          let datetime = "";
          try {
            const timestamp = Number(o.time || o.updateTime || 0);
            if (timestamp > 0) {
              datetime = new Date(timestamp).toISOString().slice(0,19).replace("T"," ");
            }
          } catch {}
          
          rows.push({
            id: String(o.orderId || ""),
            symbol: String(o.symbol || ""),
            kind: String(o.type || "").toUpperCase().includes("STOP") ? "STOP" : (String(o.type || "").toUpperCase().includes("LIMIT") ? "LIMIT" : "MARKET"),
            side: (String(o.side||"buy").toLowerCase() === "buy" ? "buy" : "sell"),
            qty: Number(o.origQty ?? 0) || 0,
            price: Number(o.price ?? 0) || undefined,
            stopPrice: Number(o.stopPrice ?? 0) || undefined,
            reduceOnly: (o.reduceOnly === true || o.reduceOnly === "true"),
            closePosition: (o.closePosition === true || o.closePosition === "true"),
            datetime,
            status: String(o.status || ""),
          });
        }
        
        // ✅ НОВОЕ: Algo Orders для всех символов
        try {
          const algoOrders = await ex.fetchOpenAlgoOrders(); // без символа = все
          for (const ao of algoOrders) {
            rows.push(parseAlgoOrder(ao));
          }
        } catch {}
      }
    } catch (e: any) {
      console.error("Orders fetch error details:", e);
      info(`Ошибка получения ордеров: ${e?.message || e}`);
    }
    
    rows.sort((a,b)=>{
      if (a.kind !== b.kind) return a.kind === "STOP" ? -1 : 1;
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
      return String(a.datetime||"").localeCompare(String(b.datetime||""));
    });
    info(formatOrders(mode, rows));
    return;
  }

  // --- отмена ордера по id ---
  if (parsed.kind === "cancel_order") {
    const id = parsed.id;
    const symbols = await collectSymbolsForOrders(ex, book);
    let ok = false;
    let foundSymbol = "";
    
    // Сначала пробуем отменить как обычный ордер
    for (const sym of symbols) {
      try {
        // Проверяем, есть ли ордер с таким ID для этого символа
        const orders = (await ex.fetchOpenOrders(sym)) as any[];
        const found = orders.find((o: any) => String(o.id) === id || String(o.info?.orderId) === id);
        if (found) {
          await ex.cancelOrder(sym, id);
          ok = true;
          foundSymbol = sym;
          break;
        }
      } catch {}
    }
    
    // ✅ Если не нашли обычный ордер - ищем среди Algo Orders (без фильтра по символу)
    if (!ok) {
      try {
        const allAlgoOrders = await ex.fetchOpenAlgoOrders(); // все Algo Orders
        const algoOrder = allAlgoOrders.find((ao: any) => 
          String(ao.algoId) === id || String(ao.orderId) === id
        );
        if (algoOrder) {
          // Конвертируем символ из Binance формата (например "PIEVERSE") в CCXT формат
          const rawSym = algoOrder.symbol || "";
          foundSymbol = rawSym.endsWith("USDT") ? `${rawSym.replace("USDT", "")}/USDT:USDT` : rawSym;
          await ex.cancelAlgoOrder(foundSymbol, id);
          ok = true;
        }
      } catch {}
    }
    
    if (ok && foundSymbol) {
      info(mode === "console" ? `Снял ордер ${id} (${foundSymbol}).` : `<b>Снял ордер</b> <code>${id}</code> для <code>${foundSymbol}</code>.`);
    } else {
      info(mode === "console" ? `Ордер ${id} не найден (или уже снят).` : `<b>Ордер не найден</b>: <code>${id}</code>.`);
    }
    return;
  }

  // --- отмена лимитных/стоп по символу ---
  if (parsed.kind === "cancel_limit_symbol" || parsed.kind === "cancel_stop_symbol") {
    const sym = parsed.symbol;
    let total = 0;
    try {
      // Обычные ордера
      const open = (await ex.fetchOpenOrders(sym)) as any[];
      const toCancel = open.filter((o: any) => parsed.kind === "cancel_limit_symbol" ? isLimitOrder(o) : isStopOrder(o));
      for (const o of toCancel) { 
        try { await ex.cancelOrder(sym, String(o.id)); total++; } catch {} 
      }
      
      // ✅ НОВОЕ: Algo Orders (STOP_MARKET, TAKE_PROFIT_MARKET)
      try {
        const algoOrders = await ex.fetchOpenAlgoOrders(sym);
        for (const ao of algoOrders) {
          const orderType = String(ao.type || ao.strategyType || "").toUpperCase();
          const isStop = orderType.includes("STOP");
          const isLimit = orderType.includes("LIMIT") && !orderType.includes("STOP");
          
          const shouldCancel = parsed.kind === "cancel_limit_symbol" ? isLimit : isStop;
          if (shouldCancel) {
            const algoId = ao.algoId || ao.orderId;
            if (algoId) {
              try { await ex.cancelAlgoOrder(sym, algoId); total++; } catch {}
            }
          }
        }
      } catch {}
      
      info(
        mode === "console"
          ? `Снял ${total} ${parsed.kind==="cancel_limit_symbol"?"LIMIT":"STOP"} ордеров по ${sym}.`
          : `<b>Снял ${total} ${parsed.kind==="cancel_limit_symbol"?"LIMIT":"STOP"} ордеров</b> по <code>${sym}</code>.`
      );
    } catch (e:any) {
      info(mode === "console" ? `Ошибка: ${e?.message || e}` : `<b>Ошибка:</b> ${e?.message || e}`);
    }
    return;
  }

  // --- cancel-all по типам ---
  if (parsed.kind === "cancel_all_orders") {
    const modeSub = parsed.sub; // all | limit | stop
    const symbols = await collectSymbolsForOrders(ex, book);
    let total = 0;
    
    for (const sym of symbols) {
      // Обычные ордера
      try {
        const open = (await ex.fetchOpenOrders(sym)) as any[];
        const toCancel = open.filter((o: any) => {
          if (modeSub === "all") return true;
          if (modeSub === "limit") return isLimitOrder(o);
          return isStopOrder(o);
        });
        for (const o of toCancel) { try { await ex.cancelOrder(sym, String(o.id)); total++; } catch {} }
      } catch {}
      
      // ✅ НОВОЕ: Algo Orders
      try {
        const algoOrders = await ex.fetchOpenAlgoOrders(sym);
        for (const ao of algoOrders) {
          const orderType = String(ao.type || ao.strategyType || "").toUpperCase();
          const isStop = orderType.includes("STOP");
          const isLimit = orderType.includes("LIMIT") && !orderType.includes("STOP");
          
          let shouldCancel = false;
          if (modeSub === "all") shouldCancel = true;
          else if (modeSub === "limit") shouldCancel = isLimit;
          else if (modeSub === "stop") shouldCancel = isStop;
          
          if (shouldCancel) {
            const algoId = ao.algoId || ao.orderId;
            if (algoId) {
              try { await ex.cancelAlgoOrder(sym, algoId); total++; } catch {}
            }
          }
        }
      } catch {}
    }
    
    info(mode === "console" ? `Снял ${total} ордеров (${modeSub}).` : `<b>Снял ${total} ордеров</b> (${modeSub}).`);
    return;
  }

  // --- пресеты ---
  if (parsed.kind === "preset_list") {
    const list = await listPresets();
    const defLong = await getDefaultPresetNameBySide("long");
    const defShort = await getDefaultPresetNameBySide("short");
    info(
      formatPresetList(
        mode,
        list.map((p) => {
          const isL = p.config_name === defLong;
          const isS = p.config_name === defShort;
          const tag = isL && isS ? " [L,S]" : isL ? " [L]" : isS ? " [S]" : "";
          return { name: `${p.config_name}${tag}`, isDefault: isL || isS };
        })
      )
    );
    return;
  }

  if (parsed.kind === "preset_show") {
    const defLong = await getDefaultPresetNameBySide("long");
    const defShort = await getDefaultPresetNameBySide("short");
    const p = await getPreset(parsed.name);
    const isL = p.config_name === defLong;
    const isS = p.config_name === defShort;
    const tag = isL && isS ? " (default: long+short)" : isL ? " (default: long)" : isS ? " (default: short)" : "";
    info(
      formatPreset(mode, {
        name: `${p.config_name}${tag}`,
        risk: p.trade_risk,
        tp: p.take_profit,
        ratio: p.take_profit_ratio,
        isDefault: isL || isS,
      })
    );
    return;
  }

  if (parsed.kind === "preset_set") {
    const current = await getPreset(parsed.name);
    const next: TradingPreset = {
      config_name: parsed.name,
      trade_risk: parsed.risk ?? current.trade_risk ?? 100,
      take_profit: parsed.tp ?? current.take_profit ?? [3, 5, 7],
      take_profit_ratio: parsed.ratio ?? current.take_profit_ratio ?? [35, 30, 35],
    };
    if (next.take_profit.length !== next.take_profit_ratio.length) {
      info(
        mode === "console"
          ? `Ошибка: длины take_profit и take_profit_ratio должны совпадать`
          : `<b>Ошибка:</b> длины <code>take_profit</code> и <code>take_profit_ratio</code> должны совпадать`
      );
      return;
    }
    await upsertPreset(next);
    if (parsed.makeDefault) {
      // legacy: ставим дефолт на обе стороны
      await setDefaultPreset(next.config_name);
    }
    if (parsed.makeDefaultLong) {
      await setDefaultPresetBySide("long", next.config_name);
    }
    if (parsed.makeDefaultShort) {
      await setDefaultPresetBySide("short", next.config_name);
    }
    const defLong = await getDefaultPresetNameBySide("long");
    const defShort = await getDefaultPresetNameBySide("short");
    const isL = next.config_name === defLong;
    const isS = next.config_name === defShort;
    const tag = isL && isS ? " (default: long+short)" : isL ? " (default: long)" : isS ? " (default: short)" : "";
    info(
      formatPreset(mode, {
        name: `${next.config_name}${tag}`,
        risk: next.trade_risk,
        tp: next.take_profit,
        ratio: next.take_profit_ratio,
        isDefault: isL || isS,
      })
    );
    return;
  }

  if (parsed.kind === "preset_delete") {
    try {
      await deletePreset(parsed.name);
      info(mode === "console" ? `Удалён пресет ${parsed.name}` : `<b>Удалён пресет ${parsed.name}</b>`);
    } catch (e: any) {
      info(mode === "console" ? `Ошибка: ${e?.message || e}` : `<b>Ошибка:</b> ${e?.message || e}`);
    }
    return;
  }

  // --- сервисные ---
  if (parsed.kind === "deposit") {
    const futures = await ex.fetchFuturesUSDTBalance();

    let spotTotal = 0, spotFree = 0, spotUsed = 0;
    try {
      const spot = await ex.fetchSpotUSDTBalance();
      spotTotal = spot.total;
      spotFree = spot.free;
      spotUsed = spot.used;
    } catch {}

    const positions = await ex.fetchAllOpenPositions();
    const unreal = positions.reduce((a, p) => a + (Number(p.unrealizedPnlUsd) || 0), 0);
    // Экспозиция как сумма |qty|*entryPrice (без тикеров, чтобы не спамить REST)
    const exposureUsd = positions.reduce((s, p) => s + Math.abs(p.contracts || 0) * (Number(p.entryPrice) || 0), 0);
    const equity = futures.total || 0;
    const leverage = equity > 0 ? exposureUsd / equity : 0;
    const grandTotal = Number(futures.total || 0) + Number(spotTotal || 0);

    info(
      formatDeposit(mode, {
        total: futures.total, free: futures.free, used: futures.used,
        unreal, spotTotal, spotFree, spotUsed, grandTotal,
        exposureUsd, leverage,
      } as any)
    );
    return;
  }

  if (parsed.kind === "positions") {
    const listRaw = await ex.fetchAllOpenPositions();
    const list = listRaw.map((p) => ({
      symbol: p.symbol, side: p.side, qty: p.contracts,
      avg: p.entryPrice || 0, pnl: Number(p.unrealizedPnlUsd) || 0,
    }));
    info(formatPositions(mode, list));
    return;
  }

  if (parsed.kind === "tasks") {
    const rows = book.list().map((t) => ({
      id: t.id, status: t.status, symbol: t.symbolCcxt, label: t.label,
      created: t.startedAt.toISOString().replace("T"," ").slice(0,19),
      error: t.error,
    }));
    info(formatTasks(mode, rows));
    return;
  }

  if (parsed.kind === "cancel") {
    const t = book.get(parsed.id);
    if (!t) {
      info(mode === "console" ? `Задача #${parsed.id} не найдена.` : `<b>Нет задачи #${parsed.id}</b>`);
      return;
    }
    try {
      const keep = new Set(t.entryOrderIds || []);
      await cancelBracketOnly(ex, t.symbolCcxt, keep).catch(() => {});
      for (const id of keep) {
        await ex.cancelOrder(t.symbolCcxt, id).catch(() => {});
      }
    } catch {}
    book.remove(t.id);
    info(mode === "console" ? `Удалил задачу #${parsed.id}.` : `<b>Удалил задачу #${parsed.id}</b>`);
    return;
  }

  if (parsed.kind === "cancel_all") {
    for (const t of book.list()) {
      try {
        const keep = new Set(t.entryOrderIds || []);
        await cancelBracketOnly(ex, t.symbolCcxt, keep).catch(() => {});
        for (const id of keep) {
          await ex.cancelOrder(t.symbolCcxt, id).catch(() => {});
        }
      } catch {}
      book.remove(t.id);
    }
    info(mode === "console" ? `Все задачи удалены.` : `<b>Все задачи удалены</b>`);
    return;
  }

  if (parsed.kind === "close") {
    const { symbol, percent } = parsed;
    const { symbolCcxt } = normalizeTickerToUsdt(symbol);
    const res = await closePositionPercent(ex, symbolCcxt, percent);
    if (res.closed <= 0) {
      info(mode === "console" ? `Нет позиции по ${symbolCcxt}.` : `<b>Нет позиции по ${symbolCcxt}</b>`);
      return;
    }
    if (res.fullyClosed) {
      await ex.cancelAllOrders(symbolCcxt).catch(() => {});
      info(
        mode === "console"
          ? `Закрыл ${symbolCcxt} на ${percent}% (${(res.closed).toFixed(5)}). Все лимитки сняты.`
          : `<b>Закрыл ${symbolCcxt} на ${percent}%.</b>\nЛимитки сняты.`
      );
    } else {
      info(
        mode === "console"
          ? `Закрыл ${symbolCcxt} на ${percent}% (${(res.closed).toFixed(5)}).`
          : `<b>Закрыл ${symbolCcxt} на ${percent}%.</b>`
      );
    }
    return;
  }

  if (parsed.kind === "task_info") {
    const t = book.get(parsed.id);
    if (!t) {
      info(mode === "console" ? `Задача #${parsed.id} не найдена.` : `<b>Нет задачи #${parsed.id}</b>`);
      return;
    }
    let entryDetails: Array<{ id: string; type: string; price?: number; stopPrice?: number; qty?: number }> = [];
    let plannedQty = 0;
    try {
      if (t.entryOrderIds && t.entryOrderIds.length) {
        const open = (await ex.fetchOpenOrders(t.symbolCcxt)) as any[];
        for (const o of open) {
          if (!o.id || !t.entryOrderIds.includes(o.id)) continue;
          const qty = Number(o.amount ?? o.info?.origQty ?? 0) || undefined;
          plannedQty += qty || 0;
          entryDetails.push({
            id: String(o.id),
            type: String(o.type || o.info?.type || ""),
            price: Number(o.price ?? o.info?.price ?? 0) || undefined,
            stopPrice: Number(o.info?.stopPrice ?? 0) || undefined,
            qty,
          });
        }
      }
    } catch {}

    let riskUsd: number | undefined = undefined;
    try {
      const presetForRisk = await getPreset(t.presetName || DEFAULT_PRESET);
      riskUsd = presetForRisk.trade_risk;
    } catch {}

    info(
      formatTaskInfo(mode, {
        id: t.id, status: t.status, symbol: t.symbolCcxt, label: t.label,
        createdAt: t.startedAt.toISOString().replace("T"," ").slice(0,19),
        updatedAt: t.updatedAt.toISOString().replace("T"," ").slice(0,19),
        side: t.side, totalUsd: t.totalUsd, presetName: t.presetName,
        entryOrderIds: t.entryOrderIds, error: t.error,
        plannedQty: plannedQty || undefined,
        riskUsd,
        entryDetails: entryDetails.length ? entryDetails : undefined,
      })
    );
    return;
  }

  if (parsed.kind === "edit") {
    const t = book.get(parsed.id);
    if (!t) {
      info(mode === "console" ? `Задача #${parsed.id} не найдена.` : `<b>Нет задачи #${parsed.id}</b>`);
      return;
    }

    const { symbolCcxt } = normalizeTickerToUsdt(parsed.rawTicker);
    if (symbolCcxt !== t.symbolCcxt) {
      info(
        mode === "console"
          ? `Задача #${t.id} привязана к ${t.symbolCcxt}, а не к ${symbolCcxt}.`
          : `<b>Задача #${t.id}</b> работает с <code>${t.symbolCcxt}</code>, не <code>${symbolCcxt}</code>.`
      );
      return;
    }

    const sideEntry = parsed.dir === "l" ? "buy" : "sell";
    const entryIds = (t.entryOrderIds || []).slice();
    if (!entryIds.length) {
      info(mode === "console" ? `У задачи #${t.id} нет входных ордеров.` : `<b>У задачи #${t.id} нет входов</b>`);
      return;
    }

    const tick = await ex.fetchTicker(symbolCcxt);
    const mark = Number(tick.last ?? tick.mark ?? tick.info?.markPrice);

    const open = (await ex.fetchOpenOrders(symbolCcxt)) as any[];
    const openIds = new Set(open.filter((o: any) => o.id).map((o: any) => o.id as string));
    const openEntryIdsOrdered = entryIds.filter((id) => openIds.has(id));

    const results: string[] = [];
    // Опционально подстройка по текущему плечу для edit
    let tierCapUsdForAlignEdit: number | undefined;
    if (ALIGN_TO_CURRENT_LEV) {
      try {
        const currentLev = await ex.fetchCurrentLeverage(symbolCcxt);
        const brackets = await ex.fetchLeverageBrackets(symbolCcxt);
        if (currentLev && brackets && brackets.length) {
          const candidates = brackets.filter(b => Number(b.initialLeverage) >= currentLev && Number(b.notionalCap) > 0);
          const cap = (candidates.length ? Math.min(...candidates.map(b => Number(b.notionalCap))) : Math.max(...brackets.map(b => Number(b.notionalCap) || 0)));
          if (Number.isFinite(cap) && cap > 0) tierCapUsdForAlignEdit = cap * 0.999;
        }
      } catch {}
    }
    const oldAlign = tierCapUsdForAlign;
    if (tierCapUsdForAlignEdit != null) tierCapUsdForAlign = tierCapUsdForAlignEdit;
    const legsForEdit: TradeLeg[] = splitLegsByUsd(parsed.legs as TradeLeg[]);
    tierCapUsdForAlign = oldAlign;
    for (let i = 0; i < legsForEdit.length; i++) {
      const leg = legsForEdit[i];
      const pick = computeQtyForUsdSmart(ex, symbolCcxt, leg.usd, leg.price);
      if (pick.tooSmall || !(pick.qty > 0)) {
        results.push(`skip ($${leg.usd.toFixed(2)} @ ${leg.price} меньше minQty/step)`);
        continue;
      }

      // ✅ КРИТИЧНО: Безопасное определение типа ордера
      const filters = ex.getSymbolFilters(symbolCcxt);
      const orderMeta = safeEntryOrderType(parsed.dir === "l" ? "long" : "short", leg.price, mark, filters.tickSize);
      const safePrice = Number(ex.priceToPrecision(symbolCcxt, orderMeta.safePrice));

      let replacedId: string | undefined;
      if (i < openEntryIdsOrdered.length) {
        replacedId = openEntryIdsOrdered[i];
        try { await ex.cancelOrder(symbolCcxt, replacedId); } catch {}
      }

      let newId: string | undefined;
      try {
        if (orderMeta.type === "LIMIT") {
          const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, safePrice);
          newId = o.id!;
        } else {
          const o = await ex.createStopMarketEntry(symbolCcxt, sideEntry as any, pick.qty, safePrice);
          newId = o.id!;
        }
      } catch (err: any) {
        // Fallback только если безопасно
        const fallbackPrice = Number(ex.priceToPrecision(symbolCcxt, leg.price));
        const isSafe = (parsed.dir === "l" ? fallbackPrice < mark : fallbackPrice > mark);
        if (isSafe) {
          const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, fallbackPrice);
          newId = o.id!;
        } else {
          results.push(`error @ ${leg.price}: ${err.message}`);
          continue;
        }
      }

      if (replacedId) {
        const idx = entryIds.indexOf(replacedId);
        if (idx >= 0 && newId) entryIds[idx] = newId;
      } else {
        if (newId) entryIds.push(newId);
      }

      results.push(
        `${replacedId ? `replace ${replacedId} → ${newId}` : `add ${newId}`} (~${(pick.qty).toFixed(5)
        } @ ${safePrice}, ≈ $${pick.usdActual.toFixed(2)} к цели $${leg.usd.toFixed(2)})`
      );
    }

    book.setEntryOrders(t, entryIds);

    info(
      mode === "console"
        ? `✏️ Edit #${t.id}:\n  ${results.join("\n  ")}\nОстальные входы без изменений.`
        : `<b>✏️ Edit #${t.id}</b>\n${results.map((r) => `• ${r}`).join("\n")}\n<i>Остальные входы без изменений.</i>`
    );
    return;
  }

  // --- торговля ---
  if (parsed.kind !== "trade") return;

  const { dir, rawTicker, legs, presetName, dryRun, market, riskUsdOverride, noPreset } = parsed as any;
  const side = dir === "l" ? "long" : "short";
  const sideEntry = side === "long" ? "buy" : "sell";
  const sideExit = side === "long" ? "sell" : "buy";

  // ✅ НОВОЕ: авто-дефолт пресета отдельно для long/short
  const presetNameEffective =
    (parsed as any)?.presetAuto ? await getDefaultPresetNameBySide(side) : presetName;
  const preset = await getPreset(presetNameEffective);
  const { symbolCcxt } = normalizeTickerToUsdt(rawTicker);
  
  // ✅ Пытаемся загрузить market (с автоперезагрузкой если не найден), но не прерываем работу
  try {
    await ex.marketSafe(symbolCcxt);
  } catch {
    // Игнорируем ошибку - fetchTicker ниже сам проверит доступность символа
  }

  const t0 = await ex.fetchTicker(symbolCcxt);
  let markPrice = Number(t0.last ?? t0.mark ?? t0.info?.markPrice);
  if (!markPrice || !(markPrice > 0)) throw new Error(`Не удалось получить текущую цену для ${symbolCcxt}`);

  if (market && market.usd > 0) {
    // ===== МГНОВЕННЫЙ ВХОД ПО РЫНКУ =====
    const pick = computeQtyForUsdSmart(ex, symbolCcxt, market.usd, markPrice);
    if (dryRun) {
      info(formatPreview(mode, {
        symbol: symbolCcxt, side, notional: market.usd, approxQty: Number(pick.qty.toFixed(5)),
        now: markPrice, entry: markPrice, isLimit: false, sl: "-", tps: [],
      }));
      info("💤 [DRY] Только превью. Заявки не выставляю.");
      return;
    }

    await ex.createMarketEntry(symbolCcxt, sideEntry as any, pick.qty);
    info(`🟩 MARKET вход: ~${fmtQty5(pick.qty)} @ ~${markPrice}`);

    const task = book.add(symbolCcxt, `${side.toUpperCase()} MARKET ($${market.usd})`, { side, totalUsd: market.usd, presetName: presetNameEffective, riskUsd: riskUsdOverride });
    book.setEntryOrders(task, [] as string[]);

    book.set(task, "waiting_fill");
    (async () => {
      try {
        const keep = new Set<string>();
        let lastSize = 0;
        let lastAvg = 0;
        let tpsPlaced = false;
        let slPxCurrent: number | undefined;
        const tpIndexById = new Map<string, number>();

        const hasClosePositionConditional = (orders: any[]) => {
          for (const o of orders || []) {
            const t = String(o?.type || o?.strategyType || "").toUpperCase();
            const isStopOrTp = t.includes("STOP") || t.includes("TAKE_PROFIT");
            const cp = o?.closePosition === true || o?.closePosition === "true" || o?.info?.closePosition === true || o?.info?.closePosition === "true";
            if (isStopOrTp && cp) return true;
          }
          return false;
        };

        const hasAnyReduceOnlyTP = (orders: any[]) => {
          for (const o of orders || []) {
            const t = String(o?.type || "").toUpperCase();
            const isLimit = t.includes("LIMIT") && !t.includes("STOP");
            const ro = o?.reduceOnly === true || o?.reduceOnly === "true" || o?.info?.reduceOnly === true || o?.info?.reduceOnly === "true";
            const cp = o?.closePosition === true || o?.closePosition === "true" || o?.info?.closePosition === true || o?.info?.closePosition === "true";
            if (isLimit && ro && !cp) return true;
          }
          return false;
        };

        const isIgnorableAlgoClosePositionDup = (e: any) => {
          const msg = String(e?.message || e || "");
          const code = Number(e?.info?.code ?? e?.code ?? NaN);
          return code === -4130 || /-4130/.test(msg) || (/closePosition/i.test(msg) && /existing/i.test(msg));
        };

        for (;;) {
          const tick = await ex.fetchTicker(symbolCcxt);
          const mark = Number(tick.last ?? tick.mark ?? tick.info?.markPrice);

          const positions = await ex.fetchAllOpenPositions();
          const my = positions.find((p) => p.symbol === symbolCcxt);
          const posSize = Math.abs(my?.contracts ?? 0);
          const entryAvg = Number(my?.entryPrice ?? 0) || 0;

          // ✅ Надёжность: проверяем реальное состояние ордеров каждый цикл.
          const open = (await ex.fetchOpenOrders(symbolCcxt)) as any[];
          let algo: any[] = [];
          try { algo = await ex.fetchOpenAlgoOrders(symbolCcxt); } catch {}
          const allOpen = [...open, ...algo];
          const hasSLNow = hasClosePositionConditional(allOpen);
          const hasTPNow = hasAnyReduceOnlyTP(open);

          // Если пользователь снял SL/TP руками — сбрасываем флаги, чтобы довыставить заново
          if (!hasSLNow) slPxCurrent = undefined;
          if (!hasTPNow) tpsPlaced = false;

          const delta = posSize - lastSize;
          const increased = delta > 1e-9;

          const minQtyForCheck = ex.getSymbolFilters(symbolCcxt).minQty || 0;
          const hasPosition = posSize > minQtyForCheck * 0.5 && entryAvg > 0;
          const shouldPlaceTP_SL = hasPosition && (!hasSLNow || !hasTPNow);

          if (shouldPlaceTP_SL) {
            const filters = ex.getSymbolFilters(symbolCcxt);
            const positionUsd = posSize * entryAvg;

            const totalUsd = task.totalUsd ?? positionUsd;
            const baseRisk =
              (typeof task.riskUsd === "number" && Number.isFinite(task.riskUsd) && task.riskUsd > 0)
                ? task.riskUsd
                : (Number.isFinite(riskUsdOverride) && (riskUsdOverride as number) > 0 ? (riskUsdOverride as number) : preset.trade_risk);
            const factor = RISK_LOCK_AFTER_FILL ? 1 : Math.min(1, positionUsd / Math.max(1, totalUsd));
            const effectiveRiskUsd = baseRisk * factor;

            // ✅ НОВОЕ: Устанавливаем SL и TP только если не отключены пресеты
            if (!noPreset) {
              const desiredSL = calcDesiredSLByRiskUsd(side, entryAvg, posSize, effectiveRiskUsd);
              const precSL = Number(ex.priceToPrecision(symbolCcxt, desiredSL));
              const safeSL0 = adjustStopForMark(side, precSL, mark, filters.tickSize || 0.0001);
              const safeSL = Number(ex.priceToPrecision(symbolCcxt, safeSL0));
              if (!Number.isFinite(safeSL) || safeSL <= 0) {
                throw new Error(`Bad stopPrice computed: entryAvg=${entryAvg}, posSize=${posSize}, desired=${precSL}, mark=${mark}`);
              }

              // SL ставим только если он реально отсутствует
              if (!hasSLNow) {
                await cancelOnlySL(ex, symbolCcxt, keep).catch(() => {});
                try {
                  await ex.createStopMarketClose(symbolCcxt, sideExit as any, safeSL);
                } catch (e: any) {
                  if (!isIgnorableAlgoClosePositionDup(e)) throw e;
                }
                slPxCurrent = safeSL;
              }

              // TP ставим только если их реально нет
              if (!hasTPNow) {
                const planningPreset = { ...preset, trade_risk: baseRisk } as any;
                const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset: planningPreset });
                let tpQtys = splitQtyToStep(posSize, preset.take_profit_ratio, filters.stepSize);
                tpQtys = mergeDustToPrev(tpQtys, filters.minQty, filters.stepSize);
                tpQtys = tpQtys.map((q) => Number(ex.amountToPrecision(symbolCcxt, q)));
                for (let i = 0; i < re.tpPrices.length; i++) {
                  const q = tpQtys[i];
                  if (q <= 0) continue;
                  const p = Number(ex.priceToPrecision(symbolCcxt, re.tpPrices[i]));
                  const ord = await ex.createReduceOnlyLimit(symbolCcxt, sideExit as any, q, p);
                  if (ord?.id) tpIndexById.set(String(ord.id), i + 1);
                }
                tpsPlaced = true;

                info(formatPlan(mode, {
                  entryPx: Number(ex.priceToPrecision(symbolCcxt, entryAvg)),
                  sl: String(ex.priceToPrecision(symbolCcxt, safeSL)),
                  tps: re.tpPrices.map((p, i) => ({ price: String(ex.priceToPrecision(symbolCcxt, p)), qty: 0, R: preset.take_profit[i] })),
                }));
              }
            } else {
              // ✅ НОВОЕ: Если пресеты отключены - просто сообщаем об успешном входе
              info(mode === "console" 
                ? `✅ MARKET вход выполнен без SL/TP: ~${fmtQty5(posSize)} @ ${entryAvg}` 
                : `<b>✅ MARKET вход выполнен без SL/TP:</b> ~${fmtQty5(posSize)} @ ${entryAvg}`
              );
            }

            lastSize = posSize;
            lastAvg = entryAvg;
            book.set(task, "live");
          }

          const f = ex.getSymbolFilters(symbolCcxt);
          const minQ = Math.max((f.minQty||0)*0.5, 1e-12);
          const posCheck1 = Math.abs(await ex.fetchPositionSize(symbolCcxt).catch(() => 999));
          const flat1 = posCheck1 < minQ;
          
          if (flat1) {
            // ✅ ДВОЙНАЯ ПРОВЕРКА: подождать и проверить ещё раз разными методами
            await new Promise(r => setTimeout(r, 1500));
            
            const posCheck2 = Math.abs(await ex.fetchPositionSize(symbolCcxt).catch(() => 999));
            let posCheck3 = 999;
            try {
              const allPos = await ex.fetchAllOpenPositions();
              const myPos = allPos.find((p: any) => p.symbol === symbolCcxt);
              posCheck3 = Math.abs(myPos?.contracts ?? 0);
            } catch {}
            
            const stillFlat = posCheck2 < minQ && posCheck3 < minQ;
            
            if (mode === "console") {
              console.log(`[DEBUG] Market flat double-check: posCheck2=${posCheck2}, posCheck3=${posCheck3}, stillFlat=${stillFlat}`);
            }
            
            if (stillFlat) {
              // позиция вручную закрыта или сработал SL — чистим ордера и удаляем задачу
              await ex.cancelAllOrders(symbolCcxt).catch(() => {});
              const markNow = Number((await ex.fetchTicker(symbolCcxt)).last ?? 0);
              const wasSL = slPxCurrent && ((side === "long" && markNow <= (slPxCurrent + (f.tickSize||0))) || (side === "short" && markNow >= (slPxCurrent - (f.tickSize||0))));
              info(mode === "console" ? (wasSL ? `SL сработал по ${symbolCcxt}. Задачу #${task.id} удалил.` : `Позиция ${symbolCcxt} закрыта. Задачу #${task.id} удалил.`)
                : (wasSL ? `<b>SL сработал</b> по <code>${symbolCcxt}</code>. Задачу #${task.id} удалил.` : `<b>Позиция закрыта</b> по <code>${symbolCcxt}</code>. Задачу #${task.id} удалил.`));
              book.remove(task.id);
              break;
            }
          }

          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err: any) {
        const t = book.get(task.id);
        if (t) book.set(t, "error", err?.message ?? err);
        info(`❌ [ERROR] ${err?.message ?? err}`);
      }
    })();

    return;
  }

  // ======= LIMIT/STOP МНОГОНОЖЕВАЯ ЛОГИКА =======
  const totalUsd = legs.reduce((a: number, l: TradeLeg) => a + l.usd, 0);
  const first = legs[0];

  const firstPick = computeQtyForUsdSmart(ex, symbolCcxt, first.usd, first.price);
  const baseRiskPreview = Number.isFinite(riskUsdOverride) && (riskUsdOverride as number) > 0 ? (riskUsdOverride as number) : preset.trade_risk;
  const planningPresetPreview = { ...preset, trade_risk: baseRiskPreview } as any;
  const firstPlan = planTargets({ side, entryPrice: first.price, positionUsd: first.usd, preset: planningPresetPreview });

  const previewRiskUsd = baseRiskPreview * (first.usd / Math.max(1, totalUsd));
  const previewSL =
    side === "long"
      ? first.price - previewRiskUsd / Math.max(1e-12, firstPick.qty)
      : first.price + previewRiskUsd / Math.max(1e-12, firstPick.qty);
  const slPreviewPx = Number(ex.priceToPrecision(symbolCcxt, previewSL));

  info(
    formatPreview(mode, {
      symbol: symbolCcxt,
      side,
      notional: totalUsd,
      approxQty: Number(firstPick.qty.toFixed(5)),
      now: markPrice,
      entry: first.price,
      isLimit: side === "long" ? first.price < markPrice : first.price > markPrice,
      sl: String(slPreviewPx),
      tps: firstPlan.tpPrices.map((p, i) => ({
        price: String(ex.priceToPrecision(symbolCcxt, p)),
        R: preset.take_profit[i],
      })),
    })
  );
  if (Math.abs(firstPick.usdActual - first.usd) / Math.max(1, first.usd) > 1e-6) {
    info(
      `ℹ️ Факт ~$${firstPick.usdActual.toFixed(2)} (qty=${(firstPick.qty).toFixed(5)}) к цели $${first.usd.toFixed(
        2
      )} — ограничение шага ${symbolCcxt}.`
    );
  }
  if (dryRun) {
    info("💤 [DRY] Только превью. Заявки не выставляю.");
    return;
  }

  // Выставляем входы
  const entryIds: string[] = [];
  // Опционально подстраиваем max по текущему плечу (берём границу бранкета для текущего левереджа)
  if (ALIGN_TO_CURRENT_LEV) {
    try {
      const currentLev = await ex.fetchCurrentLeverage(symbolCcxt);
      const brackets = await ex.fetchLeverageBrackets(symbolCcxt);
      if (currentLev && brackets && brackets.length) {
        // найдём верхнюю границу нотионала, где initialLeverage >= currentLev
        const candidates = brackets.filter(b => Number(b.initialLeverage) >= currentLev && Number(b.notionalCap) > 0);
        const cap = (candidates.length ? Math.min(...candidates.map(b => Number(b.notionalCap))) : Math.max(...brackets.map(b => Number(b.notionalCap) || 0)));
        if (Number.isFinite(cap) && cap > 0) tierCapUsdForAlign = cap * 0.999; // небольшой запас
      }
    } catch {}
  }
  const legsForPlacement: TradeLeg[] = splitLegsByUsd(legs as TradeLeg[]);
  for (const leg of legsForPlacement) {
    const pick = computeQtyForUsdSmart(ex, symbolCcxt, leg.usd, leg.price);
    if (pick.tooSmall || !(pick.qty > 0)) {
      info(`[SKIP] $${leg.usd.toFixed(2)} @ ${leg.price} — меньше minQty/step для ${symbolCcxt}`);
      continue;
    }

    // ✅ НОВОЕ: Проверяем дальность отложки
    const distancePct = Math.abs((leg.price - markPrice) / markPrice) * 100;
    if (distancePct > MAX_ENTRY_DISTANCE_PCT) {
      info(`⚠️ Отложка $${leg.usd.toFixed(2)} @ ${leg.price} слишком далеко от текущей цены ${markPrice.toFixed(2)} (${distancePct.toFixed(1)}% > ${MAX_ENTRY_DISTANCE_PCT}%)`);
    }

    // ✅ КРИТИЧНО: Безопасное определение типа ордера (НИКОГДА не market!)
    const filters = ex.getSymbolFilters(symbolCcxt);
    const orderMeta = safeEntryOrderType(side, leg.price, markPrice, filters.tickSize);
    const safePrice = Number(ex.priceToPrecision(symbolCcxt, orderMeta.safePrice));

    try {
      if (orderMeta.type === "LIMIT") {
        const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, safePrice);
        entryIds.push(o.id!);
        info(`➕ LIMIT вход: ~${(pick.qty).toFixed(5)} @ ${safePrice} (≈ $${pick.usdActual.toFixed(2)})`);
      } else {
        const o = await ex.createStopMarketEntry(symbolCcxt, sideEntry as any, pick.qty, safePrice);
        entryIds.push(o.id!);
        info(`➕ STOP вход: ~${(pick.qty).toFixed(5)} @ ${safePrice} (≈ $${pick.usdActual.toFixed(2)})`);
      }
    } catch (err: any) {
      // При ошибке — пытаемся LIMIT как fallback (но только если цена безопасна!)
      const fallbackPrice = Number(ex.priceToPrecision(symbolCcxt, leg.price));
      const isSafe = (side === "long" ? fallbackPrice < markPrice : fallbackPrice > markPrice);
      if (isSafe) {
        const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, fallbackPrice);
        entryIds.push(o.id!);
        info(`➕ LIMIT вход (fallback): ~${(pick.qty).toFixed(5)} @ ${fallbackPrice}`);
      } else {
        throw new Error(`Не удалось разместить отложку для $${leg.usd} @ ${leg.price}: ${err.message}`);
      }
    }
  }

  const task = book.add(
    symbolCcxt,
    `${side.toUpperCase()} multi ${legs.length} legs (Σ$${totalUsd})`,
    { side, totalUsd, presetName: presetNameEffective, riskUsd: riskUsdOverride }
  );
  book.setEntryOrders(task, entryIds);
  info(`📥 Выставил ${entryIds.length} входных ордеров.`);

  // Фоновый обработчик
  book.set(task, "waiting_fill");

  (async () => {
    try {
      const keep = new Set(entryIds);
      let lastSize = 0;
      let lastAvg = 0;
      let tpsPlaced = false;
      let slPxCurrent: number | undefined;
      const tpIndexById = new Map<string, number>(); // ✅ Для отслеживания TP ордеров

        const hasClosePositionConditional = (orders: any[]) => {
          for (const o of orders || []) {
            const t = String(o?.type || o?.strategyType || "").toUpperCase();
            const isStopOrTp = t.includes("STOP") || t.includes("TAKE_PROFIT");
            const cp = o?.closePosition === true || o?.closePosition === "true" || o?.info?.closePosition === true || o?.info?.closePosition === "true";
            if (isStopOrTp && cp) return true;
          }
          return false;
        };

        const isIgnorableAlgoClosePositionDup = (e: any) => {
          const msg = String(e?.message || e || "");
          const code = Number(e?.info?.code ?? e?.code ?? NaN);
          return code === -4130 || /-4130/.test(msg) || (/closePosition/i.test(msg) && /existing/i.test(msg));
        };

      // НОВОЕ: учёт исчезнувших входов с задержкой-подтверждением
      const MANUAL_GONE_GRACE_MS = 4000;
      const gone = new Map<string, { ts: number; sizeOnGone: number }>();
      
      // ✅ НОВОЕ: Защита от ложных срабатываний сразу после создания ордеров
      const TASK_CREATED_AT = Date.now();
      const MIN_TASK_AGE_MS = 10000; // Минимум 10 секунд должно пройти перед проверкой на "снято вручную"
      
      // ✅ НОВОЕ: Отслеживание, были ли ордера когда-либо видны в списке открытых
      let ordersEverSeen = false;
      let firstSeenAt = 0;
      
      // ✅ НОВОЕ: Периодическая очистка висячих tasks (каждые 30 сек)
      let lastCleanupTs = Date.now();
      const CLEANUP_INTERVAL_MS = 30_000;

      for (;;) {
        if (book.get(task.id)?.cancelRequested) {
          await cancelBracketOnly(ex, symbolCcxt, keep).catch(() => {});
          for (const id of keep) {
            await ex.cancelOrder(task.symbolCcxt, id).catch(() => {});
          }
          book.remove(task.id);
          return;
        }

        // ✅ НОВОЕ: Периодическая очистка висячих tasks
        const now = Date.now();
        if (now - lastCleanupTs > CLEANUP_INTERVAL_MS) {
          const filters = ex.getSymbolFilters(symbolCcxt);
          await book.cleanupOrphanTasks(ex, symbolCcxt, filters.minQty, info).catch(() => {});
          lastCleanupTs = now;
        }

        const tick = await ex.fetchTicker(symbolCcxt);
        const mark = Number(tick.last ?? tick.mark ?? tick.info?.markPrice);

        const positions = await ex.fetchAllOpenPositions();
        const my = positions.find((p) => p.symbol === symbolCcxt);
        const posSize = Math.abs(my?.contracts ?? 0);
        const entryAvg = Number(my?.entryPrice ?? 0) || 0;

        // ✅ КРИТИЧНО: Получаем ВСЕ открытые ордера, включая Algo Orders
        const open = (await ex.fetchOpenOrders(symbolCcxt)) as any[];
        let algoOrders: any[] = [];
        let algoOrdersFetchFailed = false; // ⚠️ Флаг ошибки получения Algo Orders
        try {
          algoOrders = await ex.fetchOpenAlgoOrders(symbolCcxt);
        } catch (e: any) {
          algoOrdersFetchFailed = true; // ⚠️ Не удалось получить Algo Orders
          // Не спамим ошибками fetch/network - логируем только раз
          const msg = String(e?.message || e);
          if (!/fetch|timeout|network/i.test(msg)) {
            console.warn(`[WARN] Failed to fetch Algo Orders for ${symbolCcxt}: ${msg}`);
          }
        }
        
        // Объединяем обычные и Algo ордера для проверки
        // Algo Orders могут иметь algoId, orderId, или clientAlgoId
        const allOpenOrders = [...open, ...algoOrders];
        const allOpenOrderIds = new Set<string>();
        for (const o of allOpenOrders) {
          const id = String(o.id || o.algoId || o.orderId || "");
          const clientId = String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "");
          if (id) allOpenOrderIds.add(id);
          if (clientId) allOpenOrderIds.add(clientId);
        }
        
        // ✅ ЛОГИРОВАНИЕ: что мы получили с биржи
        if (mode === "console" && (posSize > 0 || entryIds.length > 0)) {
          console.log(`[DEBUG] Fetched orders: regular=${open.length}, algo=${algoOrders.length}, algoFailed=${algoOrdersFetchFailed}, allOpenOrderIds.size=${allOpenOrderIds.size}`);
          console.log(`[DEBUG] Entry IDs we're tracking: ${Array.from(entryIds).join(", ")}`);
          console.log(`[DEBUG] All open order IDs: ${Array.from(allOpenOrderIds).join(", ")}`);
        }
        
        // Проверяем какие входные ордера ещё открыты (по ID или clientOrderId)
        const entriesLeft = entryIds.filter(id => {
          const idStr = String(id);
          return allOpenOrderIds.has(idStr) || 
                 allOpenOrders.some((o: any) => 
                   String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
                 );
        }).length;
        
        // ✅ НОВОЕ: Отслеживаем, были ли ордера когда-либо видны
        const hasVisibleOrders = entryIds.some(id => {
          const idStr = String(id);
          return allOpenOrderIds.has(idStr) || 
                 allOpenOrders.some((o: any) => 
                   String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
                 );
        });
        if (hasVisibleOrders && !ordersEverSeen) {
          ordersEverSeen = true;
          firstSeenAt = Date.now();
        }

        // ✅ УПРОЩЕНО: Обновляем keep - удаляем ордера которые больше не открыты
        // Если ордер исчез и позиция не появилась - удаляем из keep (будет обработано в проверке ниже)
        for (const id of [...keep]) {
          const idStr = String(id);
          const exists = allOpenOrderIds.has(idStr) || 
                        allOpenOrders.some((o: any) => 
                          String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
                        );
          if (!exists) {
            // Ордер исчез - удаляем из keep
            keep.delete(id);
            if (mode === "console") {
              console.log(`[DEBUG] Order ${id} disappeared from open orders, removed from keep`);
            }
          }
        }

        // ✅ ПРОВЕРКА 1: Ручное закрытие позиции (позиция была, теперь её нет)
        const minQty = ex.getSymbolFilters(symbolCcxt).minQty || 0;
        const flat = posSize < Math.max(minQty * 0.5, 1e-12);
        const wasInPosition = lastSize > minQty * 0.5;
        const taskAge = Date.now() - TASK_CREATED_AT;
        
        // ✅ УЛУЧШЕНО: Также считаем "была позиция" если task.status === "live"
        const taskStatus = book.get(task.id)?.status;
        const taskWasLive = taskStatus === "live" || taskStatus === "filled";
        const hadPosition = wasInPosition || taskWasLive;
        
        // Если позиция была (по lastSize или по статусу task) и сейчас flat
        const manuallyClosed = hadPosition && flat && taskAge >= 2000;
        
        if (manuallyClosed) {
          // ✅ ДВОЙНАЯ ПРОВЕРКА: подождать и проверить ещё раз разными методами
          await new Promise(r => setTimeout(r, 1500));
          
          // Проверка 1: fetchPositionSize
          const recheck1 = Math.abs(await ex.fetchPositionSize(symbolCcxt).catch(() => 0));
          
          // Проверка 2: fetchAllOpenPositions (другой API endpoint)
          let recheck2 = 0;
          try {
            const allPos = await ex.fetchAllOpenPositions();
            const myPos = allPos.find((p: any) => p.symbol === symbolCcxt);
            recheck2 = Math.abs(myPos?.contracts ?? 0);
          } catch {}
          
          const stillFlat = recheck1 < minQty * 0.5 && recheck2 < minQty * 0.5;
          
          if (mode === "console") {
            console.log(`[DEBUG] Manual close double-check: recheck1=${recheck1}, recheck2=${recheck2}, stillFlat=${stillFlat}`);
          }
          
          if (stillFlat) {
            // Позиция точно закрыта - отменяем все ордера и удаляем задачу
            await cancelBracketOnly(ex, symbolCcxt, keep).catch(() => {});
            for (const id of keep) {
              try { await ex.cancelOrder(symbolCcxt, id).catch(() => {}); } catch {}
              try { await ex.cancelAlgoOrder(symbolCcxt, id).catch(() => {}); } catch {}
            }
            book.remove(task.id);
            info(
              mode === "console"
                ? `🧹 Позиция закрыта вручную — задачу #${task.id} по ${symbolCcxt} удалил.`
                : `<b>🧹 Позиция закрыта вручную</b> — задачу #${task.id} по <code>${symbolCcxt}</code> удалил.`
            );
            return;
          }
        }

          // ✅ ПРОВЕРКА 2: Все входные ордера сняты вручную (позиции не было и нет)
        {
          // ✅ ПРОСТАЯ ПРОВЕРКА: каждый цикл проверяем - если ордеров нет и позиции нет → удаляем задачу
          const allOrdersGone = entryIds.length > 0 && entryIds.every(id => {
            const idStr = String(id);
            const foundById = allOpenOrderIds.has(idStr);
            const foundByClientId = allOpenOrders.some((o: any) => 
              String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
            );
            return !foundById && !foundByClientId;
          });
          
          const timeSinceCreated = Date.now() - TASK_CREATED_AT;

          // ✅ ДОП. ЗАЩИТА: если на символе есть какие-то ордера кроме входных этой задачи (например SL/TP),
          // то НЕ считаем это "ручным снятием всех входов" и НЕ удаляем задачу.
          const entrySet = new Set((entryIds || []).map((x) => String(x)));
          const otherOpenOrders = allOpenOrders.filter((o: any) => {
            const oId = String(o.id || o.algoId || o.orderId || "");
            const oClientId = String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "");
            const isEntry = (oId && entrySet.has(oId)) || (oClientId && entrySet.has(oClientId));
            return !isEntry;
          });
          const noOtherOpenOrders = otherOpenOrders.length === 0;
          
          // ✅ ПРОВЕРКА 2A: Entry ордера сняты вручную
          // 1. Позиция пустая (flat)
          // 2. Все entry ордера исчезли (allOrdersGone)
          // 3. Прошло минимум 3 секунды
          // 4. Ордера были видны хотя бы раз
          // 5. Algo Orders получены успешно
          // 6. На символе нет других ордеров
          const canRemoveByEntryGone = flat && entryIds.length > 0 && 
            allOrdersGone && timeSinceCreated >= 3000 && ordersEverSeen && !algoOrdersFetchFailed && noOtherOpenOrders;
          
          // ✅ ПРОВЕРКА 2B: Позиция закрыта (TP/SL или вручную), все ордера сняты
          // Если позиции нет и вообще никаких ордеров на символе нет — задача завершена
          const totalOrdersOnSymbol = allOpenOrders.length;
          const canRemoveByAllClear = flat && totalOrdersOnSymbol === 0 && 
            timeSinceCreated >= 5000 && !algoOrdersFetchFailed;
          
          const canRemove = canRemoveByEntryGone || canRemoveByAllClear;
          
          if (mode === "console") {
            console.log(`[DEBUG] Task removal check: flat=${flat}, totalOrders=${totalOrdersOnSymbol}, allOrdersGone=${allOrdersGone}, timeSinceCreated=${timeSinceCreated}ms, ordersEverSeen=${ordersEverSeen}, algoFailed=${algoOrdersFetchFailed}, canRemoveByEntryGone=${canRemoveByEntryGone}, canRemoveByAllClear=${canRemoveByAllClear}`);
          }
          
          if (canRemove) {
            // ✅ ДВОЙНАЯ ПРОВЕРКА перед удалением
            await new Promise(r => setTimeout(r, 1500));
            
            // Перепроверяем позицию
            const recheck1 = Math.abs(await ex.fetchPositionSize(symbolCcxt).catch(() => 999));
            let recheck2 = 999;
            try {
              const allPos = await ex.fetchAllOpenPositions();
              const myPos = allPos.find((p: any) => p.symbol === symbolCcxt);
              recheck2 = Math.abs(myPos?.contracts ?? 0);
            } catch {}
            
            // Перепроверяем ордера
            let recheckOrders = 999;
            try {
              const o1 = (await ex.fetchOpenOrders(symbolCcxt) as any[]).length;
              const o2 = (await ex.fetchOpenAlgoOrders(symbolCcxt)).length;
              recheckOrders = o1 + o2;
            } catch {}
            
            const stillClear = recheck1 < minQty * 0.5 && recheck2 < minQty * 0.5 && recheckOrders === 0;
            
            if (mode === "console") {
              console.log(`[DEBUG] Task removal double-check: recheck1=${recheck1}, recheck2=${recheck2}, recheckOrders=${recheckOrders}, stillClear=${stillClear}`);
            }
            
            if (!stillClear) {
              // Не прошла двойная проверка - пропускаем
              continue;
            }
            
            // Логируем для отладки
            if (mode === "console") {
              console.log(`[DEBUG] ✅ TASK REMOVAL CONFIRMED: taskId=${task.id}, symbol=${symbolCcxt}, removing...`);
            }
            // ✅ КРИТИЧНО: Проверяем, есть ли другие задачи на этот символ с активными входами
            const otherTasks = book.getBySymbol(symbolCcxt).filter(t => t.id !== task.id);
            const otherHasActiveEntries = otherTasks.some(t => 
              (t.entryOrderIds || []).some(id => {
                const idStr = String(id);
                return allOpenOrderIds.has(idStr) || 
                       allOpenOrders.some((o: any) => 
                         String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
                       );
              })
            );
            
            if (!otherHasActiveEntries) {
              // Только если у других задач тоже нет активных входов — удаляем
              book.remove(task.id);
              const reason = canRemoveByAllClear 
                ? "позиция закрыта, ордеров нет" 
                : "все входные заявки сняты";
              info(
                mode === "console"
                  ? `🧹 Задачу #${task.id} по ${symbolCcxt} удалил (${reason}).`
                  : `<b>🧹 Задачу #${task.id}</b> по <code>${symbolCcxt}</code> удалил (${reason}).`
              );
              return;
            }
          }
        }

        const delta = posSize - lastSize;
        const increased = delta > 1e-9;
        const decreased = delta < -1e-9;

        // ✅ ПРОСТАЯ ЛОГИКА: Каждый цикл проверяем позицию
        // Если позиция есть (posSize > 0) и TP/SL не выставлены → выставляем их
        // Не зависим от lastSize, increased и других сложных условий
        const hasAnyReduceOnlyTP = (orders: any[]) => {
          for (const o of orders || []) {
            const t = String(o?.type || "").toUpperCase();
            const isLimit = t.includes("LIMIT") && !t.includes("STOP");
            const ro = o?.reduceOnly === true || o?.reduceOnly === "true" || o?.info?.reduceOnly === true || o?.info?.reduceOnly === "true";
            const cp = o?.closePosition === true || o?.closePosition === "true" || o?.info?.closePosition === true || o?.info?.closePosition === "true";
            if (isLimit && ro && !cp) return true;
          }
          return false;
        };

        // ✅ Надёжность: если SL/TP сняты руками, сбрасываем флаги и довыставляем
        const hasSLNow = hasClosePositionConditional(allOpenOrders);
        const hasTPNow = hasAnyReduceOnlyTP(open);
        if (!hasSLNow) slPxCurrent = undefined;
        if (!hasTPNow) tpsPlaced = false;

        const minQtyForCheck = ex.getSymbolFilters(symbolCcxt).minQty || 0;
        const hasPosition = posSize > minQtyForCheck * 0.5 && entryAvg > 0;
        const shouldPlaceTP_SL = hasPosition && (!hasTPNow || !hasSLNow);
        
        // ✅ ЛОГИРОВАНИЕ для отладки
        if (mode === "console") {
          console.log(`[DEBUG] === CYCLE CHECK ===`);
          console.log(`[DEBUG] Position: posSize=${posSize}, entryAvg=${entryAvg}, hasPosition=${hasPosition}`);
          console.log(`[DEBUG] Orders: entriesLeft=${entriesLeft}, entryIds=${Array.from(entryIds).join(", ")}`);
          console.log(`[DEBUG] TP/SL: tpsPlaced=${tpsPlaced}, slPxCurrent=${slPxCurrent}, shouldPlaceTP_SL=${shouldPlaceTP_SL}`);
          if (hasPosition) {
            console.log(`[DEBUG] ✅ POSITION EXISTS! Will place TP/SL: ${shouldPlaceTP_SL}`);
          }
        }

        if (shouldPlaceTP_SL) {
          if (mode === "console") {
            console.log(`[DEBUG] 🚀 PLACING TP/SL: posSize=${posSize}, entryAvg=${entryAvg}`);
          }
          const filters = ex.getSymbolFilters(symbolCcxt);
          const positionUsd = posSize * entryAvg;

          const totalPlannedUsd = task.totalUsd ?? positionUsd;
          const presetForRisk = await getPreset(task.presetName || DEFAULT_PRESET);
          const baseRisk =
            (typeof task.riskUsd === "number" && Number.isFinite(task.riskUsd) && task.riskUsd > 0)
              ? task.riskUsd
              : (Number.isFinite(riskUsdOverride) && (riskUsdOverride as number) > 0 ? (riskUsdOverride as number) : presetForRisk.trade_risk);
          const factor = RISK_LOCK_AFTER_FILL && entriesLeft === 0 ? 1 : Math.min(1, positionUsd / Math.max(1, totalPlannedUsd));
          const effectiveRiskUsd = baseRisk * factor;

          // ✅ НОВОЕ: Устанавливаем SL и TP только если не отключены пресеты
          if (!noPreset) {
            const desiredSL = calcDesiredSLByRiskUsd(side, entryAvg, posSize, effectiveRiskUsd);
            const precSL = Number(ex.priceToPrecision(symbolCcxt, desiredSL));
            const safeSL0 = adjustStopForMark(side, precSL, mark, filters.tickSize || 0.0001);
            const safeSL = Number(ex.priceToPrecision(symbolCcxt, safeSL0));
            if (!Number.isFinite(safeSL) || safeSL <= 0) {
              throw new Error(`Bad stopPrice computed: entryAvg=${entryAvg}, posSize=${posSize}, desired=${precSL}, mark=${mark}`);
            }

            await cancelOnlySL(ex, symbolCcxt, keep).catch(() => {});
            const sideExit2 = side === "long" ? "sell" : "buy";
            
            // ✅ ИСПРАВЛЕНО: Выставляем SL всегда, если его ещё нет или он изменился
            // ⚠️ КРИТИЧНО: slPxCurrent устанавливается ТОЛЬКО при успешном выставлении
            if (!slPxCurrent || Math.abs(slPxCurrent - safeSL) > 1e-9) {
              try {
                // ✅ Анти-спам: если уже есть closePosition STOP/TP (обычно SL уже стоит) — не дергаем API
                if (hasClosePositionConditional(allOpenOrders)) {
                  slPxCurrent = safeSL;
                } else {
                await ex.createStopMarketClose(symbolCcxt, sideExit2 as any, safeSL);
                slPxCurrent = safeSL;
                info(mode === "console" 
                  ? `✅ SL выставлен: ${safeSL}`
                  : `<b>✅ SL выставлен:</b> ${safeSL}`
                );
                }
              } catch (e: any) {
                // Binance: -4130 означает, что уже есть открытый closePosition STOP/TP в этом направлении.
                // Это не критично (позиция уже "защищена"), поэтому не шлем это в Telegram.
                if (isIgnorableAlgoClosePositionDup(e)) {
                  slPxCurrent = safeSL;
                  if (mode === "console") {
                    console.warn(`SL already exists (ignored -4130): ${e?.message || e}`);
                  }
                } else {
                  console.error(`Failed to place SL: ${e?.message || e}`);
                  const errMsg = String(e?.message || e || "Unknown error");
                  info(mode === "console" 
                    ? `⚠️ Ошибка выставления SL: ${errMsg}`
                    : `<b>⚠️ Ошибка выставления SL:</b> ${errMsg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`
                  );
                  // НЕ устанавливаем slPxCurrent — следующая итерация попытается снова
                }
              }
            }

            // ✅ УПРОЩЕНО: Выставляем TP если они ещё не выставлены
            // Не зависим от entriesLeft или lastSize - если позиция есть и TP не выставлены → выставляем
            if (!tpsPlaced) {
              if (mode === "console") {
                console.log(`[DEBUG] 🚀 PLACING TP: entriesLeft=${entriesLeft}, lastSize=${lastSize}, posSize=${posSize}`);
              }
              try {
                const planningPreset2 = { ...presetForRisk, trade_risk: baseRisk } as any;
                const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset: planningPreset2 });

                let tpQtys = splitQtyToStep(posSize, presetForRisk.take_profit_ratio, filters.stepSize);
                tpQtys = mergeDustToPrev(tpQtys, filters.minQty, filters.stepSize);
                tpQtys = tpQtys.map((q) => Number(ex.amountToPrecision(symbolCcxt, q)));
                for (let i = 0; i < re.tpPrices.length; i++) {
                  const q = tpQtys[i];
                  if (q <= 0) continue;
                  const p = Number(ex.priceToPrecision(symbolCcxt, re.tpPrices[i]));
                  const ord = await ex.createReduceOnlyLimit(symbolCcxt, sideExit2 as any, q, p);
                  if (ord?.id) tpIndexById.set(String(ord.id), i + 1); // ✅ Сохраняем номер TP
                }
                tpsPlaced = true;
                info(mode === "console" 
                  ? `✅ TP выставлены: ${re.tpPrices.length} ордеров`
                  : `<b>✅ TP выставлены:</b> ${re.tpPrices.length} ордеров`
                );
              } catch (e: any) {
                console.error(`Failed to place TP: ${e?.message || e}`);
                const errMsg = String(e?.message || e || "Unknown error");
                info(mode === "console" 
                  ? `⚠️ Ошибка выставления TP: ${errMsg}`
                  : `<b>⚠️ Ошибка выставления TP:</b> ${errMsg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`
                );
              }
            }

            const planningPreset3 = { ...presetForRisk, trade_risk: baseRisk } as any;
            const re2 = planTargets({ side, entryPrice: entryAvg, positionUsd, preset: planningPreset3 });

            info(
              formatPlan(mode, {
                entryPx: Number(ex.priceToPrecision(symbolCcxt, entryAvg)),
                sl: String(ex.priceToPrecision(symbolCcxt, safeSL)),
                tps: re2.tpPrices.map((p, i) => ({
                  price: String(ex.priceToPrecision(symbolCcxt, p)),
                  qty: 0,
                  R: presetForRisk.take_profit[i],
                })),
              })
            );
          } else {
            // ✅ НОВОЕ: Если пресеты отключены - просто сообщаем об успешном входе
            info(mode === "console" 
              ? `✅ Вход выполнен без SL/TP: ~${fmtQty5(posSize)} @ ${entryAvg}` 
              : `<b>✅ Вход выполнен без SL/TP:</b> ~${fmtQty5(posSize)} @ ${entryAvg}`
            );
          }

          lastSize = posSize;
          lastAvg = entryAvg;
          if (entriesLeft === 0) {
            const tt = book.get(task.id);
            if (tt) book.set(tt, "live");
          } else {
            const tt = book.get(task.id);
            if (tt) book.set(tt, lastSize > 0 ? "filled" : "waiting_fill");
          }
        }

        if (decreased) {
          const closed = -delta;
          let tpNo: number | undefined;
          try {
            const current = (await ex.fetchOpenOrders(symbolCcxt)) as any[];
            const openIds = new Set(current.map((o: any) => String(o.id || "")));
            const map = tpIndexById;
            const goneIds = Array.from(map.entries()).filter(([id]) => !openIds.has(id)).map(([, idx]) => idx);
            if (goneIds.length) tpNo = Math.min(...goneIds);
          } catch {}
          const tpTag = tpNo ? `TP${tpNo}` : `TP`;
          info(mode === "console" ? `${tpTag}/выход: -${closed.toFixed(5)} по ${symbolCcxt}` : `<b>${tpTag}/выход</b>: −${closed.toFixed(5)} по <code>${symbolCcxt}</code>`);
          lastSize = posSize;
          lastAvg = entryAvg;
        }

        // Доп. гарантированная постановка TP, если все входные заявки исчезли,
        // позиция > 0, а TP ещё не поставлены (мог пропасть "increased" триггер)
        // ✅ НОВОЕ: Пропускаем если пресеты отключены
        if (!noPreset && !tpsPlaced && entriesLeft === 0 && posSize > 0) {
          try {
            const filters = ex.getSymbolFilters(symbolCcxt);
            const totalPlannedUsd = task.totalUsd ?? posSize * entryAvg;
            const presetForRisk = await getPreset(task.presetName || DEFAULT_PRESET);
            const baseRisk = Number.isFinite(riskUsdOverride) && (riskUsdOverride as number) > 0 ? (riskUsdOverride as number) : presetForRisk.trade_risk;
            const planningPreset = { ...presetForRisk, trade_risk: baseRisk } as any;
            const re = planTargets({ side, entryPrice: entryAvg, positionUsd: posSize * entryAvg, preset: planningPreset });
            let tpQtys = splitQtyToStep(posSize, presetForRisk.take_profit_ratio, filters.stepSize);
            tpQtys = mergeDustToPrev(tpQtys, filters.minQty, filters.stepSize);
            tpQtys = tpQtys.map((q) => Number(ex.amountToPrecision(symbolCcxt, q)));
            for (let i = 0; i < re.tpPrices.length; i++) {
              const q = tpQtys[i];
              if (q <= 0) continue;
              const p = Number(ex.priceToPrecision(symbolCcxt, re.tpPrices[i]));
              const ord = await ex.createReduceOnlyLimit(symbolCcxt, sideExit as any, q, p);
              if (ord?.id) tpIndexById.set(String(ord.id), i + 1); // ✅ Сохраняем номер TP
            }
            tpsPlaced = true;
          } catch {}
        }

        // ✅ ИСПРАВЛЕНО: Финальная проверка завершения задачи (учитываем другие задачи на символ)
        // Используем allOpenOrders вместо open, чтобы учитывать Algo Orders
        const nonEntryOpen = allOpenOrders.filter((o: any) => {
          const oId = String(o.id || o.algoId || o.orderId || "");
          const oClientId = String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "");
          return !keep.has(oId) && !keep.has(oClientId);
        });
        
        if (posSize < 1e-12 && keep.size === 0) {
          // Проверяем, есть ли другие задачи с активными входами на этот символ
          const otherTasks = book.getBySymbol(symbolCcxt).filter(t => t.id !== task.id);
          const otherHasActiveOrders = otherTasks.some(t => 
            (t.entryOrderIds || []).some(id => {
              const idStr = String(id);
              return allOpenOrderIds.has(idStr) || 
                     allOpenOrders.some((o: any) => 
                       String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
                     );
            })
          );
          
          // Удаляем задачу только если:
          // 1. Позиция flat
          // 2. У этой задачи нет входных ордеров
          // 3. У других задач на этот символ тоже нет активных входов
          // 4. Нет никаких других открытых ордеров (TP/SL)
          if (!otherHasActiveOrders && nonEntryOpen.length === 0) {
            book.remove(task.id);
            break;
          }
        }

        // ✅ ИСПРАВЛЕНО: Используем allOpenOrders вместо open, чтобы учитывать Algo Orders
        for (const id of [...keep]) {
          const idStr = String(id);
          const exists = allOpenOrderIds.has(idStr) || 
                        allOpenOrders.some((o: any) => 
                          String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
                        );
          if (!exists) {
            keep.delete(id);
            if (mode === "console") {
              console.log(`[DEBUG] Order ${id} not found in allOpenOrders, removed from keep`);
            }
          }
        }

        // ✅ Увеличена частота проверки до 2.5 секунд для более быстрого детектирования
        await new Promise((r) => setTimeout(r, 2500));
      }
    } catch (err: any) {
      const t = book.get(task.id);
      if (t) {
        t.error = err?.message ?? err;
        t.updatedAt = new Date();
      }
      info(`❌ [ERROR] ${err?.message ?? err}`);
    }
  })();

  // (сообщение о подборе notional убрано по запросу)
}
