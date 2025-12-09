import WebSocket from "ws";
import crypto from "crypto";

/**
 * Binance Futures User Data Stream WebSocket
 * Подписка на обновления аккаунта: ордера, позиции, баланс
 */
export class BinanceWs {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private apiKey: string;
  private secret: string;
  private baseUrl = "https://fapi.binance.com";
  private wsUrl = "wss://fstream.binance.com/ws/";
  private reconnectDelay = 5000;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isConnected = false;

  // Callbacks
  private onOrderUpdate?: (data: any) => void;
  private onAccountUpdate?: (data: any) => void;
  private onError?: (error: Error) => void;
  private onConnect?: () => void;
  private onDisconnect?: () => void;

  constructor(apiKey: string, secret: string) {
    this.apiKey = apiKey;
    this.secret = secret;
  }

  /**
   * Установить callback для обновлений ордеров
   */
  setOnOrderUpdate(callback: (data: any) => void) {
    this.onOrderUpdate = callback;
  }

  /**
   * Установить callback для обновлений аккаунта
   */
  setOnAccountUpdate(callback: (data: any) => void) {
    this.onAccountUpdate = callback;
  }

  /**
   * Установить callback для ошибок
   */
  setOnError(callback: (error: Error) => void) {
    this.onError = callback;
  }

  /**
   * Установить callback для подключения
   */
  setOnConnect(callback: () => void) {
    this.onConnect = callback;
  }

  /**
   * Установить callback для отключения
   */
  setOnDisconnect(callback: () => void) {
    this.onDisconnect = callback;
  }

  /**
   * Получить listenKey от Binance
   */
  private async getListenKey(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/fapi/v1/listenKey`, {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": this.apiKey,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get listenKey: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data.listenKey;
  }

  /**
   * Продлить listenKey (нужно делать каждые 30 минут)
   */
  private async putListenKey(): Promise<void> {
    if (!this.listenKey) return;

    const response = await fetch(`${this.baseUrl}/fapi/v1/listenKey`, {
      method: "PUT",
      headers: {
        "X-MBX-APIKEY": this.apiKey,
      },
      body: new URLSearchParams({ listenKey: this.listenKey }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`Failed to put listenKey: ${response.status} ${text}`);
    }
  }

  /**
   * Удалить listenKey
   */
  private async deleteListenKey(): Promise<void> {
    if (!this.listenKey) return;

    try {
      await fetch(`${this.baseUrl}/fapi/v1/listenKey`, {
        method: "DELETE",
        headers: {
          "X-MBX-APIKEY": this.apiKey,
        },
        body: new URLSearchParams({ listenKey: this.listenKey }),
      });
    } catch (e) {
      console.warn(`Failed to delete listenKey: ${e}`);
    }
  }

  /**
   * Подключиться к WebSocket
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isConnected) {
      return;
    }

    this.isConnecting = true;

    try {
      // Получаем listenKey
      this.listenKey = await this.getListenKey();
      console.log(`[WS] Got listenKey: ${this.listenKey.substring(0, 10)}...`);

      // Подключаемся к WebSocket
      const wsUrl = `${this.wsUrl}${this.listenKey}`;
      console.log(`[WS] Connecting to ${wsUrl}...`);

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        console.log("[WS] ✅ Connected to Binance User Data Stream");
        this.isConnected = true;
        this.isConnecting = false;
        this.onConnect?.();

        // Запускаем keep-alive (продление listenKey каждые 30 минут)
        this.keepAliveInterval = setInterval(() => {
          this.putListenKey().catch((e) => {
            console.warn(`[WS] Failed to keep alive: ${e}`);
          });
        }, 30 * 60 * 1000); // 30 минут
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (e) {
          console.error(`[WS] Failed to parse message: ${e}`);
        }
      });

      this.ws.on("error", (error: Error) => {
        console.error(`[WS] WebSocket error: ${error.message}`);
        this.onError?.(error);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        console.log(`[WS] Connection closed: ${code} ${reason.toString()}`);
        this.isConnected = false;
        this.isConnecting = false;
        this.onDisconnect?.();

        // Очищаем интервалы
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }

        // Переподключаемся если не было явного закрытия (1000 = нормальное закрытие)
        if (code !== 1000) {
          console.log(`[WS] Unexpected close (code=${code}), scheduling reconnect...`);
          this.scheduleReconnect();
        } else {
          console.log(`[WS] Normal close (code=1000), not reconnecting`);
        }
      });
    } catch (error: any) {
      this.isConnecting = false;
      console.error(`[WS] Failed to connect: ${error.message}`);
      this.onError?.(error);
      this.scheduleReconnect();
    }
  }

  /**
   * Обработка сообщений от WebSocket
   */
  private handleMessage(message: any) {
    // Логируем все сообщения для отладки
    console.log(`[WS] Received message:`, JSON.stringify(message, null, 2));
    
    // ORDER_TRADE_UPDATE - обновления ордеров
    if (message.e === "ORDER_TRADE_UPDATE") {
      const orderData = message.o;
      console.log(`[WS] 🔔 ORDER_TRADE_UPDATE:`, {
        symbol: orderData.s,
        orderId: orderData.i,
        clientOrderId: orderData.c,
        status: orderData.X,
        type: orderData.o,
        side: orderData.S,
        price: orderData.p,
        qty: orderData.q,
        executedQty: orderData.z,
        time: new Date(orderData.T).toISOString(),
      });
      this.onOrderUpdate?.(orderData);
    }

    // ACCOUNT_UPDATE - обновления аккаунта (позиции, баланс)
    if (message.e === "ACCOUNT_UPDATE") {
      console.log(`[WS] 🔔 ACCOUNT_UPDATE:`, {
        eventTime: new Date(message.E).toISOString(),
        positions: message.a?.P?.length || 0,
        balances: message.a?.B?.length || 0,
      });
      this.onAccountUpdate?.(message.a);
    }
    
    // Если это не известное событие - просто логируем
    if (message.e && message.e !== "ORDER_TRADE_UPDATE" && message.e !== "ACCOUNT_UPDATE") {
      console.log(`[WS] ⚠️ Unknown event type: ${message.e}`);
    }
  }

  /**
   * Запланировать переподключение
   */
  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    console.log(`[WS] Scheduling reconnect in ${this.reconnectDelay}ms...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect().catch((e) => {
        console.error(`[WS] Reconnect failed: ${e}`);
      });
    }, this.reconnectDelay);
  }

  /**
   * Отключиться от WebSocket
   */
  async disconnect(): Promise<void> {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }

    await this.deleteListenKey();
    this.isConnected = false;
    this.isConnecting = false;
    console.log("[WS] Disconnected");
  }

  /**
   * Проверить подключение
   */
  isWsConnected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}

