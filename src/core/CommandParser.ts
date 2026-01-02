import { ParsedCmd, TradeLeg, DEFAULT_PRESET } from "./types";
import { normalizeTickerToUsdt } from "./SymbolResolver";

/**
 * Парсинг строки CSV чисел
 */
function parseNumsCSV(s?: string): number[] | undefined {
  if (!s) return undefined;
  const parts = s.split(/[,\s]+/).filter(Boolean);
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  return nums;
}

function parseNumberToken(s?: string): number {
  if (!s) return NaN;
  const raw = String(s).replace(/_/g, "").trim().replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

// Парсинг объёма USD с суффиксами k/m/kk и разделителями '_'
function parseHumanUsd(s?: string): number {
  if (!s) return NaN;
  const raw = String(s).replace(/_/g, "").trim();
  const isKK = /(kk|кк)$/i.test(raw);
  const isK = /([kк])$/i.test(raw);
  const isM = /([mм])$/i.test(raw);
  const numStr = raw.replace(/(kk|кк|k|к|m|м)$/i, "");
  const base = parseNumberToken(numStr);
  if (!Number.isFinite(base)) return NaN;
  if (isKK || isM) return base * 1_000_000;
  if (isK) return base * 1_000;
  return base;
}

/**
 * Парсинг командной строки
 */
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

  // ✅ НОВОЕ: Risk Calculator - r <ticker> <risk> [coef] или calc <ticker> <risk> [coef]
  const cmdLower = (p[0] || "").toLowerCase();
  if ((cmdLower === "r" || cmdLower === "calc" || cmdLower === "risk") && p[1]) {
    const ticker = p[1].toUpperCase();
    const riskStr = p[2];
    const risk = riskStr ? parseHumanUsd(riskStr) : NaN;
    // Опциональный коэффициент (поддержка точки и запятой)
    const coefStr = p[3];
    const coef = coefStr ? parseNumberToken(coefStr) : undefined;
    console.log(`[PARSER DEBUG] r/calc: p=[${p.join(", ")}], coefStr="${coefStr}", coef=${coef}`);
    if (!Number.isFinite(risk) || risk <= 0) {
      // Если риск не указан - вернём с NaN, обработчик покажет ошибку
      return { kind: "risk_calc", ticker, risk: NaN, coef: undefined };
    }
    const finalCoef = Number.isFinite(coef) && coef! > 0 ? coef : undefined;
    console.log(`[PARSER DEBUG] returning coef=${finalCoef}`);
    return { kind: "risk_calc", ticker, risk, coef: finalCoef };
  }

  // Поддержка ручного риска в начале: "50 l xrp ...", "50$ l ...", или "1% l xrp ..."
  let riskOverride: number | undefined;
  let riskPercentOverride: number | undefined; // ✅ НОВОЕ: риск в % от депозита
  let idx = 0;
  const first = p[0];
  
  // Проверяем на % риск (1%, 0.5%, 2,5%)
  const percentMatch = first?.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
  if (percentMatch) {
    const pctValue = parseNumberToken(percentMatch[1]);
    if (Number.isFinite(pctValue) && pctValue > 0) {
      riskPercentOverride = pctValue;
      idx = 1;
    }
  } else {
    // Проверяем на $ риск (50, 50$)
    const mRisk = first && /^\d+(?:[.,]\d+)?\$?$/.test(first) ? parseNumberToken(first.replace(/\$/g, "")) : NaN;
    if (Number.isFinite(mRisk)) {
      riskOverride = Number(mRisk);
      idx = 1;
    }
  }

  const cmd = (p[idx] || "").toLowerCase();

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
      // ✅ НОВОЕ: risk_type=money|percent
      const riskTypeRaw = kv.get("risk_type") || kv.get("risktype") || kv.get("type");
      const riskType = riskTypeRaw === "percent" || riskTypeRaw === "%" ? "percent" : (riskTypeRaw === "money" || riskTypeRaw === "$" ? "money" : undefined);
      const tp = parseNumsCSV(kv.get("tp") || kv.get("take_profit"));
      const ratio = parseNumsCSV(kv.get("ratio") || kv.get("take_profit_ratio"));
      const makeDefault = kv.get("default") === "1" || kv.get("default") === "true";
      const makeDefaultLong =
        kv.get("default_long") === "1" || kv.get("default_long") === "true" ||
        kv.get("default_l") === "1" || kv.get("default_l") === "true";
      const makeDefaultShort =
        kv.get("default_short") === "1" || kv.get("default_short") === "true" ||
        kv.get("default_s") === "1" || kv.get("default_s") === "true";
      return { kind: "preset_set", name, risk, riskType, tp, ratio, makeDefault, makeDefaultLong, makeDefaultShort };
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
  if (cmd === "cancel" && p[1]) {
    // ✅ НОВОЕ: Если аргумент — число, отменяем по ID. Иначе — по тикеру.
    const arg = p[1];
    if (/^\d+$/.test(arg)) {
      return { kind: "cancel", id: Number(arg) };
    } else {
      // cancel xrp → отменить все задачи по XRP
      const { symbolCcxt } = normalizeTickerToUsdt(arg);
      return { kind: "cancel_ticker", symbol: symbolCcxt };
    }
  }
  if (cmd === "cancel-all") return { kind: "cancel_all" };
  if (cmd === "close" && p[idx+1]) {
    const symbol = p[idx+1];
    const percent = p[idx+2] ? Math.max(0, Math.min(100, Number(p[idx+2]))) : 100;
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
    while (i + 1 < p.length && Number.isFinite(parseHumanUsd(p[i])) && Number.isFinite(parseNumberToken(p[i + 1]))) {
      const usd = parseHumanUsd(p[i]);
      const price = parseNumberToken(p[i + 1]);
      if (usd > 0 && price > 0) legs.push({ usd, price });
      i += 2;
    }
    if (!Number.isFinite(id) || legs.length === 0) return null;
    return { kind: "edit", id, dir, rawTicker, legs };
  }

  // --- торги ---
  if (!["l", "s"].includes(cmd)) return null;

  const rawTicker = p[idx+1];
  if (!rawTicker) return null;

  // MARKET-вход с авто-объёмом: l <sym> a [preset|-]
  // НО: если после `a` идёт число (цена), это ОТЛОЖКА, не маркет!
  const marketAutoToken = p[idx+2]?.toLowerCase();
  const marketAutoMatch = marketAutoToken?.match(/^(a|auto)(?:-(\d+(?:[.,]\d+)?))?$/);
  const nextTokenAfterAuto = p[idx+3];
  const nextIsPrice = nextTokenAfterAuto && Number.isFinite(parseNumberToken(nextTokenAfterAuto)) && parseNumberToken(nextTokenAfterAuto) > 0;
  
  if (marketAutoMatch && !nextIsPrice) {
    // Маркет с авто-объёмом (нет цены после `a`)
    const autoCoef = marketAutoMatch[2] ? parseNumberToken(marketAutoMatch[2]) : undefined;
    const presetArg = p[idx+3] || DEFAULT_PRESET;
    const noPreset = presetArg === "-" || presetArg === "—";
    const presetName = noPreset ? DEFAULT_PRESET : presetArg;
    return {
      kind: "trade",
      dir: cmd as "l" | "s",
      rawTicker,
      legs: [],
      market: { usd: 0, auto: true, autoCoef: Number.isFinite(autoCoef) && autoCoef! > 0 ? autoCoef : undefined },
      presetName,
      presetAuto: !p[idx+3],
      dryRun: false,
      riskUsdOverride: riskOverride,
      riskPercentOverride,
      noPreset,
    };
  }

  // MARKET-вход краткий: l <sym> <usd> [preset|-]
  if (p.length >= idx+3 && Number.isFinite(parseHumanUsd(p[idx+2])) && (p.length === idx+3 || Number.isNaN(parseNumberToken(p[idx+3])))) {
    const usd = parseHumanUsd(p[idx+2]);
    const presetAuto = p.length === idx + 3;
    const presetArg = p[idx+3] || DEFAULT_PRESET;
    const noPreset = presetArg === "-" || presetArg === "—"; // дефис или тире
    const presetName = noPreset ? DEFAULT_PRESET : presetArg;
    return {
      kind: "trade",
      dir: cmd as "l" | "s",
      rawTicker,
      legs: [],
      market: { usd },
      presetName,
      presetAuto,
      dryRun: false,
      riskUsdOverride: riskOverride,
      riskPercentOverride, // ✅ НОВОЕ: риск в % от депозита
      noPreset,
    };
  }

  const legs: TradeLeg[] = [];
  let i = idx+2;
  
  // Проверяем auto-режим: a, auto, a-0.85, auto-0.85
  const autoToken = p[i]?.toLowerCase();
  const autoMatch = autoToken?.match(/^(a|auto)(?:-(\d+(?:[.,]\d+)?))?$/);
  
  if (autoMatch && p[i + 1]) {
    // Auto mode: a <price> или a-0.85 <price>
    const autoCoef = autoMatch[2] ? parseNumberToken(autoMatch[2]) : undefined;
    const price = parseNumberToken(p[i + 1]);
    if (price > 0) {
      // usd будет расчитан позже через NATR, пока ставим 0
      legs.push({ 
        usd: 0, 
        price, 
        auto: true, 
        autoCoef: Number.isFinite(autoCoef) && autoCoef! > 0 ? autoCoef : undefined 
      });
      i += 2;
    }
  } else {
    // Обычный режим: <usd> <price> pairs
    while (i + 1 < p.length && Number.isFinite(parseHumanUsd(p[i])) && Number.isFinite(parseNumberToken(p[i + 1]))) {
      const usd = parseHumanUsd(p[i]);
      const price = parseNumberToken(p[i + 1]);
      if (usd > 0 && price > 0) legs.push({ usd, price });
      i += 2;
    }
  }
  
  if (legs.length === 0) return null;

  let presetName = DEFAULT_PRESET;
  let dryRun = false;
  let noPreset = false; // ✅ НОВОЕ
  let presetAuto = true;
  
  for (; i < p.length; i++) {
    const tok = p[i].toLowerCase();
    if (tok === "--dry") {
      dryRun = true;
      continue;
    }
    // ✅ НОВОЕ: проверка на "-" или тире для отключения пресета
    if (tok === "-" || tok === "—") {
      noPreset = true;
      continue;
    }
    presetName = p[i];
    presetAuto = false;
  }

  return { kind: "trade", dir: cmd as "l" | "s", rawTicker, legs, presetName, presetAuto, dryRun, market: null, riskUsdOverride: riskOverride, riskPercentOverride, noPreset };
}
