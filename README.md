# Quant Futures Trader CLI — README

> Этот README заточен под **Codex / GPT-5** и разработчиков: быстрое понимание архитектуры, запуск, команды, инварианты и «безопасные точки» для рефакторинга.

---

## 🧭 Назначение

CLI/бот для торговли **USDT-M фьючерсами Binance** с поддержкой:

* **Многоэтапных входов (legs)**: LIMIT/STOP, учет шагов qty/price.
* **Пропорционального риска**: SL адаптируется к фактически набранной доле позиции и пересчитывается при каждом доборе.
* **TP-ступеней (reduce-only)** по пресету (R-множители и распределение объёма).
* Корректной обработки **ручного снятия отложек** (grace-таймаут, без конфликтов, без «ложных» отмен задач).
* Команд для позиций/ордеров/пресетов; персист задач в `data/tasks.json`.

---

## 🗂️ Структура проекта

```
.vscode/
config/
  trading_config.json          # пресеты (JSON хранилище)
data/
  tasks.json                   # персист активных задач
node_modules/
src/
  auth/
    whitelist.ts               # белый список (для телеграм-бота)
  bot/
    telegram.ts                # Telegram-бот, прокидывает команды в движок
  config/
    trading_config.ts          # CRUD пресетов + типы TradingPreset
  core/
    engine.ts                  # основной движок и фоновые циклы
    format.ts                  # форматирование вывода (консоль/бот)
    Planner.ts                 # расчёт TP-цен из R и пресета
    SymbolResolver.ts          # normalizeTickerToUsdt → SYMBOL/USDT:USDT
  exch/
    BinanceFutures.ts          # обёртка над Binance Futures (ccxt / REST)
  utils/
    # splitQtyToStep, mergeDustToPrev, математика шагов/precision
  index.ts                     # CLI-вход: парсер команд → engine
.env
.env.example
.gitignore
bun.lock
package-lock.json
package.json
README.md
tsconfig.json
```

> Если в `utils/` нет некоторых утилит — добавляйте по мере расширения (см. «Фикстуры» и «Юнит-тесты» ниже).

---

## ⚙️ Установка и запуск

### Требования

* **Node.js ≥ 18** (поддерживается также **Bun ≥ 1.1**).
* API-ключи Binance USDT-M с правами **READ/TRADE**.

### Установка зависимостей

```bash
npm i          # или pnpm i / yarn
npm run build  # если нужна явная сборка TS → JS
```

### Конфигурация `.env`

Скопируйте `.env.example` → `.env` и заполните значения:

```dotenv
BINANCE_API_KEY=xxx
BINANCE_API_SECRET=xxx

# Telegram-бот (опционально, если используете src/bot/telegram.ts)
TELEGRAM_BOT_TOKEN=xxx                   # токен бота
TELEGRAM_ALLOWED_CHAT=                   # числовой chat_id для whitelist (опц.)
TELEGRAM_ALLOWED_USERNAME=@unknown_user010309  # username для whitelist (опц.)

# Логирование Telegraf (если используете)
TELEGRAF_SKIP_REDACT=true                # флаг отключения редактирования логов
TELEGRAF_SKIP_REDACT=true                # (дубликат в примере — можно оставить один)

# Источник триггера для стоп-ордеров:
#   contract — (по умолч.) триггер по контрактной цене (last)
#   mark     — триггер по mark price
TRIGGER_PRICE_SOURCE=contract

# Сдвиг триггера SL/STOP относительно источника (целое >= 0), сглаживает ложные срабатывания.
# Например, 1 → отодвинуть на 1*tickSize в «безопасную» сторону.
TRIGGER_TICK_OFFSET=1

# Интервал цикла наблюдателя (мс). Дефолт: 400 (2.5 Гц).
OBSERVER_INTERVAL_MS=400

# Recovery loop (после рестарта / как страховка): раз в N мс проверяет задачи и позицию,
# и если SL/TP не выставлены при существующей позиции — довыставляет.
RECOVERY_ENABLED=true
RECOVERY_INTERVAL_MS=10000

# Удаление висячих задач: если по символу НЕТ позиций и НЕТ никаких открытых ордеров
# (обычных и algo), и так держится дольше grace-time — задача(и) удаляются.
RECOVERY_ORPHAN_ENABLED=true
RECOVERY_ORPHAN_GRACE_MS=60000
```

> Примечание: в вашем `env.example` флаг `TELEGRAF_SKIP_REDACT` задублирован — это не мешает, но в реальном `.env` лучше оставить **одну** строку.

### Запуск

```bash
# CLI
npm start
# или (если собрали)
node dist/index.js

# Через Bun (если хотите):
bun run src/index.ts
```

---

## 🧩 Пресеты и риск-модель

Файл: **`config/trading_config.json`**, API: **`src/config/trading_config.ts`**.

Поля:

* `trade_risk` — **$-риск на сделку** (максимум).
* `take_profit` — массив **R-множителей** (например `[3, 5, 7]`).
* `take_profit_ratio` — распределение объёма по TP в % (например `[35, 30, 35]`).

Инвариант: длины `take_profit` и `take_profit_ratio` должны совпадать.

### Пропорциональный риск по legs

Пусть `trade_risk = $100`, legs: `$2000` и `$8000` (итого `$10000`).

* Исполнился первый leg на `$2000`: **effectiveRiskUsd = 100 × (2000/10000) = $20**.
  SL ставится так, чтобы убыток на **текущую** позицию был ≈ $20.
* Исполнился второй leg: позиция ≈ `$10000` → **effectiveRiskUsd = $100**.
  SL **переставляется**.

Формула целевого SL:

```
perContractLoss = effectiveRiskUsd / positionQty
desiredSL = (long)  entryAvg - perContractLoss
          = (short) entryAvg + perContractLoss
```

Далее SL **сдвигается** от текущего mark не менее, чем на `max(TRIGGER_TICK_OFFSET, 2)*tickSize`, чтобы избежать мгновенного триггера.

---

## 💻 Команды CLI

Шорткаты: `1=positions`, `2=deposit`, `3=tasks`, `9=help`, `0=exit`

### Торговля

* **Маркет-вход:**
  `l <sym> <usd> [preset]`
  `s <sym> <usd> [preset]`
* **Много ног (LIMIT/STOP):**
  `l|s <sym> <usd1> <price1> [<usd2> <price2> ...] [preset]`
* **Только превью:** `--dry`

> Важно: цены можно вводить с точкой или запятой (например `2.45` или `2,45`).

### Пресеты

* `preset list` / `preset show <name>`
* `preset set <name> risk=100 tp=3,5,7 ratio=35,30,35 [default=true]`
* `preset delete <name>`

### Позиции / Депозит / Задачи

* `positions` — открытые позиции
* `deposit` — фьючерс/спот баланс + unrealized PnL
* `tasks` — активные задачи
* `info <taskId>` — детализация задачи
* `cancel <taskId>` / `cancel-all` — снять задачу(и) с ордерами

### Ордеры

* `orders [symbol]`
* `cancel order <id>`
* `cancel limit <symbol>` / `cancel stop <symbol>`
* `cancel-all orders|limit orders|stop orders`

### Редактирование входов

* `edit <taskId> <l|s> <sym> <usd1> <price1> [<usd2> <price2> ...]`

### Закрытие позиции

* `close <symbol> [percent]` — закрыть % маркетом (учитывает существующие reduce-only; при полном закрытии снимает оставшиеся лимитки).

---

## 🧠 Обработка ручного снятия отложек (важно)

Механика (в `core/engine.ts`):

1. Движок хранит `keep` — набор id входных ордеров задачи.
2. Каждую итерацию:

   * Если id **исчез** из `fetchOpenOrders`, фиксируется время и текущий `posSize`.
   * В течение **grace-окна** (по умолчанию ~4s) смотрим, **выросла ли позиция**:

     * Выросла → считаем, что ордер **исполнен**. Удаляем id из `keep`. Задача продолжает жить.
     * Не выросла:

       * Если **позиции нет** и **все входы** этой задачи исчезли → трактуем как **ручное снятие**: снимаем остатки ордеров **этой задачи**, удаляем задачу.
       * Если **позиция есть** → просто забываем этот id, **ничего** дополнительно **не снимаем**. Конфликтов с другими задачами/символами нет.

> Это гарантирует, что «снял руками одну из двух отложек» не убивает задачу, если часть позиции уже есть.

---

## 📐 Инварианты кода (не ломать)

* Все qty/price проходят через `getSymbolFilters` + `amountToPrecision/priceToPrecision`.
* Риск **всегда пропорционален** фактически набранной доле / плану задачи.
* SL **переставляется** при **каждом увеличении** позиции; учитывает `TRIGGER_PRICE_SOURCE` и `TRIGGER_TICK_OFFSET`.
* TP выставляются **однократно** после финального добора; все **reduce-only**.
* Обработка исчезнувших входов — только **grace + проверка роста позиции**.

---

## 🧪 Фикстуры, Докстринги/инварианты, «Якоря» для рефакторинга

### Фикстуры

Готовые сценарии/данные для тестов:

* JSON-фильтры символов (`minQty`, `stepSize`, `tickSize`) — `fixtures/filters/*.json`.
* Сценарии:

  * «2 отложки: одна исполнилась, вторую сняли → позиция есть → задача остаётся».
  * «все отложки сняли при flat → задача удаляется».

### Докстринги/комменты-инварианты

Короткие JSDoc над ключевыми функциями:

```ts
/**
 * [RISK:PROPORTIONAL_SL]
 * SL рассчитывается из effectiveRiskUsd = preset.trade_risk * min(1, positionUsd / totalPlannedUsd).
 * Возврат: цена в precision(symbol).
 */
```

### Метки-якоря (для Codex)

Единые теги-комментарии, куда можно безопасно добавлять код:

```ts
// [ENTRY:PLACE_ORDERS]
// [ENTRY:DISAPPEARANCE_HANDLING]
// [SL:ADJUST_FOR_MARK]
// [TP:PLACE_ONCE_AFTER_FINAL_ACCUMULATION]
```

---

## 🔌 Контракт `exch/BinanceFutures.ts`

Обязательные методы:

* `loadMarkets()`, `market(symbol)`
* `getSymbolFilters(symbol)` → `{ minQty, stepSize, tickSize }`
* `amountToPrecision(symbol, q)`, `priceToPrecision(symbol, p)`
* `fetchTicker(symbol)` → `mark/last`
* `fetchOpenOrders(symbol)`, `cancelOrder(symbol, id)`, `cancelAllOrders(symbol)`
* `createLimit(symbol, side, qty, price)`
* `createStopMarketEntry(symbol, side, qty, stopPrice)`
* `createStopMarketClose(symbol, side, stopPrice)`
* `createReduceOnlyLimit(symbol, side, qty, price)`
* `createReduceOnlyMarket(symbol, side, qty?)`
* `fetchAllOpenPositions()` / `fetchPositionSize(symbol)`

> Весь сетевой/биржевой слой локализован здесь. Остальной код бирже-агностичен.

---

## 📝 Логирование

* Единые префиксы: `[MAIN]`, `[HTTP]`, `[WS]`, `[CLI]`, `[BOT]`.
* ISO-время, короткие структурные сообщения.
* Если используете Telegraf — `TELEGRAF_SKIP_REDACT=true` отключает «замазывание» полей в логах.

---

## 🧪 Тесты (рекомендуемая заготовка)

```
test/
  math.spec.ts                 # splitQtyToStep/mergeDustToPrev/precision
  risk.spec.ts                 # calcDesiredSLByRiskUsd + пропорции
  engine.fixture.spec.ts       # сценарии исчезновения входов
fixtures/
  filters/
    BTCUSDT.json
    XRPUSDT.json
```

Запуск: `npm test` (добавьте Jest/Vitest по вкусу).

---

## ✅ Чек-лист перед мерджем

* [ ] Qty/price → precision/filter.
* [ ] SL пересчитывается при **каждом доборе** из **effectiveRiskUsd**.
* [ ] TP выставлены один раз, **reduce-only**.
* [ ] Ручное снятие: **grace** + **рост позиции**; удаление задачи только когда **flat** и исчезли **все** входы задачи.
* [ ] `help` актуален, `data/tasks.json` обновляется.

---



## 📬 Быстрые ссылки в коде

* Пресеты и риск-логика: `src/config/trading_config.ts`
* Движок: `src/core/engine.ts`
* Обёртка биржи: `src/exch/BinanceFutures.ts`
* CLI: `src/index.ts`
* Телеграм-бот: `src/bot/telegram.ts`
* Белый список: `src/auth/whitelist.ts`
