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

function lineBox(lines: string[], title?: string): string {
  const width = Math.max(...lines.map(l => l.length), (title?.length ?? 0) + 2, 28);
  const top = "┌" + (title ? `─ ${title} ` : "─") + "─".repeat(Math.max(0, width - (title ? title.length + 2 : 1))) + "┐";
  const body = lines.map(l => "│ " + l.padEnd(width, " ") + " │").join("\n");
  const bot = "└" + "─".repeat(width + 2) + "┘";
  return `${top}\n${body}\n${bot}`;
}

function monoBlock(s: string): string { return `<pre>${escapeHtml(s)}</pre>`; }
function escapeHtml(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

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
  }
) {
  const lines = [
    `total: ${p.total.toFixed(2)}  free: ${p.free.toFixed(2)}  used: ${p.used.toFixed(2)}`,
    `unrealized: ${fmtPnl(mode, p.unreal)}`,
  ];
  if (typeof p.spotTotal === "number") {
    lines.push(
      `spot: total=${(p.spotTotal ?? 0).toFixed(2)}  free=${(p.spotFree ?? 0).toFixed(2)}  used=${(p.spotUsed ?? 0).toFixed(2)}`
    );
  }
  if (typeof p.grandTotal === "number") {
    lines.push(`spot+perp total: ${(p.grandTotal ?? 0).toFixed(2)}`);
  }
  return mode === "console" ? lineBox(lines, "DEPOSIT (USDT)") : monoBlock(lines.join("\n"));
}

/**
 * Обновлённый компактный вывод позиций:
 * - Аккуратная таблица с заголовком: Sym | S | Qty | Avg | PnL
 * - Для Telegram — моноширинный блок, PnL с эмодзи цвета; для консоли — цвет ANSI
 * - ΣPnL и количество позиций — в заголовке таблицы
 */
export function formatPositions(
  mode: UIMode,
  list: Array<{ symbol: string; side: "long"|"short"; qty: number; avg: number; pnl: number }>
) {
  if (!list.length) {
    return mode === "console"
      ? lineBox(["Нет открытых позиций."], "POSITIONS")
      : monoBlock("Нет открытых позиций.");
  }

  // сортируем по PnL убыв.
  const items = [...list].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
  const totalPnl = items.reduce((s, p) => s + (Number(p.pnl) || 0), 0);

  // колонки
  const header = ["Sym", "S", "Qty", "Avg", "PnL"];
  const rows = items.map(p => {
    const sym = shortSymbol(p.symbol).slice(0, 10); // компакт
    const side = sideTag(mode, p.side);
    const qty = fix3(p.qty);
    const avg = fix3(p.avg);
    const pnl = fmtPnl(mode, Number(p.pnl) || 0);
    return [sym, side, qty, avg, pnl];
  });

  // ширины столбцов (кроме PnL — он цветной/эмодзи, не выравниваем жёстко)
  const colWidths = [0, 0, 0, 0].map((_, i) =>
    Math.max(header[i].length, ...rows.map(r => r[i].length))
  );

  const pad = (s: string, w: number) => s.padEnd(w, " ");

  const lines: string[] = [];
  // шапка с итого
  lines.push(`count: ${items.length}   ΣPnL: ${fmtPnl(mode, totalPnl)}`);
  // заголовок таблицы
  const headLine =
    pad(header[0], colWidths[0]) + "  " +
    pad(header[1], colWidths[1]) + "  " +
    pad(header[2], colWidths[2]) + "  " +
    pad(header[3], colWidths[3]) + "  " +
    header[4];
  lines.push(headLine);
  lines.push("-".repeat(Math.max(headLine.length, 28)));

  // строки таблицы
  for (const r of rows) {
    const line =
      pad(r[0], colWidths[0]) + "  " +
      pad(r[1], colWidths[1]) + "  " +
      pad(r[2], colWidths[2]) + "  " +
      pad(r[3], colWidths[3]) + "  " +
      r[4]; // PnL как есть (цвет/эмодзи уже внутри fmtPnl)
    lines.push(line);
  }

  return mode === "console"
    ? lineBox(lines, "POSITIONS")
    : monoBlock(lines.join("\n"));
}

export function formatTasks(mode: UIMode, rows: Array<{ id:number; status:string; symbol:string; label:string; agoSec:number; error?:string }>) {
  if (!rows.length) return mode === "console" ? lineBox(["Нет активных задач."], "TASKS") : monoBlock("Нет активных задач.");
  const lines = rows.map(t => `#${t.id} [${t.status}] ${t.symbol}  (+${t.agoSec}s)${t.error?` ERR:${t.error}`:""}`);
  return mode === "console" ? lineBox(lines, "TASKS") : monoBlock(lines.join("\n"));
}

export function banner(mode: UIMode, main: string, sub?: string) {
  return mode === "console"
    ? lineBox([b(c(main)), ...(sub ? [dim(sub)] : [])], "SMART TRADE")
    : monoBlock(`SMART TRADE\n${main}${sub?`\n${sub}`:""}`);
}

// ------ НОВОЕ: форматтеры пресетов ------
export function formatPreset(mode: UIMode, p: { name: string; risk: number; tp: number[]; ratio: number[]; isDefault?: boolean }) {
  const lines = [
    `name: ${p.name}${p.isDefault ? " (default)" : ""}`,
    `risk: ${p.risk.toFixed(2)}$`,
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
