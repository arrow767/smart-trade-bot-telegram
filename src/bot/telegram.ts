#!/usr/bin/env node
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { BinanceFutures } from "../exch/BinanceFutures";
import { DEFAULT_PRESET, parseLine, runCommand, TaskBook } from "../core/engine";
import { banner } from "../core/format";
import { setDefaultResultOrder } from "dns";
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

const mainKb = Markup.inlineKeyboard([
  [ Markup.button.callback("➕ New trade", "NEW_TRADE") ],
  [ Markup.button.callback("📊 Positions", "POS"), Markup.button.callback("💰 Deposit", "DEP") ],
  [ Markup.button.callback("🧰 Tasks", "TASKS") ],
  [ Markup.button.callback("❌ Cancel All", "CANCEL_ALL"), Markup.button.callback("❓ Help", "HELP") ],
]);

// Полный help-текст, идентичный консольному "9"
function buildHelpText(): string {
  const lines = [
    "Быстрые клавиши: 1=positions, 2=deposit, 3=tasks, 9=help, 0=exit",
    "",
    "Торговля:",
    "  l <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]",
    "  s <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]",
    "  МАРКЕТ: l <sym> <usd> [preset]  (пример: l xrp 500 4h)",
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
      { parse_mode: "HTML", ...mainKb }
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

bot.action("NEW_TRADE", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    await ctx.answerCbQuery();
    await ctx.reply(`Пришлите строку:\n<code>l xrp 500 2.45 4h</code>\nили маркет-вход: <code>l xrp 500 4h</code>`, { parse_mode: "HTML" });
  } catch (e:any) {
    console.error("NEW_TRADE action error:", e);
  }
});

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

// Любой текст — пробуем как команду
bot.on("text", async (ctx)=>{
  try {
    if (!isAllowed(ctx)) return deny(ctx);
    const text = (ctx.message?.text ?? "").trim();
    if (!text) return;

    // быстрые цифры
    if (/^[0-9]$/.test(text)) {
      const map: Record<string, any> = { "1":{kind:"positions"}, "2":{kind:"deposit"}, "3":{kind:"tasks"}, "9":{kind:"help"}, "0":{kind:"exit"} };
      const cmd = map[text];
      if (cmd?.kind==="help") {
        const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
        return ctx.reply(help, { parse_mode:"HTML", ...mainKb });
      }
      if (cmd?.kind==="exit")  return ctx.reply("Диалог завершён. /start чтобы продолжить.", { ...mainKb });
      if (cmd) return runCommand(ex, book, cmd, (m)=>ctx.reply(m, { parse_mode:"HTML" }), (m)=>ctx.reply(m, { parse_mode:"HTML" }), "telegram");
    }

    const parsed = parseLine(text);
    if (!parsed) return ctx.reply(`Неверный формат. Пример:\n<code>l xrp 500 2.45 4h</code>`, { parse_mode:"HTML" });

    if (parsed.kind==="exit")  return ctx.reply("Диалог завершён. /start чтобы продолжить.", { ...mainKb });
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