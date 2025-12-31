/**
 * NATR (Normalized ATR) Calculator
 * Интегрировано из https://github.com/arrow767/risk-calculator
 */

import { BinanceFutures } from "../exch/BinanceFutures";

// ============ КОНФИГ (можно вынести в .env) ============
export interface NatrConfig {
  k: number;        // σ multiplier (default: 1)
  limitMul: number; // winsorize limit (default: 10)
  coef: number;     // coefficient for volume calc (default: 1.1)
  interval: string; // timeframe (default: "1h")
}

export const DEFAULT_NATR_CONFIG: NatrConfig = {
  k: Number(process.env.NATR_K || 1),
  limitMul: Number(process.env.NATR_LIMIT_MUL || 10),
  coef: Number(process.env.NATR_COEF || 1.1),
  interval: process.env.NATR_INTERVAL || "1h",
};

// ============ РАСЧЁТ NATR ============

interface OhlcvData {
  highs: number[];
  lows: number[];
  closes: number[];
}

/**
 * Получить OHLCV данные с Binance Futures
 */
async function fetchOhlcv(
  symbol: string,
  interval: string,
  requiredBars: number
): Promise<OhlcvData> {
  const baseUrl = "https://fapi.binance.com/fapi/v1/klines";
  const BATCH_LIMIT = 1000;
  let all: any[][] = [];
  let endTime: number | undefined;

  // Нормализуем символ: XRP → XRPUSDT
  const binanceSymbol = symbol
    .replace("/USDT:USDT", "")
    .replace("/USDT", "")
    .replace(":USDT", "")
    .toUpperCase() + "USDT";

  while (all.length < requiredBars) {
    const batchSize = Math.min(BATCH_LIMIT, requiredBars - all.length);
    const params = new URLSearchParams({
      symbol: binanceSymbol,
      interval,
      limit: String(batchSize),
    });
    if (endTime) params.set("endTime", String(endTime));

    const res = await fetch(`${baseUrl}?${params}`);
    if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
    
    const data = await res.json();
    if (!data.length) break;
    
    all = data.concat(all);
    endTime = data[0][0] - 1;
  }

  const slice = all.slice(-requiredBars);
  return {
    highs: slice.map((k: any) => +k[2]),
    lows: slice.map((k: any) => +k[3]),
    closes: slice.map((k: any) => +k[4]),
  };
}

/**
 * Simple Moving Average
 */
function sma(arr: number[], idx: number, period: number): number {
  let sum = 0;
  for (let j = idx - period + 1; j <= idx; j++) {
    if (isNaN(arr[j]) || arr[j] === undefined) return NaN;
    sum += arr[j];
  }
  return sum / period;
}

/**
 * Standard Deviation
 */
function stdev(arr: number[], idx: number, period: number): number {
  const mean = sma(arr, idx, period);
  if (isNaN(mean)) return NaN;

  let sq = 0;
  for (let j = idx - period + 1; j <= idx; j++) {
    if (isNaN(arr[j]) || arr[j] === undefined) return NaN;
    const d = arr[j] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / period);
}

/**
 * Расчёт Robust Threshold (NATR с winsorization и double SMA)
 */
function calcRobustThr(
  highs: number[],
  lows: number[],
  closes: number[],
  L: number,
  k: number,
  limitMul: number
): { thr: number[]; thrAdj: number[] } {
  const n = closes.length;

  const n1 = Array<number>(n).fill(NaN);
  const mu0_1 = Array<number>(n).fill(NaN);
  const mu0_2 = Array<number>(n).fill(NaN);
  const n1w = Array<number>(n).fill(NaN);
  const mu1 = Array<number>(n).fill(NaN);
  const mu2 = Array<number>(n).fill(NaN);
  const thr = Array<number>(n).fill(NaN);
  const thrAdj = Array<number>(n).fill(NaN);

  // 1) NATR = (TR / Close) * 100
  for (let i = 0; i < n; i++) {
    if (
      isNaN(highs[i]) || isNaN(lows[i]) || isNaN(closes[i]) ||
      closes[i] <= 0 ||
      (i > 0 && (isNaN(closes[i - 1]) || closes[i - 1] <= 0))
    ) continue;

    const tr = i === 0
      ? highs[0] - lows[0]
      : Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
    n1[i] = (tr / closes[i]) * 100;
  }

  // 2) Double SMA for mu0_2
  for (let i = L - 1; i < n; i++) mu0_1[i] = sma(n1, i, L);
  for (let i = 2 * L - 2; i < n; i++) mu0_2[i] = sma(mu0_1, i, L);

  // 3) Winsorize
  for (let i = 0; i < n; i++) {
    const v = n1[i];
    const m02 = mu0_2[i];
    n1w[i] = isNaN(m02) || isNaN(v) || m02 <= 0 ? v : Math.min(v, m02 * limitMul);
  }

  // 4) Double SMA for mu2
  for (let i = 2 * L - 2; i < n; i++) mu1[i] = sma(n1w, i, L);
  for (let i = 3 * L - 3; i < n; i++) mu2[i] = sma(mu1, i, L);

  // 5) Threshold с σ adjustment
  for (let i = 3 * L - 3; i < n; i++) {
    const base = mu2[i];
    if (isNaN(base)) continue;
    const sigma = stdev(n1w, i, L);
    if (isNaN(sigma)) continue;
    thr[i] = base + k * sigma;
    thrAdj[i] = thr[i] * 0.85 * 2; // как в оригинальном скрипте
  }

  return { thr, thrAdj };
}

/**
 * Получить последнее значение NATR для заданного периода L
 */
async function getLastNatr(
  symbol: string,
  L: number,
  config: NatrConfig
): Promise<{ natr: number; natrAdj: number }> {
  const requiredBars = L * 3 + 10; // немного с запасом
  const { highs, lows, closes } = await fetchOhlcv(symbol, config.interval, requiredBars);
  
  if (highs.length < requiredBars) {
    throw new Error(`Недостаточно данных для ${symbol} (нужно ${requiredBars} баров)`);
  }

  const { thr, thrAdj } = calcRobustThr(highs, lows, closes, L, config.k, config.limitMul);
  
  // Найти последнее валидное значение
  let lastI = -1;
  for (let i = thr.length - 1; i >= 0; i--) {
    if (!isNaN(thr[i])) {
      lastI = i;
      break;
    }
  }
  
  if (lastI < 0) {
    throw new Error(`Не удалось рассчитать NATR для ${symbol}`);
  }

  return { natr: thr[lastI], natrAdj: thrAdj[lastI] };
}

// ============ РЕЗУЛЬТАТ КАЛЬКУЛЯТОРА ============

export interface NatrResult {
  symbol: string;
  price: number;
  risk: number;
  coef: number;
  
  // L=100
  natr100: number;
  natrCoef100: number;
  volume100: number;
  
  // L=300
  natr300: number;
  natrCoef300: number;
  volume300: number;
  
  // Дополнительно
  thr85_100: number;
  thr2_85_100: number;
  thr85_300: number;
  thr2_85_300: number;
}

/**
 * Основная функция калькулятора
 */
export async function calculateRisk(
  ex: BinanceFutures,
  ticker: string,
  riskUsd: number,
  config: NatrConfig = DEFAULT_NATR_CONFIG
): Promise<NatrResult> {
  // Нормализуем тикер
  const symbolCcxt = ticker.toUpperCase().includes("USDT") 
    ? ticker.toUpperCase() 
    : ticker.toUpperCase() + "/USDT:USDT";
  
  // Получаем текущую цену
  const tickerData = await ex.fetchTicker(symbolCcxt);
  const price = Number(tickerData.last) || 0;
  if (price <= 0) throw new Error(`Не удалось получить цену для ${ticker}`);

  // Параллельно получаем NATR для L=100 и L=300
  const [result100, result300] = await Promise.all([
    getLastNatr(ticker, 100, config),
    getLastNatr(ticker, 300, config),
  ]);

  const { coef } = config;

  // Расчёты для L=100
  const natr100 = result100.natr;
  const natrCoef100 = natr100 * coef;
  const volume100 = natrCoef100 > 0 ? (riskUsd * 100) / natrCoef100 : 0;
  const thr85_100 = natr100 * 1 * 0.85;
  const thr2_85_100 = natr100 * 2 * 0.85;

  // Расчёты для L=300
  const natr300 = result300.natr;
  const natrCoef300 = natr300 * coef;
  const volume300 = natrCoef300 > 0 ? (riskUsd * 100) / natrCoef300 : 0;
  const thr85_300 = natr300 * 1 * 0.85;
  const thr2_85_300 = natr300 * 2 * 0.85;

  return {
    symbol: symbolCcxt,
    price,
    risk: riskUsd,
    coef,
    natr100,
    natrCoef100,
    volume100,
    natr300,
    natrCoef300,
    volume300,
    thr85_100,
    thr2_85_100,
    thr85_300,
    thr2_85_300,
  };
}

// ============ ФОРМАТИРОВАНИЕ ============

/**
 * Форматирование результата для консоли
 */
export function formatNatrResultConsole(r: NatrResult): string {
  const fmt = (n: number, d = 4) => n.toFixed(d);
  const fmtVol = (n: number) => Math.round(n).toLocaleString("ru-RU");
  const fmtPrice = (n: number) => n < 1 ? n.toPrecision(5) : fmt(n, 2);

  return `
┌─ RISK CALCULATOR ────────────────────────┐
│ ${r.symbol.replace("/USDT:USDT", "")}  Price: ${fmtPrice(r.price)}
│ Risk: $${r.risk}  Coef: ${r.coef}
├──────────────────────────────────────────┤
│ L=100                                    │
│   NATR:      ${fmt(r.natr100)}%
│   NATR×coef: ${fmt(r.natrCoef100)}%
│   ×1×0.85:   ${fmt(r.thr85_100)}%
│   ×2×0.85:   ${fmt(r.thr2_85_100)}%
│   Volume:    ${fmtVol(r.volume100)}
├──────────────────────────────────────────┤
│ L=300                                    │
│   NATR:      ${fmt(r.natr300)}%
│   NATR×coef: ${fmt(r.natrCoef300)}%
│   ×1×0.85:   ${fmt(r.thr85_300)}%
│   ×2×0.85:   ${fmt(r.thr2_85_300)}%
│   Volume:    ${fmtVol(r.volume300)}
└──────────────────────────────────────────┘`.trim();
}

/**
 * Форматирование результата для Telegram (с возможностью копирования)
 */
export function formatNatrResultTelegram(r: NatrResult): string {
  const fmt = (n: number, d = 4) => n.toFixed(d);
  const fmtVol = (n: number) => Math.round(n).toLocaleString("ru-RU");
  const fmtPrice = (n: number) => n < 1 ? n.toPrecision(5) : fmt(n, 2);
  const shortSym = r.symbol.replace("/USDT:USDT", "").replace("/USDT", "");

  return `<b>📊 RISK CALCULATOR</b>

<b>${shortSym}</b>  💰 Price: <code>${fmtPrice(r.price)}</code>
Risk: <b>$${r.risk}</b>  Coef: ${r.coef}

<b>━━━ L=100 ━━━</b>
NATR: ${fmt(r.natr100)}%
NATR×coef: ${fmt(r.natrCoef100)}%
×1×0.85: ${fmt(r.thr85_100)}%
×2×0.85: ${fmt(r.thr2_85_100)}%
📦 Volume: <code>${fmtVol(r.volume100)}</code>

<b>━━━ L=300 ━━━</b>
NATR: ${fmt(r.natr300)}%
NATR×coef: ${fmt(r.natrCoef300)}%
×1×0.85: ${fmt(r.thr85_300)}%
×2×0.85: ${fmt(r.thr2_85_300)}%
📦 Volume: <code>${fmtVol(r.volume300)}</code>`;
}

