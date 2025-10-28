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
        };
        this.tasks.set(t.id, t);
      }
    } catch {}
  }

  add(symbolCcxt: string, label: string, extras?: { side?: "long"|"short"; totalUsd?: number; presetName?: string }) {
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
}

