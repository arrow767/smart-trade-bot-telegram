import fs from "fs";
import path from "path";

export type Allowed = {
  chatIds: number[];
  usernames: string[]; // в lower-case
};

// где храним привязку
const STORE = path.resolve(process.cwd(), "allowed.json");

// прочитать из файла, если есть
function readStore(): Allowed {
  try {
    const raw = fs.readFileSync(STORE, "utf8");
    const data = JSON.parse(raw);
    return {
      chatIds: Array.isArray(data.chatIds) ? data.chatIds.map(Number).filter(n => Number.isFinite(n)) : [],
      usernames: Array.isArray(data.usernames) ? data.usernames.map((s: string) => String(s || "").toLowerCase()) : [],
    };
  } catch {
    return { chatIds: [], usernames: [] };
  }
}

// записать файл
function writeStore(a: Allowed) {
  fs.writeFileSync(STORE, JSON.stringify(a, null, 2), "utf8");
}

// статическая конфигурация из .env
function allowedFromEnv(): Allowed {
  const chats = String(process.env.TELEGRAM_ALLOWED_CHAT || "").trim();
  const users = String(process.env.TELEGRAM_ALLOWED_USERNAME || "").trim().toLowerCase();
  const chatIds = chats ? chats.split(",").map(s => Number(s.trim())).filter(n => !Number.isNaN(n)) : [];
  const usernames = users ? [users] : [];
  return { chatIds, usernames };
}

/**
 * Источник прав:
 * 1) Если .env содержит хоть что-то (chatId/username) — используем только его (без автопривязки).
 * 2) Иначе — читаем/пишем allowed.json; если пусто, первый /start добавит chatId.
 */
export class Whitelist {
  private envAllowed: Allowed;
  private fileAllowed: Allowed;

  constructor() {
    this.envAllowed = allowedFromEnv();
    this.fileAllowed = readStore();
  }

  // true — если whitelist зафиксирован через .env
  get lockedByEnv(): boolean {
    return this.envAllowed.chatIds.length > 0 || this.envAllowed.usernames.length > 0;
  }

  // проверить доступ
  isAllowed(chatId?: number, username?: string): boolean {
    const userLc = String(username || "").toLowerCase();

    if (this.lockedByEnv) {
      const a = this.envAllowed;
      return (chatId != null && a.chatIds.includes(chatId)) ||
             (!!userLc && a.usernames.includes(userLc)) ||
             (a.chatIds.length === 0 && a.usernames.length === 0); // на всякий случай
    }

    const a = this.fileAllowed;
    return (chatId != null && a.chatIds.includes(chatId)) ||
           (!!userLc && a.usernames.includes(userLc));
  }

  // автопривязка первого пользователя (если не зафиксировано .env и список пуст)
  bindFirstIfEmpty(chatId: number, username?: string) {
    if (this.lockedByEnv) return; // .env управляет — не трогаем файл
    const hasAny = this.fileAllowed.chatIds.length > 0 || this.fileAllowed.usernames.length > 0;
    if (hasAny) return;

    this.fileAllowed.chatIds = [chatId];
    if (username) this.fileAllowed.usernames = [String(username).toLowerCase()];
    writeStore(this.fileAllowed);
  }

  // для /whoami удобный вывод
  static formatDenied(chatId: number|undefined, username: string|undefined) {
    const u = username ? `@${username}` : "(no username)";
    const c = chatId != null ? String(chatId) : "n/a";
    return `Access denied.\nchatId: <code>${c}</code>\nuser: <code>${u}</code>`;
  }
}
