# Новая переменная окружения для .env

## TELEGRAM_TRADE_NOTIFICATIONS

Включить/выключить уведомления о сделках в Telegram.

### Значения:
- `true` или `1` — уведомления **включены** (по умолчанию)
- `false` или `0` — уведомления **выключены**

### Пример добавления в .env:

```env
# ✅ Включить уведомления (по умолчанию)
TELEGRAM_TRADE_NOTIFICATIONS=true

# ❌ Выключить уведомления
# TELEGRAM_TRADE_NOTIFICATIONS=false
```

### Если не указана

Если переменная не указана в `.env`, уведомления будут **включены** по умолчанию.

### Где добавить

Добавьте эту строку в ваш `.env` файл в раздел Telegram настроек, например после `TELEGRAM_BOT_TOKEN`:

```env
# Telegram Bot settings
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Telegram Trade Notifications
TELEGRAM_TRADE_NOTIFICATIONS=true

# Telegram whitelist
TELEGRAM_ALLOWED_CHAT=
TELEGRAM_ALLOWED_USERNAME=@your_username
```

