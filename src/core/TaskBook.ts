import fs from "fs";
import path from "path";
import { Task, TaskStatus } from "./types";

// ======== persist tasks to JSON ========
const DATA_DIR = path.resolve(process.cwd(), "data");
const TASKS_JSON = path.join(DATA_DIR, "tasks.json");

function ensureDir(pth: string) {
  try { fs.mkdirSync(pth, { recursive: true }); } catch {}
}

let TASK_ID_SEQ = 1;

export class TaskBook {
  public tasks = new Map<number, Task>();

  constructor() {
    this.load();
    // восстановим последовательность идентификаторов
    for (const id of this.tasks.keys()) TASK_ID_SEQ = Math.max(TASK_ID_SEQ, id + 1);
    
    // ✅ НОВОЕ: Автоочистка старых tasks со status=error
    this.cleanupOldErrorTasks();
  }

  /** ✅ НОВОЕ: Очистка tasks со status=error старше AUTO_CLEANUP_DAYS дней */
  private cleanupOldErrorTasks() {
    const AUTO_CLEANUP_DAYS = Number(process.env.AUTO_CLEANUP_ERROR_TASKS_DAYS || 3);
    const now = Date.now();
    const cutoff = now - AUTO_CLEANUP_DAYS * 24 * 60 * 60 * 1000;
    
    let removed = 0;
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === "error" && task.updatedAt && task.updatedAt.getTime() < cutoff) {
        this.tasks.delete(id);
        removed++;
      }
    }
    
    if (removed > 0) {
      console.log(`🧹 Автоочистка: удалено ${removed} старых tasks со status=error (>${AUTO_CLEANUP_DAYS} дней)`);
      this.save();
    }
  }

  private save() {
    try {
      ensureDir(DATA_DIR);
      const out = JSON.stringify(
        Array.from(this.tasks.values()).map(t => ({
          ...t,
          startedAt: t.startedAt?.toISOString?.() ?? new Date().toISOString(),
          updatedAt: t.updatedAt?.toISOString?.() ?? new Date().toISOString(),
        })),
        null,
        2
      );
      fs.writeFileSync(TASKS_JSON, out, "utf-8");
    } catch {}
  }

  private load() {
    try {
      if (!fs.existsSync(TASKS_JSON)) return;
      const raw = JSON.parse(fs.readFileSync(TASKS_JSON, "utf-8")) as any[];
      for (const o of raw || []) {
        const t: Task = {
          id: Number(o.id),
          symbolCcxt: String(o.symbolCcxt),
          label: String(o.label),
          status: String(o.status) as TaskStatus,
          error: o.error ? String(o.error) : undefined,
          startedAt: new Date(o.startedAt),
          updatedAt: new Date(o.updatedAt),
          entryOrderIds: Array.isArray(o.entryOrderIds) ? o.entryOrderIds.map(String) : [],
          cancelRequested: !!o.cancelRequested,
          side: (o.side === "long" || o.side === "short") ? o.side : undefined,
          totalUsd: Number(o.totalUsd || 0) || undefined,
          presetName: o.presetName ? String(o.presetName) : undefined,
          riskUsd: Number(o.riskUsd || 0) || undefined,
        };
        this.tasks.set(t.id, t);
      }
    } catch {}
  }

  add(
    symbolCcxt: string,
    label: string,
    extras?: { side?: "long" | "short"; totalUsd?: number; presetName?: string; riskUsd?: number }
  ) {
    const t: Task = {
      id: TASK_ID_SEQ++,
      symbolCcxt,
      label,
      status: "queued",
      startedAt: new Date(),
      updatedAt: new Date(),
      side: extras?.side,
      totalUsd: extras?.totalUsd,
      presetName: extras?.presetName,
      riskUsd: (typeof extras?.riskUsd === "number" && Number.isFinite(extras.riskUsd) && extras.riskUsd > 0) ? extras.riskUsd : undefined,
    };
    this.tasks.set(t.id, t);
    this.save();
    return t;
  }

  set(t: Task, s: TaskStatus, err?: string) {
    t.status = s;
    t.updatedAt = new Date();
    if (err) t.error = err;
    this.save();
  }

  list() {
    return Array.from(this.tasks.values()).sort((a, b) => a.id - b.id);
  }

  get(id: number) {
    return this.tasks.get(id);
  }

  setEntryOrders(t: Task, ids: string[]) {
    t.entryOrderIds = ids;
    t.updatedAt = new Date();
    this.save();
  }

  requestCancel(id: number) {
    const t = this.tasks.get(id);
    if (t) {
      t.cancelRequested = true;
      t.updatedAt = new Date();
      this.save();
    }
  }

  requestCancelAll() {
    for (const t of this.tasks.values()) t.cancelRequested = true;
    this.save();
  }

  /** Полное удаление таски */
  remove(id: number) {
    this.tasks.delete(id);
    this.save();
  }

  /** ✅ НОВОЕ: Получить все задачи по символу */
  getBySymbol(symbolCcxt: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.symbolCcxt === symbolCcxt);
  }

  /** ✅ НОВОЕ: Получить все входные ордера по символу (для всех задач) */
  getAllEntryOrderIdsBySymbol(symbolCcxt: string): Set<string> {
    const all = new Set<string>();
    for (const t of this.tasks.values()) {
      if (t.symbolCcxt === symbolCcxt && t.entryOrderIds) {
        t.entryOrderIds.forEach(id => all.add(id));
      }
    }
    return all;
  }

  /** 
   * ✅ НОВОЕ: Проверка и удаление висячих tasks (отложки пропали, позиции нет).
   * Вызывается периодически из фонового обработчика.
   * @param ex - биржевой клиент для проверки ордеров и позиций
   * @param symbolCcxt - символ для проверки
   * @param minQty - минимальный размер позиции
   */
  async cleanupOrphanTasks(
    ex: any, 
    symbolCcxt: string, 
    minQty: number,
    log: (msg: string) => void
  ) {
    const tasks = this.getBySymbol(symbolCcxt);
    if (!tasks.length) return;

    try {
      // ✅ ИСПРАВЛЕНО: Получаем ВСЕ открытые ордера, включая Algo Orders
      const open = (await ex.fetchOpenOrders(symbolCcxt)) as any[];
      let algoOrders: any[] = [];
      try {
        algoOrders = await ex.fetchOpenAlgoOrders(symbolCcxt);
      } catch {}
      
      // Объединяем обычные и Algo ордера для проверки
      const allOpenOrders = [...open, ...algoOrders];
      const allOpenOrderIds = new Set<string>();
      for (const o of allOpenOrders) {
        const id = String(o.id || o.algoId || o.orderId || "");
        const clientId = String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "");
        if (id) allOpenOrderIds.add(id);
        if (clientId) allOpenOrderIds.add(clientId);
      }
      
      const posSize = Math.abs(await ex.fetchPositionSize(symbolCcxt));
      const flat = posSize < Math.max(minQty * 0.5, 1e-12);

      for (const task of tasks) {
        // ✅ ИСПРАВЛЕНО: Пропускаем активные статусы задач
        // Активные статусы: задачи, которые еще работают или ожидают исполнения
        const activeStatuses: TaskStatus[] = ["queued", "waiting_fill", "placing_bracket", "filled", "live"];
        if (activeStatuses.includes(task.status)) continue;
        
        // Пропускаем финальные статусы (они уже обработаны)
        if (task.status === "done" || task.status === "canceled") continue;
        
        // ✅ ИСПРАВЛЕНО: Проверяем ордера по ID и clientOrderId (как в engine.ts)
        const hasEntryOrders = (task.entryOrderIds || []).some(id => {
          const idStr = String(id);
          return allOpenOrderIds.has(idStr) || 
                 allOpenOrders.some((o: any) => 
                   String(o.clientOrderId || o.clientAlgoId || o.newClientOrderId || "") === idStr
                 );
        });
        
        // Висячая задача: нет входных ордеров на бирже, позиция flat, и статус не активный
        // Удаляем только задачи со статусом "error" или "flat" (или другие неактивные статусы)
        if (!hasEntryOrders && flat) {
          log(`🧹 Висячая задача #${task.id} (${symbolCcxt}): отложек нет, позиции нет → удаляю`);
          this.remove(task.id);
        }
      }
    } catch {}
  }
}

