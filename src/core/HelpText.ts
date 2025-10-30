import { UIMode } from "./format";

/**
 * Строит текст справки
 */
export function buildHelp(mode: UIMode): string {
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
    "Управление позициями и задачами:",
    "  close <symbol> [percent]",
    "  cancel <taskId>",
    "  cancel-all",
    "  info <taskId>",
    "  positions | deposit | tasks",
    "",
    "Ордеры:",
    "  orders [symbol]",
    "  cancel order <id>",
    "  cancel limit <symbol>",
    "  cancel stop <symbol>",
    "  cancel-all orders / limit orders / stop orders",
    "",
    "Пресеты:",
    "  preset list/show/set/default/delete",
  ];
  return lines.join("\n");
}

