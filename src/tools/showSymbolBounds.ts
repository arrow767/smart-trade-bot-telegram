import 'dotenv/config';
import ccxt from 'ccxt';
import { BinanceFutures } from '../exch/BinanceFutures';
import { normalizeTickerToUsdt } from '../core/SymbolResolver';

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('Usage: tsx src/tools/showSymbolBounds.ts <symbol>');
    process.exit(1);
  }

  const { symbolCcxt } = normalizeTickerToUsdt(raw);
  const ex = new BinanceFutures();
  await ex.loadMarkets().catch(() => {});
  ex.market(symbolCcxt);

  const tick = await ex.fetchTicker(symbolCcxt);
  const price = Number(tick.last ?? tick.mark ?? tick.info?.markPrice);
  const f: any = ex.getSymbolFilters(symbolCcxt);

  const minQty = Number(f.minQty);
  const stepSize = Number(f.stepSize);
  const tickSize = Number(f.tickSize);
  const maxQty = f.maxQty != null ? Number(f.maxQty) : undefined;
  const minNotional = f.minNotional != null ? Number(f.minNotional) : undefined;

  const minUsd = Math.max((minQty || 0) * price, minNotional || 0);
  const maxUsd = maxQty != null ? maxQty * price : NaN;

  console.log(`Symbol: ${symbolCcxt}`);
  console.log(`Price: ${price}`);
  console.log(`minQty=${minQty}, stepSize=${stepSize}, tickSize=${tickSize}`);
  console.log(`maxQty=${maxQty ?? '-'}, minNotional=${minNotional ?? '-'}`);
  console.log(`minUsd@price=${minUsd}${Number.isFinite(maxUsd) ? `, maxUsd@price=${maxUsd}` : ''}`);

  // Leverage brackets (tiers)
  try {
    const fapi = new (ccxt as any).binanceusdm({
      apiKey: process.env.BINANCE_API_KEY || process.env.BINANCE_KEY,
      secret: process.env.BINANCE_API_SECRET || process.env.BINANCE_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
    await fapi.loadMarkets();
    const m = fapi.market(symbolCcxt);
    // Raw signed endpoint
    const data = await (fapi as any).fapiPrivateGetLeverageBracket({ symbol: m.id });
    const rec = Array.isArray(data) ? data.find((x: any) => x?.symbol === m.id) || data[0] : data;
    const brackets = rec?.brackets || rec?.[0]?.brackets || [];
    if (Array.isArray(brackets) && brackets.length) {
      console.log('Leverage tiers:');
      for (const b of brackets) {
        const cap = Number(b.notionalCap);
        const lev = Number(b.initialLeverage);
        const floor = Number(b.notionalFloor);
        const mmr = Number(b.maintMarginRatio);
        const capStr = cap > 0 && Number.isFinite(cap) ? cap.toString() : '∞';
        console.log(`  ${floor} .. ${capStr} USD → maxLev=${lev}, maintMarginRatio=${mmr}`);
      }
    } else {
      console.log('Leverage tiers: unavailable');
    }
  } catch (e: any) {
    console.log('Leverage tiers: error', e?.message || e);
  }
}

main().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});


