// Типы команд/задач

export type TradeLeg = { usd: number; price: number };

export type ParsedCmd =
  | {
      kind: "trade";
      dir: "l" | "s";
      rawTicker: string;
      legs: TradeLeg[];
      presetName: string;
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
  | { kind: "cancel_all" }
  | { kind: "close"; symbol: string; percent: number }
  | { kind: "edit"; id: number; dir: "l" | "s"; rawTicker: string; legs: TradeLeg[] }
  | { kind: "preset_list" }
  | { kind: "preset_show"; name: string }
  | { kind: "preset_set"; name: string; risk?: number; tp?: number[]; ratio?: number[]; makeDefault?: boolean }
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
};

export const DEFAULT_PRESET = "4h";
export const NOTIONAL_BIAS: "nearest" | "down" | "up" = "nearest";

