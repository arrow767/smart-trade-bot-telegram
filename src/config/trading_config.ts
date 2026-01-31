import { promises as fs } from "fs";
import path from "path";

export type RiskType = "money" | "percent";

export type TradingPreset = {
  config_name: string;          // имя пресета
  trade_risk: number;           // риск ($ или % в зависимости от riskType)
  risk_type?: RiskType;         // "money" = фиксированная сумма, "percent" = % от депозита
  take_profit: number[];        // мультипликаторы R: [3,5,7]
  take_profit_ratio: number[];  // в %, например [35,30,35]
};

export type TradingConfigFile = {
  // legacy default (один на всё); оставляем для обратной совместимости
  default?: string;
  // ✅ НОВОЕ: два дефолта — отдельно для long и short
  default_long?: string;
  default_short?: string;
  presets: Record<string, TradingPreset>;
};

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "trading_config.json");

// пресет по умолчанию (если файла нет)
const DEFAULT_PRESET_NAME = "4h";
const DEFAULT_PRESET: TradingPreset = {
  config_name: DEFAULT_PRESET_NAME,
  trade_risk: 100,
  risk_type: "money",  // по умолчанию фиксированная сумма
  take_profit: [3, 5, 7],
  take_profit_ratio: [35, 30, 35],
};

const DEFAULT_FILE: TradingConfigFile = {
  default: DEFAULT_PRESET_NAME,
  default_long: DEFAULT_PRESET_NAME,
  default_short: DEFAULT_PRESET_NAME,
  presets: { [DEFAULT_PRESET_NAME]: DEFAULT_PRESET },
};

async function ensureFile(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.access(CONFIG_PATH);
  } catch {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_FILE, null, 2), "utf-8");
  }
}

export async function loadConfig(): Promise<TradingConfigFile> {
  await ensureFile();
  const raw = await fs.readFile(CONFIG_PATH, "utf-8");
  try {
    const parsed = JSON.parse(raw) as TradingConfigFile;
    if (!parsed || typeof parsed !== "object") throw new Error("bad config");

    // миграция: если есть только legacy default — используем его для обеих сторон
    const legacyDefault = (parsed.default || DEFAULT_PRESET_NAME).trim() || DEFAULT_PRESET_NAME;
    parsed.default ||= legacyDefault;
    parsed.default_long ||= legacyDefault;
    parsed.default_short ||= legacyDefault;

    parsed.presets ||= {};
    const ensurePreset = (name?: string) => {
      const key = (name || DEFAULT_PRESET_NAME).trim() || DEFAULT_PRESET_NAME;
      if (!parsed.presets[key]) parsed.presets[key] = DEFAULT_PRESET;
      return key;
    };
    parsed.default = ensurePreset(parsed.default);
    parsed.default_long = ensurePreset(parsed.default_long);
    parsed.default_short = ensurePreset(parsed.default_short);

    return parsed;
  } catch {
    // восстановление файла
    await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_FILE, null, 2), "utf-8");
    return DEFAULT_FILE;
  }
}

export async function saveConfig(cfg: TradingConfigFile): Promise<void> {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// публичные удобные API

export async function listPresets(): Promise<TradingPreset[]> {
  const cfg = await loadConfig();
  return Object.values(cfg.presets).sort((a, b) => a.config_name.localeCompare(b.config_name));
}

export async function getDefaultPresetName(): Promise<string> {
  const cfg = await loadConfig();
  return (cfg.default || cfg.default_long || cfg.default_short || DEFAULT_PRESET_NAME).trim() || DEFAULT_PRESET_NAME;
}

export async function setDefaultPreset(name: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.presets[name]) throw new Error(`Preset "${name}" не существует`);
  cfg.default = name;
  // legacy set: если пользователь ставит "default", считаем что это дефолт для обеих сторон
  cfg.default_long = name;
  cfg.default_short = name;
  await saveConfig(cfg);
}

export async function getDefaultPresetNameBySide(side: "long" | "short"): Promise<string> {
  const cfg = await loadConfig();
  const key = side === "long" ? (cfg.default_long || cfg.default || DEFAULT_PRESET_NAME) : (cfg.default_short || cfg.default || DEFAULT_PRESET_NAME);
  return (key || DEFAULT_PRESET_NAME).trim() || DEFAULT_PRESET_NAME;
}

export async function setDefaultPresetBySide(side: "long" | "short", name: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.presets[name]) throw new Error(`Preset "${name}" не существует`);
  if (side === "long") cfg.default_long = name;
  else cfg.default_short = name;
  // держим legacy default не пустым
  cfg.default ||= name;
  await saveConfig(cfg);
}

export async function getPreset(name?: string): Promise<TradingPreset> {
  const cfg = await loadConfig();
  const key = (name || cfg.default || cfg.default_long || cfg.default_short || DEFAULT_PRESET_NAME).trim();
  const direct = cfg.presets[key];
  if (direct) return direct;
  const lower = key.toLowerCase();
  const matchedKey = Object.keys(cfg.presets).find((k) => k.toLowerCase() === lower);
  return (matchedKey && cfg.presets[matchedKey]) || DEFAULT_PRESET;
}

export async function upsertPreset(preset: TradingPreset): Promise<void> {
  const cfg = await loadConfig();
  cfg.presets[preset.config_name] = {
    config_name: preset.config_name,
    trade_risk: Number(preset.trade_risk) || 0,
    risk_type: preset.risk_type || "money",
    take_profit: [...preset.take_profit].map(Number),
    take_profit_ratio: [...preset.take_profit_ratio].map(Number),
  };
  await saveConfig(cfg);
}

export async function deletePreset(name: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.presets[name]) throw new Error(`Preset "${name}" не найден`);
  if (cfg.default === name || cfg.default_long === name || cfg.default_short === name) {
    throw new Error(`Нельзя удалить дефолтный пресет "${name}"`);
  }
  delete cfg.presets[name];
  await saveConfig(cfg);
}
