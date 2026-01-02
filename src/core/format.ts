// src/core/format.ts
// Красивое форматирование для консоли и Telegram
export type UIMode = "console" | "telegram";

const isTTY = !!process.stdout.isTTY;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
const paint = (s: string, c: keyof typeof ANSI) => (isTTY ? `${ANSI[c]}${s}${ANSI.reset}` : s);
const b = (s: string) => paint(s, "bold");
const c = (s: string) => paint(s, "cyan");
const g = (s: string) => paint(s, "green");
const r = (s: string) => paint(s, "red");
const dim = (s: string) => paint(s, "gray");

// ===== Helpers: visible length & padding with ANSI =====
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string) { return s.replace(ANSI_REGEX, ""); }
function visLen(s: string) { return stripAnsi(String(s)).length; }
function padVisEnd(s: string, width: number) {
  const str = String(s);
  const need = Math.max(0, width - visLen(str));
  return str + " ".repeat(need);
}
function padVisStart(s: string, width: number) {
  const str = String(s);
  const need = Math.max(0, width - visLen(str));
  return " ".repeat(need) + str;
}

function shortSymbol(s: string): string {
  return s
    .replace(/\/USDT:USDT$/i, "")
    .replace(/USDT:USDT$/i, "")
    .replace(/\/USDT$/i, "")
    .replace(/USDT$/i, "");
}
function fix3(n: number): string { return (Number(n) || 0).toFixed(3); }
function sideTag(mode: UIMode, side: "long"|"short"): string {
  if (mode === "console") return side === "long" ? "L" : "S";
  return side === "long" ? "🟢L" : "🔴S";
}

// ✅ НОВОЕ: Форматирование чисел с разделителями тысяч для читабельности
function formatUsd(amount: number, decimals: number = 2): string {
  const fixed = amount.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  // Добавляем пробелы как разделители тысяч
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return decPart ? `${formatted}.${decPart}` : formatted;
}

function lineBox(lines: string[], title?: string): string {
  const width = Math.max(
    ...(lines.length ? lines.map(l => visLen(l)) : [0]),
    (title ? visLen(title) + 2 : 0),
    28
  );
  const top = "┌" + (title ? `─ ${title} ` : "─") + "─".repeat(Math.max(0, width - (title ? visLen(title) + 2 : 1))) + "┐";
  const body = lines.map(l => "│ " + padVisEnd(l, width) + " │").join("\n");
  const bot = "└" + "─".repeat(width + 2) + "┘";
  return `${top}\n${body}\n${bot}`;
}

function monoBlock(s: string): string { return `<pre>${escapeHtml(s)}</pre>`; }
function escapeHtml(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ===== Короткий формат времени: dd.mm.yy hh:mm:ss =====
function two(n: number) { return n < 10 ? `0${n}` : String(n); }
function formatTime(input?: string): string {
  if (!input) return "";
  const parsed = input.includes("T") ? input : input.replace(" ", "T");
  const d = new Date(parsed);
  if (Number.isNaN(d.getTime())) return input;
  const dd = two(d.getDate());
  const mm = two(d.getMonth() + 1);
  const yy = two(d.getFullYear() % 100);
  const hh = two(d.getHours());
  const mi = two(d.getMinutes());
  const ss = two(d.getSeconds());
  return `${dd}.${mm}.${yy} ${hh}:${mi}:${ss}`;
}

export function fmtSide(mode: UIMode, side: "long"|"short") {
  if (mode === "console") return side === "long" ? g("LONG") : r("SHORT");
  return side === "long" ? "🟢 LONG" : "🔴 SHORT";
}
export function fmtPnl(mode: UIMode, v: number) {
  const s = `${v > 0 ? "+" : ""}${v.toFixed(2)}$`;
  if (mode === "console") return v > 0 ? g(s) : v < 0 ? r(s) : s;
  return v > 0 ? `🟢 ${s}` : v < 0 ? `🔴 ${s}` : `• ${s}`;
}

export function formatPreview(mode: UIMode, p: {
  symbol: string; side: "long"|"short"; notional: number; approxQty: number;
  now: number; entry: number; isLimit: boolean; sl: string; tps: { price: string; R: number }[];
}) {
  const lines = [
    `${p.symbol}  ${fmtSide(mode, p.side)}`,
    `notional: $${p.notional}  qty: ~${p.approxQty}`,
    `now: ${p.now}  entry: ${p.entry}  type: ${p.isLimit ? "LIMIT" : "STOP"}`,
    `SL: ${p.sl}`,
    `TP: ` + p.tps.map((t, i) => `T${i+1}=${t.price}(R=${t.R})`).join("  "),
  ];
  return mode === "console" ? lineBox(lines, "PREVIEW") : monoBlock(lines.join("\n"));
}

export function formatPlan(mode: UIMode, p: { entryPx: number; sl: string; tps: { price: string; qty: number; R: number }[] }) {
  const lines = [
    `entry: ${p.entryPx}`,
    `SL: ${p.sl} (closePosition)`,
    `TP: ` + p.tps.map((t,i)=>`T${i+1}=${t.price} q=${t.qty} (R=${t.R})`).join("  "),
  ];
  return mode === "console" ? lineBox(lines, "PLAN") : monoBlock(lines.join("\n"));
}

// deposit: с выводом спота и общей суммы
export function formatDeposit(
  mode: UIMode,
  p: {
    total: number; free: number; used: number; unreal: number;
    spotTotal?: number; spotFree?: number; spotUsed?: number; grandTotal?: number;
    exposureUsd?: number; leverage?: number;
  }
) {
  // Форматирование с разделителями тысяч
  const fmtNum = (n: number) => n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnlSign = p.unreal >= 0 ? "+" : "";
  const pnlEmoji = p.unreal >= 0 ? "🟢" : "🔴";
  
  if (mode === "telegram") {
    // Красивая таблица для Telegram
    const W = 11; // ширина колонки значений
    const pad = (s: string) => s.padStart(W);
    
    let msg = `<b>💰 DEPOSIT (USDT)</b>\n\n`;
    
    // Futures секция
    msg += `<b>📊 Futures</b>\n`;
    msg += `<code>`;
    msg += `Total:    ${pad(fmtNum(p.total))}\n`;
    msg += `Free:     ${pad(fmtNum(p.free))}\n`;
    msg += `Used:     ${pad(fmtNum(p.used))}\n`;
    msg += `PnL:      ${pad(pnlSign + fmtNum(p.unreal))}</code> ${pnlEmoji}\n`;
    
    if (typeof p.exposureUsd === "number" && p.exposureUsd > 0) {
      const levStr = typeof p.leverage === "number" && p.leverage > 0 ? ` (${p.leverage.toFixed(2)}x)` : "";
      msg += `<code>Exposure: ${pad(fmtNum(p.exposureUsd))}</code>${levStr}\n`;
    }
    
    // Spot секция
    if (typeof p.spotTotal === "number") {
      msg += `\n<b>💎 Spot</b>\n`;
      msg += `<code>`;
      msg += `Total:    ${pad(fmtNum(p.spotTotal))}\n`;
      msg += `Free:     ${pad(fmtNum(p.spotFree ?? 0))}\n`;
      msg += `Used:     ${pad(fmtNum(p.spotUsed ?? 0))}</code>\n`;
    }
    
    // Aggregate секция
    if (typeof p.grandTotal === "number") {
      msg += `\n<b>📈 Aggregate</b>\n`;
      msg += `<code>Total:    ${pad(fmtNum(p.grandTotal))}</code>\n`;
    }
    
    return msg.trim();
  }
  
  // Console mode - табличный формат
  const lines: string[] = [];
  lines.push(`┌─────────────────────────────────────┐`);
  lines.push(`│ 📊 FUTURES                          │`);
  lines.push(`│   Total:   ${fmtNum(p.total).padStart(14)} USDT   │`);
  lines.push(`│   Free:    ${fmtNum(p.free).padStart(14)} USDT   │`);
  lines.push(`│   Used:    ${fmtNum(p.used).padStart(14)} USDT   │`);
  lines.push(`│   PnL:     ${(pnlSign + fmtNum(p.unreal)).padStart(14)} USDT   │`);
  
  if (typeof p.exposureUsd === "number" && p.exposureUsd > 0) {
    const levStr = typeof p.leverage === "number" && p.leverage > 0 ? ` (${p.leverage.toFixed(2)}x)` : "";
    lines.push(`│   Exposure:${fmtNum(p.exposureUsd).padStart(14)} USDT${levStr.padEnd(3)} │`);
  }
  
  if (typeof p.spotTotal === "number") {
    lines.push(`├─────────────────────────────────────┤`);
    lines.push(`│ 💎 SPOT                             │`);
    lines.push(`│   Total:   ${fmtNum(p.spotTotal).padStart(14)} USDT   │`);
    lines.push(`│   Free:    ${fmtNum(p.spotFree ?? 0).padStart(14)} USDT   │`);
    lines.push(`│   Used:    ${fmtNum(p.spotUsed ?? 0).padStart(14)} USDT   │`);
  }
  
  if (typeof p.grandTotal === "number") {
    lines.push(`├─────────────────────────────────────┤`);
    lines.push(`│ 📈 AGGREGATE                        │`);
    lines.push(`│   Total:   ${fmtNum(p.grandTotal).padStart(14)} USDT   │`);
  }
  
  lines.push(`└─────────────────────────────────────┘`);
  return lines.join("\n");
}

// ---------- Компактная таблица позиций для Telegram ----------
function makeCompactPositionsTable(
  rows: Array<{ symbol: string; side: "long"|"short"; pnl: number }>
): string {
  const data = rows.map(r => ({
    sym: shortSymbol(r.symbol).toUpperCase(),
    dir: r.side === "long" ? "L" : "S",
    pnl: r.pnl,
  }));

  const symW = Math.max(6, ...data.map(d => d.sym.length));
  const dirW = 3;
  const pnlStrs = data.map(d => `${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)}$`);
  const pnlW = Math.max(6, ...pnlStrs.map(s => s.length));

  const header = [
    "TICKER".padEnd(symW),
    "DIR".padEnd(dirW),
    "PnL".padStart(pnlW),
  ].join("  ");

  const sep = "-".repeat(header.length);

  const lines = data.map((d) => {
    const tag = d.dir === "L" ? "🟢L" : "🔴S";
    const pnlS = `${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)}$`;
    return [
      d.sym.padEnd(symW),
      tag.padEnd(dirW),
      pnlS.padStart(pnlW),
    ].join("  ");
  });

  return [header, sep, ...lines].join("\n");
}

export function formatPositions(
  mode: UIMode,
  list: Array<{ symbol: string; side: "long"|"short"; qty: number; avg: number; pnl: number }>
) {
  if (mode === "telegram") {
    if (!list.length) return monoBlock("Нет открытых позиций.");
    const compact = makeCompactPositionsTable(
      [...list]
        .sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
        .map(p => ({ symbol: p.symbol, side: p.side, pnl: Number(p.pnl) || 0 }))
    );
    return monoBlock(compact);
  }

  if (!list.length) {
    return lineBox(["Нет открытых позиций."], "POSITIONS");
  }

  const items = [...list].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
  const totalPnl = items.reduce((s, p) => s + (Number(p.pnl) || 0), 0);
  const totalPnlRaw = `${totalPnl > 0 ? "+" : ""}${totalPnl.toFixed(2)}$`;
  const totalPnlColored = totalPnl > 0 ? g(totalPnlRaw) : totalPnl < 0 ? r(totalPnlRaw) : totalPnlRaw;

  const symCol = items.map(p => shortSymbol(p.symbol));
  const sideColRaw = items.map(p => (p.side === "long" ? "L" : "S"));
  const qtyCol  = items.map(p => fix3(p.qty));
  const avgCol  = items.map(p => fix3(p.avg));
  const pnlRaw  = items.map(p => `${(Number(p.pnl)||0) >= 0 ? "+" : ""}${(Number(p.pnl)||0).toFixed(2)}$`);

  const symW  = Math.max(6, ...symCol.map(visLen));
  const sideW = 1;
  const qtyW  = Math.max(8, ...qtyCol.map(visLen));
  const avgW  = Math.max(8, ...avgCol.map(visLen));
  const pnlW  = Math.max(8, ...pnlRaw.map(s => s.length));

  const rows = items.map((p, idx) => {
    const sym = padVisEnd(symCol[idx], symW);
    const tagRaw = sideColRaw[idx];
    const tag = tagRaw === "L" ? g("L") : r("S");
    const tagPadded = padVisEnd(tag, sideW);

    const q   = padVisEnd(qtyCol[idx], qtyW);
    const avg = padVisEnd(avgCol[idx], avgW);

    const pnlSRaw = pnlRaw[idx];
    const pnlPadded = padVisStart(pnlSRaw, pnlW);
    const pnlColored = (Number(p.pnl)||0) > 0 ? g(pnlPadded) : (Number(p.pnl)||0) < 0 ? r(pnlPadded) : pnlPadded;

    return `${sym} ${tagPadded}  q=${q}  avg=${avg}  PnL=${pnlColored}`;
  });

  const head = [
    `count: ${items.length}`,
    `ΣPnL: ${totalPnlColored}`,
  ];
  const lines = [...head, ...rows];
  return lineBox(lines, "POSITIONS");
}

export function formatTasks(mode: UIMode, rows: Array<{ id:number; status:string; symbol:string; label:string; created:string; error?:string; entryPrices?:number[] }>) {
  if (!rows.length) return mode === "console" ? lineBox(["Нет активных задач."], "TASKS") : monoBlock("Нет активных задач.");
  // колонки: #id, status, symbol, created, label, prices
  const items = rows.map(r => ({
    id: r.id,
    status: r.status,
    symbol: shortSymbol(r.symbol).toUpperCase(),
    created: formatTime(r.created),
    label: r.label,
    err: r.error,
    prices: r.entryPrices,
  }));

  // Форматируем цены компактно
  const fmtPrices = (prices?: number[]) => {
    if (!prices || prices.length === 0) return "";
    if (prices.length === 1) return `@ ${prices[0]}`;
    return `@ ${prices.join(", ")}`;
  };

  if (mode === "telegram") {
    // Компактный стиль как в orders: группировка по символу, краткие строки
    const sorted = [...items].sort((a,b)=>{
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
      if (a.status !== b.status) return a.status.localeCompare(b.status);
      return a.id - b.id;
    });
    const ell = (s:string, max=64) => (s.length <= max ? s : (s.slice(0, max-1) + "…"));

    const out: string[] = [];
    let lastSym = "";
    for (const i of sorted) {
      if (i.symbol !== lastSym) {
        if (lastSym) out.push("");
        out.push(`▶ ${i.symbol}`);
        lastSym = i.symbol;
      }
      const warn = i.err ? " ⚠️" : "";
      const priceStr = fmtPrices(i.prices);
      out.push(
        `  #${i.id} ${i.status}${warn}`,
        `  ${i.created}`,
        `  ${ell(i.label)}${priceStr ? `\n  ${priceStr}` : ""}`
      );
      if (i.err) out.push(`  err: ${ell(String(i.err), 80)}`);
    }
    return monoBlock(out.join("\n"));
  }

  const lines = items.map(i => {
    const priceStr = fmtPrices(i.prices);
    return `#${i.id} [${i.status}] ${i.symbol}  ${i.created}  ${i.label}${priceStr ? ` ${priceStr}` : ""}${i.err?`  ERR:${i.err}`:""}`;
  });
  return lineBox(lines, "TASKS");
}

// ------ Пресеты ------
export function formatPreset(mode: UIMode, p: { name: string; risk: number; riskType?: "money" | "percent"; tp: number[]; ratio: number[]; isDefault?: boolean }) {
  const riskDisplay = p.riskType === "percent" ? `${p.risk}%` : `${p.risk.toFixed(2)}$`;
  const lines = [
    `name: ${p.name}${p.isDefault ? " (default)" : ""}`,
    `risk: ${riskDisplay}${p.riskType === "percent" ? " (от депозита)" : ""}`,
    `take_profit: [${p.tp.join(", ")}]`,
    `take_profit_ratio: [${p.ratio.join(", ")}]`,
  ];
  return mode === "console" ? lineBox(lines, "PRESET") : monoBlock(lines.join("\n"));
}

export function formatPresetList(mode: UIMode, list: Array<{ name: string; isDefault: boolean }>) {
  if (!list.length) return mode === "console" ? lineBox(["Пресетов нет."], "PRESETS") : monoBlock("Пресетов нет.");
  const lines = list.map(p => `${p.isDefault ? "★ " : "  "}${p.name}`);
  return mode === "console" ? lineBox(lines, "PRESETS") : monoBlock(lines.join("\n"));
}

// ------ Баннер (добавлено) ------
export function banner(mode: UIMode, main: string, sub?: string) {
  const mainLine = b(c(main));
  return mode === "console"
    ? lineBox([mainLine, ...(sub ? [dim(sub)] : [])], "SMART TRADE")
    : monoBlock(`SMART TRADE\n${main}${sub?`\n${sub}`:""}`);
}

// ===== НОВОЕ: формат таблицы ордеров =====
// Реальные типы ордеров Binance:
// LIMIT, MARKET, STOP, STOP_MARKET, TAKE_PROFIT, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET
export function formatOrders(
  mode: UIMode,
  rows: Array<{
    id: string;
    symbol: string;
    kind: string; // реальный тип ордера от биржи
    side: "buy" | "sell";
    qty: number;
    price?: number;
    stopPrice?: number;
    reduceOnly?: boolean;
    closePosition?: boolean;
    datetime?: string;
    status?: string;
  }>
) {
  if (!rows.length) {
    return mode === "console" ? lineBox(["Открытых ордеров нет."], "ORDERS") : monoBlock("Открытых ордеров нет.");
  }

  const items = rows.map(r => {
    // Определяем какую цену показывать:
    // - LIMIT: price
    // - STOP, STOP_MARKET, TAKE_PROFIT, TAKE_PROFIT_MARKET: stopPrice
    // - MARKET: нет цены
    let px: number | string = 0;
    const kindUpper = r.kind.toUpperCase();
    
    if (kindUpper === "LIMIT") {
      px = (r.price && r.price > 0) ? r.price : "-";
    } else if (kindUpper.includes("STOP") || kindUpper.includes("TAKE_PROFIT")) {
      px = (r.stopPrice && r.stopPrice > 0) ? r.stopPrice : "-";
    } else if (kindUpper === "MARKET") {
      px = "-"; // маркет не имеет цены
    } else {
      // Неизвестный тип - пытаемся найти любую цену
      px = (r.stopPrice && r.stopPrice > 0) ? r.stopPrice : (r.price && r.price > 0 ? r.price : "-");
    }
    
    return {
      id: r.id,
      sym: shortSymbol(r.symbol).toUpperCase(),
      kind: r.kind, // показываем реальный тип
      side: r.side.toLowerCase() === "buy" ? "B" : "S",
      qty: fix3(r.qty),
      px,
      ro: r.reduceOnly ? "RO" : "",
      cp: r.closePosition ? "CP" : "",
      dt: formatTime(r.datetime || ""),
      st: r.status || ""
    };
  });

  // Телеграм: карточки (устойчивые к узким экранам и эмодзи)
  if (mode === "telegram") {
    const sorted = [...items].sort((a,b)=>{
      if (a.sym !== b.sym) return a.sym.localeCompare(b.sym);
      if (a.kind !== b.kind) return a.kind === "STOP" ? -1 : 1; // STOP раньше LIMIT
      return String(a.dt||"").localeCompare(String(b.dt||""));
    });

    const out: string[] = [];
    let lastSym = "";
    for (const i of sorted) {
      if (i.sym !== lastSym) {
        if (lastSym) out.push("");
        out.push(`▶ ${i.sym}`);
        lastSym = i.sym;
      }
      const sideTagTxt = i.side === "B" ? "BUY" : "SELL";
      const flags = [i.ro, i.cp].filter(Boolean).join(",");
      out.push(
        `  ${i.kind} ${sideTagTxt}`,
        `  qty: ${i.qty}   px: ${i.px}`,
        (i.st || i.dt) ? `  ${i.st}${i.st && i.dt ? " • " : ""}${i.dt}` : `  `,
        `  id: ${i.id}${flags ? `   flags: ${flags}` : ""}`
      );
    }
    return monoBlock(out.join("\n"));
  }

  // Консоль: табличная версия
  const wId  = Math.max(10, ...items.map(i=>i.id.length));
  const wSym = Math.max(6, ...items.map(i=>i.sym.length));
  const wKind= 5;
  const wSide= 1;
  const wQty = Math.max(8, ...items.map(i=>i.qty.length));
  const wPx  = Math.max(10, ...items.map(i=>String(i.px).length));
  const wSt  = Math.max(6, ...items.map(i=>i.st.length));
  const header = [
    padVisEnd("id", wId),
    padVisEnd("symbol", wSym),
    padVisEnd("type", wKind),
    padVisEnd("S", wSide),
    padVisStart("qty", wQty),
    padVisStart("px/stop", wPx),
    padVisEnd("flags", 6),
    padVisEnd("status", wSt),
    "datetime"
  ].join("  ");
  const sep = "-".repeat(visLen(header));

  const lines = items.map(i => {
    const s = i.side === "B" ? g("B") : r("S");
    const flags = [i.ro, i.cp].filter(Boolean).join(",");
    return [
      padVisEnd(i.id, wId),
      padVisEnd(i.sym, wSym),
      padVisEnd(i.kind, wKind),
      padVisEnd(s, wSide),
      padVisStart(i.qty, wQty),
      padVisStart(String(i.px), wPx),
      padVisEnd(flags, 6),
      padVisEnd(i.st, wSt),
      i.dt
    ].join("  ");
  });

  return lineBox([header, sep, ...lines], "ORDERS");
}

// ===== НОВОЕ: детальная инфа по таске =====
export function formatTaskInfo(
  mode: UIMode,
  p: {
    id: number;
    status: string;
    symbol: string;
    label: string;
    createdAt: string;
    updatedAt: string;
    side?: "long"|"short";
    totalUsd?: number;
    presetName?: string;
    entryOrderIds?: string[];
    error?: string;
    plannedQty?: number;
    riskUsd?: number;
    entryPrices?: number[]; // ✅ НОВОЕ: цены входов
    entryDetails?: Array<{ id: string; type: string; price?: number; stopPrice?: number; qty?: number }>
  }
) {
  const fmtPrices = (prices?: number[]) => {
    if (!prices || prices.length === 0) return "-";
    return prices.join(", ");
  };
  
  const lines = [
    `id: ${p.id}`,
    `status: ${p.status}`,
    `symbol: ${p.symbol}`,
    `label: ${p.label}`,
    `created: ${formatTime(p.createdAt)}`,
    `updated: ${formatTime(p.updatedAt)}`,
    ...(p.side ? [`side: ${p.side}`] : []),
    ...(typeof p.totalUsd === "number" ? [`planned_usd: ${p.totalUsd}`] : []),
    ...(typeof p.plannedQty === "number" ? [`planned_qty: ${fix3(p.plannedQty)}`] : []),
    ...(typeof p.riskUsd === "number" ? [`risk_usd: ${p.riskUsd.toFixed(2)}`] : []),
    ...(p.presetName ? [`preset: ${p.presetName}`] : []),
    // ✅ НОВОЕ: показываем цены входов
    ...(p.entryPrices && p.entryPrices.length > 0 ? [`entry_prices: ${fmtPrices(p.entryPrices)}`] : []),
    `entries: ${(p.entryOrderIds||[]).join(", ") || "-"}`,
    ...(p.entryDetails && p.entryDetails.length
      ? ["", "entry details:", ...p.entryDetails.map(ed => `  #${ed.id} ${ed.type}` +
          (ed.qty ? ` q=${fix3(ed.qty)}` : "") +
          (typeof ed.price === "number" ? ` px=${ed.price}` : "") +
          (typeof ed.stopPrice === "number" ? ` stop=${ed.stopPrice}` : ""))]
      : []),
    ...(p.error ? [`error: ${p.error}`] : []),
  ];
  return mode === "console" ? lineBox(lines, "TASK INFO") : monoBlock(lines.join("\n"));
}

// ===== НОВОЕ: красивое уведомление о создании сделки =====
export function formatTradeNotification(p: {
  ticker: string;
  side: "long"|"short";
  riskUsd: number;
  legs: Array<{ usd: number; price: number; type: "LIMIT"|"STOP"|"MARKET" }>;
  takes: number[];
  takesRatio?: number[];
  preset: string;
  market?: boolean;
  noPreset?: boolean; // ✅ НОВОЕ: флаг отключения пресета
  // ✅ НОВОЕ: информация о существующих задачах и ордерах по монете
  existingTasks?: Array<{ id: number; status: string; side?: string; totalUsd?: number; entryPrice?: number }>;
  existingOrders?: Array<{ type: string; side: string; price?: number; qty?: number; stopPrice?: number; isEntry?: boolean; reduceOnly?: boolean; closePosition?: boolean }>;
}): string {
  const sideEmoji = p.side === "long" ? "🟢" : "🔴";
  const sideText = p.side === "long" ? "LONG" : "SHORT";
  
  let msg = `${sideEmoji} <b>${sideText} ${p.ticker.toUpperCase()}</b>\n\n`;
  
  // ✅ НОВОЕ: Если пресеты отключены - показываем "-" и предупреждение
  if (p.noPreset) {
    msg += `⚙️ <b>Preset:</b> - (БЕЗ авто SL/TP)\n`;
    msg += `⚠️ <i>Стопы и тейки НЕ будут выставлены автоматически</i>\n\n`;
  } else {
    msg += `📊 <b>Risk:</b> $${formatUsd(p.riskUsd)}\n`;
    msg += `⚙️ <b>Preset:</b> ${p.preset}\n\n`;
  }
  
  // Входы
  if (p.market) {
    const totalUsd = p.legs.reduce((sum, leg) => sum + leg.usd, 0);
    msg += `💰 <b>Volume:</b> $${formatUsd(totalUsd)} (MARKET)\n\n`;
  } else {
    msg += `💰 <b>Входы:</b>\n`;
    p.legs.forEach((leg, idx) => {
      const typeEmoji = leg.type === "LIMIT" ? "📌" : leg.type === "STOP" ? "🛑" : "⚡";
      msg += `  ${typeEmoji} ${leg.type} #${idx + 1}: $${formatUsd(leg.usd)} @ ${leg.price}\n`;
    });
    msg += `\n`;
  }
  
  // ✅ НОВОЕ: Тейки показываем только если пресеты не отключены
  if (!p.noPreset) {
    msg += `🎯 <b>Takes:</b> ${p.takes.map(t => `${t}R`).join(", ")}\n`;
    if (p.takesRatio && p.takesRatio.length > 0) {
      msg += `   <i>Распределение: ${p.takesRatio.map(r => `${r}%`).join(", ")}</i>\n`;
    }
  }
  
  // ✅ НОВОЕ: Показываем существующие задачи по монете
  if (p.existingTasks && p.existingTasks.length > 0) {
    msg += `\n⚠️ <b>Существующие задачи по ${p.ticker.toUpperCase()}:</b>\n`;
    for (const t of p.existingTasks) {
      const sideIcon = t.side === "long" ? "🟢" : t.side === "short" ? "🔴" : "⚪";
      const usdInfo = t.totalUsd ? ` ($${formatUsd(t.totalUsd)})` : "";
      const priceInfo = t.entryPrice ? ` @ ${t.entryPrice}` : "";
      msg += `  ${sideIcon} #${t.id} [${t.status}]${usdInfo}${priceInfo}\n`;
    }
  }
  
  // ✅ НОВОЕ: Показываем существующие ордера по монете
  if (p.existingOrders && p.existingOrders.length > 0) {
    msg += `\n📋 <b>Открытые ордера по ${p.ticker.toUpperCase()}:</b>\n`;
    for (const o of p.existingOrders) {
      const typeEmoji = o.type.includes("STOP") ? "🛑" : o.type.includes("LIMIT") ? "📌" : "⚪";
      const sideIcon = o.side === "buy" ? "🟢" : "🔴";
      const priceInfo = o.stopPrice ? `@ ${o.stopPrice}` : (o.price ? `@ ${o.price}` : "");
      const qtyInfo = o.qty ? ` (qty: ${o.qty.toFixed(4)})` : "";
      
      // ✅ ИСПРАВЛЕНО: Правильная логика определения типа ордера
      let label = "";
      if (o.isEntry) {
        label = " [entry]";
      } else if (o.reduceOnly || o.closePosition) {
        // Это exit-ордер (SL или TP)
        if (o.stopPrice || o.type.includes("STOP")) {
          label = " [SL]";
        } else {
          label = " [TP]";
        }
      }
      // Если нет reduceOnly/closePosition и не entry - это ручной ордер, без label
      
      msg += `  ${typeEmoji}${sideIcon} ${o.type}${label}: ${priceInfo}${qtyInfo}\n`;
    }
  }
  
  return msg;
}