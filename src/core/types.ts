// Типы команд/задач

export type TradeLeg = { usd: number; price: number };

export type ParsedCmd =
  | {
      kind: "trade";
      dir: "l" | "s";
      rawTicker: string;
      legs: TradeLeg[];
      presetName: string;
      // ✅ НОВОЕ: если true — presetName выбран автоматически по стороне (long/short) из конфигурации
      presetAuto?: boolean;
      dryRun: boolean;
      market?: { usd: number } | null;
      riskUsdOverride?: number;
      noPreset?: boolean; // ✅ НОВОЕ: отключение автоматических SL/TP
    }
  | { kind: "help" }
  | { kind: "tasks" }
  | { kind: "positions" }
  | { kind: "deposit" }
  | { kind: "exit" }
  | { kind: "cancel"; id: number }
  | { kind: "cancel_ticker"; symbol: string }
  | { kind: "cancel_all" }
  | { kind: "risk_calc"; ticker: string; risk: number; coef?: number }
  | { kind: "close"; symbol: string; percent: number }
  | { kind: "edit"; id: number; dir: "l" | "s"; rawTicker: string; legs: TradeLeg[] }
  | { kind: "preset_list" }
  | { kind: "preset_show"; name: string }
  | {
      kind: "preset_set";
      name: string;
      risk?: number;
      tp?: number[];
      ratio?: number[];
      // legacy: установить дефолт на обе стороны
      makeDefault?: boolean;
      // ✅ НОВОЕ: отдельные дефолты
      makeDefaultLong?: boolean;
      makeDefaultShort?: boolean;
    }
  | { kind: "preset_delete"; name: string }
  | { kind: "task_info"; id: number }
  | { kind: "orders"; symbol?: string }
  | { kind: "cancel_order"; id: string }
  | { kind: "cancel_limit_symbol"; symbol: string }
  | { kind: "cancel_stop_symbol"; symbol: string }
  | { kind: "cancel_all_orders"; sub: "all" | "limit" | "stop" };

export type TaskStatus =
  | "queued"
  | "waiting_fill"
  | "filled"
  | "placing_bracket"
  | "live"
  | "flat"
  | "canceled"
  | "error"
  | "done";

export type Task = {
  id: number;
  symbolCcxt: string;
  label: string;
  status: TaskStatus;
  error?: string;
  startedAt: Date;
  updatedAt: Date;
  entryOrderIds?: string[];
  cancelRequested?: boolean;
  side?: "long" | "short";
  totalUsd?: number;
  presetName?: string;
  /**
   * Кастомный риск в USD, если пользователь вводил его в начале команды, напр:
   * "3 l hype 200 28.34" → riskUsd=3
   */
  riskUsd?: number;
  
  /**
   * ✅ НОВОЕ: Средняя цена входа по заявкам ЭТОЙ task (не всей позиции).
   * Используется для расчёта SL при цепочке задач.
   */
  taskEntryAvg?: number;
  
  /**
   * ✅ НОВОЕ: Объём входа по заявкам ЭТОЙ task.
   * Используется для расчёта SL при цепочке задач.
   */
  taskEntryQty?: number;
  
  /**
   * ✅ НОВОЕ: Флаг, что эта задача была отменена в рамках цепочки (superseded более новой задачей).
   */
  supersededBy?: number;
  
  /**
   * ✅ НОВОЕ: Если true — автоматические SL/TP отключены для этой задачи.
   */
  noPreset?: boolean;
};

export const DEFAULT_PRESET = "4h";
export const NOTIONAL_BIAS: "nearest" | "down" | "up" = "nearest";

