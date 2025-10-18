export function normalizeTickerToUsdt(ticker: string): { base: string; symbolCcxt: string } {
  const t = ticker.trim().toUpperCase();
  const base = t.endsWith("USDT") ? t.replace(/USDT$/, "") : t;
  return { base, symbolCcxt: `${base}/USDT:USDT` };
}
