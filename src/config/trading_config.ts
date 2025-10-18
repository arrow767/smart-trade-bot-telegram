import { promises as fs } from "fs";
import path from "path";

export type TradingPreset = {
  config_name: string;          // имя пресета
  trade_risk: number;           // риск в $
  take_profit: number[];        // мультипликаторы R: [3,5,7]
  take_profit_ratio: number[];  // в %, например [35,30,35]
};

export type TradingConfigFile = {
  default: string;              // дефолтный пресет
  presets: Record<string, TradingPreset>;
};

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "trading_config.json");

// пресет по умолчанию (если файла нет)
const DEFAULT_PRESET_NAME = "4h";
const DEFAULT_PRESET: TradingPreset = {
  config_name: DEFAULT_PRESET_NAME,
  trade_risk: 100,
  take_profit: [3, 5, 7],
  take_profit_ratio: [35, 30, 35],
};

const DEFAULT_FILE: TradingConfigFile = {
  default: DEFAULT_PRESET_NAME,
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
    parsed.default ||= DEFAULT_PRESET_NAME;
    parsed.presets ||= {};
    if (!parsed.presets[parsed.default]) {
      parsed.presets[parsed.default] = DEFAULT_PRESET;
    }
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
  return cfg.default || DEFAULT_PRESET_NAME;
}

export async function setDefaultPreset(name: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.presets[name]) throw new Error(`Preset "${name}" не существует`);
  cfg.default = name;
  await saveConfig(cfg);
}

export async function getPreset(name?: string): Promise<TradingPreset> {
  const cfg = await loadConfig();
  const key = (name || cfg.default || DEFAULT_PRESET_NAME).trim();
  return cfg.presets[key] || DEFAULT_PRESET;
}

export async function upsertPreset(preset: TradingPreset): Promise<void> {
  const cfg = await loadConfig();
  cfg.presets[preset.config_name] = {
    config_name: preset.config_name,
    trade_risk: Number(preset.trade_risk) || 0,
    take_profit: [...preset.take_profit].map(Number),
    take_profit_ratio: [...preset.take_profit_ratio].map(Number),
  };
  await saveConfig(cfg);
}

export async function deletePreset(name: string): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.presets[name]) throw new Error(`Preset "${name}" не найден`);
  if (cfg.default === name) throw new Error(`Нельзя удалить дефолтный пресет "${name}"`);
  delete cfg.presets[name];
  await saveConfig(cfg);
}
