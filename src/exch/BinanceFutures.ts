import ccxt from "ccxt";

export type SymbolFilters = {
  minQty: number;
  stepSize: number;
  tickSize: number;
};

function readEnv(key: string, ...alts: string[]): string | undefined {
  for (const k of [key, ...alts]) {
    const v = (process.env as any)[k];
    if (v && String(v).length > 0) return String(v);
  }
  return undefined;
}

export class BinanceFutures {
  private fapi: ccxt.binanceusdm;
  private sapi?: ccxt.binance; // spot client (лениво)
  private apiKey?: string;
  private secret?: string;

  constructor(opts?: { apiKey?: string; secret?: string; enableRateLimit?: boolean }) {
    // допускаем отсутствие opts: возьмём из env
    this.apiKey = opts?.apiKey ?? readEnv("BINANCE_API_KEY", "BINANCE_KEY");
    this.secret = opts?.secret ?? readEnv("BINANCE_API_SECRET", "BINANCE_SECRET");

    this.fapi = new ccxt.binanceusdm({
      apiKey: this.apiKey,
      secret: this.secret,
      enableRateLimit: opts?.enableRateLimit ?? true,
      options: { defaultType: "future" },
    } as any);
  }

  // ——— общая проверка наличия ключей перед приватными вызовами ———
  private ensureKeysOrThrow() {
    if (!this.apiKey || !this.secret) {
      throw new Error(
        "Binance API keys are missing. Set BINANCE_API_KEY and BINANCE_API_SECRET (или передайте их в конструктор)."
      );
    }
  }

  // Лениво создаём спотовый клиент с теми же ключами
  private ensureSpot() {
    if (!this.sapi) {
      this.sapi = new ccxt.binance({
        apiKey: this.apiKey,
        secret: this.secret,
        enableRateLimit: true,
        options: { defaultType: "spot" },
      } as any);
    }
    return this.sapi!;
  }

  // ====== Рынки и фильтры ======
  async loadMarkets() { return this.fapi.loadMarkets(); }
  market(symbol: string) { return this.fapi.market(symbol); }

  // ✅ Берём шаги из нативных фильтров Binance (LOT_SIZE / PRICE_FILTER)
  getSymbolFilters(symbol: string): SymbolFilters {
    const m: any = this.fapi.market(symbol);
    let minQty = 0, stepSize = 0.0001, tickSize = 0.0001;

    const filters: any[] = m?.info?.filters || [];
    const lot = filters.find((f) => f?.filterType === "LOT_SIZE");
    const priceF = filters.find((f) => f?.filterType === "PRICE_FILTER");

    if (lot) {
      const mq = Number(lot.minQty);
      const ss = Number(lot.stepSize);
      if (Number.isFinite(mq) && mq > 0) minQty = mq;
      if (Number.isFinite(ss) && ss > 0) stepSize = ss;
    }

    if (priceF) {
      const ts = Number(priceF.tickSize);
      if (Number.isFinite(ts) && ts > 0) tickSize = ts;
    } else if (m?.precision?.price != null) {
      // fallback, если PRICE_FILTER не пришёл
      tickSize = Math.pow(10, -m.precision.price);
    }

    // если minQty не пришёл, но есть stepSize — логично приравнять
    if (!minQty && stepSize) minQty = stepSize;

    return { minQty: Number(minQty), stepSize: Number(stepSize), tickSize: Number(tickSize) };
  }

  amountToPrecision(symbol: string, amount: number) { return this.fapi.amountToPrecision(symbol, amount); }
  priceToPrecision(symbol: string, price: number) { return this.fapi.priceToPrecision(symbol, price); }

  // ====== Балансы ======
  async fetchFuturesUSDTBalance(): Promise<{ total: number; free: number; used: number }> {
    this.ensureKeysOrThrow();
    const bal = await this.fapi.fetchBalance({ type: "future" });
    const t = Number(bal?.USDT?.total ?? bal?.total?.USDT ?? 0);
    const f = Number(bal?.USDT?.free  ?? bal?.free?.USDT  ?? 0);
    const u = Number(bal?.USDT?.used  ?? bal?.used?.USDT  ?? (t - f));
    return { total: t, free: f, used: u };
  }

  // Точный спотовый USDT (нужен отдельный spot-клиент)
  async fetchSpotUSDTBalance(): Promise<{ total: number; free: number; used: number }> {
    this.ensureKeysOrThrow();
    const spot = this.ensureSpot();
    const bal = await spot.fetchBalance(); // spot account
    const t = Number(bal?.total?.USDT ?? bal?.USDT ?? 0);
    const f = Number(bal?.free?.USDT ?? 0);
    const u = Number(bal?.used?.USDT ?? Math.max(0, t - f));
    return { total: t, free: f, used: u };
  }

  // ====== Позиции / тикеры / ордера ======
  async fetchAllOpenPositions(): Promise<Array<{
    symbol: string; side: "long"|"short"; contracts: number; entryPrice: number; unrealizedPnlUsd: number;
  }>> {
    this.ensureKeysOrThrow();
    const positions = await this.fapi.fetchPositions();
    return positions
      .map((p: any) => {
        // ВАЖНО: используем сырой signed amount из info.positionAmt
        const amtSigned = Number(p?.info?.positionAmt ?? 0);
        const qtyAbs = Math.abs(amtSigned);
        return {
          symbol: p.symbol,
          side: amtSigned >= 0 ? "long" : "short",
          contracts: qtyAbs,
          entryPrice: Number(p.entryPrice ?? p.info?.entryPrice ?? 0),
          unrealizedPnlUsd: Number(p.unrealizedPnl ?? p.info?.unRealizedProfit ?? 0),
        };
      })
      .filter((x) => x.contracts > 0);
  }

  async fetchPositionSize(symbol: string): Promise<number> {
    this.ensureKeysOrThrow();
    const positions = await this.fapi.fetchPositions([symbol]);
    const p: any = positions?.[0];
    // возвращаем SIGNED размер (для вычисления стороны выхода)
    const amtSigned = Number(p?.info?.positionAmt ?? 0);
    return amtSigned;
  }

  async fetchTicker(symbol: string) {
    // тикер публичный — ключи не нужны
    return this.fapi.fetchTicker(symbol);
  }

  async fetchOpenOrders(symbol: string) {
    this.ensureKeysOrThrow();
    return this.fapi.fetchOpenOrders(symbol);
  }

  async cancelOrder(symbol: string, id: string) {
    this.ensureKeysOrThrow();
    return this.fapi.cancelOrder(id, symbol);
  }

  async cancelAllOrders(symbol: string) {
    this.ensureKeysOrThrow();
    return this.fapi.cancelAllOrders(symbol);
  }

  // ====== Создание ордеров ======

  // LIMIT (вход/ТП)
  async createLimit(symbol: string, side: "buy"|"sell", amount: number, price: number) {
    this.ensureKeysOrThrow();
    return this.fapi.createOrder(symbol, "limit", side, amount, price, {
      reduceOnly: false,
      timeInForce: "GTC",
    });
  }

  // ✅ STOP-MARKET ВХОД (срабатываем по stopPrice, исполняем по рынку)
  async createStopMarketEntry(symbol: string, side: "buy"|"sell", amount: number, stopPrice: number) {
    this.ensureKeysOrThrow();
    return this.fapi.createOrder(symbol, "market", side, amount, undefined, {
      type: "STOP_MARKET",
      stopPrice,
      workingType: "MARK_PRICE",
      reduceOnly: false,
    });
  }

  // ✅ STOP-MARKET СТОП-ЛОСС (закрытие всей позиции) — БЕЗ reduceOnly!
  async createStopMarketClose(symbol: string, side: "buy"|"sell", stopPrice: number) {
    this.ensureKeysOrThrow();
    return this.fapi.createOrder(symbol, "market", side, undefined, undefined, {
      type: "STOP_MARKET",
      closePosition: true,
      stopPrice,
      workingType: "MARK_PRICE",
      // reduceOnly НЕЛЬЗЯ указывать при closePosition — иначе -1106
    });
  }

  // ТП: reduce-only LIMIT
  async createReduceOnlyLimit(symbol: string, side: "buy"|"sell", amount: number, price: number) {
    this.ensureKeysOrThrow();
    return this.fapi.createOrder(symbol, "limit", side, amount, price, {
      reduceOnly: true,
      timeInForce: "GTC",
    });
  }

  // Частичное закрытие: reduce-only MARKET
  async createReduceOnlyMarket(symbol: string, side: "buy"|"sell", amount: number) {
    this.ensureKeysOrThrow();
    return this.fapi.createOrder(symbol, "market", side, amount, undefined, {
      reduceOnly: true,
    });
  }
}
