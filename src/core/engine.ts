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
import fs from "fs";
import path from "path";
import { 
  ParsedCmd, 
  Task, 
  TradeLeg,
  TaskStatus, 
  DEFAULT_PRESET,
  NOTIONAL_BIAS 
} from "./types";

// Реэкспорт для внешних модулей
export { DEFAULT_PRESET } from "./types";
export type { ParsedCmd, Task, TradeLeg, TaskStatus } from "./types";

// ======== persist tasks to JSON ========
const DATA_DIR = path.resolve(process.cwd(), "data");
const TASKS_JSON = path.join(DATA_DIR, "tasks.json");

function ensureDir(pth: string) {
  try { fs.mkdirSync(pth, { recursive: true }); } catch {}
}

let TASK_ID_SEQ = 1;

export class TaskBook {
  public tasks = new Map<number, Task>();

  constructor() {
    this.load();
    // восстановим последовательность идентификаторов
    for (const id of this.tasks.keys()) TASK_ID_SEQ = Math.max(TASK_ID_SEQ, id + 1);
  }

  private save() {
    try {
      ensureDir(DATA_DIR);
      const out = JSON.stringify(
        Array.from(this.tasks.values()).map(t => ({
          ...t,
          startedAt: t.startedAt?.toISOString?.() ?? new Date().toISOString(),
          updatedAt: t.updatedAt?.toISOString?.() ?? new Date().toISOString(),
        })),
        null,
        2
      );
      fs.writeFileSync(TASKS_JSON, out, "utf-8");
    } catch {}
  }

  private load() {
    try {
      if (!fs.existsSync(TASKS_JSON)) return;
      const raw = JSON.parse(fs.readFileSync(TASKS_JSON, "utf-8")) as any[];
      for (const o of raw || []) {
        const t: Task = {
          id: Number(o.id),
          symbolCcxt: String(o.symbolCcxt),
          label: String(o.label),
          status: String(o.status) as TaskStatus,
          error: o.error ? String(o.error) : undefined,
          startedAt: new Date(o.startedAt),
          updatedAt: new Date(o.updatedAt),
          entryOrderIds: Array.isArray(o.entryOrderIds) ? o.entryOrderIds.map(String) : [],
          cancelRequested: !!o.cancelRequested,
          side: (o.side === "long" || o.side === "short") ? o.side : undefined,
          totalUsd: Number(o.totalUsd || 0) || undefined,
          presetName: o.presetName ? String(o.presetName) : undefined,
        };
        this.tasks.set(t.id, t);
      }
    } catch {}
  }

  add(symbolCcxt: string, label: string, extras?: { side?: "long"|"short"; totalUsd?: number; presetName?: string }) {
    const t: Task = {
      id: TASK_ID_SEQ++,
      symbolCcxt,
      label,
      status: "queued",
      startedAt: new Date(),
      updatedAt: new Date(),
      side: extras?.side,
      totalUsd: extras?.totalUsd,
      presetName: extras?.presetName,
    };
    this.tasks.set(t.id, t);
    this.save();
    return t;
  }

  set(t: Task, s: TaskStatus, err?: string) {
    t.status = s;
    t.updatedAt = new Date();
    if (err) t.error = err;
    this.save();
  }

  list() {
    return Array.from(this.tasks.values()).sort((a, b) => a.id - b.id);
  }

  get(id: number) {
    return this.tasks.get(id);
  }

  setEntryOrders(t: Task, ids: string[]) {
    t.entryOrderIds = ids;
    t.updatedAt = new Date();
    this.save();
  }

  requestCancel(id: number) {
    const t = this.tasks.get(id);
    if (t) {
      t.cancelRequested = true;
      t.updatedAt = new Date();
      this.save();
    }
  }

  requestCancelAll() {
    for (const t of this.tasks.values()) t.cancelRequested = true;
    this.save();
  }

  /** НОВОЕ: полное удаление таски */
  remove(id: number) {
    this.tasks.delete(id);
    this.save();
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

// --- НОВОЕ: утилиты для ордеров ---
function isStopOrder(o: any): boolean {
  const t = String(o.type || o.info?.type || "").toUpperCase();
  return t.includes("STOP"); // STOP, STOP_MARKET, STOP_LOСС_LIMIT, TAKE_PROFIT_* (если есть STOP)
}
function isLimitOrder(o: any): boolean {
  const t = String(o.type || o.info?.type || "").toUpperCase();
  return t.includes("LIMIT") && !t.includes("STOP");
}
async function collectSymbolsForOrders(ex: BinanceFutures, book: TaskBook): Promise<string[]> {
  const set = new Set<string>();
  for (const t of book.list()) set.add(t.symbolCcxt);
  try {
    const positions = await ex.fetchAllOpenPositions();
    for (const p of positions) if ((p.contracts ?? 0) > 0) set.add(p.symbol);
  } catch {}
  return Array.from(set.values());
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

    // FIXED: "или" → "||"
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

  // --- инфо по таске ---
  if (cmd === "info" && p[1]) {
    const id = Number(p[1]);
    if (!Number.isFinite(id)) return null;
    return { kind: "task_info", id };
  }

  // --- НОВОЕ: ордера / отмена ордеров ---
  if (cmd === "orders") {
    const sym = p[1];
    if (sym) {
      const { symbolCcxt } = normalizeTickerToUsdt(sym);
      return { kind: "orders", symbol: symbolCcxt };
    }
    return { kind: "orders" };
  }

  if (cmd === "cancel" && (p[1]||"").toLowerCase() === "order" && p[2]) {
    return { kind: "cancel_order", id: p[2] };
  }

  if (cmd === "cancel" && (p[1]||"").toLowerCase() === "limit" && p[2]) {
    const { symbolCcxt } = normalizeTickerToUsdt(p[2]);
    return { kind: "cancel_limit_symbol", symbol: symbolCcxt };
  }

  if (cmd === "cancel" && (p[1]||"").toLowerCase() === "stop" && p[2]) {
    const { symbolCcxt } = normalizeTickerToUsdt(p[2]);
    return { kind: "cancel_stop_symbol", symbol: symbolCcxt };
  }

  if (cmd === "cancel-all") {
    const sub1 = (p[1]||"").toLowerCase();
    const sub2 = (p[2]||"").toLowerCase();
    if (sub1 === "orders" && !sub2) return { kind: "cancel_all_orders", sub: "all" };
    if (sub1 === "limit" && sub2 === "orders") return { kind: "cancel_all_orders", sub: "limit" };
    if (sub1 === "stop" && sub2 === "orders") return { kind: "cancel_all_orders", sub: "stop" };
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

  // --- редактирование входов ---
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

  // --- торги ---
  if (!["l", "s"].includes(cmd)) return null;

  const rawTicker = p[1];
  if (!rawTicker) return null;

  // MARKET-вход краткий: l <sym> <usd> [preset]
  if (p.length >= 3 && isFinite(Number(p[2])) && (p.length === 3 || isNaN(Number(p[3])))) {
    const usd = Number(p[2]);
    const presetName = p[3] ? p[3] : DEFAULT_PRESET;
    return {
      kind: "trade",
      dir: cmd as "l" | "s",
      rawTicker,
      legs: [],
      market: { usd },
      presetName,
      dryRun: false,
    };
  }

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

  return { kind: "trade", dir: cmd as "l" | "s", rawTicker, legs, presetName, dryRun, market: null };
}

// ========== Утилиты торговли ==========

function fmtQty5(q: number): string {
  return (Math.round(q * 1e5) / 1e5).toFixed(5);
}

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

// точный SL в долларах риска
function calcDesiredSLByRiskUsd(
  side: "long" | "short",
  entryAvg: number,
  posSize: number,
  effectiveRiskUsd: number
): number {
  if (!(entryAvg > 0) || !(posSize > 0) || !(effectiveRiskUsd >= 0)) return entryAvg;
  const perContractLoss = effectiveRiskUsd / Math.max(1e-12, posSize);
  return side === "long" ? (entryAvg - perContractLoss) : (entryAvg + perContractLoss);
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

// закрытие части
async function closePositionPercent(
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

// ========== Help-текст ==========

function buildHelp(mode: UIMode): string {
  const lines = [
    "Быстрые клавиши: 1=positions, 2=deposit, 3=tasks, 9=help, 0=exit",
    "",
    "Торговля:",
    "  l <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]",
    "  s <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]",
    "  МАРКЕТ: l <sym> <usd> [preset]  (пример: l xrp 500 4h)",
    "  Пример: l xrp 500 2.35 300 2.33 4h",
    "",
    "Редактирование входов:",
    "  edit <taskId> <l|s> <sym> <usd1> <price1> [<usd2> <price2> ...]",
    "  Пример: edit 1 l xrp 200 2.35 100 2.36 100 2.37",
    "",
    "Управление позициями и задачами:",
    "  close <symbol> [percent]",
    "  cancel <taskId>",
    "  cancel-all",
    "  info <taskId>",
    "  positions | deposit | tasks",
    "",
    "Ордеры:",
    "  orders [symbol]",
    "  cancel order <id>",
    "  cancel limit <symbol>",
    "  cancel stop <symbol>",
    "  cancel-all orders / limit orders / stop orders",
    "",
    "Пресеты:",
    "  preset list/show/set/default/delete",
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
  if (parsed.kind === "help") {
    info(mode === "console" ? buildHelp(mode) : `<pre>${buildHelp(mode)}</pre>`);
    return;
  }

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
    const grandTotal = Number(futures.total || 0) + Number(spotTotal || 0);

    info(
      formatDeposit(mode, {
        total: futures.total, free: futures.free, used: futures.used,
        unreal, spotTotal, spotFree, spotUsed, grandTotal,
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
    info(
      formatTaskInfo(mode, {
        id: t.id, status: t.status, symbol: t.symbolCcxt, label: t.label,
        createdAt: t.startedAt.toISOString().replace("T"," ").slice(0,19),
        updatedAt: t.updatedAt.toISOString().replace("T"," ").slice(0,19),
        side: t.side, totalUsd: t.totalUsd, presetName: t.presetName,
        entryOrderIds: t.entryOrderIds, error: t.error,
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

  const { dir, rawTicker, legs, presetName, dryRun, market } = parsed;
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
            const effectiveRiskUsd = preset.trade_risk * Math.min(1, positionUsd / Math.max(1, totalUsd));

            const desiredSL = calcDesiredSLByRiskUsd(side, entryAvg, posSize, effectiveRiskUsd);
            const safeSL = adjustStopForMark(side, Number(ex.priceToPrecision(symbolCcxt, desiredSL)), mark, filters.tickSize || 0.0001);

            await cancelOnlySL(ex, symbolCcxt, keep).catch(() => {});
            await ex.createStopMarketClose(symbolCcxt, sideExit as any, safeSL);

            if (!tpsPlaced) {
              const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset });
              let tpQtys = splitQtyToStep(posSize, preset.take_profit_ratio, filters.stepSize);
              tpQtys = mergeDustToPrev(tpQtys, filters.minQty, filters.stepSize);
              tpQtys = tpQtys.map((q) => Number(ex.amountToPrecision(symbolCcxt, q)));
              for (let i = 0; i < re.tpPrices.length; i++) {
                const q = tpQtys[i];
                if (q <= 0) continue;
                const p = Number(ex.priceToPrecision(symbolCcxt, re.tpPrices[i]));
                await ex.createReduceOnlyLimit(symbolCcxt, sideExit as any, q, p);
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
          if (Math.abs(await ex.fetchPositionSize(symbolCcxt)) < 1e-12 && nonEntryOpen.length === 0) {
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
  const firstPlan = planTargets({ side, entryPrice: first.price, positionUsd: first.usd, preset });

  const previewRiskUsd = preset.trade_risk * (first.usd / Math.max(1, totalUsd));
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
                ? `🧹 Все входные отложенные заявки задачи сняты вручную — задачу удалил.`
                : `<b>🧹 Все входные отложенные заявки задачи сняты вручную</b> — задачу удалил.`
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
          const effectiveRiskUsd =
            presetForRisk.trade_risk * Math.min(1, positionUsd / Math.max(1, totalPlannedUsd));

          const desiredSL = calcDesiredSLByRiskUsd(side, entryAvg, posSize, effectiveRiskUsd);
          const safeSL = adjustStopForMark(side, Number(ex.priceToPrecision(symbolCcxt, desiredSL)), mark, filters.tickSize || 0.0001);

          await cancelOnlySL(ex, symbolCcxt, keep).catch(() => {});
          const sideExit2 = side === "long" ? "sell" : "buy";
          await ex.createStopMarketClose(symbolCcxt, sideExit2 as any, safeSL);

          if (entriesLeft === 0 && !tpsPlaced) {
            const re = planTargets({ side, entryPrice: entryAvg, positionUsd, preset: presetForRisk });

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

          const re2 = planTargets({ side, entryPrice: entryAvg, positionUsd, preset: presetForRisk });

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
          lastSize = posSize;
          lastAvg = entryAvg;
        }

        const nonEntryOpen = open.filter((o) => !(o.id && keep.has(o.id)));
        if (posSize < 1e-12 && keep.size === 0 && nonEntryOpen.length === 0) {
          book.remove(task.id);
          break;
        }

        for (const id of [...keep]) {
          if (!open.find((o) => o.id === id)) keep.delete(id);
        }

        await new Promise((r) => setTimeout(r, 1000));
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

  info(
    "🚀 Входы подбираются к целевому notional по ближайшему шагу. SL пропорционален заполненной доле; TP — один раз после финального добора. Задачи сохраняются в data/tasks.json."
  );
}
