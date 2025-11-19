#!/usr/bin/env node
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { BinanceFutures } from "../exch/BinanceFutures";
import { DEFAULT_PRESET, parseLine, runCommand, TaskBook } from "../core/engine";
import { banner } from "../core/format";
import { setDefaultResultOrder } from "dns";
import { listPresets, getPreset, upsertPreset, deletePreset, getDefaultPresetName, setDefaultPreset } from "../config/trading_config";
setDefaultResultOrder?.("ipv4first");  // принудительно IPv4 в Node


const token = process.env.TELEGRAM_BOT_TOKEN!;
if (!token) { console.error("TELEGRAM_BOT_TOKEN не задан в .env"); process.exit(1); }

const allowedChatsEnv = (process.env.TELEGRAM_ALLOWED_CHAT || "").trim();
const allowedUserEnv  = (process.env.TELEGRAM_ALLOWED_USERNAME || "").trim().toLowerCase();
const allowedChatIds = allowedChatsEnv ? allowedChatsEnv.split(",").map(s=>Number(s.trim())).filter(n=>!Number.isNaN(n)) : [];
function isAllowed(ctx:any){ if (allowedChatIds.length===0 && !allowedUserEnv) return true; const chatId=Number(ctx.chat?.id ?? ctx.from?.id); const user=String(ctx.from?.username||"").toLowerCase(); return allowedChatIds.includes(chatId)|| (!!allowedUserEnv && user===allowedUserEnv); }
function deny(ctx:any){ const chatId=Number(ctx.chat?.id ?? ctx.from?.id); const username=ctx.from?.username?`@${ctx.from.username}`:"(no username)"; return ctx.reply(`Access denied.\nchatId: <code>${chatId}</code>\nuser: <code>${username}</code>`, { parse_mode:"HTML" }); }

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

const bot = agent ? new Telegraf(token, { telegram: { agent } }) : new Telegraf(token);
const ex = new BinanceFutures();
const book = new TaskBook();

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
    await ctx.reply(
      banner("telegram",
        `Готов. Формат: l|s <symbol> <position_usd> <entry> [preset=${DEFAULT_PRESET}]`,
        `Пример: l xrp 500 2.45 4h`),
      { parse_mode: "HTML", ...mainKb, ...mainReplyKb }
    );
  } catch (e:any) {
    console.error("start handler error:", e);
    await ctx.reply(`Ошибка запуска: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
  }
});

// ✅ HELP: отправляем НОВОЕ сообщение (reply), а не editMessageText —
// чтобы не ловить 400 "message is not modified"
bot.action("HELP", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
    await ctx.reply(help, { parse_mode: "HTML", ...mainKb });
  } catch (e:any) {
    console.error("HELP action error:", e);
  }
});

// кнопка NEW_TRADE удалена

bot.action("POS", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    // Позиции + кнопки «закрыть процент» (оставляем как было)
    const list = await ex.fetchAllOpenPositions();
    if (!list.length) return ctx.reply(`<b>Открытых позиций нет.</b>`, { parse_mode:"HTML" });
    for (const p of list) {
      const sym = p.symbol.replace("/USDT:USDT","").toLowerCase();
      const kb = Markup.inlineKeyboard([
        [ Markup.button.callback("Close 25%", `CLOSE|${sym}|25`), Markup.button.callback("Close 50%", `CLOSE|${sym}|50`), Markup.button.callback("Close 100%", `CLOSE|${sym}|100`) ]
      ]);
      await ctx.reply(
        `<b>${p.symbol}</b>\nside: ${p.side.toUpperCase()}  qty=${p.contracts}  avg=${p.entryPrice}\nPnL: ${(Number(p.unrealizedPnlUsd)||0).toFixed(2)}$`,
        { parse_mode:"HTML", ...kb }
      );
    }
  } catch (e:any) {
    console.error("POS action error:", e);
    await ctx.reply(`Ошибка позиций: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
  }
});

bot.action(/CLOSE\|([a-zA-Z0-9]+)\|([0-9]{1,3})/, async (ctx) => {
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    const symbol = ctx.match![1];
    const pct = Math.max(1, Math.min(100, Number(ctx.match![2])));
    await runCommand(ex, book, { kind:"close", symbol, percent: pct }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("CLOSE action error:", e);
    await ctx.reply(`Ошибка закрытия: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
  }
});

bot.action("DEP", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    await runCommand(ex, book, {kind:"deposit"}, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("DEP action error:", e);
  }
});

bot.action("ORDERS", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    await runCommand(ex, book, { kind:"orders" }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("ORDERS action error:", e);
    try { await ctx.reply(`Ошибка orders: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" }); } catch {}
  }
});

// Reply keyboard handlers
bot.hears("📜 Orders", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, { kind:"orders" }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Orders error:", e);
  }
});

bot.hears("📊 Positions", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, { kind:"positions" }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Positions error:", e);
  }
});

bot.hears("💰 Deposit", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, {kind:"deposit"}, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Deposit error:", e);
  }
});

bot.hears("🧰 Tasks", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await runCommand(ex, book, { kind:"tasks" }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("hears Tasks error:", e);
  }
});

bot.hears("❓ Help", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
    await ctx.reply(help, { parse_mode:"HTML" });
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
    await ctx.answerCbQuery(`Cancel #${ctx.match![1]}`);
    const id = Number(ctx.match![1]);
    await runCommand(ex, book, { kind:"cancel", id }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
  } catch (e:any) {
    console.error("CANCEL action error:", e);
  }
});

bot.action("CANCEL_ALL", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery("Cancel all");
    await runCommand(ex, book, { kind:"cancel_all" }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
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
    const defaultPreset = await getDefaultPresetName();
    
    if (!presets.length) {
      await ctx.reply(
        `<b>⚙️ Пресеты</b>\n\nПресетов пока нет.`,
        { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]]) }
      );
      return;
    }
    
    // Кнопки для каждого пресета
    const buttons = presets.map(p => [
      Markup.button.callback(
        `${p.config_name === defaultPreset ? "⭐ " : ""}${p.config_name}`,
        `PRESET_SHOW|${p.config_name}`
      )
    ]);
    
    buttons.push([Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]);
    buttons.push([Markup.button.callback("« Назад", "BACK_MAIN")]);
    
    await ctx.reply(
      `<b>⚙️ Пресеты</b>\n\nВыберите пресет для просмотра/редактирования:\n⭐ - default пресет`,
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
    const defaultPreset = await getDefaultPresetName();
    
    if (!presets.length) {
      await ctx.reply(
        `<b>⚙️ Пресеты</b>\n\nПресетов пока нет.`,
        { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]]) }
      );
      return;
    }
    
    const buttons = presets.map(p => [
      Markup.button.callback(
        `${p.config_name === defaultPreset ? "⭐ " : ""}${p.config_name}`,
        `PRESET_SHOW|${p.config_name}`
      )
    ]);
    
    buttons.push([Markup.button.callback("➕ Добавить пресет", "PRESET_ADD")]);
    
    await ctx.reply(
      `<b>⚙️ Пресеты</b>\n\nВыберите пресет для просмотра/редактирования:\n⭐ - default пресет`,
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
    const defaultPreset = await getDefaultPresetName();
    const isDefault = name === defaultPreset;
    
    const text = [
      `<b>⚙️ Пресет: ${name}</b>`,
      isDefault ? `<b>⭐ Default</b>` : "",
      ``,
      `<b>Риск:</b> $${preset.trade_risk}`,
      `<b>Take Profit:</b> ${preset.take_profit.join(", ")}`,
      `<b>Ratio:</b> ${preset.take_profit_ratio.join(", ")}%`,
    ].filter(Boolean).join("\n");
    
    const buttons = [
      [Markup.button.callback(`📝 Риск ($${preset.trade_risk})`, `PRESET_EDIT|${name}|risk`)],
      [Markup.button.callback(`📝 TP (${preset.take_profit.join(",")})`, `PRESET_EDIT|${name}|tp`)],
      [Markup.button.callback(`📝 Ratio (${preset.take_profit_ratio.join(",")})`, `PRESET_EDIT|${name}|ratio`)],
      [
        isDefault 
          ? Markup.button.callback("⭐ Default", "NOOP")
          : Markup.button.callback("⭐ Сделать default", `PRESET_DEFAULT|${name}`)
      ],
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

// PRESET_DEFAULT: сделать пресет default
bot.action(/PRESET_DEFAULT\|(.+)/, async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery("Установлен default");
    
    const name = ctx.match![1];
    await setDefaultPreset(name);
    
    // Перезагрузить view
    await ctx.reply(
      `✅ Пресет <b>${name}</b> установлен как default`,
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
    
    // ✅ Если идёт редактирование пресета — обработать
    if (state) {
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
        try {
          await getPreset(name);
          return ctx.reply(
            `❌ Пресет <b>${name}</b> уже существует\n\nВыберите другое имя:`,
            { parse_mode:"HTML" }
          );
        } catch {
          // Пресет не существует — ОК
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
        return ctx.reply(help, { parse_mode:"HTML", ...mainKb });
      }
      if (cmd) return runCommand(ex, book, cmd, (m)=>ctx.reply(m, { parse_mode:"HTML" }), (m)=>ctx.reply(m, { parse_mode:"HTML" }), "telegram");
    }

    const parsed = parseLine(text);
    if (!parsed) return ctx.reply(`Неверный формат. Пример:\n<code>l xrp 500 2.45 4h</code>`, { parse_mode:"HTML" });

    // команда exit удалена
    if (parsed.kind==="help")  {
      const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
      return ctx.reply(help, { parse_mode:"HTML", ...mainKb });
    }

    await runCommand(ex, book, parsed, (m)=>ctx.reply(m, { parse_mode:"HTML" }), (m)=>ctx.reply(m, { parse_mode:"HTML" }), "telegram");
  } catch (e:any) {
    console.error("text handler error:", e);
    try {
      await ctx.reply(`Ошибка: <code>${escapeHtml(e?.message||String(e))}</code>`, { parse_mode:"HTML" });
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
    await ctx.reply?.(`Неожиданная ошибка: <code>${escapeHtml((err as any)?.message||String(err))}</code>`, { parse_mode:"HTML" });
  } catch {}
});

bot.launch().then(()=> console.log("Telegram bot started.")).catch((e)=>{ console.error(e); });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ---- utils ----
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

process.on("unhandledRejection", e => console.error("UNHANDLED:", e));
process.on("uncaughtException", e => console.error("UNCAUGHT:", e));