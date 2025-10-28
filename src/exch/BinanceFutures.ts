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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTimeoutOrUnknown(e: any): boolean {
  const msg = String(e?.message || e?.toString?.() || "");
  const desc = String(e?.description || "");
  const code = Number((e && (e.code ?? e.errorCode ?? e.status)) || NaN);
  const binanceMsg = String(e?.body || e?.details || e?.name || "");
  const ccxtName = String(e?.constructor?.name || "");

  // ✅ ДОБАВЛЕНО: -1000 Unknown error считаем временным и ретраим
  if (code === -1000) return true;

  if (code === -1007) return true; // execution status unknown
  if (/execution status unknown/i.test(msg + binanceMsg + desc)) return true;
  if (/timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|network error/i.test(msg + desc + binanceMsg)) return true;
  if (/RequestTimeout|NetworkError/i.test(ccxtName)) return true;

  // ✅ ДОБАВЛЕНО: разные формулировки "unknown error" от Binance
  if (/unknown error/i.test(msg + binanceMsg + desc)) return true;

  return false;
}

// простенький генератор id для clientOrderId
function rid(prefix: string) {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

export class BinanceFutures {
  private fapi: ccxt.binanceusdm;
  private sapi?: ccxt.binance; // spot client (лениво)
  private apiKey?: string;
  private secret?: string;

  // ====== ДОБАВЛЕНО: поля для авто-синхронизации времени ======
  private timeSkewMs = 0;
  private lastSyncTs = 0;
  private SYNC_TTL = 30_000; // обновлять смещение раз в 30 сек

  constructor(opts?: { apiKey?: string; secret?: string; enableRateLimit?: boolean }) {
    // допускаем отсутствие opts: возьмём из env
    this.apiKey = opts?.apiKey ?? readEnv("BINANCE_API_KEY", "BINANCE_KEY");
    this.secret = opts?.secret ?? readEnv("BINANCE_API_SECRET", "BINANCE_SECRET");

    this.fapi = new ccxt.binanceusdm({
      apiKey: this.apiKey,
      secret: this.secret,
      enableRateLimit: opts?.enableRateLimit ?? true,
      timeout: 20_000,
      // recvWindow можно задавать и тут, и в options
      recvWindow: Number(process.env.BINANCE_RECV_WINDOW || 60_000),
      options: {
        defaultType: "future",
        adjustForTimeDifference: true, // пускай ccxt тоже помогает
        recvWindow: Number(process.env.BINANCE_RECV_WINDOW || 60_000),
      },
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
        timeout: 20_000,
        recvWindow: Number(process.env.BINANCE_RECV_WINDOW || 60_000),
        options: {
          defaultType: "spot",
          recvWindow: Number(process.env.BINANCE_RECV_WINDOW || 60_000),
          adjustForTimeDifference: true, // ✅ добавлено для спота тоже
        },
      } as any);
    }
    return this.sapi!;
  }

  // ====== ДОБАВЛЕНО: жёсткая синхронизация со временем Binance ======
  private async syncServerTime(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSyncTs < this.SYNC_TTL) return;

    // ccxt raw endpoint: /fapi/v1/time
    const server = await (this.fapi as any).fapiPublicGetTime();
    const serverTs = Number(server?.serverTime ?? 0);
    const localTs = Date.now();

    if (Number.isFinite(serverTs) && serverTs > 0) {
      // положительное — локальные часы спешат
      this.timeSkewMs = localTs - serverTs;
      // ccxt binance читает difference из этого поля
      (this.fapi as any).timeDifference = -this.timeSkewMs;
    }
    this.lastSyncTs = now;
  }

  // ====== универсальный ретрай-обёртка ======
  private async withRetry<T>(
    op: () => Promise<T>,
    opts?: { tries?: number; baseDelay?: number; maxDelay?: number }
  ): Promise<T> {
    const tries = Math.max(1, opts?.tries ?? 5);
    const base = opts?.baseDelay ?? 400; // мс
    const maxD = opts?.maxDelay ?? 2500;

    let lastErr: any;
    for (let i = 0; i < tries; i++) {
      try {
        // ДОБАВЛЕНО: перед вызовом — актуализируем смещение по TTL
        await this.syncServerTime(false);
        return await op();
      } catch (e: any) {
        lastErr = e;

        // ДОБАВЛЕНО: спец-обработка -1021 (Timestamp ahead/behind)
        const code = Number(e?.code ?? e?.errno ?? 0);
        const msg = String(e?.message || e);
        if (code === -1021 || /Timestamp .* (ahead|behind)/i.test(msg)) {
          try { await this.syncServerTime(true); } catch {}
          // немедленно повторим попытку (не расходуя сильно backoff)
          try { return await op(); } catch (ee) { lastErr = ee; }
        }

        if (!isTimeoutOrUnknown(lastErr) || i === tries - 1) break;
        const backoff = Math.min(maxD, base * Math.pow(1.7, i)) + Math.random() * 180;
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  // ====== Рынки и фильтры ======
  async loadMarkets() { return this.withRetry(() => this.fapi.loadMarkets()); }
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
    const bal = await this.withRetry(() => this.fapi.fetchBalance({ type: "future" }));
    const t = Number(bal?.USDT?.total ?? bal?.total?.USDT ?? 0);
    const f = Number(bal?.USDT?.free  ?? bal?.free?.USDT  ?? 0);
    const u = Number(bal?.USDT?.used  ?? bal?.used?.USDT  ?? (t - f));
    return { total: t, free: f, used: u };
  }

  // Точный спотовый USDT (нужен отдельный spot-клиент)
  async fetchSpotUSDTBalance(): Promise<{ total: number; free: number; used: number }> {
    this.ensureKeysOrThrow();
    const spot = this.ensureSpot();
    const bal = await this.withRetry(() => spot.fetchBalance());
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
    const positions = await this.withRetry(() => this.fapi.fetchPositions());
    return positions
      .map((p: any) => {
        const amtSigned = Number(p?.info?.positionAmt ?? 0); // важен ЗНАК
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
    const positions = await this.withRetry(() => this.fapi.fetchPositions([symbol]));
    const p: any = positions?.[0];
    const amtSigned = Number(p?.info?.positionAmt ?? 0);
    return amtSigned;
  }

  async fetchTicker(symbol: string) {
    // тикер публичный — ключи не нужны, но таймауты бывают, поэтому тоже ретраим
    return this.withRetry(() => this.fapi.fetchTicker(symbol));
  }

  async fetchOpenOrders(symbol: string) {
    this.ensureKeysOrThrow();
    // прокинем recvWindow для надёжности
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    return this.withRetry(() => this.fapi.fetchOpenOrders(symbol, undefined, undefined, { recvWindow }));
  }

  async cancelOrder(symbol: string, id: string) {
    this.ensureKeysOrThrow();
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    return this.withRetry(() => this.fapi.cancelOrder(id, symbol, { recvWindow }));
  }

  async cancelAllOrders(symbol: string) {
    this.ensureKeysOrThrow();
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    return this.withRetry(() => this.fapi.cancelAllOrders(symbol, { recvWindow }));
  }

  // ====== Вспомогательное: поиск ордера по clientOrderId ======
  private async findOpenByClientId(symbol: string, clientId: string) {
    const open = await this.fetchOpenOrders(symbol);
    return open.find((o) => {
      const cid = String(o?.clientOrderId ?? o?.info?.clientOrderId ?? o?.info?.clientOid ?? "");
      return cid && cid === clientId;
    });
  }

  // ====== Создание ордеров (с идемпотентностью и ретраями) ======

  // LIMIT (вход/ТП)
  async createLimit(symbol: string, side: "buy"|"sell", amount: number, price: number) {
    this.ensureKeysOrThrow();
    const clientOrderId = rid("L");
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    const place = async () => this.fapi.createOrder(symbol, "limit", side, amount, price, {
      reduceOnly: false,
      timeInForce: "GTC",
      newClientOrderId: clientOrderId,
      recvWindow,
    });
    try {
      return await this.withRetry(place);
    } catch (e: any) {
      if (isTimeoutOrUnknown(e)) {
        const exists = await this.findOpenByClientId(symbol, clientOrderId);
        if (exists) return exists;
      }
      throw e;
    }
  }

  // ✅ STOP-MARKET ВХОД (срабатываем по stopPrice, исполняем по рынку)
  async createStopMarketEntry(symbol: string, side: "buy"|"sell", amount: number, stopPrice: number) {
    this.ensureKeysOrThrow();
    const clientOrderId = rid("SME");
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    const workingType = String(process.env.BINANCE_STOP_WORKING_TYPE || "CONTRACT_PRICE").toUpperCase(); // "CONTRACT_PRICE" | "MARK_PRICE"
    const place = async () => this.fapi.createOrder(symbol, "market", side, amount, undefined, {
      type: "STOP_MARKET",
      stopPrice,
      workingType,          // ⬅️ по умолчанию last/contract price для более быстрого триггера
      priceProtect: false,  // ⬅️ без защиты, чтобы не задерживать триггер
      reduceOnly: false,
      newClientOrderId: clientOrderId,
      recvWindow,
    });
    try {
      return await this.withRetry(place);
    } catch (e: any) {
      if (isTimeoutOrUnknown(e)) {
        const exists = await this.findOpenByClientId(symbol, clientOrderId);
        if (exists) return exists;
      }
      throw e;
    }
  }

  // ✅ MARKET ВХОД (мгновенный)
  async createMarketEntry(symbol: string, side: "buy"|"sell", amount: number) {
    this.ensureKeysOrThrow();
    const clientOrderId = rid("ME");
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    const place = async () => this.fapi.createOrder(symbol, "market", side, amount, undefined, {
      reduceOnly: false,
      newClientOrderId: clientOrderId,
      recvWindow,
    });
    try {
      return await this.withRetry(place);
    } catch (e: any) {
      if (isTimeoutOrUnknown(e)) {
        // при unknown проверяем позицию — если увеличилась, считаем что исполнилось
        const before = Math.abs(await this.fetchPositionSize(symbol));
        const exists = await this.findOpenByClientId(symbol, clientOrderId);
        const after = Math.abs(await this.fetchPositionSize(symbol));
        if (exists || after > before) {
          return { id: "unknown-but-applied", info: { newClientOrderId: clientOrderId } } as any;
        }
      }
      throw e;
    }
  }

  // ✅ STOP-MARKET СТОП-ЛОСС (закрытие всей позиции) — БЕЗ reduceOnly!
  async createStopMarketClose(symbol: string, side: "buy"|"sell", stopPrice: number) {
    this.ensureKeysOrThrow();
    const clientOrderId = rid("SLC");
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    const workingType = String(process.env.BINANCE_STOP_WORKING_TYPE || "CONTRACT_PRICE").toUpperCase();
    const place = async () => this.fapi.createOrder(symbol, "market", side, undefined, undefined, {
      type: "STOP_MARKET",
      closePosition: true,
      stopPrice,
      workingType,          // ⬅️ быстрый триггер по last/contract
      priceProtect: false,  // ⬅️ без защитной задержки
      newClientOrderId: clientOrderId,
      recvWindow,
    });
    try {
      return await this.withRetry(place);
    } catch (e: any) {
      if (isTimeoutOrUnknown(e)) {
        const exists = await this.findOpenByClientId(symbol, clientOrderId);
        if (exists) return exists;
      }
      throw e;
    }
  }

  // ТП: reduce-only LIMIT
  async createReduceOnlyLimit(symbol: string, side: "buy"|"sell", amount: number, price: number) {
    this.ensureKeysOrThrow();
    const clientOrderId = rid("TP");
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    const place = async () => this.fapi.createOrder(symbol, "limit", side, amount, price, {
      reduceOnly: true,
      timeInForce: "GTC",
      newClientOrderId: clientOrderId,
      recvWindow,
    });
    try {
      return await this.withRetry(place);
    } catch (e: any) {
      if (isTimeoutOrUnknown(e)) {
        const exists = await this.findOpenByClientId(symbol, clientOrderId);
        if (exists) return exists;
      }
      throw e;
    }
  }

  // Частичное закрытие: reduce-only MARKET
  async createReduceOnlyMarket(symbol: string, side: "buy"|"sell", amount: number) {
    this.ensureKeysOrThrow();
    const clientOrderId = rid("RO_MKT");
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW || 60_000);
    const place = async () => this.fapi.createOrder(symbol, "market", side, amount, undefined, {
      reduceOnly: true,
      newClientOrderId: clientOrderId,
      recvWindow,
    });
    try {
      return await this.withRetry(place);
    } catch (e: any) {
      if (isTimeoutOrUnknown(e)) {
        // reduce-only market после unknown: проверим, не уменьшилась ли позиция
        const before = Math.abs(await this.fetchPositionSize(symbol));
        const exists = await this.findOpenByClientId(symbol, clientOrderId);
        const after = Math.abs(await this.fetchPositionSize(symbol));
        if (exists || after < before) {
          return { id: "unknown-but-applied", info: { newClientOrderId: clientOrderId } } as any;
        }
      }
      throw e;
    }
  }
}
