import 'dotenv/config';
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
}

main().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});


