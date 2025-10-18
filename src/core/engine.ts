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
} from "./format";

// ========== Типы команд/задач ==========

export type TradeLeg = { usd: number; price: number };

export type ParsedCmd =
  | {
      kind: "trade";
      dir: "l" | "s";
      rawTicker: string;
      legs: TradeLeg[];
      presetName: string;
      dryRun: boolean;
    }
  | { kind: "help" }
  | { kind: "tasks" }
  | { kind: "positions" }
  | { kind: "deposit" }
  | { kind: "exit" }
  | { kind: "cancel"; id: number }
  | { kind: "cancel_all" }
  | { kind: "close"; symbol: string; percent: number }
  | { kind: "edit"; id: number; dir: "l" | "s"; rawTicker: string; legs: TradeLeg[] }
  // управление пресетами:
  | { kind: "preset_list" }
  | { kind: "preset_show"; name: string }
  | { kind: "preset_set"; name: string; risk?: number; tp?: number[]; ratio?: number[]; makeDefault?: boolean }
  | { kind: "preset_delete"; name: string };

export type TaskStatus =
  | "queued"
  | "waiting_fill"
  | "filled"
  | "placing_bracket"
  | "live"
  | "flat"
  | "canceled"
  | "error"
  | "done";

export type Task = {
  id: number;
  symbolCcxt: string;
  label: string;
  status: TaskStatus;
  error?: string;
  startedAt: Date;
  updatedAt: Date;
  entryOrderIds?: string[];
  cancelRequested?: boolean;
};

export const DEFAULT_PRESET = "4h";
const NOTIONAL_BIAS: "nearest" | "down" | "up" = "nearest";

// ========== Книга задач ==========

let TASK_ID_SEQ = 1;

export class TaskBook {
  public tasks = new Map<number, Task>();

  add(symbolCcxt: string, label: string) {
    const t: Task = {
      id: TASK_ID_SEQ++,
      symbolCcxt,
      label,
      status: "queued",
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    this.tasks.set(t.id, t);
    return t;
  }

  set(t: Task, s: TaskStatus, err?: string) {
    t.status = s;
    t.updatedAt = new Date();
    if (err) t.error = err;
  }

  list() {
    return Array.from(this.tasks.values()).sort((a, b) => a.id - b.id);
  }

  setEntryOrders(t: Task, ids: string[]) {
    t.entryOrderIds = ids;
    t.updatedAt = new Date();
  }

  requestCancel(id: number) {
    const t = this.tasks.get(id);
    if (t) {
      t.cancelRequested = true;
      t.updatedAt = new Date();
    }
  }

  requestCancelAll() {
    for (const t of this.tasks.values()) t.cancelRequested = true;
  }

  isCancelRequested(id: number) {
    return !!this.tasks.get(id)?.cancelRequested;
  }
}

// ========== Парсер команд ==========

function parseNumsCSV(s?: string): number[] | undefined {
  if (!s) return undefined;
  const parts = s.split(/[,\s]+/).filter(Boolean);
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  return nums;
}

export function parseLine(line: string): ParsedCmd | null {
  const p = line.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return null;

  // шорткаты цифрами
  if (p.length === 1 && /^\d$/.test(p[0])) {
    const d = p[0];
    if (d === "1") return { kind: "positions" };
    if (d === "2") return { kind: "deposit" };
    if (d === "3") return { kind: "tasks" };
    if (d === "9") return { kind: "help" };
    if (d === "0") return { kind: "exit" };
  }

  const cmd = p[0].toLowerCase();

  // --- управление пресетами ---
  if (cmd === "preset" || cmd === "presets" || cmd === "config") {
    const sub = (p[1] || "").toLowerCase();

    if (!sub || sub === "list" || sub === "ls") {
      return { kind: "preset_list" };
    }

    if (sub === "show") {
      const name = p[2];
      if (!name) return null;
      return { kind: "preset_show", name };
    }

    if (sub === "delete" || sub === "rm" || sub === "del") {
      const name = p[2];
      if (!name) return null;
      return { kind: "preset_delete", name };
    }

    if (sub === "set" || sub === "add") {
      const name = p[2];
      if (!name) return null;
      const kv = new Map<string, string>();
      for (let i = 3; i < p.length; i++) {
        const m = p[i].match(/^([a-zA-Z_]+)=(.+)$/);
        if (m) kv.set(m[1].toLowerCase(), m[2]);
      }
      const risk = kv.has("risk") ? Number(kv.get("risk")) : undefined;
      const tp = parseNumsCSV(kv.get("tp") || kv.get("take_profit"));
      const ratio = parseNumsCSV(kv.get("ratio") || kv.get("take_profit_ratio"));
      const makeDefault = kv.get("default") === "1" || kv.get("default") === "true";
      return { kind: "preset_set", name, risk, tp, ratio, makeDefault };
    }

    if (sub.startsWith("default")) {
      const m = p[1].match(/^default=(.+)$/i);
      const name = m ? m[1] : p[2];
      if (!name) return null;
      return { kind: "preset_set", name, makeDefault: true };
    }
  }

  // --- стандартные команды ---
  if (cmd === "cancel" && p[1]) return { kind: "cancel", id: Number(p[1]) };
  if (cmd === "cancel-all") return { kind: "cancel_all" };
  if (cmd === "close" && p[1]) {
    const symbol = p[1];
    const percent = p[2] ? Math.max(0, Math.min(100, Number(p[2]))) : 100;
    return { kind: "close", symbol, percent: Number.isFinite(percent) ? percent : 100 };
  }
  if (["help", "?"].includes(cmd)) return { kind: "help" };
  if (["tasks"].includes(cmd)) return { kind: "tasks" };
  if (["positions", "pos", "open", "мои", "мои-позиции", "мои_позиции"].includes(cmd))
    return { kind: "positions" };
  if (
    ["deposit", "депозит", "баланс"].includes(cmd) ||
    (p[0].toLowerCase() === "my" && (p[1] ?? "").toLowerCase() === "deposit")
  )
    return { kind: "deposit" };
  if (["exit", "quit"].includes(cmd)) return { kind: "exit" };

  // edit <id> <l|s> <symbol> <usd1> <price1> [<usd2> <price2> ...]
  if (
    cmd === "edit" &&
    p[1] &&
    ["l", "s"].includes((p[2] ?? "").toLowerCase()) &&
    p[3] &&
    p[4] &&
    p[5]
  ) {
    const id = Number(p[1]);
    const dir = p[2].toLowerCase() as "l" | "s";
    const rawTicker = p[3];
    const legs: TradeLeg[] = [];
    let i = 4;
    while (i + 1 < p.length && isFinite(Number(p[i])) && isFinite(Number(p[i + 1]))) {
      const usd = Number(p[i]);
      const price = Number(p[i + 1]);
      if (usd > 0 && price > 0) legs.push({ usd, price });
      i += 2;
    }
    if (!Number.isFinite(id) || legs.length === 0) return null;
    return { kind: "edit", id, dir, rawTicker, legs };
  }

  // trade
  if (!["l", "s"].includes(cmd)) return null;

  const rawTicker = p[1];
  if (!rawTicker) return null;

  const legs: TradeLeg[] = [];
  let i = 2;
  while (i + 1 < p.length && isFinite(Number(p[i])) && isFinite(Number(p[i + 1]))) {
    const usd = Number(p[i]);
    const price = Number(p[i + 1]);
    if (usd > 0 && price > 0) legs.push({ usd, price });
    i += 2;
  }
  if (legs.length === 0) return null;

  let presetName = DEFAULT_PRESET;
  let dryRun = false;
  for (; i < p.length; i++) {
    const tok = p[i].toLowerCase();
    if (tok === "--dry") {
      dryRun = true;
      continue;
    }
    presetName = p[i];
  }

  return { kind: "trade", dir: cmd as "l" | "s", rawTicker, legs, presetName, dryRun };
}

// ========== Утилиты торговли ==========

// qty в UI до 5 знаков
function fmtQty5(q: number): string {
  return (Math.round(q * 1e5) / 1e5).toFixed(5);
}

// подобрать qty по шагу под целевой notional
function computeQtyForUsdSmart(
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

  let q = qFloor,
    usdAct = usdFloor;
  if (bias === "down") {
    q = qFloor;
    usdAct = usdFloor;
  } else if (bias === "up") {
    q = qCeil;
    usdAct = usdCeil;
  } else {
    if (diffCeil < diffFloor) {
      q = qCeil;
      usdAct = usdCeil;
    } else if (diffCeil > diffFloor) {
      q = qFloor;
      usdAct = usdFloor;
    } else {
      q = qFloor;
      usdAct = usdFloor;
    }
  }

  q = Number(ex.amountToPrecision(symbol, q));
  if (q < (ex.getSymbolFilters(symbol).minQty || 0) - 1e-12) {
    return { qty: 0, usdActual: 0, under: true, over: false, tooSmall: true };
  }
  return {
    qty: q,
    usdActual: usdAct,
    under: usdAct <= usdTarget,
    over: usdAct > usdTarget,
    tooSmall: false,
  };
}

function wouldStopImmediatelyTrigger(side: "long" | "short", stopPrice: number, mark: number) {
  return side === "long" ? stopPrice <= mark : stopPrice >= mark;
}

function adjustStopForMark(side: "long" | "short", desired: number, mark: number, tick: number) {
  if (side === "long") {
    const safe = mark - 2 * tick;
    return Math.min(desired, safe);
  } else {
    const safe = mark + 2 * tick;
    return Math.max(desired, safe);
  }
}

// снимаем только SL (closePosition/stop), не трогая входы/ТП
async function cancelOnlySL(ex: BinanceFutures, symbolCcxt: string, keepIds: Set<string>) {
  const open = await ex.fetchOpenOrders(symbolCcxt);
  for (const o of open) {
    const isEntry = o.id && keepIds.has(o.id);
    if (isEntry) continue;
    const t = String(o.type || "").toLowerCase();
    const isClose = o.info?.closePosition === true || o.info?.closePosition === "true";
    const looksLikeSL = t.includes("stop");
    if (isClose || looksLikeSL) {
      try { await ex.cancelOrder(symbolCcxt, o.id!); } catch {}
    }
  }
}

// снимаем SL и TP, не трогая входы
async function cancelBracketOnly(ex: BinanceFutures, symbolCcxt: string, keepIds: Set<string>) {
  const open = await ex.fetchOpenOrders(symbolCcxt);
  for (const o of open) {
    if (o.id && keepIds.has(o.id)) continue;
    try { await ex.cancelOrder(symbolCcxt, o.id!); } catch {}
  }
}

// ✅ Частичное/полное закрытие: если reduce-only MARKET не проходит из-за занятой квоты TP,
// снимаем минимально нужное количество reduce-only лимиток, затем выполняем MARKET, с ретраями.
async function closePositionPercent(
  ex: BinanceFutures,
  symbolCcxt: string,
  percent: number
): Promise<{ closed: number; sideExit: "buy" | "sell"; fullyClosed: boolean }> {
  // получаем SIGNED размер (для стороны выхода)
  const amtSigned0 = await ex.fetchPositionSize(symbolCcxt);
  const sideExit: "buy" | "sell" = amtSigned0 > 0 ? "sell" : "buy";
  const size0 = Math.abs(amtSigned0);
  if (size0 <= 0) return { closed: 0, sideExit, fullyClosed: true };

  const f = ex.getSymbolFilters(symbolCcxt);
  const targetRaw = percent >= 100 ? size0 : (size0 * percent) / 100;
  const steps = Math.floor(targetRaw / f.stepSize + 1e-12);
  const target = Math.max(f.minQty, Number(ex.amountToPrecision(symbolCcxt, steps * f.stepSize)));
  if (!(target > 0)) return { closed: 0, sideExit, fullyClosed: false };

  const tryOnce = async (): Promise<boolean> => {
    // Открытые reduce-only лимитки (TP) в сторону выхода
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

    // актуальный размер позы перед закрытием
    const amtSigned = await ex.fetchPositionSize(symbolCcxt);
    const currentSize = Math.abs(amtSigned);
    const roTotal = roList.reduce((s, x) => s + x.amount, 0);
    const freeCapacity = Math.max(0, currentSize - roTotal);

    // если квоты не хватает — снимем минимально нужные TP
    if (target > freeCapacity + 1e-12) {
      let toCancel = target - freeCapacity;
      roList.sort((a, b) => a.amount - b.amount);
      for (const o of roList) {
        if (toCancel <= 0) break;
        try { await ex.cancelOrder(symbolCcxt, o.id); } catch {}
        toCancel -= o.amount;
      }
    }

    try {
      await ex.createReduceOnlyMarket(symbolCcxt, sideExit as any, target);
      return true;
    } catch {
      return false;
    }
  };

  for (let i = 0; i < 3; i++) { // до трёх попыток в гонке
    const ok = await tryOnce();
    if (ok) break;
    await new Promise(r => setTimeout(r, 250 + i * 250));
    if (i === 2) throw new Error("ReduceOnly Order is rejected.");
  }

  await new Promise((r) => setTimeout(r, 600));
  const left = Math.abs(await ex.fetchPositionSize(symbolCcxt));
  const fullyClosed = left < f.minQty * 0.5;

  return { closed: target, sideExit, fullyClosed };
}

// ========== Help-текст ==========

function buildHelp(mode: UIMode): string {
  const lines = [
    "Быстрые клавиши: 1=positions, 2=deposit, 3=tasks, 9=help, 0=exit",
    "",
    "Торговля:",
    "  l <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]",
    "  s <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]",
    "  Пример: l xrp 500 2.35 300 2.33 4h",
    "",
    "Редактирование входов:",
    "  edit <taskId> <l|s> <sym> <usd1> <price1> [<usd2> <price2> ...]",
    "  Пример: edit 1 l xrp 200 2.35 100 2.36 100 2.37",
    "",
    "Управление позициями и задачами:",
    "  close <symbol> [percent]      — закрыть позицию полностью/частично",
    "  cancel <taskId>               — отменить задачу",
    "  cancel-all                    — отменить все задачи",
    "  positions | deposit | tasks   — инфо",
    "",
    "Пресеты:",
    "  preset list",
    "  preset show <name>",
    "  preset set <name> risk=<num> tp=<a,b,c> ratio=<a,b,c> [default=1]",
    "  preset default=<name>",
    "  preset delete <name>",
  ];
  return lines.join("\n");
}

// ========== Основной обработчик ==========

export async function runCommand(
  ex: BinanceFutures,
  book: TaskBook,
  parsed: ParsedCmd,
  log: (msg: string) => void,
  info: (msg: string) => void,
  mode: UIMode = "console"
) {
  // --- help ---
  if (parsed.kind === "help") {
    info(mode === "console" ? buildHelp(mode) : `<pre>${buildHelp(mode)}</pre>`);
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

    // spot USDT
    let spotTotal = 0,
      spotFree = 0,
      spotUsed = 0;
    try {
      const spot = await ex.fetchSpotUSDTBalance();
      spotTotal = spot.total;
      spotFree = spot.free;
      spotUsed = spot.used;
    } catch {}

    const positions = await ex.fetchAllOpenPositions();
    const unreal = positions.reduce((a, p) => a + (Number(p.unrealizedPnlUsd) || 0), 0);
    const grandTotal = Number(futures.total || 0) + Number(spotTotal || 0);

    info(
      formatDeposit(mode, {
        total: futures.total,
        free: futures.free,
        used: futures.used,
        unreal,
        spotTotal,
        spotFree,
        spotUsed,
        grandTotal,
      } as any)
    );
    return;
  }

  if (parsed.kind === "positions") {
    const listRaw = await ex.fetchAllOpenPositions();
    const list = listRaw.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: p.contracts,
      avg: p.entryPrice || 0,
      pnl: Number(p.unrealizedPnlUsd) || 0,
    }));
    info(formatPositions(mode, list));
    return;
  }

  if (parsed.kind === "tasks") {
    const rows = book.list().map((t) => ({
      id: t.id,
      status: t.status,
      symbol: t.symbolCcxt,
      label: t.label,
      agoSec: Math.round((Date.now() - t.startedAt.getTime()) / 1000),
      error: t.error,
    }));
    info(formatTasks(mode, rows));
    return;
  }

  if (parsed.kind === "cancel") {
    const t = book.tasks.get(parsed.id);
    if (!t) {
      info(mode === "console" ? `Задача #${parsed.id} не найдена.` : `<b>Нет задачи #${parsed.id}</b>`);
      return;
    }
    book.requestCancel(parsed.id);
    try {
      const keep = new Set(t.entryOrderIds || []);
      await cancelBracketOnly(ex, t.symbolCcxt, keep).catch(() => {});
      for (const id of keep) {
        await ex.cancelOrder(t.symbolCcxt, id).catch(() => {});
      }
    } catch {}
    book.set(t, "canceled");
    info(mode === "console" ? `Отменил задачу #${parsed.id}.` : `<b>Отменил задачу #${parsed.id}</b>`);
    return;
  }

  if (parsed.kind === "cancel_all") {
    book.requestCancelAll();
    for (const t of book.tasks.values()) {
      try {
        const keep = new Set(t.entryOrderIds || []);
        await cancelBracketOnly(ex, t.symbolCcxt, keep).catch(() => {});
        for (const id of keep) {
          await ex.cancelOrder(t.symbolCcxt, id).catch(() => {});
        }
        book.set(t, "canceled");
      } catch {}
    }
    info(mode === "console" ? `Все задачи отменены.` : `<b>Все задачи отменены</b>`);
    return;
  }

  if (parsed.kind === "close") {
    const { symbol, percent } = parsed;
    const { symbolCcxt } = normalizeTickerToUsdt(symbol);
    try {
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
    } catch (e:any) {
      info(`❌ [ERROR] ${e?.message || e}`);
    }
    return;
  }

  // --- редактирование входов ---
  if (parsed.kind === "edit") {
    const t = book.tasks.get(parsed.id);
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

    const tick = await ex.fetchTickerSafe(symbolCcxt);
    const mark = Number(tick.last ?? (tick as any).mark ?? (tick as any).info?.markPrice);

    const open = await ex.fetchOpenOrders(symbolCcxt);
    const openIds = new Set(open.filter((o) => o.id).map((o) => o.id as string));
    const openEntryIdsOrdered = entryIds.filter((id) => openIds.has(id));

    const results: string[] = [];
    for (let i = 0; i < parsed.legs.length; i++) {
      const leg = parsed.legs[i];
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

  const { dir, rawTicker, legs, presetName, dryRun } = parsed;
  const side = dir === "l" ? "long" : "short";
  const sideEntry = side === "long" ? "buy" : "sell";
  const sideExit = side === "long" ? "sell" : "buy";

  const preset = await getPreset(presetName);
  const { symbolCcxt } = normalizeTickerToUsdt(rawTicker);
  ex.loadMarkets && (await ex.loadMarkets().catch(() => {}));
  ex.market(symbolCcxt);

  const t0 = await ex.fetchTickerSafe(symbolCcxt);
  let markPrice = Number(t0.last ?? (t0 as any).mark ?? (t0 as any).info?.markPrice);
  if (!markPrice || !(markPrice > 0)) throw new Error(`Не удалось получить текущую цену для ${symbolCcxt}`);

  const totalUsd = legs.reduce((a, l) => a + l.usd, 0);
  const first = legs[0];

  const firstPick = computeQtyForUsdSmart(ex, symbolCcxt, first.usd, first.price);
  const firstPlan = planTargets({ side, entryPrice: first.price, positionUsd: first.usd, preset });

  info(
    formatPreview(mode, {
      symbol: symbolCcxt,
      side,
      notional: totalUsd,
      approxQty: Number(firstPick.qty.toFixed(5)),
      now: markPrice,
      entry: first.price,
      isLimit: side === "long" ? first.price < markPrice : first.price > markPrice,
      sl: String(ex.priceToPrecision(symbolCcxt, firstPlan.stopPrice)),
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
  for (const leg of legs) {
    const pick = computeQtyForUsdSmart(ex, symbolCcxt, leg.usd, leg.price);
    if (pick.tooSmall || !(pick.qty > 0)) {
      info(`[SKIP] $${leg.usd.toFixed(2)} @ ${leg.price} — меньше minQty/step для ${symbolCcxt}`);
      continue;
    }

    const isLimitLeg = side === "long" ? leg.price < markPrice : leg.price > markPrice;
    try {
      if (isLimitLeg) {
        const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
        const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, px);
        entryIds.push(o.id!);
      } else {
        const stopPx = Number(ex.priceToPrecision(symbolCcxt, leg.price));
        if (wouldStopImmediatelyTrigger(side, stopPx, markPrice)) {
          const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
          const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, px);
          entryIds.push(o.id!);
        } else {
          const o = await ex.createStopMarketEntry(symbolCcxt, sideEntry as any, pick.qty, stopPx);
          entryIds.push(o.id!);
        }
      }
      info(`➕ Вход: ~${(pick.qty).toFixed(5)} @ ${leg.price} (≈ $${pick.usdActual.toFixed(2)} к цели $${leg.usd.toFixed(2)})`);
    } catch {
      const px = Number(ex.priceToPrecision(symbolCcxt, leg.price));
      const o = await ex.createLimit(symbolCcxt, sideEntry as any, pick.qty, px);
      entryIds.push(o.id!);
    }
  }

  const task = book.add(symbolCcxt, `${side.toUpperCase()} multi ${legs.length} legs (Σ$${totalUsd})`);
  book.setEntryOrders(task, entryIds);
  info(`📥 Выставил ${entryIds.length} входных ордеров.`);

  // Фоновый обработчик: SL пересчитываем только при доборе; TP ставим один раз после финального добора
  book.set(task, "waiting_fill");

  (async () => {
    try {
      const keep = new Set(entryIds);
      let lastSize = 0;
      let lastAvg = 0;
      let tpsPlaced = false;

      for (;;) {
        if (book.isCancelRequested(task.id)) {
          await cancelBracketOnly(ex, symbolCcxt, keep).catch(() => {});
          for (const id of keep) {
            await ex.cancelOrder(symbolCcxt, id).catch(() => {});
          }
          book.set(task, "canceled");
          return;
        }

        const tick = await ex.fetchTickerSafe(symbolCcxt);
        const mark = Number(tick.last ?? (tick as any).mark ?? (tick as any).info?.markPrice);

        const positions = await ex.fetchAllOpenPositions();
        const my = positions.find((p) => p.symbol === symbolCcxt);
        const posSize = Math.abs(my?.contracts ?? 0);
        const entryAvg = Number(my?.entryPrice ?? 0) || 0;

        const open = await ex.fetchOpenOrders(symbolCcxt);
        const entriesLeft = open.filter((o) => o.id && keep.has(o.id)).length;

        const delta = posSize - lastSize;
        const increased = delta > 1e-9; // добор
        const decreased = delta < -1e-9;

        if (posSize > 0 && increased) {
          const filters = ex.getSymbolFilters(symbolCcxt);
          const positionUsd = posSize * entryAvg;
          const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset });

          // SL пересчитываем при доборе
          await cancelOnlySL(ex, symbolCcxt, keep).catch(() => {});
          const desiredSL = Number(ex.priceToPrecision(symbolCcxt, re.stopPrice));
          const safeSL = adjustStopForMark(side, desiredSL, mark, filters.tickSize || 0.0001);
          const sideExit2 = side === "long" ? "sell" : "buy";
          await ex.createStopMarketClose(symbolCcxt, sideExit2 as any, safeSL);

          // TP ставим только один раз — когда все входы исполнены
          if (entriesLeft === 0 && !tpsPlaced) {
            let tpQtys = splitQtyToStep(posSize, preset.take_profit_ratio, filters.stepSize);
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

          info(
            formatPlan(mode, {
              entryPx: Number(ex.priceToPrecision(symbolCcxt, entryAvg)),
              sl: String(ex.priceToPrecision(symbolCcxt, safeSL)),
              tps: re.tpPrices.map((p, i) => ({
                price: String(ex.priceToPrecision(symbolCcxt, p)),
                qty: 0,
                R: preset.take_profit[i],
              })),
            })
          );

          lastSize = posSize;
          lastAvg = entryAvg;
          book.set(task, entriesLeft === 0 ? "live" : lastSize > 0 ? "filled" : "waiting_fill");
        }

        if (decreased) {
          lastSize = posSize;
          lastAvg = entryAvg;
        }

        const nonEntryOpen = open.filter((o) => !(o.id && keep.has(o.id)));
        if (posSize < 1e-12 && keep.size === 0 && nonEntryOpen.length === 0) {
          book.set(task, "flat");
          book.set(task, "done");
          break;
        }

        for (const id of [...keep]) {
          if (!open.find((o) => o.id === id)) keep.delete(id);
        }

        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (err: any) {
      book.set(task, "error", err?.message ?? err);
      info(`❌ [ERROR] ${err?.message ?? err}`);
    }
  })();

  info(
    "🚀 Входы подбираются к целевому notional по ближайшему шагу. SL пересчитывается только при доборе. TP — один раз после финального добора."
  );
}
