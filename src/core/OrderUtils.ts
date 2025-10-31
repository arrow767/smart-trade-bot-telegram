import { BinanceFutures } from "../exch/BinanceFutures";
import { TaskBook } from "./TaskBook";

/**
 * Проверка, является ли ордер стоп-ордером
 */
export function isStopOrder(o: any): boolean {
  const t = String(o.type || o.info?.type || "").toUpperCase();
  return t.includes("STOP");
}

/**
 * Проверка, является ли ордер лимитным ордером
 */
export function isLimitOrder(o: any): boolean {
  const t = String(o.type || o.info?.type || "").toUpperCase();
  return t.includes("LIMIT") && !t.includes("STOP");
}

/**
 * Собрать все символы для поиска ордеров
 */
export async function collectSymbolsForOrders(ex: BinanceFutures, book: TaskBook): Promise<string[]> {
  const set = new Set<string>();
  for (const t of book.list()) set.add(t.symbolCcxt);
  try {
    const positions = await ex.fetchAllOpenPositions();
    for (const p of positions) if ((p.contracts ?? 0) > 0) set.add(p.symbol);
  } catch {}
  return Array.from(set.values());
}

/**
 * Снять только стоп-лоссы (closePosition/stop), не трогая входы/ТП
 */
export async function cancelOnlySL(
  ex: BinanceFutures,
  symbolCcxt: string,
  keepIds: Set<string>
) {
  const open = await ex.fetchOpenOrders(symbolCcxt);
  for (const o of open) {
    const isEntry = o.id && keepIds.has(o.id);
    if (isEntry) continue;
    const t = String(o.type || "").toUpperCase();
    const isClose = o.info?.closePosition === true || o.info?.closePosition === "true";
    // Снимаем только STOP_MARKET с closePosition=true (SL закрывает всю позицию)
    // НЕ снимаем STOP_MARKET без closePosition и не снимаем другие типы ордеров
    if (isClose && t.includes("STOP")) {
      try { await ex.cancelOrder(symbolCcxt, o.id!); } catch {}
    }
  }
}

/**
 * Снять SL и TP, не трогая входы
 */
export async function cancelBracketOnly(
  ex: BinanceFutures,
  symbolCcxt: string,
  keepIds: Set<string>
) {
  const open = await ex.fetchOpenOrders(symbolCcxt);
  for (const o of open) {
    if (o.id && keepIds.has(o.id)) continue;
    try { await ex.cancelOrder(symbolCcxt, o.id!); } catch {}
  }
}

/**
 * Закрытие позиции на процент
 */
export async function closePositionPercent(
  ex: BinanceFutures,
  symbolCcxt: string,
  percent: number
): Promise<{ closed: number; sideExit: "buy" | "sell"; fullyClosed: boolean }> {
  const amtSigned = await ex.fetchPositionSize(symbolCcxt);
  const sideExit: "buy" | "sell" = amtSigned > 0 ? "sell" : "buy";
  const size = Math.abs(amtSigned);
  if (size <= 0) return { closed: 0, sideExit, fullyClosed: true };

  const f = ex.getSymbolFilters(symbolCcxt);
  const targetRaw = percent >= 100 ? size : (size * percent) / 100;
  const steps = Math.floor(targetRaw / f.stepSize + 1e-12);
  const target = Math.max(f.minQty, Number(ex.amountToPrecision(symbolCcxt, steps * f.stepSize)));
  if (!(target > 0)) return { closed: 0, sideExit, fullyClosed: false };

  const open = await ex.fetchOpenOrders(symbolCcxt);
  type OpenRO = { id: string; amount: number; side: string; type: string };
  const roList: OpenRO[] = [];
  for (const o of open) {
    const reduceOnly =
      (o.info?.reduceOnly === true || o.info?.reduceOnly === "true" || (o as any).reduceOnly === true) &&
      String(o.type || "").toUpperCase().includes("LIMIT");
    if (!reduceOnly) continue;
    if (String(o.side || "").toLowerCase() !== sideExit) continue;
    const amt = Number(o.amount ?? o.info?.origQty ?? 0) || 0;
    if (amt > 0 && o.id) roList.push({ id: o.id, amount: amt, side: String(o.side), type: String(o.type) });
  }

  const roTotal = roList.reduce((s, x) => s + x.amount, 0);
  const freeCapacity = Math.max(0, size - roTotal);

  if (target > freeCapacity + 1e-12) {
    let toCancel = target - freeCapacity;
    roList.sort((a, b) => a.amount - b.amount);
    for (const o of roList) {
      if (toCancel <= 0) break;
      try { await ex.cancelOrder(symbolCcxt, o.id); } catch {}
      toCancel -= o.amount;
    }
  }

  await ex.createReduceOnlyMarket(symbolCcxt, sideExit as any, target);

  await new Promise((r) => setTimeout(r, 600));
  const left = Math.abs(await ex.fetchPositionSize(symbolCcxt));
  const fullyClosed = left < f.minQty * 0.5;

  return { closed: target, sideExit, fullyClosed };
}

