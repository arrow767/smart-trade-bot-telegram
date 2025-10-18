#!/usr/bin/env node
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { BinanceFutures } from "../exch/BinanceFutures";
import { DEFAULT_PRESET, parseLine, runCommand, TaskBook } from "../core/engine";
import { banner } from "../core/format";

const token = process.env.TELEGRAM_BOT_TOKEN!;
if (!token) { console.error("TELEGRAM_BOT_TOKEN не задан в .env"); process.exit(1); }

const allowedChatsEnv = (process.env.TELEGRAM_ALLOWED_CHAT || "").trim();
const allowedUserEnv  = (process.env.TELEGRAM_ALLOWED_USERNAME || "").trim().toLowerCase();
const allowedChatIds = allowedChatsEnv ? allowedChatsEnv.split(",").map(s=>Number(s.trim())).filter(n=>!Number.isNaN(n)) : [];
function isAllowed(ctx:any){ if (allowedChatIds.length===0 && !allowedUserEnv) return true; const chatId=Number(ctx.chat?.id ?? ctx.from?.id); const user=String(ctx.from?.username||"").toLowerCase(); return allowedChatIds.includes(chatId)|| (!!allowedUserEnv && user===allowedUserEnv); }
function deny(ctx:any){ const chatId=Number(ctx.chat?.id ?? ctx.from?.id); const username=ctx.from?.username?`@${ctx.from.username}`:"(no username)"; return ctx.reply(`Access denied.\nchatId: <code>${chatId}</code>\nuser: <code>${username}</code>`, { parse_mode:"HTML" }); }

const bot = new Telegraf(token);
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
    "  Пример: l xrp 500 2.35 300 2.33 4h",
    "",
    "Редактирование входов:",
    "  edit <taskId> <l|s> <sym> <usd1> <price1> [<usd2> <price2> ...]",
    "  Пример: edit 1 l xrp 200 2.35 100 2.36 100 2.37",
    "",
    "Управление позициями и задачами:",
    "  close <symbol> [percent]      — закрыть позицию полностью/частично",
    "  cancel <taskId>               — отменить задачу",
    "  cancel-all                    — отменить все задачи",
    "  positions | deposit | tasks   — инфо",
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
  if (!isAllowed(ctx)) return deny(ctx);
  await ex.loadMarkets().catch(()=>{});
  await ctx.reply(
    banner("telegram",
      `Готов. Формат: l|s <symbol> <position_usd> <entry> [preset=${DEFAULT_PRESET}]`,
      `Пример: l xrp 500 2.45 4h`),
    { parse_mode: "HTML", ...mainKb }
  );
});

// ✅ HELP: отправляем НОВОЕ сообщение (reply), а не editMessageText —
// чтобы не ловить 400 "message is not modified"
bot.action("HELP", async (ctx)=>{
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  const help = `<pre>${escapeHtml(buildHelpText())}</pre>`;
  await ctx.reply(help, { parse_mode: "HTML", ...mainKb });
});

bot.action("NEW_TRADE", async (ctx)=>{
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  await ctx.reply(`Пришлите строку:\n<code>l xrp 500 2.45 4h</code>`, { parse_mode: "HTML" });
});

bot.action("POS", async (ctx)=>{
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  // Позиции + кнопки «закрыть процент»
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
});

bot.action(/CLOSE\|([a-zA-Z0-9]+)\|([0-9]{1,3})/, async (ctx) => {
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  const symbol = ctx.match![1];
  const pct = Math.max(1, Math.min(100, Number(ctx.match![2])));
  await runCommand(ex, book, { kind:"close", symbol, percent: pct }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
});

bot.action("DEP", async (ctx)=>{
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  await runCommand(ex, book, {kind:"deposit"}, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
});

bot.action("TASKS", async (ctx)=>{
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery();
  // Выводим список + кнопки Cancel для каждого
  const rows = book.list();
  if (!rows.length) return ctx.reply(`Нет активных задач.`, { parse_mode:"HTML" });
  for (const t of rows) {
    const kb = Markup.inlineKeyboard([
      [ Markup.button.callback(`Cancel #${t.id}`, `CANCEL|${t.id}`) ]
    ]);
    const ago = Math.round((Date.now()-t.startedAt.getTime())/1000);
    await ctx.reply(
      `<b>#${t.id}</b> [${t.status}] ${t.symbolCcxt}\n${t.label}\n(+${ago}s)${t.error?`\nERR: ${t.error}`:""}`,
      { parse_mode:"HTML", ...kb }
    );
  }
  // Кнопка «Cancel All» внизу
  await ctx.reply(`Действия:`, { parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel All", "CANCEL_ALL")]]) });
});

bot.action(/CANCEL\|([0-9]+)/, async (ctx)=>{
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery(`Cancel #${ctx.match![1]}`);
  const id = Number(ctx.match![1]);
  await runCommand(ex, book, { kind:"cancel", id }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
});

bot.action("CANCEL_ALL", async (ctx)=>{
  if (!isAllowed(ctx)) return deny(ctx);
  await ctx.answerCbQuery("Cancel all");
  await runCommand(ex, book, { kind:"cancel_all" }, (m)=>ctx.reply(m,{parse_mode:"HTML"}), (m)=>ctx.reply(m,{parse_mode:"HTML"}), "telegram");
});

// /whoami для whitelisting
bot.command("whoami", (ctx)=>{
  const chatId = Number(ctx.chat?.id ?? ctx.from?.id);
  const username = ctx.from?.username ? `@${ctx.from.username}` : "(no username)";
  return ctx.reply(`chatId: <code>${chatId}</code>\nusername: <code>${username}</code>`, { parse_mode: "HTML" });
});

// Любой текст — пробуем как команду
bot.on("text", async (ctx)=>{
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
});

bot.launch().then(()=> console.log("Telegram bot started.")).catch(console.error);
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ---- utils ----
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
