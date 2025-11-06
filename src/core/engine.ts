import {
  getPreset,
  listPresets,
  upsertPreset,
  deletePreset,
  getDefaultPresetName,
  setDefaultPreset,
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
  calcDesiredSLByRiskUsd
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
  function calcBoundsUsd(price: number) {
    const f: any = ex.getSymbolFilters(symbolCcxt) as any;
    const minUsd = Math.max((Number(f.minQty) || 0) * price, Number(f.minNotional) || 0);
    const maxUsdFilter = (f.maxQty ? Number(f.maxQty) * price : Infinity);
    const envCap = ENV_CAP_USD > 0 ? ENV_CAP_USD : Infinity;
    const maxUsd = Math.min(envCap, Number.isFinite(maxUsdFilter) && maxUsdFilter > 0 ? maxUsdFilter : Infinity);
    return { minUsd, maxUsd: Number.isFinite(maxUsd) ? maxUsd : envCap };
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
      id: string; symbol: string; kind: "LIMIT"|"STOP"; side: "buy"|"sell";
      qty: number; price?: number; stopPrice?: number; reduceOnly?: boolean;
      closePosition?: boolean; datetime?: string; status?: string;
    }> = [];
    const symbols = parsed.symbol ? [parsed.symbol] : await collectSymbolsForOrders(ex, book);
    for (const sym of symbols) {
      try {
        const open = await ex.fetchOpenOrders(sym);
        for (const o of open) {
          rows.push({
            id: String(o.id || o.info?.orderId || ""),
            symbol: sym,
            kind: isStopOrder(o) ? "STOP" : "LIMIT",
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
      } catch {}
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
    for (const sym of symbols) {
      try {
        await ex.cancelOrder(sym, id);
        ok = true;
        info(mode === "console" ? `Снял ордер ${id} (${sym}).` : `<b>Снял ордер</b> <code>${id}</code> для <code>${sym}</code>.`);
        break;
      } catch {}
    }
    if (!ok) {
      info(mode === "console" ? `Ордер ${id} не найден (или уже снят).` : `<b>Ордер не найден</b>: <code>${id}</code>.`);
    }
    return;
  }

  // --- отмена лимитных/стоп по символу ---
  if (parsed.kind === "cancel_limit_symbol" || parsed.kind === "cancel_stop_symbol") {
    const sym = parsed.symbol;
    try {
      const open = await ex.fetchOpenOrders(sym);
      const toCancel = open.filter(o => parsed.kind === "cancel_limit_symbol" ? isLimitOrder(o) : isStopOrder(o));
      for (const o of toCancel) { try { await ex.cancelOrder(sym, String(o.id)); } catch {} }
      info(
        mode === "console"
          ? `Снял ${toCancel.length} ${parsed.kind==="cancel_limit_symbol"?"LIMIT":"STOP"} ордеров по ${sym}.`
          : `<b>Снял ${toCancel.length} ${parsed.kind==="cancel_limit_symbol"?"LIMIT":"STOP"} ордеров</b> по <code>${sym}</code>.`
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
      try {
        const open = await ex.fetchOpenOrders(sym);
        const toCancel = open.filter(o => {
          if (modeSub === "all") return true;
          if (modeSub === "limit") return isLimitOrder(o);
          return isStopOrder(o);
        });
        for (const o of toCancel) { try { await ex.cancelOrder(sym, String(o.id)); total++; } catch {} }
      } catch {}
    }
    info(mode === "console" ? `Снял ${total} ордеров (${modeSub}).` : `<b>Снял ${total} ордеров</b> (${modeSub}).`);
    return;
  }

  // --- пресеты ---
  if (parsed.kind === "preset_list") {
    const list = await listPresets();
    const def = await getDefaultPresetName();
    info(
      formatPresetList(
        mode,
        list.map((p) => ({ name: p.config_name, isDefault: p.config_name === def }))
      )
    );
    return;
  }

  if (parsed.kind === "preset_show") {
    const def = await getDefaultPresetName();
    const p = await getPreset(parsed.name);
    info(
      formatPreset(mode, {
        name: p.config_name,
        risk: p.trade_risk,
        tp: p.take_profit,
        ratio: p.take_profit_ratio,
        isDefault: p.config_name === def,
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
      await setDefaultPreset(next.config_name);
    }
    const def = await getDefaultPresetName();
    info(
      formatPreset(mode, {
        name: next.config_name,
        risk: next.trade_risk,
        tp: next.take_profit,
        ratio: next.take_profit_ratio,
        isDefault: next.config_name === def,
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
        const open = await ex.fetchOpenOrders(t.symbolCcxt);
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

    const open = await ex.fetchOpenOrders(symbolCcxt);
    const openIds = new Set(open.filter((o) => o.id).map((o) => o.id as string));
    const openEntryIdsOrdered = entryIds.filter((id) => openIds.has(id));

    const results: string[] = [];
    const legsForEdit: TradeLeg[] = splitLegsByUsd(parsed.legs as TradeLeg[]);
    for (let i = 0; i < legsForEdit.length; i++) {
      const leg = legsForEdit[i];
      const pick = computeQtyForUsdSmart(ex, symbolCcxt, leg.usd, leg.price);
      if (pick.tooSmall || !(pick.qty > 0)) {
        results.push(`skip ($${leg.usd.toFixed(2)} @ ${leg.price} меньше minQty/step)`);
        continue;
      }

      let isLimit = (parsed.dir === "l" ? leg.price < mark : leg.price > mark);

      let replacedId: string | undefined;
      if (i < openEntryIdsOrdered.length) {
        replacedId = openEntryIdsOrdered[i];
        try { await ex.cancelOrder(symbolCcxt, replacedId); } catch {}
      }

      let newId: string | undefined;
      try {
        if (!isLimit && wouldStopImmediatelyTrigger(parsed.dir === "l" ? "long" : "short", leg.price, mark)) {
          isLimit = true;
        }
        if (isLimit) {
          const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
          const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, px);
          newId = o.id!;
        } else {
          const stopPx = Number(ex.priceToPrecision(symbolCcxt, leg.price));
          const o = await ex.createStopMarketEntry(symbolCcxt, sideEntry as any, pick.qty, stopPx);
          newId = o.id!;
        }
      } catch {
        const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
        const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, px);
        newId = o.id!;
      }

      if (replacedId) {
        const idx = entryIds.indexOf(replacedId);
        if (idx >= 0 && newId) entryIds[idx] = newId;
      } else {
        if (newId) entryIds.push(newId);
      }

      results.push(
        `${replacedId ? `replace ${replacedId} → ${newId}` : `add ${newId}`} (~${(pick.qty).toFixed(5)
        } @ ${leg.price}, ≈ $${pick.usdActual.toFixed(2)} к цели $${leg.usd.toFixed(2)})`
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

  const { dir, rawTicker, legs, presetName, dryRun, market, riskUsdOverride } = parsed as any;
  const side = dir === "l" ? "long" : "short";
  const sideEntry = side === "long" ? "buy" : "sell";
  const sideExit = side === "long" ? "sell" : "buy";

  const preset = await getPreset(presetName);
  const { symbolCcxt } = normalizeTickerToUsdt(rawTicker);
  ex.loadMarkets && (await ex.loadMarkets().catch(() => {}));
  ex.market(symbolCcxt);

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

    const task = book.add(symbolCcxt, `${side.toUpperCase()} MARKET ($${market.usd})`, { side, totalUsd: market.usd, presetName });
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

        for (;;) {
          const tick = await ex.fetchTicker(symbolCcxt);
          const mark = Number(tick.last ?? tick.mark ?? tick.info?.markPrice);

          const positions = await ex.fetchAllOpenPositions();
          const my = positions.find((p) => p.symbol === symbolCcxt);
          const posSize = Math.abs(my?.contracts ?? 0);
          const entryAvg = Number(my?.entryPrice ?? 0) || 0;

          const delta = posSize - lastSize;
          const increased = delta > 1e-9;

          if (increased && posSize > 0) {
            const filters = ex.getSymbolFilters(symbolCcxt);
            const positionUsd = posSize * entryAvg;

            const totalUsd = task.totalUsd ?? positionUsd;
          const baseRisk = Number.isFinite(riskUsdOverride) && (riskUsdOverride as number) > 0 ? (riskUsdOverride as number) : preset.trade_risk;
          const factor = RISK_LOCK_AFTER_FILL ? 1 : Math.min(1, positionUsd / Math.max(1, totalUsd));
          const effectiveRiskUsd = baseRisk * factor;

            const desiredSL = calcDesiredSLByRiskUsd(side, entryAvg, posSize, effectiveRiskUsd);
            const precSL = Number(ex.priceToPrecision(symbolCcxt, desiredSL));
            const safeSL0 = adjustStopForMark(side, precSL, mark, filters.tickSize || 0.0001);
            const safeSL = Number(ex.priceToPrecision(symbolCcxt, safeSL0));
            if (!Number.isFinite(safeSL) || safeSL <= 0) {
              throw new Error(`Bad stopPrice computed: entryAvg=${entryAvg}, posSize=${posSize}, desired=${precSL}, mark=${mark}`);
            }

            await cancelOnlySL(ex, symbolCcxt, keep).catch(() => {});
            await ex.createStopMarketClose(symbolCcxt, sideExit as any, safeSL);
            slPxCurrent = safeSL;

            if (!tpsPlaced) {
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

            lastSize = posSize;
            lastAvg = entryAvg;
            book.set(task, "live");
          }

          const open = await ex.fetchOpenOrders(symbolCcxt);
          const nonEntryOpen = open;
          const f = ex.getSymbolFilters(symbolCcxt);
          const flat = Math.abs(await ex.fetchPositionSize(symbolCcxt)) < Math.max((f.minQty||0)*0.5, 1e-12);
          if (flat) {
            // позиция вручную закрыта или сработал SL — чистим ордера и удаляем задачу
            await ex.cancelAllOrders(symbolCcxt).catch(() => {});
            const markNow = Number((await ex.fetchTicker(symbolCcxt)).last ?? 0);
            const wasSL = slPxCurrent && ((side === "long" && markNow <= (slPxCurrent + (f.tickSize||0))) || (side === "short" && markNow >= (slPxCurrent - (f.tickSize||0))));
            info(mode === "console" ? (wasSL ? `SL сработал по ${symbolCcxt}. Задачу #${task.id} удалил.` : `Позиция ${symbolCcxt} закрыта. Задачу #${task.id} удалил.`)
              : (wasSL ? `<b>SL сработал</b> по <code>${symbolCcxt}</code>. Задачу #${task.id} удалил.` : `<b>Позиция закрыта</b> по <code>${symbolCcxt}</code>. Задачу #${task.id} удалил.`));
            book.remove(task.id);
            break;
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
  const totalUsd = legs.reduce((a, l) => a + l.usd, 0);
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
  const legsForPlacement: TradeLeg[] = splitLegsByUsd(legs as TradeLeg[]);
  for (const leg of legsForPlacement) {
    const pick = computeQtyForUsdSmart(ex, symbolCcxt, leg.usd, leg.price);
    if (pick.tooSmall || !(pick.qty > 0)) {
      info(`[SKIP] $${leg.usd.toFixed(2)} @ ${leg.price} — меньше minQty/step для ${symbolCcxt}`);
      continue;
    }

    const isLimitLeg = side === "long" ? leg.price < markPrice : leg.price > markPrice;
    try {
      if (isLimitLeg) {
        const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
        const o = await ex.createLimit(symbolCcxt, (side === "long" ? "buy" : "sell") as any, pick.qty, px);
        entryIds.push(o.id!);
      } else {
        const stopPx = Number(ex.priceToPrecision(symbolCcxt, leg.price));
        if (wouldStopImmediatelyTrigger(side, stopPx, markPrice)) {
          const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
          const o = await ex.createLimit(symbolCcxt, (side === "long" ? "buy" : "sell") as any, pick.qty, px);
          entryIds.push(o.id!);
        } else {
          const o = await ex.createStopMarketEntry(symbolCcxt, (side === "long" ? "buy" : "sell") as any, pick.qty, stopPx);
          entryIds.push(o.id!);
        }
      }
      info(`➕ Вход: ~${(pick.qty).toFixed(5)} @ ${leg.price} (≈ $${pick.usdActual.toFixed(2)} к цели $${leg.usd.toFixed(2)})`);
    } catch {
      const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
      const o = await ex.createLimit(symbolCcxt, (side === "long" ? "buy" : "sell") as any, pick.qty, px);
      entryIds.push(o.id!);
    }
  }

  const task = book.add(
    symbolCcxt,
    `${side.toUpperCase()} multi ${legs.length} legs (Σ$${totalUsd})`,
    { side, totalUsd, presetName }
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

      // НОВОЕ: учёт исчезнувших входов с задержкой-подтверждением
      const MANUAL_GONE_GRACE_MS = 4000;
      const gone = new Map<string, { ts: number; sizeOnGone: number }>();

      for (;;) {
        if (book.get(task.id)?.cancelRequested) {
          await cancelBracketOnly(ex, symbolCcxt, keep).catch(() => {});
          for (const id of keep) {
            await ex.cancelOrder(task.symbolCcxt, id).catch(() => {});
          }
          book.remove(task.id);
          return;
        }

        const tick = await ex.fetchTicker(symbolCcxt);
        const mark = Number(tick.last ?? tick.mark ?? tick.info?.markPrice);

        const positions = await ex.fetchAllOpenPositions();
        const my = positions.find((p) => p.symbol === symbolCcxt);
        const posSize = Math.abs(my?.contracts ?? 0);
        const entryAvg = Number(my?.entryPrice ?? 0) || 0;

        const open = await ex.fetchOpenOrders(symbolCcxt);
        const entriesLeft = open.filter((o) => o.id && keep.has(o.id)).length;

        // === Исправлено: надёжное определение «снято вручную» ===
        for (const id of [...keep]) {
          const exists = open.some((o) => o.id === id);
          if (exists) {
            gone.delete(id);
            continue;
          }
          // не найден среди открытых
          const rec = gone.get(id);
          if (!rec) {
            // помечаем момент исчезновения
            gone.set(id, { ts: Date.now(), sizeOnGone: posSize });
            continue;
          }
          const elapsed = Date.now() - rec.ts;
          const increasedSinceGone = posSize > rec.sizeOnGone + 1e-9;

          if (increasedSinceGone) {
            // считаем, что ордер исполнился (позиция увеличилась)
            keep.delete(id);
            gone.delete(id);
            continue;
          }

          if (elapsed < MANUAL_GONE_GRACE_MS) {
            // ждём подтверждения
            continue;
          }

          // прошло достаточно времени и позиция не выросла — трактуем как снятый руками
          const minQty = ex.getSymbolFilters(symbolCcxt).minQty || 0;
          const flat = posSize < Math.max(minQty * 0.5, 1e-12);

          if (flat) {
            // ⚠️ Больше НЕ удаляем задачу немедленно.
            // Просто вычёркиваем этот вход и даём шансу другим входам этой задачи остаться в силе.
            keep.delete(id);
            gone.delete(id);
            // продолжаем цикл
          } else {
            // уже в позиции — ничего не снимаем, только вычёркиваем этот id из keep и продолжаем
            keep.delete(id);
            gone.delete(id);
          }
        }

        // ✅ НОВЫЙ чек: если мы вне позиции и ВСЕ входные отложки этой задачи сняты — удаляем задачу
        {
          const minQty = ex.getSymbolFilters(symbolCcxt).minQty || 0;
          const flat = posSize < Math.max(minQty * 0.5, 1e-12);
          if (flat && keep.size === 0) {
            // Ничего дополнительно не отменяем, чтобы не конфликтовать с другими задачами по этому же символу
            book.remove(task.id);
            info(
              mode === "console"
                ? `🧹 Все входные заявки сняты вручную — задачу #${task.id} по ${symbolCcxt} удалил.`
                : `<b>🧹 Все входные заявки сняты вручную</b> — задачу #${task.id} по <code>${symbolCcxt}</code> удалил.`
            );
            return;
          }
        }

        const delta = posSize - lastSize;
        const increased = delta > 1e-9;
        const decreased = delta < -1e-9;

        if (posSize > 0 && increased) {
          const filters = ex.getSymbolFilters(symbolCcxt);
          const positionUsd = posSize * entryAvg;

          const totalPlannedUsd = task.totalUsd ?? positionUsd;
          const presetForRisk = await getPreset(task.presetName || DEFAULT_PRESET);
          const baseRisk = Number.isFinite(riskUsdOverride) && (riskUsdOverride as number) > 0 ? (riskUsdOverride as number) : presetForRisk.trade_risk;
          const factor = RISK_LOCK_AFTER_FILL && entriesLeft === 0 ? 1 : Math.min(1, positionUsd / Math.max(1, totalPlannedUsd));
          const effectiveRiskUsd = baseRisk * factor;

          const desiredSL = calcDesiredSLByRiskUsd(side, entryAvg, posSize, effectiveRiskUsd);
          const precSL = Number(ex.priceToPrecision(symbolCcxt, desiredSL));
          const safeSL0 = adjustStopForMark(side, precSL, mark, filters.tickSize || 0.0001);
          const safeSL = Number(ex.priceToPrecision(symbolCcxt, safeSL0));
          if (!Number.isFinite(safeSL) || safeSL <= 0) {
            throw new Error(`Bad stopPrice computed: entryAvg=${entryAvg}, posSize=${posSize}, desired=${precSL}, mark=${mark}`);
          }

          await cancelOnlySL(ex, symbolCcxt, keep).catch(() => {});
          const sideExit2 = side === "long" ? "sell" : "buy";
          await ex.createStopMarketClose(symbolCcxt, sideExit2 as any, safeSL);
          slPxCurrent = safeSL;

          if (entriesLeft === 0 && !tpsPlaced) {
            const planningPreset2 = { ...presetForRisk, trade_risk: baseRisk } as any;
            const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset: planningPreset2 });

            let tpQtys = splitQtyToStep(posSize, presetForRisk.take_profit_ratio, filters.stepSize);
            tpQtys = mergeDustToPrev(tpQtys, filters.minQty, filters.stepSize);
            tpQtys = tpQtys.map((q) => Number(ex.amountToPrecision(symbolCcxt, q)));
            for (let i = 0; i < re.tpPrices.length; i++) {
              const q = tpQtys[i];
              if (q <= 0) continue;
              const p = Number(ex.priceToPrecision(symbolCcxt, re.tpPrices[i]));
              await ex.createReduceOnlyLimit(symbolCcxt, sideExit2 as any, q, p);
            }
            tpsPlaced = true;
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
            const current = await ex.fetchOpenOrders(symbolCcxt);
            const openIds = new Set(current.map(o=>String(o.id||"")));
            // tpIndexById может отсутствовать в этой ветке — создадим локально, если нет
            // (безопасно: просто не будет номера)
            const map = (typeof tpIndexById !== "undefined" ? tpIndexById : new Map<string, number>());
            const gone = Array.from(map.entries()).filter(([id])=>!openIds.has(id)).map(([,idx])=>idx);
            if (gone.length) tpNo = Math.min(...gone);
          } catch {}
          const tpTag = tpNo ? `TP${tpNo}` : `TP`;
          info(mode === "console" ? `${tpTag}/выход: -${closed.toFixed(5)} по ${symbolCcxt}` : `<b>${tpTag}/выход</b>: −${closed.toFixed(5)} по <code>${symbolCcxt}</code>`);
          lastSize = posSize;
          lastAvg = entryAvg;
        }

        // Доп. гарантированная постановка TP, если все входные заявки исчезли,
        // позиция > 0, а TP ещё не поставлены (мог пропасть "increased" триггер)
        if (!tpsPlaced && entriesLeft === 0 && posSize > 0) {
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
              await ex.createReduceOnlyLimit(symbolCcxt, sideExit as any, q, p);
            }
            tpsPlaced = true;
          } catch {}
        }

        const nonEntryOpen = open.filter((o) => !(o.id && keep.has(o.id)));
        if (posSize < 1e-12 && keep.size === 0 && nonEntryOpen.length === 0) {
          book.remove(task.id);
          break;
        }

        for (const id of [...keep]) {
          if (!open.find((o) => o.id === id)) keep.delete(id);
        }

        await new Promise((r) => setTimeout(r, 1200));
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
