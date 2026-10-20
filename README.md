# MoneyForUp — стартовый бот для Telegram

Рабочий бот под Mini App: открывает игру кнопкой, считает токены, принимает оплату **картой и по СБП через Platega**, **крипту через Coinso**, **звёзды через Telegram Stars** (плюс ручные заявки по СБП с подтверждением админа в 1 клик), ведёт **стейкинг 1 % в сутки** и платит **15 % с пополнений приглашённых**.

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
| `/coinso 300` | счёт на 300 ₽ в крипте (USDT, TON, BTC) через **Coinso** |
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
| POST | `/api/play` (алиас `/api/record-bet`) | `{ initData, game, bet, mult, roundId }` | исход раунда считает **сервер**: `{ win, mult, tokens, item? }` |
| POST | `/api/inventory` · `/api/inventory/sell` · `/api/inventory/sell-all` | `{ initData, [itemId] }` | предметы кейсов живут на сервере (`items.js`), цена продажи — серверная |
| POST | `/api/platega-invoice` | `{ initData, rub, termsAcceptedAt }` | `{ pay_url, invoice_id, tokens }` |
| POST | `/api/check-platega` | `{ initData, invoice_id }` | `{ paid, tokens }` |
| POST | `/api/coinso-invoice` | `{ initData, rub, termsAcceptedAt }` | `{ pay_url, invoice_id, order_id, tokens }` |
| POST | `/api/check-coinso` | `{ initData, invoice_id, order_id }` | `{ paid, tokens }` |
| POST | `/api/cases/catalog` | `{ initData }` | пять новых режимов, предметы, шансы, история |
| POST | `/api/cases/open` | `{ initData, modeId, requestId }` | `{ drop, tokens, duplicate }` — цена и дроп серверные |
| POST | `/api/cases/history` | `{ initData, limit? }` | журнал открытий игрока |
| POST | `/api/upgrade/catalog` | `{ initData }` | режимы риска SAFE/BALANCED/EXTREME, цели, инвентарь, таблицы лесенки |
| POST | `/api/upgrade/run` | `{ initData, mode, sourceType, amount?, itemId?, targets[], requestId }` | `{ won, target, chance, distribution, tokens }` |
| POST | `/api/upgrade/ladder/start` | `{ initData, mode, steps: 3\|5\|10, sourceType, amount?, itemId?, requestId }` | серверная сессия лесенки |
| POST | `/api/upgrade/ladder/step` | `{ initData, sessionId, expectedStep, requestId }` | результат шага, обновлённая сессия |
| POST | `/api/upgrade/ladder/cashout` | `{ initData, sessionId, requestId }` | кэшаут текущей стоимости |
| POST | `/api/upgrade/ladder/state` | `{ initData, sessionId? }` | активная сессия после перезагрузки |
| POST | `/api/upgrade/history` | `{ initData, limit? }` | журнал апгрейдов |
| POST | `/api/revolver/state` | `{ initData }` | активный раунд револьвера (восстановление после сбоя) |
| POST | `/api/withdraw` | `{ initData, rub, method, details }` | заявка на вывод (минимум 200 ₽, нужен депозит) |
| POST | `/api/order-sbp` | `{ initData, rub, termsAcceptedAt }` | `{ order_id, tokens }` |
| POST | `/platega-webhook` | уведомление Platega (заголовки `X-MerchantId`, `X-Secret`) | `{ ok }` |
| POST | `/coinso-webhook` | уведомление Coinso, заголовок `X-Signature = HMAC-SHA256(raw, COINSO_SECRET_KEY)` | `{ ok }` |

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

1. **Хранилище**: пользователи, заказы, инвентарь и журнал транзакций уже живут в SQLite (`db.js`, встроенный `node:sqlite`, путь — `DB_PATH`); `Map` в памяти — только кэш поверх БД. Для масштаба beyond одного процесса переносите на Postgres. Минимальная схема:

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
4. **Вебхуки платёжек**: в кабинете Platega укажите `https://<бэкенд>/platega-webhook` (заголовки `X-MerchantId`/`X-Secret`, сравнение — `timingSafeEqual`), для Coinso — `https://<бэкенд>/coinso-webhook` (подпись `X-Signature`; без `COINSO_SECRET_KEY` вебхук отвечает 503, а не работает без проверки). Если вебхук не дошёл, приложение само опрашивает статус: `/api/check-platega`, `/api/check-coinso`.
5. **Две копии фронта**: в прод (Cloudflare) уходит только `public/index.html`, корневой `index.html` — вторая копия. Источник правды — корневой файл; после правок гоняйте `npm run sync:frontend`, перед коммитом — `npm run check:frontend`.
6. **Чеки и налоги**: в РФ для приёма от физлиц нужна онлайн-касса (54-ФЗ) — её обычно даёт агрегатор (ЮKassa, Т-Банк Касса). Telegram Stars закрывает чеки сам, но берёт ~30 %.

### Новые режимы кейсов и Апгрейдер

В разделе «Кейсы» (`casehub`) теперь **все 20 кейсов**: 15 классических из
`items.js` и 5 новых режимов — **STARTER DROP** (250 ⬦), **CYBER RUSH**
(750 ⬦), **GOLDEN VAULT** (3 500 ⬦), **GLITCH MODE** (11 000 ⬦) и
**OMEGA CORE** (35 000 ⬦). Цены и состав классики лежат в `items.js`, новых
режимов — в `assets/case-modes.js`; у каждого кейса есть обложка
`assets/cases/<id>.jpg`. Открытие идёт через один эндпоинт, идемпотентно по
`requestId` (таблица `case_opens`); цена и дроп проверяются на сервере, предмет
сразу попадает в `user_inventory`. Сохранены рулетка, продажа, апгрейд,
бесплатный кейс за депозит и кейс за 5 друзей.

Апгрейдер (`upgrader`) переработан в серверную Upgrade Arena:
* три режима риска с разными `edge`, потолком цели и максимальным шансом;
* источник — токены или предмет инвентаря, цель — предмет из серверного
  каталога `items.js`; шанс = `min(cap, (1 − edge) × S / T)`;
* мульти-апгрейд до 5 целей: цель выбирается равновероятно, совокупный шанс —
  среднее шансов, вероятности не учитываются дважды;
* лесенка на 3/5/10 шагов: сессия и каждый шаг хранятся в SQLite
  (`upgrade_sessions`, `upgrade_actions`), переживают перезагрузку и повтор
  запроса; один активный шаг нельзя выполнить дважды;
* серия: несколько последовательных серверных раундов с отдельным
  `requestId` на каждый и остановкой при сетевой ошибке.

Реферальная программа перенесена в профиль: отдельной кнопки «Рефералы» в
нижней навигации больше нет, весь прежний функционал (код, ссылка, статистика,
15 % с пополнений) находится в блоке `#profileRef`.

Баланс меняется только внутри транзакций `db.atomicOpenCase()`,
`db.atomicUpgradeRun()`, `db.atomicLadder*()`, `db.atomicScratchPlay()`,
`db.atomicSafeGuess()`; клиент не присылает ни цену, ни результат.

### Тесты

```bash
npm test                # bot-test.js: 36 проверок — Platega/Coinso, подписи вебхуков, идемпотентность, реферальные 15 %, auth_date из будущего, энтропия orderId
npm run test:security   # e2e аудита: исход игры решает сервер, инвентарь серверный, баланс применяется ровно один раз
npm run test:new        # математика апгрейдера, экономика пяти кейсов, E2E кейсов/апгрейда/лесенки/идемпотентности
npm run test:ui         # jsdom smoke: раздел «Кейсы», Upgrade Arena, мульти/лесенка/серия, отсутствие JS-ошибок
npm run check:frontend  # index.html и public/index.html идентичны; assets/case-modes.js синхронизирован
```

Тесты поднимают мок-серверы платёжек и бота с `BOT_DRY_RUN=1` в изолированной временной БД — Telegram и боевая база не трогаются. Полный регламент аудита — `.agents/skills/security-audit/` (реестр находок: `reference/known-findings.md`).

> `ui-test.js` / `tg-test.js` (jsdom, `npm i` ставит dev-зависимость) написаны под прежнюю вёрстку и требуют переписывания под текущий интерфейс — сейчас они падают на устаревших ожиданиях, а не на багах продакшена.

## Безопасность

- Все секреты — **только** в переменных окружения хостинга (см. `.env.example`); в коде нет и не должно быть значений по умолчанию для ключей платёжек. Ключ, попавший в git, считается скомпрометированным: сначала ротация в кабинете провайдера, потом чистка истории.
- Баланс меняется ровно одним путём: `applyBalance()`/`setBalanceTo()` в `bot.js` → `db.atomicBalanceChange()` → запись в `transactions_ledger`. `db.saveUser()` баланс не пишет — это защита от двойного применения delta, а не баг.
- Исход игр, цены и выпадение предметов считает сервер (`/api/play`, `items.js`); клиент присылает только выбор (игра, ставка, множитель в границах игры).
- Вебхуки без валидной криптоподписи отклоняются; зачисление депозита идемпотентно (claim до первого `await`), секреты сравниваются через `timingSafeEqual`, на денежных эндпоинтах стоят rate-лимиты.
- База `data/` и `*.db` — в `.gitignore`, в репозиторий не попадают. Сверка уже испорченных балансов: `node tools/reconcile-ledger.js <копия_бд>` (только чтение).

## Комиссии (для справки)

| Способ | Комиссия | Подключение |
|---|---|---|
| Coinso (крипта) | см. тариф проекта | `COINSO_PROJECT_ID` + `COINSO_SECRET_KEY`, вебхук `/coinso-webhook` |
| Platega (карта / СБП) | от 4–5 % (торгуется) | merchant id и secret из кабинета |
| Telegram Stars | ~30 % | 1 команда BotFather, ничего больше не нужно |
| СБП вручную (этот бот, `/sbp`) | 0 % | ничего, но подтверждает админ |

## Деплой фронта на Cloudflare

На Cloudflare уходит **только статика** — `public/` (`wrangler.jsonc` → `assets.directory`); бот и API живут на Render/Fly и исключены через `.cfignore`.

```bash
npx wrangler deploy --dry-run   # проверка сборки без токенов: ждём «Read 46 files from .../public»
npm run deploy                  # боевой деплой (нужен CLOUDFLARE_API_TOKEN или интерактивный логин)
```

В настройках сборки на Cloudflare используются две команды: превью ветки — `npx wrangler preview`, прод — `npx wrangler deploy`. Команда `preview` в wrangler ≥ 4.150 **требует блок `previews`** в `wrangler.jsonc` — он добавлен и намеренно пуст: `assets`, `compatibility_date` и `observability` остаются на верхнем уровне и наследуются превью. Без блока сборка падает с `Your Wrangler configuration is missing a previews block`.

Wrangler закреплён в `devDependencies` точной версией (`4.150.0`), чтобы `npx wrangler` не тянул свежий релиз и сборка не ломалась от изменений в апстриме. Перед обновлением версии прогоните `npx wrangler deploy --dry-run` (должно собрать 46 файлов из `public/`) и `npx wrangler preview --ignore-base-config` (проверка конфига должна пройти).

## Полезные ссылки

- BotFather: `@BotFather` → `/newbot`, `/newapp`, `/myapps` (Mini App и кнопка меню)
- Документация Mini Apps: https://core.telegram.org/bots/webapps
- Оплата звёздами: https://core.telegram.org/bots/payments-stars
- grammY (фреймворк бота): https://grammy.dev
