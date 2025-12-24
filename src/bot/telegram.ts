#!/usr/bin/env node
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { BinanceFutures } from "../exch/BinanceFutures";
import { DEFAULT_PRESET, parseLine, runCommand, TaskBook } from "../core/engine";
import { banner, formatTradeNotification } from "../core/format";
import { startTaskRecoveryLoop } from "../core/recovery";
import { setDefaultResultOrder } from "dns";
import { listPresets, getPreset, upsertPreset, deletePreset, getDefaultPresetNameBySide, setDefaultPresetBySide, setDefaultPreset } from "../config/trading_config";
setDefaultResultOrder?.("ipv4first");  // принудительно IPv4 в Node


const token = process.env.TELEGRAM_BOT_TOKEN!;
if (!token) { console.error("TELEGRAM_BOT_TOKEN не задан в .env"); process.exit(1); }

const allowedChatsEnv = (process.env.TELEGRAM_ALLOWED_CHAT || "").trim();
const allowedUserEnv  = (process.env.TELEGRAM_ALLOWED_USERNAME || "").trim().toLowerCase();
const allowedChatIds = allowedChatsEnv ? allowedChatsEnv.split(",").map(s=>Number(s.trim())).filter(n=>!Number.isNaN(n)) : [];
function isAllowed(ctx:any){ if (allowedChatIds.length===0 && !allowedUserEnv) return true; const chatId=Number(ctx.chat?.id ?? ctx.from?.id); const user=String(ctx.from?.username||"").toLowerCase(); return allowedChatIds.includes(chatId)|| (!!allowedUserEnv && user===allowedUserEnv); }
function deny(ctx:any){ const chatId=Number(ctx.chat?.id ?? ctx.from?.id); const username=ctx.from?.username?`@${ctx.from.username}`:"(no username)"; return ctx.reply(`Access denied.\nchatId: <code>${chatId}</code>\nuser: <code>${username}</code>`, { parse_mode:"HTML" }); }

// ✅ НОВОЕ: опциональные уведомления о сделках
const ENABLE_TRADE_NOTIFICATIONS = String(process.env.TELEGRAM_TRADE_NOTIFICATIONS || "true").toLowerCase() === "true" || String(process.env.TELEGRAM_TRADE_NOTIFICATIONS || "true") === "1";

// Optional proxy agent for Telegram only
const proxyUrl = (process.env.TELEGRAM_PROXY_URL || "").trim();
let agent: any = undefined;
if (proxyUrl) {
  try {
    if (/^socks/i.test(proxyUrl)) {
      // socks5://user:pass@host:port
      const { SocksProxyAgent } = await import("socks-proxy-agent");
      agent = new (SocksProxyAgent as any)(proxyUrl);
    } else if (/^http/i.test(proxyUrl) || /^https/i.test(proxyUrl)) {
      // http(s)://user:pass@host:port
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      agent = new (HttpsProxyAgent as any)(proxyUrl);
    }
  } catch (e) {
    console.error("Failed to init TELEGRAM proxy agent:", e);
  }
}

// ✅ НОВОЕ: Настройки таймаутов и retry для Telegram
const TELEGRAM_TIMEOUT = Number(process.env.TELEGRAM_TIMEOUT_MS || 30_000); // 30 секунд по умолчанию
const TELEGRAM_RETRY_TRIES = Number(process.env.TELEGRAM_RETRY_TRIES || 3);
const TELEGRAM_RETRY_DELAY = Number(process.env.TELEGRAM_RETRY_DELAY_MS || 1000);

const bot = agent 
  ? new Telegraf(token, { 
      telegram: { 
        agent,
        apiRoot: process.env.TELEGRAM_API_ROOT || undefined,
        webhookReply: false, // отключаем webhook reply для стабильности
      } 
    }) 
  : new Telegraf(token, {
      telegram: {
        apiRoot: process.env.TELEGRAM_API_ROOT || undefined,
        webhookReply: false,
      }
    });

// ✅ Дедупликация сообщений — предотвращаем спам одинаковых сообщений
// ✅ УВЕЛИЧЕНО: окно 30 секунд для защиты от спама в цикле трекинга (каждые 2.5 сек)
const DEDUP_WINDOW_MS = 30_000; // окно дедупликации: 30 секунд
const DEDUP_MAX_ENTRIES = 200; // максимум записей в кэше
const recentMessages = new Map<string, number>(); // hash → timestamp

function getMessageHash(chatId: number | string, text: string): string {
  // Простой хэш: chatId + первые 200 символов текста (без timestamp/динамических частей)
  // ✅ ИСПРАВЛЕНО: заменяем ВСЕ числа (включая целые) на N для лучшей дедупликации
  const normalized = text.slice(0, 200).replace(/\d+/g, "N"); 
  return `${chatId}:${normalized}`;
}

function isDuplicate(chatId: number | string, text: string): boolean {
  const now = Date.now();
  const hash = getMessageHash(chatId, text);
  const lastSent = recentMessages.get(hash);
  
  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
    return true; // дубликат
  }
  
  // Очистка старых записей
  if (recentMessages.size > DEDUP_MAX_ENTRIES) {
    for (const [k, v] of recentMessages) {
      if (now - v > DEDUP_WINDOW_MS * 2) recentMessages.delete(k);
    }
  }
  
  recentMessages.set(hash, now);
  return false;
}

// ✅ НОВОЕ: Утилита для безопасной отправки сообщений с retry и дедупликацией
async function safeReply(
  ctx: any,
  text: string,
  options?: any,
  retries = TELEGRAM_RETRY_TRIES
): Promise<any> {
  // ✅ Дедупликация: пропускаем если сообщение уже отправлено недавно
  const chatId = ctx?.chat?.id || ctx?.from?.id || "unknown";
  if (isDuplicate(chatId, text)) {
    console.log(`[DEDUP] Skipping duplicate message to ${chatId}: ${text.slice(0, 50)}...`);
    return null;
  }
  
  let lastError: any;
  
  for (let i = 0; i < retries; i++) {
    try {
      // Увеличиваем таймаут для каждого запроса
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Telegram API timeout")), TELEGRAM_TIMEOUT);
      });
      
      const replyPromise = ctx.reply(text, options);
      return await Promise.race([replyPromise, timeoutPromise]);
    } catch (e: any) {
      lastError = e;
      
      // Проверяем, стоит ли ретраить
      const isRetryable = 
        e?.code === "ETIMEDOUT" ||
        e?.errno === "ETIMEDOUT" ||
        e?.type === "system" ||
        /timeout|timed out|network|ECONNRESET|ENOTFOUND/i.test(e?.message || "");
      
      if (!isRetryable || i === retries - 1) {
        throw e;
      }
      
      // Экспоненциальный backoff
      const delay = TELEGRAM_RETRY_DELAY * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

// ✅ НОВОЕ: Утилита для безопасного answerCbQuery
async function safeAnswerCbQuery(
  ctx: any,
  text?: string,
  retries = TELEGRAM_RETRY_TRIES
): Promise<any> {
  let lastError: any;
  
  for (let i = 0; i < retries; i++) {
    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Telegram API timeout")), 5000); // короткий таймаут для callback
      });
      
      const answerPromise = ctx.answerCbQuery(text);
      return await Promise.race([answerPromise, timeoutPromise]);
    } catch (e: any) {
      lastError = e;
      
      const isRetryable = 
        e?.code === "ETIMEDOUT" ||
        e?.errno === "ETIMEDOUT" ||
        /timeout|timed out|network/i.test(e?.message || "");
      
      if (!isRetryable || i === retries - 1) {
        // Для answerCbQuery не критично, просто логируем
        console.warn("Failed to answerCbQuery:", e?.message || e);
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
    }
  }
}

const ex = new BinanceFutures();
const book = new TaskBook();

// ✅ НОВОЕ: Хранилище ожидающих подтверждения команд
const pendingTrades = new Map<string, { parsed: any; userId: number; chatId: number; messageId?: number }>();

// Inline keyboard (under messages)
const mainKb = Markup.inlineKeyboard([
  [ Markup.button.callback("📊 Positions", "POS"), Markup.button.callback("💰 Deposit", "DEP") ],
  [ Markup.button.callback("📜 Orders", "ORDERS"), Markup.button.callback("🧰 Tasks", "TASKS") ],
  [ Markup.button.callback("⚙️ Presets", "PRESETS"), Markup.button.callback("❓ Help", "HELP") ],
  [ Markup.button.callback("❌ Cancel All", "CANCEL_ALL") ],
]);

// Reply keyboard (big buttons near input). Replaces old New trade/Exit set.
const mainReplyKb = Markup.keyboard([
  [ "📜 Orders", "📊 Positions" ],
  [ "💰 Deposit", "🧰 Tasks" ],
  [ "⚙️ Presets", "❓ Help" ],
]).resize();

// Полный help-текст, идентичный консольному "9"
function buildHelpText(): string {
  const lines = [
    "Быстрые клавиши: 1=positions, 2=deposit, 3=tasks, 9=help, 0=exit",
    "",
    "Торговля:",
    "  [<risk$>] l|s <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]",
    "  МАРКЕТ: [<risk$>] l|s <sym> <usd> [preset]  (пример: 50 l xrp 500 4h)",
    "  Пример: l xrp 500 2.35 300 2.33 4h",
    "",
    "Редактирование входов:",
    "  edit <taskId> <l|s> <sym> <usd1> <price1> [<usd2> <price2> ...]",
    "  Пример: edit 1 l xrp 200 2.35 100 2.36 100 2.37",
    "",
    "Позиции/задачи/депозит:",
    "  positions | deposit | tasks",
    "  close <symbol> [percent]      — закрыть позицию полностью/частично",
    "  cancel <taskId>               — отменить и удалить задачу",
    "  cancel-all                    — отменить и удалить все задачи",
    "  info <taskId>                 — подробности по задаче",
    "",
    "Ордеры:",
    "  orders [symbol]               — показать открытые ордера",
    "  cancel order <id>             — снять ордер по ID",
    "  cancel limit <symbol>         — снять все LIMIT по символу",
    "  cancel stop <symbol>          — снять все STOP по символу",
    "  cancel-all orders             — снять все ордера",
    "  cancel-all limit orders       — снять все LIMIT ордера",
    "  cancel-all stop orders        — снять все STOP ордера",
    "",
    "Пресеты:",
    "  preset list",
    "  preset show <name>",
    "  preset set <name> risk=<num> tp=<a,b,c> ratio=<a,b,c> [default=1]",
    "  preset default=<name>",
    "  preset delete <name>",
  ];
  return lines.join("\n");
}

bot.start(async (ctx) => {
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ex.loadMarkets().catch(()=>{});
    await safeReply(ctx,
      banner("telegram",
        `Готов. Формат: l|s <symbol> <position_usd> <entry> [preset=${DEFAULT_PRESET}]`,
        `Пример: l xrp 500 2.45 4h`),
      { parse_mode: "HTML", ...mainKb, ...mainReplyKb }
    );
  } catch (e:any) {
    console.error("start handler error:", e);
    try {
      await safeReply(ctx, `Ошибка запуска: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
    } catch {}
  }
});

// ✅ HELP: отправляем НОВОЕ сообщение (reply), а не editMessageText —
// чтобы не ловить 400 "message is not modified"
bot.action("HELP", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx);
    const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
    await safeReply(ctx, help, { parse_mode: "HTML", ...mainKb });
  } catch (e:any) {
    console.error("HELP action error:", e);
  }
});

// кнопка NEW_TRADE удалена

bot.action("POS", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx);
    // Позиции + кнопки «закрыть процент» (оставляем как было)
    const list = await ex.fetchAllOpenPositions();
    if (!list.length) return safeReply(ctx, `<b>Открытых позиций нет.</b>`, { parse_mode:"HTML" });
    for (const p of list) {
      const sym = p.symbol.replace("/USDT:USDT","").toLowerCase();
      const kb = Markup.inlineKeyboard([
        [ Markup.button.callback("Close 25%", `CLOSE|${sym}|25`), Markup.button.callback("Close 50%", `CLOSE|${sym}|50`), Markup.button.callback("Close 100%", `CLOSE|${sym}|100`) ]
      ]);
      await safeReply(ctx,
        `<b>${p.symbol}</b>\nside: ${p.side.toUpperCase()}  qty=${p.contracts}  avg=${p.entryPrice}\nPnL: ${(Number(p.unrealizedPnlUsd)||0).toFixed(2)}$`,
        { parse_mode:"HTML", ...kb }
      );
    }
  } catch (e:any) {
    console.error("POS action error:", e);
    try {
      await safeReply(ctx, `Ошибка позиций: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
    } catch {}
  }
});

bot.action(/CLOSE\|([a-zA-Z0-9]+)\|([0-9]{1,3})/, async (ctx) => {
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx);
    const symbol = ctx.match![1];
    const pct = Math.max(1, Math.min(100, Number(ctx.match![2])));
    await runCommand(ex, book, { kind:"close", symbol, percent: pct }, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("CLOSE action error:", e);
    try {
      await safeReply(ctx, `Ошибка закрытия: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
    } catch {}
  }
});

bot.action("DEP", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx);
    await runCommand(ex, book, {kind:"deposit"}, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("DEP action error:", e);
  }
});

bot.action("ORDERS", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx);
    await runCommand(ex, book, { kind:"orders" }, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("ORDERS action error:", e);
    try { await safeReply(ctx, `Ошибка orders: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" }); } catch {}
  }
});

// Reply keyboard handlers
bot.hears("📜 Orders", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, { kind:"orders" }, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Orders error:", e);
  }
});

bot.hears("📊 Positions", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, { kind:"positions" }, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Positions error:", e);
  }
});

bot.hears("💰 Deposit", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, {kind:"deposit"}, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Deposit error:", e);
  }
});

bot.hears("🧰 Tasks", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, { kind:"tasks" }, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Tasks error:", e);
  }
});

bot.hears("❓ Help", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
    await safeReply(ctx, help, { parse_mode:"HTML" });
  } catch (e:any) {
    console.error("hears Help error:", e);
  }
});

bot.action("TASKS", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    // Выводим список + кнопки Cancel для каждого
    const rows = book.list();
    if (!rows.length) return ctx.reply(`Нет активных задач.`, { parse_mode:"HTML" });
    for (const t of rows) {
      const kb = Markup.inlineKeyboard([
        [ Markup.button.callback(`Cancel #${t.id}`, `CANCEL|${t.id}`) ]
      ]);
      const created = t.startedAt.toISOString().replace("T"," ").slice(0,19);
      await ctx.reply(
        `<b>#${t.id}</b> [${t.status}] ${t.symbolCcxt}\n${t.label}\n${created}${t.error?`\nERR: ${escapeHtml(String(t.error))}`:""}`,
        { parse_mode:"HTML", ...kb }
      );
    }
    // Кнопка «Cancel All» внизу
    await ctx.reply(`Действия:`, { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel All", "CANCEL_ALL")]]) });
  } catch (e:any) {
    console.error("TASKS action error:", e);
  }
});

bot.action(/CANCEL\|([0-9]+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx, `Cancel #${ctx.match![1]}`);
    const id = Number(ctx.match![1]);
    await runCommand(ex, book, { kind:"cancel", id }, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("CANCEL action error:", e);
  }
});

bot.action("CANCEL_ALL", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx, "Cancel all");
    await runCommand(ex, book, { kind:"cancel_all" }, (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), (m)=>safeReply(ctx, m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("CANCEL_ALL action error:", e);
  }
});

// ==============================
// ✅ НОВОЕ: Управление пресетами
// ==============================

// State для редактирования (в памяти, упрощённая версия)
const editState = new Map<number, { preset: string; field: string }>();

// PRESETS: показать список пресетов
bot.action("PRESETS", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    
    const presets = await listPresets();
    const defaultLong = await getDefaultPresetNameBySide("long");
    const defaultShort = await getDefaultPresetNameBySide("short");
    
    if (!presets.length) {
      await ctx.reply(
        `<b>⚙️ Пресеты</b>\n\nПресетов пока нет.`,
        { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]]) }
      );
      return;
    }
    
    // Кнопки для каждого пресета
    const buttons = presets.map(p => {
      const isL = p.config_name === defaultLong;
      const isS = p.config_name === defaultShort;
      const tag = isL && isS ? "⭐LS " : isL ? "⭐L " : isS ? "⭐S " : "";
      return [Markup.button.callback(`${tag}${p.config_name}`, `PRESET_SHOW|${p.config_name}`)];
    });
    
    buttons.push([Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]);
    buttons.push([Markup.button.callback("« Назад", "BACK_MAIN")]);
    
    await ctx.reply(
      `<b>⚙️ Пресеты</b>\n\nВыберите пресет для просмотра/редактирования:\n⭐L - default для long\n⭐S - default для short`,
      { parse_mode:"HTML", ...Markup.inlineKeyboard(buttons) }
    );
  } catch (e:any) {
    console.error("PRESETS action error:", e);
    await ctx.reply(`Ошибка: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
  }
});

// Reply keyboard handler
bot.hears("⚙️ Presets", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    
    const presets = await listPresets();
    const defaultLong = await getDefaultPresetNameBySide("long");
    const defaultShort = await getDefaultPresetNameBySide("short");
    
    if (!presets.length) {
      await ctx.reply(
        `<b>⚙️ Пресеты</b>\n\nПресетов пока нет.`,
        { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]]) }
      );
      return;
    }
    
    const buttons = presets.map(p => {
      const isL = p.config_name === defaultLong;
      const isS = p.config_name === defaultShort;
      const tag = isL && isS ? "⭐LS " : isL ? "⭐L " : isS ? "⭐S " : "";
      return [Markup.button.callback(`${tag}${p.config_name}`, `PRESET_SHOW|${p.config_name}`)];
    });
    
    buttons.push([Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]);
    
    await ctx.reply(
      `<b>⚙️ Пресеты</b>\n\nВыберите пресет для просмотра/редактирования:\n⭐L - default для long\n⭐S - default для short`,
      { parse_mode:"HTML", ...Markup.inlineKeyboard(buttons) }
    );
  } catch (e:any) {
    console.error("hears Presets error:", e);
  }
});

// PRESET_SHOW: показать детали пресета с кнопками редактирования
bot.action(/PRESET_SHOW\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    
    const name = ctx.match![1];
    const preset = await getPreset(name);
    const defaultLong = await getDefaultPresetNameBySide("long");
    const defaultShort = await getDefaultPresetNameBySide("short");
    const isDefaultLong = name === defaultLong;
    const isDefaultShort = name === defaultShort;
    
    const text = [
      `<b>⚙️ Пресет: ${name}</b>`,
      isDefaultLong ? `<b>⭐ Default Long</b>` : "",
      isDefaultShort ? `<b>⭐ Default Short</b>` : "",
      ``,
      `<b>Риск:</b> $${preset.trade_risk}`,
      `<b>Take Profit:</b> ${preset.take_profit.join(", ")}`,
      `<b>Ratio:</b> ${preset.take_profit_ratio.join(", ")}%`,
    ].filter(Boolean).join("\n");
    
    const buttons = [
      [Markup.button.callback(`📝 Риск ($${preset.trade_risk})`, `PRESET_EDIT|${name}|risk`)],
      [Markup.button.callback(`📝 TP (${preset.take_profit.join(",")})`, `PRESET_EDIT|${name}|tp`)],
      [Markup.button.callback(`📝 Ratio (${preset.take_profit_ratio.join(",")})`, `PRESET_EDIT|${name}|ratio`)],
      [Markup.button.callback(isDefaultLong ? "⭐ Default Long" : "⭐ Сделать Default Long", isDefaultLong ? "NOOP" : `PRESET_DEFAULT|long|${name}`)],
      [Markup.button.callback(isDefaultShort ? "⭐ Default Short" : "⭐ Сделать Default Short", isDefaultShort ? "NOOP" : `PRESET_DEFAULT|short|${name}`)],
      [
        Markup.button.callback("🗑 Удалить", `PRESET_DELETE|${name}`),
        Markup.button.callback("« Назад", "PRESETS")
      ],
    ];
    
    await ctx.reply(text, { parse_mode:"HTML", ...Markup.inlineKeyboard(buttons) });
  } catch (e:any) {
    console.error("PRESET_SHOW action error:", e);
    await ctx.reply(`Ошибка: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
  }
});

// PRESET_EDIT: начать редактирование поля
bot.action(/PRESET_EDIT\|(.+)\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    
    const name = ctx.match![1];
    const field = ctx.match![2];
    const userId = ctx.from?.id || 0;
    
    // Сохраняем state
    editState.set(userId, { preset: name, field });
    
    const fieldLabels: Record<string, string> = {
      risk: "Риск в USD",
      tp: "Take Profit (через запятую, например: 0.3,0.5,3)",
      ratio: "Ratio в % (через запятую, например: 35,30,35)"
    };
    
    await ctx.reply(
      `<b>✏️ Редактирование пресета "${name}"</b>\n\n` +
      `<b>${fieldLabels[field] || field}</b>\n\n` +
      `Введите новое значение:`,
      { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("« Отмена", `PRESET_SHOW|${name}`)]]) }
    );
  } catch (e:any) {
    console.error("PRESET_EDIT action error:", e);
  }
});

// PRESET_DEFAULT: сделать пресет default (long/short) + legacy
bot.action(/PRESET_DEFAULT\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery("Ок");
    
    const payload = String(ctx.match![1] || "");
    const parts = payload.split("|");
    if (parts.length >= 2 && (parts[0] === "long" || parts[0] === "short")) {
      const side = parts[0] as "long" | "short";
      const name = parts.slice(1).join("|");
      await setDefaultPresetBySide(side, name);
      await ctx.reply(
        `✅ Пресет <b>${escapeHtml(name)}</b> установлен как default для <b>${side === "long" ? "long" : "short"}</b>`,
        { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("« К пресетам", "PRESETS")]]) }
      );
      return;
    }
    // legacy: ставим на обе стороны
    const name = payload;
    await setDefaultPreset(name);
    
    // Перезагрузить view
    await ctx.reply(
      `✅ Пресет <b>${escapeHtml(name)}</b> установлен как default (long+short)`,
      { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("« К пресетам", "PRESETS")]]) }
    );
  } catch (e:any) {
    console.error("PRESET_DEFAULT action error:", e);
    await ctx.reply(`Ошибка: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
  }
});

// PRESET_DELETE: удалить пресет
bot.action(/PRESET_DELETE\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    
    const name = ctx.match![1];
    
    // Подтверждение
    await ctx.answerCbQuery();
    await ctx.reply(
      `<b>🗑 Удалить пресет "${name}"?</b>\n\nЭто действие нельзя отменить.`,
      { parse_mode:"HTML", ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Да, удалить", `PRESET_DELETE_CONFIRM|${name}`)],
        [Markup.button.callback("« Отмена", `PRESET_SHOW|${name}`)]
      ]) }
    );
  } catch (e:any) {
    console.error("PRESET_DELETE action error:", e);
  }
});

// PRESET_DELETE_CONFIRM: подтверждение удаления
bot.action(/PRESET_DELETE_CONFIRM\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery("Удалено");
    
    const name = ctx.match![1];
    await deletePreset(name);
    
    await ctx.reply(
      `✅ Пресет <b>${name}</b> удалён`,
      { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("« К пресетам", "PRESETS")]]) }
    );
  } catch (e:any) {
    console.error("PRESET_DELETE_CONFIRM action error:", e);
    await ctx.reply(`Ошибка: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
  }
});

// PRESET_ADD: добавить новый пресет
bot.action("PRESET_ADD", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    
    const userId = ctx.from?.id || 0;
    editState.set(userId, { preset: "__new__", field: "name" });
    
    await ctx.reply(
      `<b>➕ Добавить новый пресет</b>\n\n` +
      `Введите имя пресета (например: <code>15m</code>, <code>1h</code>):`,
      { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("« Отмена", "PRESETS")]]) }
    );
  } catch (e:any) {
    console.error("PRESET_ADD action error:", e);
  }
});

// BACK_MAIN: вернуться в главное меню
bot.action("BACK_MAIN", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    await ctx.reply(`Главное меню:`, { ...mainKb });
  } catch (e:any) {
    console.error("BACK_MAIN action error:", e);
  }
});

// NOOP: ничего не делать (для disabled кнопок)
bot.action("NOOP", async (ctx)=>{
  try {
    await ctx.answerCbQuery();
  } catch {}
});

// ✅ НОВОЕ: обработчик кнопки "ОК" для подтверждения сделки
bot.action(/TRADE_CONFIRM\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx, "✅ Выполняю команду...");
    
    const tradeId = ctx.match![1];
    const pending = pendingTrades.get(tradeId);
    
    if (!pending) {
      await safeReply(ctx, "⚠️ Команда устарела или уже выполнена.", { parse_mode: "HTML" });
      return;
    }
    
    // Удаляем из очереди
    pendingTrades.delete(tradeId);
    
    // Удаляем кнопки из сообщения
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch {}
    
    // Выполняем команду
    await runCommand(ex, book, pending.parsed, (m)=>safeReply(ctx, m, { parse_mode:"HTML" }), (m)=>safeReply(ctx, m, { parse_mode:"HTML" }), "telegram");
  } catch (e:any) {
    console.error("TRADE_CONFIRM error:", e);
    try {
      await safeReply(ctx, `Ошибка: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
    } catch {}
  }
});

// ✅ НОВОЕ: обработчик кнопки "Cancel" для отмены сделки
bot.action(/TRADE_CANCEL\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await safeAnswerCbQuery(ctx, "❌ Отменено");
    
    const tradeId = ctx.match![1];
    const pending = pendingTrades.get(tradeId);
    
    if (!pending) {
      await safeReply(ctx, "⚠️ Команда уже не активна.", { parse_mode: "HTML" });
      return;
    }
    
    // Удаляем из очереди
    pendingTrades.delete(tradeId);
    
    // Удаляем кнопки и добавляем метку отмены
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await safeReply(ctx, "❌ <b>Команда отменена</b>", { parse_mode: "HTML" });
    } catch {}
  } catch (e:any) {
    console.error("TRADE_CANCEL error:", e);
  }
});

// DEPRECATED: старый обработчик (оставлен для совместимости)
bot.action("TRADE_OK", async (ctx)=>{
  try {
    await safeAnswerCbQuery(ctx, "✅");
  } catch {}
});

// ==============================
// Обработка текста для редактирования
// ==============================

// Перехватываем текст если идёт редактирование
bot.on("text", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    const text = (ctx.message?.text ?? "").trim();
    if (!text) return;
    
    const userId = ctx.from?.id || 0;
    const state = editState.get(userId);
    
    // ✅ ИСПРАВЛЕНО: Проверяем, является ли это торговой командой
    // Поддерживаем команды с риском в начале: "100 l xrp 5000"
    const isTradingCommand = 
      /^[ls]\s+/i.test(text) || // l xrp... или s btc...
      /^\d+\s+[ls]\s+/i.test(text) || // 100 l xrp... (с риском в начале)
      /^\d+\$?\s+[ls]\s+/i.test(text) || // 100$ l xrp... (с $ после риска)
      /^[0-9]$/.test(text) || // быстрые цифры: 1, 2, 3, 9
      text.startsWith("cancel") || 
      text.startsWith("close") ||
      text.startsWith("edit") ||
      text.startsWith("orders") ||
      text.startsWith("positions") ||
      text.startsWith("deposit") ||
      text.startsWith("tasks") ||
      text.startsWith("info") ||
      text.startsWith("help");
    
    // Если это торговая команда и идёт редактирование — выходим из режима редактирования
    if (state && isTradingCommand) {
      editState.delete(userId);
      await ctx.reply(`✅ Выход из режима редактирования`, { parse_mode:"HTML" });
      // Продолжаем обработку команды ниже
    }
    
    // ✅ Если идёт редактирование пресета — обработать
    if (state && !isTradingCommand) {
      if (state.preset === "__new__" && state.field === "name") {
        // Создание нового пресета
        const name = text;
        
        // Валидация имени
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return ctx.reply(
            `❌ Имя должно содержать только буквы, цифры, _ и -\n\nПопробуйте ещё раз:`,
            { parse_mode:"HTML" }
          );
        }
        
        // Проверяем существует ли
        const allNames = (await listPresets()).map(p => p.config_name);
        if (allNames.includes(name)) {
          return ctx.reply(
            `❌ Пресет <b>${name}</b> уже существует\n\nВыберите другое имя:`,
            { parse_mode:"HTML" }
          );
        }
        
        // Создаём с дефолтными значениями
        await upsertPreset({
          config_name: name,
          trade_risk: 100,
          take_profit: [3, 5, 7],
          take_profit_ratio: [35, 30, 35]
        });
        
        editState.delete(userId);
        
        await ctx.reply(
          `✅ Пресет <b>${name}</b> создан\n\n` +
          `Риск: $100\nTP: 3, 5, 7\nRatio: 35%, 30%, 35%\n\n` +
          `Теперь вы можете отредактировать параметры:`,
          { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback(`📝 Редактировать ${name}`, `PRESET_SHOW|${name}`)]]) }
        );
        return;
      }
      
      // Редактирование существующего пресета
      const { preset: name, field } = state;
      const current = await getPreset(name);
      
      if (field === "risk") {
        const risk = Number(text);
        if (isNaN(risk) || risk <= 0) {
          return ctx.reply(`❌ Риск должен быть положительным числом\n\nПопробуйте ещё раз:`, { parse_mode:"HTML" });
        }
        
        await upsertPreset({ ...current, trade_risk: risk });
        editState.delete(userId);
        
        await ctx.reply(
          `✅ Риск обновлён: <b>$${risk}</b>`,
          { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback(`« К ${name}`, `PRESET_SHOW|${name}`)]]) }
        );
        return;
      }
      
      if (field === "tp") {
        const values = text.split(",").map(v => Number(v.trim())).filter(v => !isNaN(v));
        if (values.length === 0) {
          return ctx.reply(`❌ Введите числа через запятую\n\nПример: 0.3,0.5,3`, { parse_mode:"HTML" });
        }
        
        await upsertPreset({ ...current, take_profit: values });
        editState.delete(userId);
        
        await ctx.reply(
          `✅ Take Profit обновлён: <b>${values.join(", ")}</b>`,
          { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback(`« К ${name}`, `PRESET_SHOW|${name}`)]]) }
        );
        return;
      }
      
      if (field === "ratio") {
        const values = text.split(",").map(v => Number(v.trim())).filter(v => !isNaN(v));
        if (values.length === 0) {
          return ctx.reply(`❌ Введите числа через запятую\n\nПример: 35,30,35`, { parse_mode:"HTML" });
        }
        
        // Проверка что сумма = 100
        const sum = values.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 100) > 0.1) {
          return ctx.reply(
            `❌ Сумма ratio должна быть 100%\n\nТекущая сумма: ${sum}%\n\nПопробуйте ещё раз:`,
            { parse_mode:"HTML" }
          );
        }
        
        await upsertPreset({ ...current, take_profit_ratio: values });
        editState.delete(userId);
        
        await ctx.reply(
          `✅ Ratio обновлён: <b>${values.join(", ")}%</b>`,
          { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback(`« К ${name}`, `PRESET_SHOW|${name}`)]]) }
        );
        return;
      }
    }

    // ✅ Если НЕ редактируем пресет — обычная обработка команд

    // быстрые цифры
    if (/^[0-9]$/.test(text)) {
      const map: Record<string, any> = { "1":{kind:"positions"}, "2":{kind:"deposit"}, "3":{kind:"tasks"}, "9":{kind:"help"} };
      const cmd = map[text];
      if (cmd?.kind==="help") {
        const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
        return safeReply(ctx, help, { parse_mode:"HTML", ...mainKb });
      }
      if (cmd) return runCommand(ex, book, cmd, (m)=>safeReply(ctx, m, { parse_mode:"HTML" }), (m)=>safeReply(ctx, m, { parse_mode:"HTML" }), "telegram");
    }

    const parsed = parseLine(text);
    if (!parsed) return safeReply(ctx, `Неверный формат. Пример:\n<code>l xrp 500 2.45 4h</code>`, { parse_mode:"HTML" });

    // команда exit удалена
    if (parsed.kind==="help")  {
      const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
      return safeReply(ctx, help, { parse_mode:"HTML", ...mainKb });
    }

    // ✅ НОВОЕ: Отправка уведомления о сделке перед выполнением
    if (parsed.kind === "trade" && ENABLE_TRADE_NOTIFICATIONS) {
      try {
        const side = parsed.dir === "l" ? "long" : "short";
        const presetNameEffective = (parsed as any)?.presetAuto ? await getDefaultPresetNameBySide(side) : parsed.presetName;
        const preset = await getPreset(presetNameEffective);
        const riskUsd = Number.isFinite(parsed.riskUsdOverride) && (parsed.riskUsdOverride as number) > 0 ? (parsed.riskUsdOverride as number) : preset.trade_risk;
        
        let legs: Array<{ usd: number; price: number; type: "LIMIT"|"STOP"|"MARKET" }> = [];
        
        if (parsed.market && parsed.market.usd > 0) {
          legs = [{ usd: parsed.market.usd, price: 0, type: "MARKET" }];
        } else {
          // Получаем текущую цену для определения типа ордера
          const { symbolCcxt } = await import("../core/SymbolResolver").then(m => m.normalizeTickerToUsdt(parsed.rawTicker));
          await ex.loadMarkets().catch(()=>{});
          const ticker = await ex.fetchTicker(symbolCcxt);
          const currentPrice = Number(ticker.last ?? ticker.mark ?? ticker.info?.markPrice) || 0;
          
          const isLong = parsed.dir === "l";
          legs = parsed.legs.map((leg: any) => {
            // LIMIT если цена лучше текущей (для long - ниже, для short - выше)
            // STOP если цена хуже текущей (для long - выше, для short - ниже)
            const isLimit = isLong ? leg.price < currentPrice : leg.price > currentPrice;
            return {
              usd: leg.usd,
              price: leg.price,
              type: isLimit ? "LIMIT" as const : "STOP" as const
            };
          });
        }
        
        const notification = formatTradeNotification({
          ticker: parsed.rawTicker,
          side,
          riskUsd,
          legs,
          takes: preset.take_profit,
          takesRatio: preset.take_profit_ratio,
          preset: presetNameEffective,
          market: !!parsed.market,
          noPreset: parsed.noPreset || false, // ✅ НОВОЕ: передаём флаг noPreset
        });
        
        // ✅ Генерируем уникальный ID для этой команды
        const tradeId = `trade_${userId}_${Date.now()}`;
        
        // ✅ Две кнопки: ОК и Cancel
        const confirmButtons = Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ ОК", `TRADE_CONFIRM|${tradeId}`),
            Markup.button.callback("❌ Cancel", `TRADE_CANCEL|${tradeId}`)
          ]
        ]);
        
        const msg = await safeReply(ctx, notification, { parse_mode: "HTML", ...confirmButtons });
        
        // Сохраняем команду для последующего выполнения
        pendingTrades.set(tradeId, {
          parsed,
          userId,
          chatId: ctx.chat?.id || 0,
          messageId: msg.message_id
        });
        
        // Автоматическая очистка через 5 минут
        setTimeout(() => {
          pendingTrades.delete(tradeId);
        }, 5 * 60 * 1000);
        
        return; // НЕ выполняем команду сразу, ждем подтверждения
      } catch (e: any) {
        console.error("Trade notification error:", e);
        // При ошибке уведомления выполняем команду сразу
      }
    }

    await runCommand(
      ex, 
      book, 
      parsed, 
      (m) => safeReply(ctx, m, { parse_mode:"HTML" }), 
      (m) => safeReply(ctx, m, { parse_mode:"HTML" }), 
      "telegram"
    );
  } catch (e:any) {
    console.error("text handler error:", e);
    try {
      await safeReply(ctx, `Ошибка: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
    } catch {}
  }
});

// /whoami для whitelisting
bot.command("whoami", async (ctx)=>{
  try {
    const chatId = Number(ctx.chat?.id ?? ctx.from?.id);
    const username = ctx.from?.username ? `@${ctx.from.username}` : "(no username)";
    return ctx.reply(`chatId: <code>${chatId}</code>\nusername: <code>${username}</code>`, { parse_mode: "HTML" });
  } catch (e:any) {
    console.error("whoami error:", e);
  }
});

bot.catch(async (err, ctx) => {
  console.error("Unhandled bot error:", err);
  try {
    if (ctx && ctx.reply) {
      await safeReply(ctx, `Неожиданная ошибка: <code>${escapeHtml((err as any)?.message||String(err))}</code>`, { parse_mode:"HTML" });
    }
  } catch {}
});

bot.launch().then(async ()=> {
  await ex.init(); // Синхронизация времени перед первым использованием
  await ex.loadMarkets();
  startTaskRecoveryLoop(ex, book, (m) => console.log(m));
  console.log("Telegram bot started.");
}).catch((e)=>{ console.error(e); });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ---- utils ----
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ✅ НОВОЕ: Улучшенная обработка unhandled errors
process.on("unhandledRejection", (e: any) => {
  console.error("UNHANDLED REJECTION:", e);
  // Игнорируем таймауты Telegram API - они обрабатываются через retry
  if (e?.code === "ETIMEDOUT" || e?.errno === "ETIMEDOUT" || /telegram|fetch/i.test(e?.message || "")) {
    console.warn("Telegram API timeout (will retry):", e?.message || e);
    return;
  }
});

process.on("uncaughtException", (e: any) => {
  console.error("UNCAUGHT EXCEPTION:", e);
  // Не завершаем процесс для некритичных ошибок
  if (e?.code === "ETIMEDOUT" || e?.errno === "ETIMEDOUT") {
    console.warn("Network timeout (non-critical):", e?.message || e);
    return;
  }
  // Для критичных ошибок - завершаем процесс
  console.error("Critical error, exiting...");
  process.exit(1);
});