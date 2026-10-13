# Паттерны исправлений

Общий принцип: **сервер — источник истины.** Клиент сообщает *намерение*, сервер вычисляет *результат*. Всё, что нарушает это, — дыра.

Порядок применения: сначала P0 (архитектура), потом P1 (эскалация), потом P2/P3.

---

## P0-5. Один источник истины для баланса (двойная запись)

Симптом: `saveUser()` и `atomicBalanceChange()` идут парой, и delta применяется дважды.

**Плохо** — `saveUser` пишет абсолютное значение, затем `atomicBalanceChange` прибавляет delta поверх:
```js
u.tokens = nextTk;                                            // память
try { db.saveUser(u); } catch (_) {}                          // БД: абсолютное значение
try { db.atomicBalanceChange(u.id, delta, 'game_bet', …) }    // БД: +delta ПОВЕРХ уже записанного
  catch (_) {}                                                // ← и ошибка проглочена
```

**Хорошо** — баланс меняет **только** `atomicBalanceChange`, память синхронизируется из результата:
```js
let res;
try {
  res = db.atomicBalanceChange(u.id, delta, 'game_bet', `Игра: ${gameName}`);
} catch (e) {
  // НЕ глотать: игроку нужен честный отказ, админу — сигнал
  console.error('[Ledger] Не удалось изменить баланс:', e.message);
  return send(500, { error: 'Не удалось обновить баланс' });
}
u.tokens = res.balanceAfter;      // память следует за БД, а не наоборот
```

И в `db.js` — убрать `tokens` из `UPDATE` в `saveUser`, чтобы она физически не могла менять баланс:
```js
updateUser: db.prepare(`
  UPDATE users SET
    num_id = ?, name = ?, username = ?, staked = ?, stake_since = ?, accrued_base = ?,
    ref_id = ?, ref_earned = ?, ref_invited = ?, terms_at = ?, total_deposited_rub = ?,
    last_deposit_rub = ?, last_deposit_id = ?, last_cashback_at = ?,
    cashback_claimed_dep_id = ?, easycash_claimed = ?, code = ?
  WHERE id = ?`)          -- поля tokens здесь больше НЕТ
```

**Почему «просто поменять порядок вызовов» — недостаточный фикс:** остаются два пути записи одного
поля, и следующий разработчик снова перепутает порядок в новом эндпоинте. Убирать надо не симптом,
а вторую руку: одна функция на баланс.

**Обязательно после фикса:** сверить `users.tokens` с `SUM(transactions_ledger.amount)` по каждому
игроку. Балансы уже испорчены — фикс кода прошлые расхождения не чинит (`delegation.md`, Brief 1).

**И не глотать ошибки.** `catch (_) {}` вокруг денежных операций скрывает ровно те сбои, из-за которых
потом не сходится баланс. Ошибка при записи денег обязана быть видимой.

---

## P0-0. Скомпрометированные секреты — сначала ротация, потом код

Порядок нельзя менять: правки кода при утёкшем ключе не защищают ничего.

```bash
# 1. РОТАЦИЯ (делает пользователь в ЛК провайдера — код этого не заменит)
#    Coinso: перевыпустить API key и Secret key
#    Platega: перевыпустить Secret
#    BotFather → /revoke → новый BOT_TOKEN (все выданные initData станут недействительны)
```

```js
/* 2. Только после ротации — убрать литеральные дефолты */
const REQUIRED = ['BOT_TOKEN', 'ADMIN_ID', 'PLATEGA_MERCHANT_ID', 'PLATEGA_SECRET',
                  'HELEKET_MERCHANT_ID', 'HELEKET_API_KEY',
                  'COINSO_PROJECT_ID', 'COINSO_API_KEY', 'COINSO_SECRET_KEY',
                  'PAYMENT_WEBHOOK_SECRET'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  // Падаем громко: тихий запуск с дефолтным секретом хуже падения
  throw new Error('Не заданы переменные окружения: ' + missing.join(', '));
}
const COINSO_SECRET_KEY = process.env.COINSO_SECRET_KEY;   // без || '...'
```

```bash
# 3. Очистить историю git (утечка уже произошла — это гигиена, а не защита)
git filter-repo --replace-text <(echo 'literal-ключ==>REMOVED')   # или BFG
git push --force-with-lease origin main
```
**Важно сказать пользователю:** удаление из истории **не** отменяет компрометацию — форки, кэш GitHub и боты-сканеры секретов уже могли забрать ключ. Ротация обязательна в любом случае; очистка истории нужна, чтобы не утекло повторно.

```bash
# 4. Проверка, что ничего не забыто
#    - нет ли ключей в других файлах и в .env.example
grep -rnE "(SECRET|API_KEY|TOKEN)[A-Z_]*[[:space:]]*=[^;]*['\"][A-Za-z0-9_-]{16,}['\"]" \
  --include="*.js" --include="*.json" . | grep -v node_modules
```

**Корневая причина, а не симптом.** Литеральные дефолты появились потому, что эти переменные
**вообще не описаны в `.env.example`** — при деплое их просто неоткуда взять. Найти расхождение:
```bash
grep -oE "process\.env\.[A-Z_]+" bot.js | sed 's/process\.env\.//' | sort -u > /tmp/used
grep -oE "^[A-Z_]+=" .env.example | tr -d '=' | sort -u > /tmp/doc
comm -23 /tmp/used /tmp/doc      # используются в коде, но не задокументированы
```
На момент аудита не задокументированы: `COINSO_PROJECT_ID`, `COINSO_API_KEY`, `COINSO_SECRET_KEY`,
`COINSO_API`, `PAYMENT_WEBHOOK_SECRET`, `ADMIN_USERNAME`, `BOT_DRY_RUN`, `PORT`.
**Добавить их в `.env.example` с плейсхолдерами** — иначе следующий разработчик (или агент)
снова впишет реальное значение в код.
Плюс включить secret scanning в настройках репозитория (GitHub → Settings → Code security), чтобы следующий ключ не попал в `main`.

---

## P0-1. Убрать клиентскую авторитетность баланса

**Было** (псевдозащита: сверяем клиентское число с клиентским же числом):
```js
let betTk = Number(body.betTokens) || 0;
let winTk = Number(body.winTokens) || 0;
let nextTk = body.tokens ?? (u.tokens - betTk + winTk);
const calcMaxTk = Math.max(0, u.tokens - betTk + winTk + 100);
if (nextTk > calcMaxTk && !isAdmin) { /* … */ }
u.tokens = nextTk;
```

**Стало** — сервер принимает только намерение, результат считает сам:
```js
const GAMES = {
  dice:      { minBet: 10, maxBet: 50_000, payout: () => (Math.random() < 0.48 ? 2 : 0) },
  cases:     { minBet: 10, maxBet: 50_000, payout: () => 0 },
  // …
};

if (url.pathname === '/api/play' && req.method === 'POST') {
  const spec = GAMES[String(body.game || '')];
  if (!spec) return send(400, { error: 'Неизвестная игра' });

  const bet = Math.floor(Number(body.bet));
  if (!Number.isFinite(bet) || bet < spec.minBet || bet > spec.maxBet) {
    return send(400, { error: 'Некорректная ставка' });
  }
  if (bet > (u.tokens || 0)) return send(400, { error: 'Недостаточно токенов' });

  // детерминированная последовательность сидов на пользователя -> нельзя переиграть исход
  const mult = spec.payout(u);          // ← результат решает СЕРВЕР
  const win = Math.floor(bet * mult);
  u.tokens = u.tokens - bet + win;

  betsMonitor.recordBet({ userId: u.id, game: body.game, betTokens: bet, winTokens: win,
                          balanceAfter: u.tokens, totalDepositedRub: u.totalDepositedRub || 0 });
  return send(200, { ok: true, win, tokens: u.tokens });
}
```
`/api/record-bet` и `/api/sync-balance` **удалить**: они существуют только чтобы клиент сообщал результат. Клиентский баланс — чистая визуализация, источник истины — `GET /api/balance`.

Причины, почему это не «правка одной строки»: нужно перенести логику игр на сервер. Скажи пользователю прямо и предложи компромисс на переходный период — серверные лимиты ниже.

**Временная мера, если переносить игры долго** (не фикс, а жгут):
```js
// потолок роста баланса ЖЁСТКО привязан к реальным депозитам, а не к клиентским числам
const LIFETIME_GROWTH_CAP = userDep * TOKENS_PER_RUB * 3;   // не вырос больше, чем 3x от внесённого
if (!isAdmin(tgUser) && u.tokens > LIFETIME_GROWTH_CAP) {
  betsMonitor.flagSuspicious({ /* … */ });
  u.tokens = Math.min(u.tokens, LIFETIME_GROWTH_CAP);
}
```

---

## P0-2. Вебхук не должен зачислять без криптопроверки

```js
/* ПЛОХО: отсутствие заголовка = пропуск проверки */
if (sig && sig !== calcSig) return send(403, { error: 'bad signature' });

/* ХОРОШО */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a), B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

if (!COINSO_SECRET_KEY) {
  console.error('[Coinso] секрет не настроен — вебхук отклонён');
  return send(503, { error: 'not configured' });
}
const sig = req.headers['x-signature'];
const calcSig = crypto.createHmac('sha256', COINSO_SECRET_KEY).update(raw).digest('hex');
if (!safeEqual(sig, calcSig)) return send(403, { error: 'bad signature' });
```

**Дефолтные секреты — удалить:**
```js
/* ПЛОХО: репозиторий публичный -> это публичный ключ */
const EXPECTED_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'MUP_SECRET_KEY_2026';

/* ХОРОШО: падаем на старте, а не тихо работаем с публичным секретом */
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET;
if (!PAYMENT_WEBHOOK_SECRET) throw new Error('PAYMENT_WEBHOOK_SECRET не задан — отказ запуска');
```
И по возможности заменить статичный секрет на подпись тела с nonce + защитой от повторов (`Date.now() - ts < 300_000`).

**Проверка суммы и владельца.** Ключ сопоставления заявки должен быть непредсказуемым, а сумма — свериться:
```js
const ord = orders.get(String(body.custom || ''));
if (!ord) return send(404, { error: 'order not found' });
if (ord.status === 'paid') return send(200, { ok: true, already: true });   // идемпотентность
if (Number(body.amount) !== Number(ord.rub)) {                              // ← сумма совпадает
  betsMonitor.flagSuspicious({ userId: ord.userId, reason: 'Сумма вебхука не совпала с заявкой',
                               details: `вебхук ${body.amount} ≠ заявка ${ord.rub}` });
  return send(400, { error: 'amount mismatch' });
}
```

**Предсказуемый `orderId` — на `crypto.randomBytes`:**
```js
/* ПЛОХО: 'MF_COIN_' + Date.now() + '_' + userId — перебирается */
const orderId = 'MF_COIN_' + Date.now() + '_' + userId;

/* ХОРОШО */
const orderId = 'MF_COIN_' + crypto.randomBytes(16).toString('hex');
```
И заявку всегда искать по своему `Map`, а не линейным поиском по клиентскому `invoice_id`.

---

## P0-3. `isAdmin` без самовыдачи прав

```js
/* ПЛОХО: при незаданном ADMIN_ID кто угодно с ником ADMIN_USERNAME становится админом */
function isAdmin(u) {
  if (ADMIN_ID && Number(u.id) === ADMIN_ID) return true;
  if (u.username && String(u.username).toLowerCase() === ADMIN_USERNAME) {
    if (!ADMIN_ID && u.id) ADMIN_ID = Number(u.id);   // ← самоприсвоение
    return true;
  }
  return false;
}

/* ХОРОШО: только явный ADMIN_ID, иначе — отказ на старте */
const ADMIN_ID = Number(process.env.ADMIN_ID);
if (!ADMIN_ID) throw new Error('ADMIN_ID не задан — отказ запуска');

function isAdmin(u) {
  return !!u && Number(u.id) === ADMIN_ID;
}
```
Админ-действия — всегда **после** проверки и всегда с аудит-логом:
```js
if (!isAdmin(tgUser)) {
  betsMonitor.flagSuspicious({ userId: tgUser?.id, reason: 'Попытка доступа в админку',
                               details: url.pathname });
  return send(403, { error: 'Доступ запрещён' });
}
```

---

## P1. Стейкинг: устранить двойной claim и мусорные числа

```js
function stakeClaim(u) {
  const acc = stakeAccrued(u);
  if (!(acc > 0)) return { claimed: 0, tokens: u.tokens };   // ← защита от «клейма в ноль»
  u.tokens += acc;
  u.accruedBase = 0;
  u.stakeSince = Date.now();      // базис сбрасывается ОДНОВРЕМЕННО с начислением
  return { claimed: acc, tokens: u.tokens };
}
```
Входные числа — нормализовать:
```js
function toTokens(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;   // Number.isFinite отсекает NaN и Infinity
  return n;
}
const amt = toTokens(body.amount);
if (amt === null) return send(400, { error: 'Некорректная сумма' });
```
> `Math.floor(Number('1e400'))` → `Infinity`, а `isNaN(Infinity) === false`. Поэтому **всегда `Number.isFinite`, а не `isNaN`.**

---

## P1. Гонки: идемпотентность через «займи, потом считай»

`check-then-act` через `await` даёт двойное зачисление. Помечай **до** асинхронной работы:
```js
async function creditOnce(key, fn) {
  const entry = credits.get(key);
  if (entry) return entry.result ?? { pending: true };
  const claim = { startedAt: Date.now(), result: null };
  credits.set(key, claim);                       // ← занимаем синхронно, без await
  try {
    claim.result = await fn();
    return claim.result;
  } catch (e) {
    credits.delete(key);                          // позволить повтор только при ошибке
    throw e;
  }
}
// использование: await creditOnce('platega:' + txId, () => plategaCredit(txId, orderId));
```
Для нескольких инстансов приложения — блокировка во внешнем хранилище (Redis/БД), `Map` в памяти не переживёт рестарт и не работает между воркерами.

---

## P1. Экранирование в сообщениях админу

Ввод пользователя уходит в Telegram с `parse_mode: 'HTML'` — это HTML-инъекция в админ-чат (спуфинг, фишинговая ссылка от имени бота):
```js
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// ├ Реквизиты: <code>${esc(details)}</code>
```
Так же экранируй `username`, `first_name`, `text` из SMS и `method`.

---

## P2. `checkInitData`: сузить окно и запретить будущее

```js
const authDate = Number(params.get('auth_date') || 0) * 1000;
const age = Date.now() - authDate;
const MAX_AGE = 5 * 60 * 1000;                 // вместо 24 часов для денежных операций
if (!Number.isFinite(authDate) || age < -60_000 || age > MAX_AGE) return null;
//        ^ auth_date в будущем (было: отрицательный age всегда проходил)
```
Для депозитов и выводов окно делай коротким; для чтения баланса 24 ч приемлемо.

---

## P2. Rate limiting — минимально достаточный

```js
const hits = new Map();                          // key -> [timestamps]
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) return false;
  arr.push(now);
  hits.set(key, arr);
  return true;
}
// на входе handle(): if (!rateLimit('ip:' + ip, 60, 60_000)) return send(429, { error: 'too many requests' });
// отдельно и строже:  /api/withdraw, /api/promo, /api/payment-webhook, *-webhook
```
Обязательно прикрутить к `/api/promo` (брутфорс кодов) и `/api/withdraw` (флуд заявками).

---

## P2. Не отдавать лишнее в API

```js
/* ПЛОХО: isAdmin, totalDeposited, lastDeposit уезжают на клиент всем */
const who = { id, tokens, staked, accrued, isAdmin: isAdmin(tgUser), totalDeposited: … };

/* ХОРОШО */
const who = { id: u.id, tokens: u.tokens, staked: u.staked, accrued: stakeAccrued(u) };
if (isAdmin(tgUser)) who.admin = true;      // флаг только админу
```

---

## P2. Состояние в памяти → на диск

`users` и `orders` живут в `Map()` и обнуляются при каждом рестарте (а `bets_monitor` при этом пишет в файл — рассинхрон). Минимум — периодический снапшот:
```js
const STATE_FILE = process.env.STATE_FILE || './state.json';
setInterval(() => {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    users: [...users.entries()],
    orders: [...orders.entries()],
    at: Date.now()
  }), 'utf8');
  fs.renameSync(tmp, STATE_FILE);             // атомарная замена
}, 15_000);
```
Учти: снапшот содержит балансы пользователей и **не должен** попадать в git (в `.gitignore`).

---

## Чеклист перед закрытием фикса

- [ ] PoC из шага 4 перестал работать (показан вывод)
- [ ] Легитимный сценарий всё ещё работает (игрок играет, депозит зачисляется, вывод уходит)
- [ ] Нет новых клиентских проверок как «фикса»
- [ ] Секретов в коде и логах не появилось
- [ ] Добавлен регрессионный кейс в `scripts/poc-*.js`
- [ ] Проверено на staging, не на проде
