# MoneyForUp — стартовый бот для Telegram

Рабочий бот под Mini App: открывает игру кнопкой, считает токены, принимает оплату **картой и по СБП через Platega**, **крипту через Heleket и CryptoBot**, **звёзды через Telegram Stars** (плюс ручные заявки по СБП), ведёт **стейкинг 1 % в сутки** и платит **15 % с пополнений приглашённых**.

## Быстрый старт (5 минут)

> Полная инструкция по деплою (хостинг, BotFather, вебхуки, приёмка, траблшутинг) — в `../tutorial-miniapp.md`.

```bash
cd bot
npm i
cp .env.example .env          # впишите BOT_TOKEN, APP_URL, PUBLIC_URL, ADMIN_ID и ключи платёжек
npm start                     # или: node --env-file=.env bot.js
```

Бот поднимется на long-polling, а HTTP-API — на `API_PORT` (по умолчанию 3000).

## Команды бота

| Команда | Что делает |
|---|---|
| `/start` | приветствие + кнопка «Открыть MoneyForUp», принимает реферальный код (`/start MFU-4827`) |
| `/balance` | баланс токенов и рублёвый эквивалент |
| `/buy 3000` | счёт на 3000 ⬦ через **Telegram Stars** (нативная оплата) |
| `/pay 300` | счёт на 300 ₽ с оплатой **картой или по СБП** через **Platega** |
| `/heleket 300` | счёт на 300 ₽ в крипте (USDT, BTC, ETH) через **Heleket** |
| `/crypto 300` | счёт на 300 ₽ в USDT / TON / BTC через **CryptoBot** |
| `/sbp 300` | заявка на 300 ₽ по СБП: админу приходит сообщение с кнопкой «Подтвердить оплату» |
| `/stake 500` | вложить токены в стейкинг (1 % в сутки, простые проценты по секундам) |
| `/claim` | забрать накопленные проценты, не снимая тело стейкинга |
| `/unstake` | снять всё: тело + проценты |
| `/ref` | реферальная ссылка, приглашённые, заработано (15 % с каждого пополнения) |

Проценты стейкинга и реферальные начисления начисляются на **серверный** баланс — их нельзя подделать из браузера. Реферальные 15 % приходят рефереру автоматически после оплаты, плюс ему уходит уведомление от бота.

## HTTP-API для игры

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/api/balance` | `{ initData }` | `{ tokens }` |
| POST | `/api/terms` | `{ initData }` | отметка о принятии пользовательского соглашения |
| POST | `/api/stake` \| `/api/claim` \| `/api/unstake` | `{ initData, [amount] }` | `{ staked, accrued, tokens }` |
| GET | `/api/refs` | `{ initData }` | `{ link, invited, earned, percent: 15, list }` |
| POST | `/api/invoice` | `{ initData, tokens, rub, termsAcceptedAt }` | `{ invoice_link, tokens }` |
| POST | `/api/crypto-invoice` | `{ initData, rub, termsAcceptedAt }` | `{ pay_url, invoice_id, tokens }` |
| POST | `/api/check-crypto` | `{ initData, invoice_id }` | `{ paid, tokens }` |
| POST | `/api/platega-invoice` | `{ initData, rub, termsAcceptedAt }` | `{ pay_url, invoice_id, tokens }` |
| POST | `/api/check-platega` | `{ initData, invoice_id }` | `{ paid, tokens }` |
| POST | `/api/heleket-invoice` | `{ initData, rub, termsAcceptedAt }` | `{ pay_url, invoice_id, tokens }` |
| POST | `/api/check-heleket` | `{ initData, invoice_id }` | `{ paid, tokens }` |
| POST | `/api/order-sbp` | `{ initData, rub, termsAcceptedAt }` | `{ order_id, tokens }` |
| POST | `/platega-webhook` | уведомление Platega (заголовки `X-MerchantId`, `X-Secret`) | `{ ok }` |
| POST | `/heleket-webhook` | уведомление Heleket (подпись в теле) | `{ ok }` |
| POST | `/cryptobot-webhook` | уведомление от CryptoBot | `{ ok }` |

Эндпоинты оплаты возвращают **403**, если пользователь не принял соглашение (`termsAcceptedAt` пустой). Это серверная страховка: без галочки в приложении счёт не создастся даже через прямой запрос.

Все запросы проверяют `initData` по HMAC-SHA256 с секретом `HMAC_SHA256("WebAppData", BOT_TOKEN)` и отбрасывают всё старше 24 часов. Без этой проверки кто угодно сможет назваться любым пользователем.

## Как связать с игрой

В файле `moneyforup-tg.html` в начале скрипта есть строка:

```js
const API_BASE=(typeof window.MONEYFORUP_API==='string'?window.MONEYFORUP_API:(typeof window.MATHPLAY_API==='string'?window.MATHPLAY_API:''));
```

Вариант А (правильный): положите перед подключением скрипта игры

```html
<script>window.MONEYFORUP_API='https://api.ваш-домен.ru';</script>
```

Вариант Б: впишите адрес прямо в `API_BASE` (для новых сборок используется `window.MONEYFORUP_API`, старое имя `window.MATHPLAY_API` тоже поддерживается).

Если `API_BASE` пустой — игра работает в демо-режиме: баланс хранится в localStorage браузера, оплата имитируется. Это удобно для тестов, но **небезопасно для реальных денег**: баланс обязан жить на сервере.

## Что заменить для продакшена

1. **Хранилище**: сейчас `users`/`orders` — это `Map` в памяти (обнуляется при перезапуске). Возьмите SQLite (`better-sqlite3`), Postgres (`pg`) или Supabase. Минимальная схема:

```sql
CREATE TABLE users (
  id BIGINT PRIMARY KEY,          -- telegram user id
  name TEXT,
  tokens BIGINT NOT NULL DEFAULT 1000,
  stars BIGINT NOT NULL DEFAULT 0,
  ref TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,            -- уникальный id = идемпотентность
  user_id BIGINT NOT NULL,
  tokens BIGINT NOT NULL,
  rub NUMERIC(10,2),
  stars BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed
  created_at TIMESTAMPTZ DEFAULT now(),
  paid_at TIMESTAMPTZ
);
```

2. **Идемпотентность**: любой платёж зачисляйте один раз — по `order_id` и статусу. Telegram может повторить доставку `successful_payment`, а агрегатор — вебхук.
3. **Вебхуки вместо опроса**: переведите бота на `webhookCallback` (подойдёт и для serverless), а API закройте перед nginx/Caddy с HTTPS.
4. **Вебхуки платёжек**: в кабинете Platega укажите `https://<бэкенд>/platega-webhook` (запросы проверяются по заголовкам `X-MerchantId` и `X-Secret`), для Heleket адрес подставляется автоматически из `PUBLIC_URL` (`/heleket-webhook`, подпись `md5(base64(body без sign) + API_KEY)`). Если вебхук не дошёл, приложение само опрашивает статус: `/api/check-platega`, `/api/check-heleket`, `/api/check-crypto`.
5. **Вебхук CryptoBot**: в @CryptoBot → Crypto Pay → My Apps укажите `https://<ваш-бэкенд>/cryptobot-webhook`. Подпись проверяется как `HMAC-SHA256(rawBody, SHA256(CRYPTOBOT_TOKEN))` — сравнение в константном времени. Если вебхук недоступен, игра всё равно подхватит оплату: при открытом счёте она опрашивает `/api/check-crypto`.
6. **Чеки и налоги**: в РФ для приёма от физлиц нужна онлайн-касса (54-ФЗ) — её обычно даёт агрегатор (ЮKassa, Т-Банк Касса). Telegram Stars закрывает чеки сам, но берёт ~30 %.

### Тесты

```bash
cd ../tests
node bot-test.js        # 29 проверок: подписи Platega/Heleket, вебхуки, идемпотентность, реферальные 15 %
```

Тест поднимает мок-сервер платёжек и запускает бота с `BOT_DRY_RUN=1` — Telegram не опрашивается.

## Комиссии (для справки)

| Способ | Комиссия | Подключение |
|---|---|---|
| Heleket (крипта) | от 0.4 % | ключ API + `PUBLIC_URL` для вебхука |
| Platega (карта / СБП) | от 4–5 % (торгуется) | merchant id и secret из кабинета |
| Telegram Stars | ~30 % | 1 команда BotFather, ничего больше не нужно |
| CryptoBot | приём без комиссии (вывод ~5 % через P2P) | токен приложения |
| СБП вручную (этот бот, `/sbp`) | 0 % | ничего, но подтверждает админ |

## Полезные ссылки

- BotFather: `@BotFather` → `/newbot`, `/newapp`, `/myapps` (Mini App и кнопка меню)
- Документация Mini Apps: https://core.telegram.org/bots/webapps
- Оплата звёздами: https://core.telegram.org/bots/payments-stars
- grammY (фреймворк бота): https://grammy.dev
