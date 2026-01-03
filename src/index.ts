#!/usr/bin/env node
import "dotenv/config";
import readline from "node:readline";
import { BinanceFutures } from "./exch/BinanceFutures";
import { DEFAULT_PRESET, parseLine, runCommand, TaskBook } from "./core/engine";
import { banner } from "./core/format";
import { startTaskRecoveryLoop } from "./core/recovery";

async function main(){
  const ex = new BinanceFutures();
  await ex.init(); // Синхронизация времени перед первым запросом
  await ex.loadMarkets();
  const book = new TaskBook();
  startTaskRecoveryLoop(ex, book, (m) => console.log(m));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  console.log(banner("console",
    `Пример: l xrp 5000 3  (preset по умолчанию: ${DEFAULT_PRESET})`,
    `Быстрые: 1=positions  2=deposit  3=tasks  9=help  0=exit | Дополнительно: cancel <id>, cancel-all, close <symbol> [percent]`
  ));
  rl.prompt();

  rl.on("line", async (line) => {
    try{
      const parsed = parseLine(line);
      // DEBUG: показать что распарсилось для risk_calc
      if (!parsed) { console.log("Неверный ввод. Пример: l xrp 5000 3"); rl.prompt(); return; }
      if (parsed.kind === "exit"){ console.log("Выход."); process.exit(0); }
      await runCommand(ex, book, parsed, (m)=>console.log(m), (m)=>console.log(m), "console");
    }catch(e:any){
      console.error(`[ERROR] ${e?.message ?? e}`);
    }finally{
      rl.prompt();
    }
  });

  rl.on("close", ()=>{ console.log("Выход."); process.exit(0); });
}
main().catch(e=>{ console.error(e); process.exit(1); });
