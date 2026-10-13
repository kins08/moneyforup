/**
 * MoneyForUp — бот + API для Telegram Mini App.
 *
 * Возможности:
 *   • Mini App по кнопке, реферальные ссылки (?startapp=<id>)
 *   • Стейкинг: 1 % в сутки, проценты считаются по секундам, снятие в любой момент
 *   • Реферальная программа: 15 % от каждого пополнения приглашённого — токенами рефереру
 *   • Оплата: СБП и Карты (напрямую админу), Криптовалюта Coinso, промокоды с лимитом
 *   • Проверка initData (HMAC-SHA256) на каждом запросе, фиксация принятия соглашения
 *
 * Запуск:
 *   npm i && BOT_TOKEN=... APP_URL=... node bot.js
 *
 * Демо-хранилище — в памяти (Map). Для продакшена заменить на БД, см. README.md.
 */
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}
const http = require('http');
const crypto = require('crypto');
const { Bot, InlineKeyboard } = require('grammy');

const BOT_TOKEN     = process.env.BOT_TOKEN;
const APP_URL       = process.env.APP_URL || 'https://example.com/moneyforup-tg.html';
const API_PORT      = +(process.env.PORT || process.env.API_PORT || 3000);
const ADMIN_ID        = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : 0;
const betsMonitor   = require('./bets_monitor');
/* Требование к рантайму проверяем ЯВНО и здесь, а не только в package.json.
   Почему: engines в package.json читает ещё и сборка Cloudflare, а ей Node 22
   не нужен — статике всё равно. Требование «Node 22.13+» относится только к
   рантайму бота, поэтому и живёт в рантайме. */
const __node = process.versions.node.split('.').map(Number);
const __nodeOk = (__node[0] === 22 && __node[1] >= 13) || (__node[0] === 23 && __node[1] >= 4) || __node[0] >= 24;
if (!__nodeOk) {
  console.error(
    '\n[Старт] НУЖЕН ДРУГОЙ NODE.JS.\n' +
    '  Сейчас: ' + process.version + '\n' +
    '  Нужен:  22.13+ (или 23.4+, или 24+)\n\n' +
    '  Причина: встроенный модуль node:sqlite доступен без флагов только с этих версий.\n' +
    '  На 20 и ниже его нет; в 22.5–22.12 и 23.0–23.3 он за флагом --experimental-sqlite,\n' +
    '  а бот не запускается с этим флагом.\n\n' +
    '  Что делать: на хостинге бота выставить версию Node 22.13+ (например,\n' +
    '  NODE_VERSION=22.13.0 в переменных окружения Render/Fly).\n'
  );
  process.exit(1);
}

const db            = require('./db');
const items         = require('./items');   // серверный каталог кейсов и предметов

function isAdmin(u) {
  if (!u || !ADMIN_ID) return false;
  return Number(u.id) === ADMIN_ID;
}

const escHtml = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
/* Сравнение секретов за константное время (P1/P3): обычный !== завершается
   на первом несовпавшем символе и позволяет подбирать секрет по времени ответа. */
function safeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const A = Buffer.from(a), B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}
function clientIp(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* Platega (карты РФ и СБП). Кабинет: platega.io → Настройки → API
   В ЛК укажите Callback URL: https://<бэкенд>/platega-webhook (только HTTPS, самоподписанные сертификаты не принимаются) */
const PLATEGA_MERCHANT_ID = process.env.PLATEGA_MERCHANT_ID || '';
const PLATEGA_SECRET      = process.env.PLATEGA_SECRET || '';
const PLATEGA_API         = process.env.PLATEGA_API || 'https://app.platega.io';

/* Coinso (CryptoProc: Криптовалюта USDT, TON, BTC и др.). Кабинет: coinso.io → Настройки проекта → Интеграция */
const COINSO_PROJECT_ID = process.env.COINSO_PROJECT_ID || '';
const COINSO_API_KEY     = process.env.COINSO_API_KEY || '';
const COINSO_SECRET_KEY  = process.env.COINSO_SECRET_KEY || '';
const COINSO_API         = (process.env.COINSO_API || 'https://coinso.io/api').replace(/\/+$/, '');
const coinsoOrders       = new Map(); // orderId -> { userId, tokens, rub, invoice_id, credited }

/* Платёжные реквизиты СБП и банковских карт (настраиваются в .env, не хранятся в открытом коде) */
const SBP_PHONE    = process.env.SBP_PHONE || '';
const SBP_HOLDER   = process.env.SBP_HOLDER || '';
const CARD_TINKOFF = process.env.CARD_TINKOFF || '';
const CARD_SBER    = process.env.CARD_SBER || '';
const CARD_OZON    = process.env.CARD_OZON || '';

/* Публичный адрес этого бэкенда (без слэша на конце) — для url_callback и вебхуков */
const PUBLIC_URL      = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const BOT_USERNAME    = (process.env.BOT_USERNAME || '').replace(/^@/, '');   // имя бота без @ (для реферальных ссылок)

const TOKENS_PER_RUB  = 10;     // 10 ⬦ = 1 ₽
const STARS_TO_TOKENS = 20;     // 1 звезда ≈ 2 ₽ ⇒ 20 ⬦
const START_TOKENS    = 50;
const STAKE_RATE      = 0.01;   // 1 % в сутки
const DAY_MS          = 86400000;
const REF_PERCENT     = 15;     // 15 % от пополнений приглашённых
/* Бизнес-правило: игрок без единого депозита не может поднять баланс выше этого
   потолка. Проверяется ТОЛЬКО на сервере (в playRound) — клиентская версия
   этой проверки была лишь эвристикой и обходилась. */
const NON_DEPOSITOR_CAP = 400;  // 40 ₽

if (!BOT_TOKEN) {
  console.error('================================================================');
  console.error('ОШИБКА: Не задан BOT_TOKEN в переменных окружения!');
  console.error('На Render.com: откройте ваш Web Service -> Environment -> добавьте BOT_TOKEN=токен_бота');
  console.error('================================================================');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
if (process.env.BOT_DRY_RUN === '1') {
  bot.api.config.use(async () => ({ ok: true, result: true }));
}

/* ------------------------------------------------------------------ */
/* In-memory Rate Limiter для защиты эндпоинтов                      */
/* ------------------------------------------------------------------ */
const rateLimits = new Map();
function checkRateLimit(key, maxRequests = 30, windowMs = 60000) {
  const now = Date.now();
  let timestamps = rateLimits.get(key);
  if (!timestamps) {
    timestamps = [];
    rateLimits.set(key, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
    timestamps.shift();
  }
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits.entries()) {
    while (v.length > 0 && v[0] <= now - 60000) v.shift();
    if (v.length === 0) rateLimits.delete(k);
  }
}, 300000).unref();

/* ------------------------------------------------------------------ */
/* Хранилище (демо). Заменить на Postgres/SQLite — см. README.md        */
/* ------------------------------------------------------------------ */
const users = new Map();    // id → { name, code, tokens, staked, stakeSince, accruedBase, ref, refEarned, refInvited, termsAt, starsUsd }
const byCode = new Map();   // реферальный код → id пользователя
const orders = new Map();   // orderId → order object
const promoCodes = new Map(); // CODE -> { code, tokens, maxUses, usedBy: Set<userId>, createdAt }
const plategaTx = new Map(); // transactionId Platega → { userId, tokens, rub }
let orderSeq = Date.now() % 100000;

// Загрузка всех заказов из постоянной БД
function reloadOrdersFromDb() {
  try {
    for (const o of db.getAllOrders()) {
      orders.set(String(o.id), {
        id: String(o.id),
        type: o.type,
        userId: o.user_id,
        tokens: o.tokens,
        rub: o.rub,
        bank: o.bank,
        card: o.card,
        sender: o.sender,
        method: o.method,
        details: o.details,
        status: o.status,
        source: o.source,
        tx: o.tx,
        createdAt: o.created_at,
        updatedAt: o.updated_at
      });
    }
  } catch (e) {
    console.warn('Ошибка загрузки заказов из БД:', e.message);
  }
}
reloadOrdersFromDb();

function getOrder(id) {
  let ord = orders.get(String(id));
  if (!ord) {
    const fromDb = db.getOrder(String(id));
    if (fromDb) {
      ord = {
        id: fromDb.id,
        type: fromDb.type,
        userId: fromDb.user_id,
        tokens: fromDb.tokens,
        rub: fromDb.rub,
        bank: fromDb.bank,
        card: fromDb.card,
        sender: fromDb.sender,
        method: fromDb.method,
        details: fromDb.details,
        status: fromDb.status,
        source: fromDb.source,
        tx: fromDb.tx,
        createdAt: fromDb.created_at,
        updatedAt: fromDb.updated_at
      };
      orders.set(String(id), ord);
    }
  }
  return ord;
}

function setOrder(id, ord) {
  ord.id = String(id);
  orders.set(String(id), ord);
  try { db.saveOrder(ord); } catch (e) { console.error('Ошибка сохранения заказа в БД:', e.message); }
}

/* ---------- реферальные коды -------------------------------------- */
/* Код вида MF7K3QD2: 8 символов, без I/O/L/0/1 — его диктуют вслух и копируют вручную.
   Код выдаётся один раз и живёт, пока существует запись пользователя. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = 'MF';
    const bytes = crypto.randomBytes(CODE_LEN - 2);
    for (let i = 0; i < bytes.length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!byCode.has(code) && !db.getUserByCode(code)) return code;
  }
  return 'MF' + Date.now().toString(36).toUpperCase().slice(-6);   // практический недостижимый фолбэк
}
/* start_param может быть кодом (MF...) или старым числовым id — поддерживаем оба */
function resolveRef(param) {
  const raw = String(param || '').trim();
  if (!raw) return 0;
  const codeUp = raw.toUpperCase();
  const byC = byCode.get(codeUp);
  if (byC) return byC;
  const fromDb = db.getUserByCode(codeUp);
  if (fromDb && fromDb.id) {
    byCode.set(codeUp, fromDb.id);
    return fromDb.id;
  }
  const asId = Number(raw);
  return Number.isInteger(asId) && asId > 0 ? asId : 0;
}
function setRef(u, param) {
  const refId = resolveRef(param);
  if (!refId || refId === u.id || u.ref) return 0;      // самоприглашение и повторную привязку отсекаем
  u.ref = refId;
  try { db.saveUser(u); } catch (_) {}
  const referrer = user(refId);
  if (referrer) {
    referrer.refInvited = countInvited(referrer.id);
    try { db.saveUser(referrer); } catch (_) {}
  }
  return refId;
}

let nextPlayerId = 10000;

function user(id, name, username) {
  let u = users.get(id);
  if (!u) {
    const fromDb = db.getUser(id);
    if (fromDb) {
      u = fromDb;
      u.notifications = [];
      users.set(id, u);
      if (u.code) byCode.set(u.code, id);
    } else {
      const code = makeCode();
      const numId = nextPlayerId++;
      u = {
        id, numId, code, name: name || '', username: username || '',
        tokens: START_TOKENS, staked: 0, stakeSince: 0, accruedBase: 0,
        ref: null, refEarned: 0, refInvited: 0, termsAt: 0, starsUsd: 0,
        totalDepositedRub: 0, lastDeposit: 0, lastDepositId: 0,
        cashbackClaimedDepositId: 0, lastCashbackAt: 0,
        easycashClaimed: false, notifications: []
      };
      users.set(id, u);
      byCode.set(code, id);
      try { db.saveUser(u); } catch (e) { console.error('Ошибка сохранения нового пользователя:', e.message); }
    }
  }
  if (!u.numId) {
    u.numId = nextPlayerId++;
    try { db.saveUser(u); } catch (_) {}
  }
  let dirty = false;
  if (name && u.name !== name) { u.name = name; dirty = true; }
  if (username && u.username !== username) { u.username = username; dirty = true; }
  if (dirty) {
    try { db.saveUser(u); } catch (_) {}
  }
  return u;
}

/* ------------------------------------------------------------------ */
/* Стейкинг: 1 % в сутки, простые проценты, по секундам                */
/* ------------------------------------------------------------------ */
/* сколько пользователей реально пришли по ссылке этого игрока */
const countInvited = id => db.countInvited(Number(id));

const stakeAccrued = u => (u.accruedBase || 0) +
  (u.staked > 0 && u.stakeSince ? u.staked * STAKE_RATE * Math.max(0, Date.now() - u.stakeSince) / DAY_MS : 0);

/* ------------------------------------------------------------------ */
/* Единый путь изменения баланса: ledger -> память                     */
/* ------------------------------------------------------------------ */
/* Баланс меняется ТОЛЬКО здесь и в setBalanceTo(). В db.js saveUser()  */
/* физически не пишет tokens, поэтому двойное применение delta         */
/* (saveUser + atomicBalanceChange) стало невозможным по конструкции.  */
function applyBalance(u, delta, type, reason, refId = '') {
  delta = Math.floor(Number(delta) || 0);
  if (!delta) return { ok: true, changed: false, balance: u.tokens };
  try {
    const res = db.atomicBalanceChange(u.id, delta, type, reason, refId);
    u.tokens = res.balanceAfter;               // память следует за БД, а не наоборот
    return { ok: true, changed: true, balance: res.balanceAfter };
  } catch (e) {
    // НЕ глотаем: ошибка записи денег обязана быть видимой
    console.error(`[Ledger] ${type} игроку ${u.id} (${delta > 0 ? '+' : ''}${delta} ⬦): ${e.message}`);
    return { ok: false, error: e.message, balance: u.tokens };
  }
}

/* Установить баланс в конкретное значение (сброс/штраф античита) — тоже через ledger */
function setBalanceTo(u, value, type, reason) {
  value = Math.max(0, Math.floor(Number(value) || 0));
  return applyBalance(u, value - Math.floor(u.tokens || 0), type, reason);
}

/* ------------------------------------------------------------------ */
/* Серверная игра: исход раунда решает ТОЛЬКО сервер                    */
/* ------------------------------------------------------------------ */
/* Клиент присылает выбор игрока (игра, ставка, желаемый множитель), а  */
/* не результат. Сервер сам бросает жребий и сам считает выигрыш.        */
/*                                                                       */
/* Раньше исход считал клиент и присылал winTokens — это и был эксплойт. */
/*                                                                       */
/* Модель выплат: winChance = (1 − edge) / mult, выигрыш = bet × mult.   */
/* Матожидание игрока = −edge × bet (стандартная комиссия казино).       */
/* Множитель — это ВЫБОР игрока, а не результат, поэтому его можно       */
/* принимать от клиента, но обязательно проверять по границам игры.      */
const GAMES = {
  // ключ (нормализованный)   границы ставки        границы множителя   edge
  dice:          { label: 'Dice',              minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: 0.03, defaultMult: 1.95 },
  jumper:        { label: 'Попрыгун',          minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 120,  edge: 0.03, defaultMult: 2.0 },
  spin:          { label: 'Спин',              minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: 0.03, defaultMult: 2.0 },
  drop:          { label: 'Дроп',              minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: 0.03, defaultMult: 2.0 },
  skuf:          { label: 'Скуф vs Альтушка',  minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: 0.04, defaultMult: 2.0 },
  avito:         { label: 'Перекуп на Авито',  minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: 0.04, defaultMult: 2.0 },
  cases:         { label: 'Апгрейд кейса',     minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 30,   edge: 0.05, defaultMult: 2.0 },
  upgrader:      { label: 'Апгрейдер',         minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 30,   edge: 0.05, defaultMult: 2.0 },
  auction:       { label: 'Тайный аукцион',    minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: 0.05, defaultMult: 1.8 },
  racket:        { label: 'Ракетка',           minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 30,   edge: 0.04, defaultMult: 1.7 },
  hotdrop:       { label: 'Hot Drop',          minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: 0.05, defaultMult: 2.0 },
  wheel:         { label: 'Колесо Фортуны',    minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: 0.05, defaultMult: 2.0 },
  // Неизвестная игра: консервативный профиль вместо отказа — чтобы клиент не ломался
  __default:     { label: 'Игра',              minBet: 10, maxBet: 10000,  minMult: 1.1, maxMult: 2,    edge: 0.10, defaultMult: 2.0 }
};

/* ── Ракетка (Crash Game 24/7): детерминированная модель крушения по раундам ── */
const RK = { tcap: 12, k: 0.18 };
function sampleCrash(seedIdx) {
  let r;
  if (seedIdx != null) {
    let a = (seedIdx ^ 0x6D2B79F5) >>> 0;
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    r = ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  } else {
    r = Math.random();
  }
  if (r < 0.08) return 1.00;
  if (r < 0.14) return +(1.01 + ((r - 0.08) / 0.06) * 0.09).toFixed(2);
  if (r < 0.29) return +(1.10 + ((r - 0.14) / 0.15) * 0.20).toFixed(2);
  if (r < 0.53) return +(1.30 + ((r - 0.29) / 0.24) * 0.25).toFixed(2);
  if (r < 0.73) return +(1.55 + ((r - 0.53) / 0.20) * 0.20).toFixed(2);
  if (r < 0.79) return +(1.75 + ((r - 0.73) / 0.06) * 0.25).toFixed(2);
  if (r < 0.89) return +(2.00 + ((r - 0.79) / 0.10) * 0.30).toFixed(2);
  if (r < 0.98) return +(2.30 + ((r - 0.89) / 0.09) * 0.69).toFixed(2);
  const t0 = Math.log(3.5) / RK.k;
  const rLong = (r - 0.98) / 0.02;
  return +Math.exp(RK.k * (t0 + rLong * (RK.tcap - t0))).toFixed(2);
}

const activeRacketBets = new Map(); // roundId -> { userId, bet, rIdx, createdAt, cashed: false }
setInterval(() => {
  const now = Date.now();
  for (const [id, bet] of activeRacketBets.entries()) {
    if (now - bet.createdAt > 300000) activeRacketBets.delete(id);
  }
}, 60000).unref();

function gameConfig(rawName) {
  const key = String(rawName || '').trim().toLowerCase()
    .replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (GAMES[key]) return { key, ...GAMES[key] };
  // сопоставление по русским названиям, которые присылает клиент
  const aliases = {
    'попрыгун': 'jumper', 'спин': 'spin', 'дроп': 'drop', 'wheel': 'wheel',
    'колесо_фортуны': 'wheel', 'скуг_vs_альтушка': 'skuf', 'скуф_vs_альтушка': 'skuf',
    'перекуп_на_авито': 'avito', 'апгрейд_кейса': 'cases', 'апгрейдер': 'upgrader',
    'тайный_аукцион': 'auction', 'ракетка': 'racket', 'hot_drop': 'hotdrop',
    'дис': 'dice', 'кости': 'dice'
  };
  const mapped = aliases[key];
  if (mapped && GAMES[mapped]) return { key: mapped, ...GAMES[mapped] };
  return { key: '__default', ...GAMES.__default };
}

/**
 * Проводит раунд: списывает ставку, бросает жребий, начисляет выигрыш.
 * Возвращает результат для отображения. Клиент НЕ может повлиять на жребий.
 */
/**
 * Раунд в КЕЙСЕ. Отличие от остальных игр принципиальное:
 * предмет И ЕСТЬ выигрыш, токены за раунд не начисляются.
 *
 * Почему так: EV предмета в кейсах 0.74–0.88 от цены кейса (см. caseRtp).
 * Если вдобавок платить токены по обычной формуле, суммарный RTP станет ~1.7
 * и кейс начнёт печатать деньги. Ценность забирается продажей предмета.
 */
function playCaseRound(u, c, rawBet, rawRoundId) {
  const bet = Math.floor(Number(rawBet) || 0);
  // Ставка обязана равняться цене кейса: иначе игрок откроет кейс за 10000,
  // поставив 10 ⬦, и получит предмет со средним выигрышем ~8 750 ⬦.
  if (bet !== c.cost) {
    return { ok: false, error: `Кейс «${c.name}» стоит ${c.cost} ⬦` };
  }
  if (bet > Math.floor(u.tokens || 0)) return { ok: false, error: 'Недостаточно токенов' };

  const roundId = String(rawRoundId || '').trim() ||
    ('C' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex'));
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(roundId)) return { ok: false, error: 'Некорректный идентификатор раунда' };
  try {
    if (db.getRound(roundId)) return { ok: false, error: 'Раунд уже проведён' };
  } catch (_) { /* таблицы нет — не блокируем игру */ }

  // Жребий предмета — серверный CSPRNG, веса из серверного каталога
  const drop = items.rollItem(c.id, crypto.randomInt(0, 1_000_000) / 1_000_000);
  if (!drop) return { ok: false, error: 'Кейс недоступен' };

  // Деньги: списываем ровно цену кейса. Выигрыш придёт ПРОДАЖЕЙ предмета.
  const r = applyBalance(u, -bet, 'game_round',
    `Кейс «${c.name}» · раунд ${roundId} (ставка ${bet}, выпало: ${drop.name})`, roundId);
  if (!r.ok) return { ok: false, error: 'Не удалось провести раунд, повторите позже' };

  // Предмет кладём ПОСЛЕ успешного списания: иначе предмет был бы, а оплаты нет
  let itemId = null;
  try {
    const saved = db.addInventoryItem({
      userId: u.id, itemCode: drop.code, name: drop.name, icon: drop.icon,
      price: drop.price, tier: drop.tier, caseId: c.id, caseName: c.name, roundId
    });
    itemId = saved.id;
  } catch (e) {
    console.error(`[Inventory] предмет не сохранён игроку ${u.id}: ${e.message}`);
  }

  const verdict = drop.price >= bet ? 'win' : 'lose';   // для анимации: отбился или нет
  try {
    db.saveRound({ roundId, userId: u.id, game: 'Кейс: ' + c.name, bet, mult: 1, win: 0,
      status: 'settled', itemCode: drop.code, itemPrice: drop.price });
  } catch (e) { console.error('[Round] не сохранён:', e.message); }

  betsMonitor.recordBet({
    userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
    game: 'Кейс: ' + c.name, betTokens: bet, winTokens: 0,
    balanceAfter: u.tokens, totalDepositedRub: u.totalDepositedRub || u.lastDeposit || 0
  });

  return {
    ok: true, roundId, game: 'Кейс: ' + c.name, gameKey: 'case',
    verdict, win: 0, mult: 1, tokens: u.tokens, case: c.id,
    drop: { id: itemId, code: drop.code, name: drop.name, icon: drop.icon,
            price: drop.price, tier: drop.tier, caseName: c.name }
  };
}

function playRound(u, rawGame, rawBet, rawMult, rawRoundId) {
  const cfg = gameConfig(rawGame);
  const bet = Math.floor(Number(rawBet) || 0);
  if (!Number.isFinite(bet) || bet < cfg.minBet || bet > cfg.maxBet) {
    return { ok: false, error: `Ставка должна быть от ${cfg.minBet} до ${cfg.maxBet} ⬦` };
  }
  if (bet > Math.floor(u.tokens || 0)) return { ok: false, error: 'Недостаточно токенов' };

  // Кейсы живут по другой модели (предмет = выигрыш) — уводим их в отдельную ветку
  const __case = items.findCaseByName(rawGame);
  if (__case) return playCaseRound(u, __case, rawBet, rawRoundId);

  // Множитель — выбор игрока, но строго в границах игры
  let mult = Number(rawMult);
  if (!Number.isFinite(mult) || mult <= 0) mult = cfg.defaultMult;
  mult = Math.min(cfg.maxMult, Math.max(cfg.minMult, mult));
  mult = Math.round(mult * 100) / 100;

  // Идемпотентность: повторный roundId не создаёт второй раунд
  const roundId = String(rawRoundId || '').trim() ||
    ('R' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex'));
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(roundId)) return { ok: false, error: 'Некорректный идентификатор раунда' };
  try {
    if (db.getRound(roundId)) return { ok: false, error: 'Раунд уже проведён' };
  } catch (_) { /* таблицы нет — не блокируем игру */ }

  // ── Жребий: серверный CSPRNG + комиссия, которую невозможно обойти с клиента
  const winChance = Math.min(0.98, Math.max(0.001, (1 - cfg.edge) / mult));
  const roll = crypto.randomInt(0, 1_000_000) / 1_000_000;
  let win = roll < winChance ? Math.floor(bet * mult) : 0;

  // Бизнес-правило: игрок без единого депозита не поднимается выше потолка
  const userDep = u.totalDepositedRub || u.lastDeposit || 0;
  if (userDep <= 0 && !isAdmin(u)) {
    const after = Math.floor(u.tokens || 0) - bet + win;
    if (after > NON_DEPOSITOR_CAP) {
      win = 0;   // ставка всё равно списывается — играть без депозита можно, выводить нельзя
      betsMonitor.flagSuspicious({
        userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
        reason: 'Потолок бездепозитного баланса (сервер)',
        details: `раунд ${cfg.label}: ставка ${bet} ⬦, попытка поднять до ${after} ⬦`
      });
    }
  }

  // ── Деньги: одна запись в ledger на весь раунд (net = выигрыш − ставка)
  const r = applyBalance(u, win - bet, 'game_round',
    `${cfg.label} · раунд ${roundId} (ставка ${bet}, ×${mult}, выигрыш ${win})`, roundId);
  if (!r.ok) return { ok: false, error: 'Не удалось провести раунд, повторите позже' };

  try {
    db.saveRound({ roundId, userId: u.id, game: cfg.label, bet, mult, win, status: 'settled' });
  } catch (e) { console.error('[Round] не сохранён:', e.message); }

  betsMonitor.recordBet({
    userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
    game: cfg.label, betTokens: bet, winTokens: win,
    balanceAfter: u.tokens, totalDepositedRub: userDep
  });

  return { ok: true, roundId, game: cfg.label, gameKey: cfg.key, verdict: win > 0 ? 'win' : 'lose', win, mult, tokens: u.tokens };
}

function stakeAdd(u, v) {
  v = Math.floor(Number(v) || 0);
  if (v <= 0) return { error: 'Сумма должна быть больше нуля' };
  if (v > u.tokens) return { error: 'Недостаточно токенов на балансе' };
  const accrued = stakeAccrued(u);          // считаем ДО изменения стейка
  const r = applyBalance(u, -v, 'stake_add', 'Добавлено в стейкинг');
  if (!r.ok) return { error: 'Не удалось изменить баланс, попробуйте позже' };
  u.accruedBase = accrued;
  u.staked += v;
  u.stakeSince = Date.now();
  try { db.saveUser(u); } catch (e) { console.error('saveUser (stake_add):', e.message); }
  return { staked: u.staked, tokens: u.tokens, accrued: u.accruedBase };
}
function stakeClaim(u) {
  const acc = stakeAccrued(u);
  const tkAcc = Math.floor(acc);            // на баланс идёт только целое число токенов
  if (tkAcc <= 0) return { error: 'Пока нечего забирать' };
  const r = applyBalance(u, tkAcc, 'stake_claim', 'Начисление процентов стейкинга');
  if (!r.ok) return { error: 'Не удалось изменить баланс, попробуйте позже' };
  u.accruedBase = acc - tkAcc;              // дробный остаток не теряем — дозреет
  u.stakeSince = Date.now();
  try { db.saveUser(u); } catch (e) { console.error('saveUser (stake_claim):', e.message); }
  return { claimed: tkAcc, tokens: u.tokens };
}
function stakeRemove(u, all) {
  const acc = stakeAccrued(u), body = u.staked;
  const take = all === false ? 0 : body;
  const gross = Math.floor(take + acc);
  if (gross <= 0) return { error: 'Стейкинг пуст' };
  const r = applyBalance(u, gross, 'stake_remove', 'Снятие из стейкинга');
  if (!r.ok) return { error: 'Не удалось изменить баланс, попробуйте позже' };
  u.staked -= take;
  u.accruedBase = (take + acc) - gross;     // дробный остаток остаётся на стейкере
  u.stakeSince = u.staked ? Date.now() : 0;
  try { db.saveUser(u); } catch (e) { console.error('saveUser (stake_remove):', e.message); }
  return { removed: gross, tokens: u.tokens, staked: u.staked };
}

/* ------------------------------------------------------------------ */
/* Пополнение + реферальные 15 %                                       */
/* ------------------------------------------------------------------ */
async function creditDeposit(userId, tokens, source) {
  const u = user(userId);
  // Делаем зачисление ДО всего остального и не подменяем его памятью при сбое:
  // если запись в ledger не прошла — депозит не зачислен, и вызывающий код обязан это увидеть.
  const credit = applyBalance(u, tokens, 'deposit', `Пополнение через ${source}`, '');
  if (!credit.ok) {
    console.error(`[Deposit] НЕ зачислено ${tokens} ⬦ игроку ${userId}: ${credit.error}`);
    return { tokens, refPaid: 0, refErr: credit.error, credited: false };
  }
  const rubAmt = Math.round(tokens / TOKENS_PER_RUB);
  u.lastDeposit = rubAmt;
  u.totalDepositedRub = (u.totalDepositedRub || 0) + rubAmt;
  u.lastDepositId = (u.lastDepositId || 0) + 1;
  try { db.saveUser(u); } catch (e) { console.error('saveUser (deposit):', e.message); }
  try { betsMonitor.recordCashflow('deposit', rubAmt, u.id, u.username ? '@' + u.username : u.name); } catch (_) {}
  let refPaid = 0, refErr = null;
  const refId = Number(u.ref);
  if (refId) {
    const referrer = user(refId);                              // реферер мог ещё не открыть бота — создаём запись
    if (Number(u.ref) !== u.id) {                              // самоприглашение отсекаем
      refPaid = Math.floor(tokens * REF_PERCENT / 100);
      if (refPaid > 0) {
        const rp = applyBalance(referrer, refPaid, 'referral', `15% от депозита игрока ID ${u.id}`, String(u.id));
        if (rp.ok) {
          referrer.refEarned = (referrer.refEarned || 0) + refPaid;
          referrer.refInvited = countInvited(referrer.id);
          try { db.saveUser(referrer); } catch (e) { console.error('saveUser (referral):', e.message); }
          try {
            await bot.api.sendMessage(referrer.id,
              `🎁 Ваш реферал пополнил баланс на ${tokens} ⬦ · вам +${refPaid} ⬦ (${REF_PERCENT}%)`);
          } catch (e) { refErr = e.message; }
        } else {
          // Не начислено — не сообщаем о начислении и не делаем вид, что оно было
          refPaid = 0; refErr = rp.error;
        }
      }
    }
  }
  return { tokens, refPaid, refErr, credited: true };
}

/* ------------------------------------------------------------------ */
/* Проверка initData                                                   */
/* ------------------------------------------------------------------ */
function checkInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (calc.length !== hash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0) * 1000;
  const age = Date.now() - authDate;
  // Окно 24 часа: Telegram НЕ обновляет initData внутри открытой сессии WebApp,
  // auth_date фиксируется в момент запуска. Окно в 5 минут (было так) после
  // 5 минут игры отклоняло ВСЕ запросы как «initData недействителен».
  // Будущее по-прежнему запрещено; подпись HMAC проверяется как раньше.
  if (!Number.isFinite(authDate) || age < -60_000 || age > 24 * 3600 * 1000) return null;
  try { return JSON.parse(params.get('user') || '{}'); } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Telegram Stars                                                      */
/* ------------------------------------------------------------------ */
async function starsInvoiceLink(userId, tokens) {
  const stars = Math.max(1, Math.round(tokens / STARS_TO_TOKENS));
  return bot.api.createInvoiceLink(
    'Токены MoneyForUp',
    `${tokens} ⬦ — токены для игры (10 ⬦ = 1 ₽). Вывод в деньги не предусмотрен.`,
    JSON.stringify({ kind: 'tokens', userId, tokens }),
    '', 'XTR',
    [{ label: `${tokens} ⬦`, amount: stars }]
  );
}

/* ------------------------------------------------------------------ */
/* Промокоды (с лимитом общего числа активаций в SQLite)              */
/* ------------------------------------------------------------------ */
function applyPromo(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Введите промокод' };
  const res = db.atomicApplyPromo(userId, code);
  if (res.ok) {
    // atomicApplyPromo уже записала баланс и ledger в одной транзакции — синхронизируем память
    user(userId).tokens = res.newBalance;   // ledger-ok: значение прочитано из БД внутри транзакции
  }
  return res;
}


/* ------------------------------------------------------------------ */
/* Общее: уведомление об оплате                                        */
/* ------------------------------------------------------------------ */
async function notifyPaid(userId, tokens, refPaid, source) {
  try {
    await bot.api.sendMessage(userId,
      `Оплата получена (${source}): +${tokens} ⬦` +
      (refPaid ? ` · пригласившему +${refPaid} ⬦ (${REF_PERCENT} %)` : ''));
  } catch (e) { /* пользователь мог не начать чат с ботом */ }
}

/* ------------------------------------------------------------------ */
/* Platega — карты РФ и СБП                                            */
/* ------------------------------------------------------------------ */
const plategaOn = () => !!(PLATEGA_MERCHANT_ID && PLATEGA_SECRET);
const plategaHeaders = () => ({
  'Content-Type': 'application/json',
  'X-MerchantId': PLATEGA_MERCHANT_ID,
  'X-Secret': PLATEGA_SECRET
});

async function plategaCreate(u, rub, tokens, name) {
  if (!plategaOn()) throw new Error('Platega не настроена: добавьте PLATEGA_MERCHANT_ID и PLATEGA_SECRET');
  const orderId = 'PL' + crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${PLATEGA_API}/transaction/process`, {
    method: 'POST',
    headers: plategaHeaders(),
    body: JSON.stringify({
      paymentDetails: { amount: rub, currency: 'RUB' },
      description: `MoneyForUp · ${tokens} ⬦ (заказ ${orderId})`,
      return: APP_URL,
      failedUrl: APP_URL,
      payload: orderId,
      metadata: { userId: String(u.id), userName: name || '' }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error('Platega: ' + JSON.stringify(data.message || data.error || data));
  orders.set(orderId, { userId: u.id, tokens, rub, status: 'pending', source: 'Platega', tx: data.transactionId });
  plategaTx.set(String(data.transactionId), { orderId, userId: u.id, tokens, rub, status: 'pending' });
  return { pay_url: data.url, invoice_id: data.transactionId, order_id: orderId, tokens };
}

async function plategaStatus(txId) {
  const res = await fetch(`${PLATEGA_API}/transaction/${encodeURIComponent(txId)}`, { headers: plategaHeaders() });
  const data = await res.json().catch(() => ({}));
  return String(data.status || '').toUpperCase();
}

/* зачисление ровно один раз: и по вебхуку, и по опросу */
async function plategaCredit(txId, orderIdFromHook) {
  const local = plategaTx.get(String(txId));
  const orderId = (local && local.orderId) || orderIdFromHook;
  const order = orderId ? orders.get(String(orderId)) : null;
  if (!order) return { paid: true, credited: false, error: 'заказ не найден', tokens: 0 };
  if (order.status === 'paid') return { paid: true, already: true, tokens: order.tokens };
  // Claim ДО первого await: проверка и пометка идут синхронно, поэтому
  // параллельный вебхук + опрос статуса не зачислят депозит дважды (P2-4).
  if (order._crediting) return { paid: true, credited: false, inProgress: true, tokens: order.tokens };
  order._crediting = true;
  const r = await creditDeposit(order.userId, order.tokens, 'Platega');
  if (!r.credited) {
    // Зачисление не прошло — снимаем claim и НЕ помечаем заказ оплаченным, чтобы вебхук повторился
    order._crediting = false;
    return { paid: true, credited: false, retry: true, error: r.refErr, tokens: order.tokens };
  }
  order._crediting = false;
  order.status = 'paid';
  if (local) local.status = 'paid';
  await notifyPaid(order.userId, order.tokens, r.refPaid, 'Platega');
  return { paid: true, credited: true, tokens: order.tokens, refPaid: r.refPaid };
}

/* ------------------------------------------------------------------ */
/* Coinso (CryptoProc: только Криптовалюта USDT, TON, BTC, ETH и др.)  */
/* Документация: coinso.io/docs                                       */
/* ------------------------------------------------------------------ */
const coinsoOn = () => !!(COINSO_PROJECT_ID && COINSO_SECRET_KEY);

async function createCoinsoInvoice(userId, tokens, rub) {
  if (!coinsoOn()) throw new Error('Coinso не настроен (проверьте COINSO_PROJECT_ID и COINSO_SECRET_KEY)');
  const orderId = 'MF_COIN_' + crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${COINSO_API}/payment/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${COINSO_SECRET_KEY}`
    },
    body: JSON.stringify({
      project_id: Number(COINSO_PROJECT_ID),
      amount: rub,
      method: 'crypto',
      description: `Пополнение ${tokens} ⬦ MoneyForUp (Криптовалюта)`,
      custom: orderId,
      client_telegram_id: String(userId)
    })
  });
  const data = await res.json();
  const payUrl = data.payment_url || (data.data && data.data.payment_url);
  const invId = data.invoice_id || (data.data && data.data.invoice_id);
  if (!payUrl) {
    throw new Error('Coinso: ' + (data.message || JSON.stringify(data)));
  }
  coinsoOrders.set(orderId, { userId, tokens, rub, invoice_id: invId, credited: false });
  return {
    order_id: orderId,
    invoice_id: invId,
    pay_url: payUrl,
    tokens
  };
}

/* Зачисление Coinso ровно один раз: claim (credited=true) выставляется
   синхронно ДО await, поэтому вебхук и опрос статуса параллельно не проведут
   депозит дважды. При сбое claim откатывается — провайдер повторит вебхук. */
async function coinsoCredit(saved, key) {
  if (!saved) return { paid: true, credited: false };
  if (saved.credited) return { paid: true, already: true, tokens: saved.tokens };
  saved.credited = true;                       // claim — до первого await
  const r = await creditDeposit(saved.userId, saved.tokens, 'Coinso');
  if (!r.credited) { saved.credited = false; return { paid: true, credited: false, retry: true, error: r.refErr, tokens: saved.tokens }; }
  await notifyPaid(saved.userId, saved.tokens, r.refPaid, 'Coinso');
  const k = key || [...coinsoOrders.entries()].find(([, v]) => v === saved)?.[0];
  if (k) coinsoOrders.delete(k);
  return { paid: true, credited: true, tokens: saved.tokens, refPaid: r.refPaid };
}
function findCoinsoOrder(orderId, invoiceId) {
  if (orderId && coinsoOrders.has(orderId)) return [orderId, coinsoOrders.get(orderId)];
  for (const [k, v] of coinsoOrders.entries()) if (v.invoice_id === invoiceId) return [k, v];
  return [null, null];
}

async function checkCoinsoInvoice(invoiceId, orderId) {
  if (!invoiceId) return { paid: false };
  try {
    const res = await fetch(`${COINSO_API}/payment/status?uuid=${encodeURIComponent(invoiceId)}`);
    const data = await res.json();
    if (data && (data.status === 'paid' || (data.data && data.data.status === 'paid'))) {
      const [key, saved] = findCoinsoOrder(orderId, invoiceId);
      if (saved) return await coinsoCredit(saved, key);
      return { paid: true };
    }
    return { paid: false, status: data.status || (data.data && data.data.status) };
  } catch (e) {
    return { paid: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* Команды бота                                                        */
/* ------------------------------------------------------------------ */
function botUsername() {
  if (BOT_USERNAME) return BOT_USERNAME;
  try { return bot.botInfo.username; } catch (e) { return 'your_bot'; }   // botInfo доступен только после init()
}
const refLink = code => `https://t.me/${botUsername()}?startapp=${code}`;

bot.command('start', async ctx => {
  const param = (ctx.match || '').trim();
  const u = user(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const taken = setRef(u, param);
  if (taken) {
    await ctx.reply(`Реферальный код принят ✅ · за ваши пополнения пригласивший получает ${REF_PERCENT} %`);
  }
  const kb = new InlineKeyboard().webApp('🚀 Играть в MoneyForUp', APP_URL);
  const text =
    `🔥 <b>Добро пожаловать в MoneyForUp!</b>\n` +
    `<i>Делай мани, ап-ап! 🚀</i>\n\n` +
    `<b>MoneyForUp</b> — это игровая платформа в Telegram с кейсами, быстрыми играми и пассивным доходом.\n\n` +
    `🎮 <b>Что вас ждёт:</b>\n` +
    `• 📦 <b>Кейсы &amp; Спин</b> — сочные дропы и колесо удачи\n` +
    `• 🍺 <b>Скуф vs Альтушка</b> — находи альтушек и обходи пиво\n` +
    `• 📈 <b>Стейкинг 1 % в сутки</b> — проценты начисляются каждую секунду\n` +
    `• 👥 <b>Реферальная система</b> — ${REF_PERCENT} % с пополнений ваших друзей\n` +
    `• 🎟 <b>Промокоды</b> — активируйте командой <code>/promo КОД</code>\n\n` +
    `💳 <b>Пополнение:</b> СБП / Карты напрямую админу, Крипта (Coinso).\n` +
    `💎 <b>Ваш баланс:</b> <code>${u.tokens} ⬦</code> (~${(u.tokens / TOKENS_PER_RUB).toFixed(2)} ₽)\n\n` +
    `Нажимайте кнопку ниже и начинайте игру! 👇`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.command('balance', async ctx => {
  const u = user(ctx.from.id);
  const acc = stakeAccrued(u);
  await ctx.reply(
    `Баланс: ${u.tokens} ⬦ ≈ ${(u.tokens / TOKENS_PER_RUB).toFixed(2)} ₽\n` +
    `В стейкинге: ${u.staked} ⬦ · накоплено процентов: ${acc.toFixed(2)} ⬦\n` +
    `Приносит в сутки: ${(u.staked * STAKE_RATE).toFixed(2)} ⬦`
  );
});

bot.command('stake', async ctx => {
  const arg = (ctx.match || '').trim();
  const u = user(ctx.from.id);
  if (!arg) {
    const acc = stakeAccrued(u);
    return ctx.reply(`Стейкинг 1 % в сутки.\nВ стейкинге: ${u.staked} ⬦\nНакоплено: ${acc.toFixed(2)} ⬦\nВ сутки: ${(u.staked * STAKE_RATE).toFixed(2)} ⬦\n\n` +
      `Вложить: /stake 5000 · Забрать проценты: /claim · Снять всё: /unstake`);
  }
  const r = stakeAdd(u, arg);
  await ctx.reply(r.error ? '⚠️ ' + r.error : `В стейкинг добавлено ${Math.floor(arg)} ⬦. Всего ${r.staked} ⬦, в сутки +${(r.staked * STAKE_RATE).toFixed(2)} ⬦`);
});

bot.command('claim', async ctx => {
  const u = user(ctx.from.id);
  const r = stakeClaim(u);
  await ctx.reply(r.error ? '⚠️ ' + r.error : `Забрано ${r.claimed.toFixed(2)} ⬦. Баланс: ${r.tokens.toFixed(2)} ⬦`);
});

bot.command('unstake', async ctx => {
  const u = user(ctx.from.id);
  const r = stakeRemove(u, true);
  await ctx.reply(r.error ? '⚠️ ' + r.error : `Снято ${r.removed.toFixed(2)} ⬦. Баланс: ${r.tokens.toFixed(2)} ⬦`);
});

bot.command('ref', async ctx => {
  const u = user(ctx.from.id);
  await ctx.reply(
    `Ваш код: ${u.code}\nВаша ссылка: ${refLink(u.code)}\n\n` +
    `Приглашено: ${countInvited(u.id)}\nЗаработано: ${Math.round(u.refEarned || 0)} ⬦\n` +
    `Условие: ${REF_PERCENT} % от каждого пополнения приглашённого — токенами на баланс.`
  );
});

bot.command('buy', async ctx => {
  const arg = Number((ctx.match || '').trim());
  const tokens = arg > 0 ? Math.floor(arg) : 3000;
  try {
    const link = await starsInvoiceLink(ctx.from.id, tokens);
    await ctx.reply(`Счёт на ${tokens} ⬦ ≈ ${(tokens / TOKENS_PER_RUB).toFixed(2)} ₽`,
      { reply_markup: new InlineKeyboard().url('⭐ Оплатить звёздами', link) });
  } catch (e) { await ctx.reply('Не удалось создать счёт: ' + (e.message || e)); }
});

bot.command('promo', async ctx => {
  const arg = (ctx.match || '').trim();
  if (!arg) {
    return ctx.reply(
      '🎟 <b>Активация промокода</b>\n\n' +
      'Используйте: <code>/promo КОД</code>\n' +
      'Пример: <code>/promo MONEYUP</code>\n\n' +
      '<i>Также промокод можно ввести прямо в приложении на вкладке Пополнение.</i>',
      { parse_mode: 'HTML' }
    );
  }
  const res = applyPromo(ctx.from.id, arg);
  if (!res.ok) {
    return ctx.reply('⚠️ ' + res.error);
  }
  await ctx.reply(
    `🎉 <b>Промокод «${escHtml(res.code)}» успешно активирован!</b>\n\n` +
    `├ Зачислено: <b>+${res.tokens} ⬦</b> (~${(res.tokens / TOKENS_PER_RUB).toFixed(2)} ₽)\n` +
    `├ Ваш текущий баланс: <b>${res.newBalance} ⬦</b>\n` +
    `└ Осталось активаций этого промокода: <b>${res.remainingUses} из ${res.maxUses}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('addpromo', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора проекта.');
  const parts = (ctx.match || '').trim().split(/\s+/);
  const [code, tokensStr, maxUsesStr] = parts;
  if (!code || !tokensStr) {
    return ctx.reply(
      'ℹ️ <b>Как добавить промокод:</b>\n\n' +
      '<code>/addpromo КОД ТОКЕНЫ [МАКС_АКТИВАЦИЙ]</code>\n\n' +
      '<b>Пример:</b>\n' +
      '<code>/addpromo BONUS1000 1000 50</code> — промокод на 1000 ⬦ для первых 50 пользователей.',
      { parse_mode: 'HTML' }
    );
  }
  try {
    const tokens = Number(tokensStr);
    const maxUses = maxUsesStr ? Number(maxUsesStr) : 100;
    const promo = addPromoCode(code, tokens, maxUses);
    await ctx.reply(
      `✅ <b>Промокод создан!</b>\n\n` +
      `├ Код: <code>${escHtml(promo.code)}</code>\n` +
      `├ Награда: <b>${promo.tokens} ⬦</b> (~${(promo.tokens / TOKENS_PER_RUB).toFixed(2)} ₽)\n` +
      `├ Лимит активаций: <b>${promo.maxUses}</b> человек\n` +
      `└ Активировано сейчас: <b>${promo.usedBy.size}</b>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    await ctx.reply('⚠️ Ошибка: ' + (e.message || e));
  }
});

bot.command(['promos', 'promocodes'], async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора проекта.');
  if (promoCodes.size === 0) return ctx.reply('Промокодов пока нет. Создайте: /addpromo КОД ТОКЕНЫ МАКС');
  let text = '🎟 <b>Список активных промокодов:</b>\n\n';
  for (const [code, p] of promoCodes.entries()) {
    const left = p.maxUses - p.usedBy.size;
    text += `• <code>${escHtml(code)}</code>: <b>+${p.tokens} ⬦</b> | Использовано: <b>${p.usedBy.size}/${p.maxUses}</b> (осталось: ${left})\n`;
  }
  text += '\n<i>Удалить: /delpromo КОД</i>';
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('delpromo', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора проекта.');
  const code = (ctx.match || '').trim().toUpperCase();
  if (!code) return ctx.reply('Используйте: /delpromo КОД');
  if (!promoCodes.has(code)) return ctx.reply(`Промокод «${code}» не найден.`);
  promoCodes.delete(code);
  await ctx.reply(`🗑 Промокод «${code}» успешно удалён.`);
});

bot.command('pay', async ctx => {
  if (!plategaOn()) return ctx.reply('Platega не настроена: добавьте PLATEGA_MERCHANT_ID и PLATEGA_SECRET в .env');
  const rub = Math.max(1, Math.floor(Number((ctx.match || '').trim()) || 300));
  const tokens = rub * TOKENS_PER_RUB;
  try {
    const r = await plategaCreate(user(ctx.from.id, ctx.from.first_name), rub, tokens, ctx.from.first_name);
    await ctx.reply(`Счёт на ${rub} ₽ (${tokens} ⬦) · Platega: карта или СБП`,
      { reply_markup: new InlineKeyboard().url('💳 Оплатить', r.pay_url) });
  } catch (e) { await ctx.reply('Не удалось создать счёт Platega: ' + (e.message || e)); }
});

bot.command('coinso', async ctx => {
  if (!coinsoOn()) return ctx.reply('Coinso не настроен.');
  const rub = Math.max(1, Math.floor(Number((ctx.match || '').trim()) || 300));
  const tokens = rub * TOKENS_PER_RUB;
  try {
    const r = await createCoinsoInvoice(ctx.from.id, tokens, rub);
    await ctx.reply(`Счёт на ${rub} ₽ (${tokens} ⬦) · Coinso (Криптовалюта USDT, TON, BTC)`,
      { reply_markup: new InlineKeyboard().url('🪙 Оплатить криптой', r.pay_url) });
  } catch (e) { await ctx.reply('Не удалось создать счёт Coinso: ' + (e.message || e)); }
});

bot.command('sbp', async ctx => {
  if (!ADMIN_ID) return ctx.reply('Оплата по СБП не настроена (нет ADMIN_ID).');
  const rub = Math.max(1, Math.floor(Number((ctx.match || '').trim()) || 300));
  const id = 'SBP_' + crypto.randomBytes(16).toString('hex');
  const tokens = rub * TOKENS_PER_RUB;
  const newOrder = { id, userId: ctx.from.id, tokens, rub, status: 'pending', source: 'СБП / Карта', createdAt: Date.now() };
  setOrder(id, newOrder);

  let reqText = '';
  if (SBP_PHONE) reqText += `• Телефон СБП: <code>${escHtml(SBP_PHONE)}</code>${SBP_HOLDER ? ` (${escHtml(SBP_HOLDER)})` : ''}\n• Банки СБП: Т-Банк, Сбербанк, Озон Банк\n`;
  if (CARD_TINKOFF || CARD_SBER || CARD_OZON) {
    reqText += `• Или прямой перевод на карту:\n`;
    if (CARD_TINKOFF) reqText += `  — Т-Банк: <code>${escHtml(CARD_TINKOFF)}</code>\n`;
    if (CARD_SBER) reqText += `  — Сбербанк: <code>${escHtml(CARD_SBER)}</code>\n`;
    if (CARD_OZON) reqText += `  — Озон Банк: <code>${escHtml(CARD_OZON)}</code>\n`;
  }
  if (!reqText) {
    reqText = `• Реквизиты для оплаты уточняйте у администратора.\n`;
  }

  await ctx.reply(
    `💳 <b>Заявка №${escHtml(id)} на ${rub} ₽ (${tokens} ⬦)</b>\n\n` +
    `<b>Реквизиты для оплаты:</b>\n` +
    reqText + `\n` +
    `После перевода администратор проверит платёж и токены сразу зачислятся на баланс.`,
    { parse_mode: 'HTML' }
  );
  const senderLabel = ctx.from.username ? '@' + ctx.from.username : (ctx.from.first_name || 'ID ' + ctx.from.id);
  await bot.api.sendMessage(ADMIN_ID,
    `💳 <b>Заявка №${escHtml(id)} по СБП:</b> ${rub} ₽ → <b>+${tokens} ⬦</b>\n` +
    `От: <b>${escHtml(senderLabel)}</b> (id: <code>${ctx.from.id}</code>)`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Подтвердить', 'ok:' + id)
        .text('❌ Отклонить', 'no:' + id)
    }
  );
});

async function processOrderAction(orderId, action) {
  const order = getOrder(String(orderId));
  if (!order) return { ok: false, error: 'Заявка не найдена' };
  if (order.status !== 'pending') return { ok: false, error: 'Заявка уже обработана (' + order.status + ')' };

  if (order.type === 'withdraw') {
    const u = user(order.userId);
    if (action === 'wd_ok' || action === 'approve') {
      order.status = 'paid';
      order.completedAt = Date.now();
      try { db.updateOrderStatus(orderId, 'paid'); } catch (_) {}
      try { betsMonitor.recordCashflow('withdraw', order.rub, u.id, u.username ? '@' + u.username : u.name); } catch (_) {}
      u.notifications = u.notifications || [];
      u.notifications.push({
        id: 'notif_' + Date.now(),
        text: `✅ Ваша заявка на вывод ${order.rub} ₽ успешно выполнена! Средства отправлены на реквизиты: ${order.details}`,
        t: Date.now()
      });
      await bot.api.sendMessage(order.userId,
        `✅ <b>Ваша заявка на вывод №${escHtml(orderId)} выполнена!</b> ☑️\n\n` +
        `├ Сумма выплаты: <b>${order.rub} ₽</b> (${order.tokens} ⬦)\n` +
        `├ Способ: <b>${escHtml(order.method)}</b>\n` +
        `└ Реквизиты: <code>${escHtml(order.details)}</code>\n\n` +
        `Средства успешно отправлены! Спасибо за игру в MoneyForUp! 🚀`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return { ok: true, status: 'paid', order };
    } else {
      order.status = 'rejected';
      order.completedAt = Date.now();
      try { db.updateOrderStatus(orderId, 'rejected'); } catch (_) {}
      // Возвращаем токены только если у игрока были реальные депозиты, иначе сбрасываем накрутку
      if ((u.totalDepositedRub || u.lastDeposit || 0) > 0) {
        applyBalance(u, order.tokens, 'refund_withdraw', `Возврат отклоненного вывода #${orderId}`);
      } else {
        setBalanceTo(u, Math.min(u.tokens, START_TOKENS), 'anticheat_reset', `Сброс накрутки по заявке #${orderId}`);
      }
      try { db.saveUser(u); } catch (e) { console.error('saveUser (refund):', e.message); }
      u.notifications = u.notifications || [];
      u.notifications.push({
        id: 'notif_' + Date.now(),
        text: `⚠️ Заявка на вывод ${order.rub} ₽ отклонена.`,
        t: Date.now()
      });
      await bot.api.sendMessage(order.userId,
        `⚠️ <b>Заявка на вывод №${escHtml(orderId)} на ${order.rub} ₽ отклонена.</b>\n` +
        `Проверьте условия вывода и реквизиты или напишите @lev_god.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return { ok: true, status: 'rejected', order };
    }
  } else {
    // Заявка на пополнение
    const u = user(order.userId);
    if (action === 'ok' || action === 'approve') {
      // Claim ДО await: повторный клик/параллельный вызов видит status='paid'
      // и не зачислит второй раз. При сбое зачисления возвращаем 'pending'.
      order.status = 'paid';
      const r = await creditDeposit(order.userId, order.tokens, order.source || 'СБП');
      if (!r.credited) {
        order.status = 'pending';
        return { ok: false, error: 'Не удалось зачислить баланс — заявка оставлена в ожидании: ' + (r.refErr || '') };
      }
      order.completedAt = Date.now();
      try { db.updateOrderStatus(orderId, 'paid'); } catch (_) {}
      u.notifications = u.notifications || [];
      u.notifications.push({
        id: 'notif_' + Date.now(),
        text: `🎉 Пополнение подтверждено! Зачислено +${order.tokens} ⬦ (${order.rub} ₽).`,
        t: Date.now()
      });
      await bot.api.sendMessage(order.userId,
        `🎉 Оплата получена: <b>+${order.tokens} ⬦</b> (${order.rub} ₽)${r.refPaid ? `, рефереру +${r.refPaid} ⬦` : ''}!\nБаланс успешно пополнен.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return { ok: true, status: 'paid', order, refPaid: r.refPaid };
    } else {
      order.status = 'rejected';
      order.completedAt = Date.now();
      try { db.updateOrderStatus(orderId, 'rejected'); } catch (_) {}
      u.notifications = u.notifications || [];
      u.notifications.push({
        id: 'notif_' + Date.now(),
        text: `⚠️ Заявка на пополнение №${orderId} (${order.rub} ₽) отклонена администратором.`,
        t: Date.now()
      });
      await bot.api.sendMessage(order.userId,
        `⚠️ Заявка №${orderId} на ${order.rub} ₽ отклонена. Если возник вопрос — напишите администратору @lev_god.`
      ).catch(() => {});
      return { ok: true, status: 'rejected', order };
    }
  }
}

bot.callbackQuery(/^ok:(.+)$/, async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только администратор может подтверждать пополнения!', show_alert: true });
  const res = await processOrderAction(ctx.match[1], 'ok');
  if (!res.ok) return ctx.answerCallbackQuery({ text: res.error, show_alert: true });
  await ctx.answerCallbackQuery('Зачислено ✅');
  await ctx.editMessageText(
    (ctx.callbackQuery.message.text || '') + '\n\n✅ <b>Оплата подтверждена! Зачислено +' + res.order.tokens + ' ⬦</b>',
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.callbackQuery(/^no:(.+)$/, async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только администратор может отклонять заявки!', show_alert: true });
  const res = await processOrderAction(ctx.match[1], 'no');
  if (!res.ok) return ctx.answerCallbackQuery({ text: res.error, show_alert: true });
  await ctx.answerCallbackQuery('Отклонено ❌');
  await ctx.editMessageText(
    (ctx.callbackQuery.message.text || '') + '\n\n❌ <b>Заявка отклонена администратором</b>',
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.callbackQuery(/^wd_ok:(.+)$/, async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только администратор может подтверждать выводы!', show_alert: true });
  const res = await processOrderAction(ctx.match[1], 'wd_ok');
  if (!res.ok) return ctx.answerCallbackQuery({ text: res.error, show_alert: true });
  await ctx.answerCallbackQuery('Вывод отмечен выполненным ☑️ Уведомление отправлено!');
  await ctx.editMessageText(
    (ctx.callbackQuery.message.text || '') + '\n\n☑️ <b>ВЫПЛАЧЕНО (галочка поставлена, игрок уведомлён)</b>',
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.callbackQuery(/^wd_no:(.+)$/, async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только администратор может отклонять выводы!', show_alert: true });
  const res = await processOrderAction(ctx.match[1], 'wd_no');
  if (!res.ok) return ctx.answerCallbackQuery({ text: res.error, show_alert: true });
  await ctx.answerCallbackQuery('Вывод отклонён ❌');
  await ctx.editMessageText(
    (ctx.callbackQuery.message.text || '') + '\n\n❌ <b>Вывод отклонён администратором</b>',
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

/* ---------- Команды администратора: /stats, /pnl, /admin, /orders, /games, /players, /audit ---------- */
function getAdminStatsKeyboard() {
  return new InlineKeyboard()
    .text('📊 Сводка 12ч', 'adm_stats:12')
    .text('📅 Сводка 24ч', 'adm_stats:24')
    .text('🏦 За всё время', 'adm_stats:0')
    .row()
    .text('🎮 Отчёт по играм', 'adm_games')
    .text('👥 Отчёт по игрокам', 'adm_players')
    .row()
    .text('🛡 Античит / Аудит', 'adm_audit')
    .text('📋 Активные заявки', 'adm_orders')
    .row()
    .text('🧹 Обнулить накрутчиков (0 деп)', 'adm_wipe_cheaters');
}

bot.command(['stats', 'pnl', 'admin', 'orders'], async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора.');
  const report = betsMonitor.formatTelegramReport(12);
  await ctx.reply(report, { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() });
});

bot.command('games', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора.');
  await ctx.reply(betsMonitor.formatGamesReport(0), { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() });
});

bot.command('players', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора.');
  await ctx.reply(betsMonitor.formatPlayersReport(users), { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() });
});

bot.command('audit', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора.');
  await ctx.reply(betsMonitor.formatAuditReport(users), { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() });
});

bot.callbackQuery(/^adm_stats:(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только для администратора', show_alert: true });
  const hours = Number(ctx.match[1] || 12);
  await ctx.answerCallbackQuery('Обновляю сводку...');
  const report = betsMonitor.formatTelegramReport(hours);
  await ctx.editMessageText(report, { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() }).catch(() => {});
});

bot.callbackQuery('adm_games', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только для администратора', show_alert: true });
  await ctx.answerCallbackQuery('Отчёт по играм...');
  await ctx.editMessageText(betsMonitor.formatGamesReport(0), { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() }).catch(() => {});
});

bot.callbackQuery('adm_players', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только для администратора', show_alert: true });
  await ctx.answerCallbackQuery('Отчёт по игрокам...');
  await ctx.editMessageText(betsMonitor.formatPlayersReport(users), { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() }).catch(() => {});
});

bot.callbackQuery('adm_audit', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только для администратора', show_alert: true });
  await ctx.answerCallbackQuery('Аудит безопасности...');
  await ctx.editMessageText(betsMonitor.formatAuditReport(users), { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() }).catch(() => {});
});

bot.callbackQuery('adm_wipe_cheaters', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только для администратора', show_alert: true });
  let wipedCount = 0;
  let canceledWithdrawals = 0;
  // ВАЖНО: раньше правки шли только в память и после перехода на SQLite не сохранялись вовсе.
  for (const [uid, u] of users.entries()) {
    if (isAdmin(u)) continue;
    const dep = u.totalDepositedRub || u.lastDeposit || 0;
    if (dep <= 0 && u.tokens > 400) {
      const r = setBalanceTo(u, START_TOKENS, 'anticheat_wipe', 'Массовая очистка накрученных балансов');
      if (r.ok && r.changed) {
        try { db.saveUser(u); } catch (e) { console.error('saveUser (wipe):', e.message); }
        wipedCount++;
      }
    }
  }
  for (const [id, o] of orders.entries()) {
    if (o.type === 'withdraw' && o.status === 'pending') {
      const usr = users.get(o.userId);
      const dep = (usr && (usr.totalDepositedRub || usr.lastDeposit)) || 0;
      if (dep <= 0) {
        o.status = 'rejected';
        o.completedAt = Date.now();
        try { db.updateOrderStatus(id, 'rejected'); } catch (_) {}
        if (usr) {
          const r = setBalanceTo(usr, START_TOKENS, 'anticheat_reset', `Отклонён фейк-вывод #${id}`);
          if (r.ok) { try { db.saveUser(usr); } catch (e) { console.error('saveUser (wipe wd):', e.message); } }
        }
        canceledWithdrawals++;
      }
    }
  }
  await ctx.answerCallbackQuery(`Очищено аккаунтов: ${wipedCount}, отклонено фейк-выводов: ${canceledWithdrawals}`, { show_alert: true });
  await ctx.editMessageText(betsMonitor.formatAuditReport(users), { parse_mode: 'HTML', reply_markup: getAdminStatsKeyboard() }).catch(() => {});
});

bot.callbackQuery('adm_orders', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.answerCallbackQuery({ text: '⛔ Только для администратора', show_alert: true });
  await ctx.answerCallbackQuery();
  const pending = [...orders.entries()].filter(([_, o]) => o.status === 'pending');
  if (pending.length === 0) {
    return ctx.reply('✅ Активных ожидающих заявок на пополнение или вывод сейчас нет.');
  }
  for (const [id, o] of pending.slice(0, 15)) {
    const u = users.get(o.userId) || { name: 'ID ' + o.userId };
    if (o.type === 'withdraw') {
      const dossier = betsMonitor.getPlayerDossier(o.userId, u);
      const pName = u.username ? '@' + u.username : (u.name || 'ID ' + o.userId);
      await ctx.reply(
        `💸 <b>Ожидает вывода #${escHtml(id)}</b>\n` +
        `├ Игрок: <b>${escHtml(pName)}</b> (<code>${o.userId}</code>)\n` +
        `├ Сумма: <b>${o.rub} ₽</b> (${o.tokens} ⬦)\n` +
        `├ Способ: <b>${escHtml(o.method)}</b>\n` +
        `└ Реквизиты: <code>${escHtml(o.details)}</code>\n\n` +
        dossier,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('☑️ Выплачено (галочка)', 'wd_ok:' + id)
            .text('❌ Отклонить', 'wd_no:' + id)
        }
      );
    } else {
      const pName = u.username ? '@' + u.username : (u.name || 'ID ' + o.userId);
      await ctx.reply(
        `💳 <b>Ожидает пополнения #${escHtml(id)}</b>\n` +
        `├ Игрок: <b>${escHtml(pName)}</b> (<code>${o.userId}</code>)\n` +
        `├ Сумма: <b>${o.rub} ₽</b> (+${o.tokens} ⬦)\n` +
        `└ Способ: <b>${escHtml(o.bank || o.source || 'СБП')}</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Подтвердить', 'ok:' + id)
            .text('❌ Отклонить', 'no:' + id)
        }
      );
    }
  }
});

/* ---------- Команда /boost: Вариант 7, Вариант 10, Вариант 4 ---------- */
bot.command('boost', async ctx => {
  const u = user(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const kb = new InlineKeyboard()
    .webApp('⚡ Открыть Boost-Центр', `${APP_URL}#boost`)
    .row()
    .text('🎯 Вариант 7: Челлендж 24ч', 'boost_v7')
    .text('🔥 Вариант 10: Hot Drop', 'boost_v10')
    .row()
    .text('🤫 Вариант 4: Тайный аукцион', 'boost_v4');

  const text =
    `⚡ <b>MUP BOOST CENTER — 3 режима ускорения токенов!</b>\n\n` +
    `Привет, <b>${escHtml(ctx.from.first_name || 'Игрок')}</b>! Активируй бонусы и забирай дополнительный профит:\n\n` +
    `🎯 <b>Вариант 7: «Челлендж за 24 часа» (Daily Challenge)</b>\n` +
    `• 3 ежедневных задания с возрастающей наградой до <b>+150 ⬦</b>\n` +
    `• Удерживай серию дней (Стрик 1..7 🔥)\n` +
    `• Таймер сброса заданий: 24:00:00\n\n` +
    `🔥 <b>Вариант 10: «Hot Drop» (Ежечасный Дроп)</b>\n` +
    `• Бесплатный супер-бокс каждый час (таймер 60 минут)\n` +
    `• Мгновенный шанс выбить от <b>15 до 500 ⬦</b> без депозита!\n` +
    `• Забирай в один клик\n\n` +
    `🤫 <b>Вариант 4: «Тайный аукцион» (Blind Auction)</b>\n` +
    `• Закрытые торги вслепую за редкие сейфы и контейнеры токенов\n` +
    `• Перебивай ставки соперников, блефуй и забирай банк с супер-дисконтом!\n\n` +
    `Нажмите кнопку ниже для подробностей или запустите Mini App:`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('boost_v7', async ctx => {
  await ctx.answerCallbackQuery();
  const u = user(ctx.from.id);
  const kb = new InlineKeyboard().webApp('🎯 Открыть Челленджи в Mini App', `${APP_URL}#challenge24`);
  const text =
    `🎯 <b>Вариант 7: «Челлендж за 24 часа»</b>\n\n` +
    `🔥 <b>Ваш статус:</b> День 1 / 7 · Стрик активен\n` +
    `⏱ <b>Таймер до обновления:</b> 24:00:00\n\n` +
    `<b>Задания на сегодня:</b>\n` +
    `1. 🚀 «Гонка на Ракете» — сделать 3 кэшаута в Ракетке (+30 ⬦)\n` +
    `2. 🤫 «Тайный Аукционер» — сделать ставку в Аукционе (+25 ⬦)\n` +
    `3. 🔥 «Горячий Трофей» — забрать Hot Drop (+20 ⬦)\n\n` +
    `<i>Выполняйте квесты прямо в игре и забирайте токены на баланс!</i>`;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('boost_v10', async ctx => {
  await ctx.answerCallbackQuery();
  const u = user(ctx.from.id);
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  u.lastHotDrop = u.lastHotDrop || 0;
  const elapsed = now - u.lastHotDrop;
  if (elapsed >= ONE_HOUR) {
    const rewards = [20, 35, 50, 75, 120, 250];
    const win = rewards[Math.floor(Math.random() * rewards.length)];
    // Раньше бонус начислялся только в память и пропадал при рестарте (в БД не сохранялся)
    applyBalance(u, win, 'bonus_hotdrop_tg', 'Hot Drop в боте');
    u.lastHotDrop = now;
    try { db.saveUser(u); } catch (e) { console.error('saveUser (hotdrop tg):', e.message); }
    const kb = new InlineKeyboard().webApp('🔥 Играть в MoneyForUp', APP_URL);
    await ctx.reply(
      `🔥 <b>HOT DROP УСПЕШНО ОТКРЫТ!</b> 🎉\n\n` +
      `Вы открыли ежечасный дроп и получили: <b>+${win} ⬦</b> (~${(win / TOKENS_PER_RUB).toFixed(2)} ₽)!\n` +
      `Ваш баланс: <b>${Math.floor(u.tokens)} ⬦</b>\n\n` +
      `⏱ Следующий бесплатный Hot Drop будет доступен через 60 минут.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  } else {
    const leftMins = Math.ceil((ONE_HOUR - elapsed) / 60000);
    const kb = new InlineKeyboard().webApp('🚀 Открыть в приложении', `${APP_URL}#hotdrop`);
    await ctx.reply(
      `⏳ <b>Hot Drop пока на перезарядке!</b>\n\n` +
      `До следующего бесплатного контейнера осталось: <b>${leftMins} мин.</b>\n` +
      `Заходите в игру, запускайте Ракетку и крутите Спин!`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }
});

bot.callbackQuery('boost_v4', async ctx => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().webApp('🤫 Войти в Тайный аукцион', `${APP_URL}#auction`);
  const text =
    `🤫 <b>Вариант 4: «Тайный аукцион»</b>\n\n` +
    `📦 <b>Текущий лот:</b> Секретный Кибер-Сейф MUP #088\n` +
    `💎 <b>Содержимое:</b> от 500 до 1 500 ⬦\n` +
    `⏱ <b>Статус торгов:</b> Идёт приём тайных ставок\n\n` +
    `Делайте ставки вслепую, блефуйте и забирайте сейф по лучшей цене!`;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.on('pre_checkout_query', ctx => ctx.answerPreCheckoutQuery(true));

bot.on('message:successful_payment', async ctx => {
  const sp = ctx.message.successful_payment;
  let payload = {};
  try { payload = JSON.parse(sp.invoice_payload || '{}'); } catch {}
  const userId = payload.userId || ctx.from.id;
  const tokens = payload.tokens || sp.total_amount * STARS_TO_TOKENS;
  const r = await creditDeposit(userId, tokens, 'Telegram Stars');
  const u = user(userId);
  await ctx.reply(`Оплачено ${sp.total_amount} ⭐ — зачислено ${tokens} ⬦` +
    (r.refPaid ? `, пригласившему +${r.refPaid} ⬦ (${REF_PERCENT} %)` : '') +
    `.\nБаланс: ${u.tokens.toFixed(2)} ⬦ ≈ ${(u.tokens / TOKENS_PER_RUB).toFixed(2)} ₽`);
});

/* ------------------------------------------------------------------ */
/* HTTP-API для Mini App                                               */
/* ------------------------------------------------------------------ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function readJson(req) { return readBody(req).then(b => { try { return JSON.parse(b || '{}'); } catch { return {}; } }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
                          'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') return send(204, {});

  // Если открыли адрес в обычном браузере — отдаём красивую страницу статуса
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MoneyForUp Backend</title>
  <style>
    body { margin: 0; background: #0b0e14; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .card { background: #161c28; border: 1px solid #2a3449; border-radius: 20px; padding: 36px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .badge { display: inline-block; padding: 6px 14px; background: rgba(74, 222, 128, 0.15); color: #4ade80; border: 1px solid rgba(74, 222, 128, 0.3); border-radius: 999px; font-size: 13px; font-weight: bold; margin-bottom: 20px; }
    h1 { margin: 0 0 12px; font-size: 26px; color: #fff; }
    p { margin: 0 0 24px; color: #94a3b8; font-size: 15px; line-height: 1.6; }
    .btn { display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #00e5ff, #0072ff); color: #fff; text-decoration: none; border-radius: 12px; font-weight: bold; font-size: 15px; transition: transform 0.2s; box-shadow: 0 8px 20px rgba(0,114,255,0.4); }
    .btn:hover { transform: translateY(-2px); }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● СЕРВЕР РАБОТАЕТ (ONLINE)</div>
    <h1>MoneyForUp API & Bot</h1>
    <p>Бэкенд на Render успешно запущен и обрабатывает запросы Telegram-бота, стейкинга и платежей.</p>
    <a href="${APP_URL || '#'}" class="btn" target="_blank" rel="noopener">🎮 Открыть сайт с играми (Cloudflare)</a>
  </div>
</body>
</html>`);
  }

  try {
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
    const tgUser = checkInitData(body.initData || url.searchParams.get('initData'));


    /* вебхук Platega: приходит с заголовками X-MerchantId и X-Secret */
    if (url.pathname === '/platega-webhook' && req.method === 'POST') {
      if (!checkRateLimit(`wh:platega:${clientIp(req)}`, 120, 60000)) return send(429, { error: 'too many requests' });
      const mid = String(req.headers['x-merchantid'] || ''), sec = String(req.headers['x-secret'] || '');
      if (!plategaOn() || !safeEqualStr(mid, PLATEGA_MERCHANT_ID) || !safeEqualStr(sec, PLATEGA_SECRET)) return send(403, { error: 'bad credentials' });
      const status = String(body.status || '').toUpperCase();
      if (status === 'CONFIRMED') {
        const res = await plategaCredit(body.id, body.payload);
        // 500 заставит Platega повторить вебхук — зачисление не потеряется
        if (res.retry) return send(500, { error: 'credit failed, retry', ...res });
        return send(200, { ok: true, ...res });
      }
      if (status === 'CANCELED' || status === 'CHARGEBACKED') {
        const order = orders.get(String(body.payload || ''));
        if (order && order.status !== 'paid') order.status = status === 'CANCELED' ? 'canceled' : 'chargeback';
        const local = plategaTx.get(String(body.id)); if (local) local.status = status;
      }
      return send(200, { ok: true, status });
    }

    /* вебхук Coinso (CryptoProc): X-Signature = HMAC-SHA256(raw, COINSO_SECRET_KEY) */
    if (url.pathname === '/coinso-webhook' && req.method === 'POST') {
      if (!checkRateLimit(`wh:coinso:${clientIp(req)}`, 120, 60000)) return send(429, { error: 'too many requests' });
      // Подпись обязательна: без секрета вебхук не работает вообще, а не «без проверки»
      if (!COINSO_SECRET_KEY) return send(503, { error: 'Coinso не настроен' });
      const sig = req.headers['x-signature'];
      if (!sig) {
        console.warn('[Coinso Webhook] Отсутствует обязательный заголовок X-Signature');
        return send(403, { error: 'missing signature header' });
      }
      const calcSig = crypto.createHmac('sha256', COINSO_SECRET_KEY).update(raw).digest('hex');
      if (!safeEqualStr(String(sig), calcSig)) {
        console.warn('[Coinso Webhook] Неверная подпись X-Signature');
        return send(403, { error: 'bad signature' });
      }
      const upd = body;
      const orderId = String(upd.custom || '');
      const status = String(upd.event || upd.status || '');
      if (status === 'payment.success' || status === 'paid') {
        const [key, saved] = findCoinsoOrder(orderId, upd.invoice_id);
        if (saved) {
          const r = await coinsoCredit(saved, key);
          if (r.retry) {
            console.error('[Coinso Webhook] Зачисление не удалось, ожидаем повтор вебхука');
            return send(500, { error: 'credit failed, retry' });
          }
          if (r.credited) console.log(`[Coinso Webhook] Успешное зачисление: +${saved.tokens} токенов пользователю ${saved.userId}`);
          return send(200, { ok: true, ...r });
        }
      }
      return send(200, { ok: true });
    }

    /* Вебхук автоматизации смс-уведомлений с телефона (iOS Быстрые команды / Android MacroDroid) */
    if (url.pathname === '/api/payment-webhook' && req.method === 'POST') {
      if (!checkRateLimit(`wh:payment:${clientIp(req)}`, 10, 60000)) return send(429, { error: 'too many requests' });
      const authHeader = req.headers['authorization'] || '';
      const secret = body.secret || authHeader.replace(/^Bearer\s+/i, '');
      const EXPECTED_SECRET = process.env.PAYMENT_WEBHOOK_SECRET;
      if (!EXPECTED_SECRET || !safeEqualStr(String(secret || ''), EXPECTED_SECRET)) {
        return send(403, { error: 'unauthorized: invalid webhook secret' });
      }

      const text = String(body.text || body.message || body.sms || '');
      const senderPhone = String(body.sender || '');
      console.log(`[Payment Webhook] Получено уведомление от ${senderPhone}: "${text}"`);

      // Извлекаем сумму платежа из текста СМС (например "Пополнение 300р", "перевод 500 RUB", "+300.00 RUB", "300 ₽")
      let match = text.match(/(?:пополнение|перевод|зачисление|поступило|\+)\s*([\d\s]+(?:[.,]\d{1,2})?)\s*(?:₽|руб|rub)?/i);
      if (!match) {
        match = text.match(/([\d\s]+(?:[.,]\d{1,2})?)\s*(?:₽|руб|rub)/i);
      }
      
      let amountRub = 0;
      if (match && match[1]) {
        amountRub = Math.floor(parseFloat(match[1].replace(/\s+/g, '').replace(',', '.')));
      } else if (body.amount) {
        amountRub = Math.floor(Number(body.amount));
      }

      if (!amountRub || amountRub <= 0) {
        return send(400, { error: 'Не удалось определить сумму из текста сообщения', text });
      }

      // Ищем заявку по сумме среди ожидающих (pending)
      let foundOrder = null;
      let foundId = null;
      for (const [id, ord] of orders.entries()) {
        if (ord.status === 'pending' && Number(ord.rub) === amountRub) {
          foundOrder = ord;
          foundId = id;
          break;
        }
      }

      if (foundOrder) {
        // Claim ДО await: параллельное СМС-уведомление на ту же сумму не зачислит второй раз
        foundOrder.status = 'paid';
        const r = await creditDeposit(foundOrder.userId, foundOrder.tokens, 'СБП / Карта (Авто)');
        if (!r.credited) {
          foundOrder.status = 'pending';
          return send(500, { error: 'credit failed, retry', amount: amountRub });
        }
        try { db.updateOrderStatus(foundId, 'paid'); } catch (_) {}
        await bot.api.sendMessage(foundOrder.userId,
          `🎉 Платёж успешно распознан и подтверждён автоматикой!\nЗачислено: <b>+${foundOrder.tokens} ⬦</b> (${foundOrder.rub} ₽)!\nПриятной игры в MoneyForUp!`,
          { parse_mode: 'HTML' }
        ).catch(() => {});

        if (ADMIN_ID) {
          await bot.api.sendMessage(ADMIN_ID,
            `🤖 <b>Авто-зачисление по СМС:</b>\n` +
            `├ Заявка: <b>№${escHtml(foundId)}</b>\n` +
            `├ Сумма: <b>${amountRub} ₽</b> (+${foundOrder.tokens} ⬦)\n` +
            `├ Пользователь ID: <code>${foundOrder.userId}</code>\n` +
            `└ Текст смс: <i>${escHtml(text)}</i>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }

        return send(200, { ok: true, matched_order: foundId, amount: amountRub, tokens: foundOrder.tokens });
      }

      // Если конкретная заявка не найдена, уведомляем админа о поступившем платеже без заявки
      if (ADMIN_ID) {
        await bot.api.sendMessage(ADMIN_ID,
          `ℹ️ <b>Получено СМС о пополнении на ${amountRub} ₽, но активная заявка на такую сумму не найдена в очереди:</b>\n` +
          `<i>${escHtml(text)}</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }

      return send(200, { ok: true, note: 'payment received but no pending order matched', amount: amountRub });
    }

    if (!tgUser || !tgUser.id) return send(401, { error: 'initData недействителен' });
    const u = user(tgUser.id, tgUser.first_name, tgUser.username);
    const who = {
      id: u.id,
      numId: u.numId,
      username: tgUser.username || u.username || '',
      name: tgUser.first_name || u.name || '',
      tokens: u.tokens,
      staked: u.staked,
      accrued: stakeAccrued(u),
      refCode: u.code,
      totalDeposited: u.totalDepositedRub || u.lastDeposit || 0,
      lastDeposit: u.lastDeposit || 0,
      lastCashbackAt: u.lastCashbackAt || 0,
      cashbackClaimed: (u.cashbackClaimedDepositId === u.lastDepositId && u.lastDepositId > 0),
      easycashClaimed: !!u.easycashClaimed,
      isAdmin: isAdmin(tgUser),
      notifications: (u.notifications || []).slice(-5)
    };
    if (u.notifications && u.notifications.length > 0) {
      u.notifications = []; // очищаем после доставки клиенту
    }

    /* регистрация/синхронизация: реф-код из start_param, принятие соглашения */
    if (url.pathname === '/api/register' && req.method === 'POST') {
      setRef(u, body.startParam);          // код пригласившего: MF... или старый числовой id
      if (body.termsAcceptedAt) u.termsAt = Number(body.termsAcceptedAt) || Date.now();
      return send(200, { ...who, numId: u.numId, refCode: u.code, link: refLink(u.code), refInvited: countInvited(u.id), refEarned: Math.round(u.refEarned || 0),
                         referredBy: u.ref || null, termsAt: u.termsAt });
    }

    if (url.pathname === '/api/balance') return send(200, { ...who });

    /* ── Ракетка: приём ставки до старта полёта ────────────────────────────── */
    if (url.pathname === '/api/racket/bet' && req.method === 'POST') {
      if (process.env.BOT_DRY_RUN !== '1' && !checkRateLimit(`racket-bet:${u.id}`, 60, 60000)) {
        return send(429, { error: 'Слишком много запросов. Пожалуйста, подождите.' });
      }
      const bet = Math.floor(Number(body.bet != null ? body.bet : body.betTokens) || 0);
      if (bet < 10 || bet > 100000) return send(400, { error: 'Ставка должна быть от 10 до 100000 ⬦' });
      if (bet > Math.floor(u.tokens || 0)) return send(400, { error: 'Недостаточно токенов' });

      const rIdx = Number(body.rIdx) || Math.floor(Date.now() / 30000);
      const roundId = String(body.roundId || ('RK_' + rIdx + '_' + u.id + '_' + crypto.randomBytes(4).toString('hex')));

      const r = applyBalance(u, -bet, 'racket_bet', `Ракетка · ставка в раунде #${rIdx} (${bet} ⬦)`, roundId);
      if (!r.ok) return send(400, { error: 'Не удалось списать ставку' });

      activeRacketBets.set(roundId, {
        userId: u.id,
        bet,
        rIdx,
        createdAt: Date.now(),
        cashed: false
      });

      try {
        db.saveRound({ roundId, userId: u.id, game: 'Ракетка', bet, mult: 1, win: 0, status: 'active' });
      } catch (_) {}

      return send(200, { ok: true, roundId, bet, tokens: u.tokens });
    }

    /* ── Ракетка: кэшаут (забрать выигрыш на текущем множителе) ─────────────── */
    if (url.pathname === '/api/racket/cashout' && req.method === 'POST') {
      const roundId = String(body.roundId || '');
      const saved = activeRacketBets.get(roundId);
      if (!saved || saved.userId !== u.id) {
        return send(400, { error: 'Активная ставка в Ракетке не найдена' });
      }
      if (saved.cashed) {
        return send(400, { error: 'Выигрыш уже забран' });
      }

      const serverCrash = sampleCrash(saved.rIdx);
      const clientMult = Math.round((Number(body.mult) || 1.01) * 100) / 100;

      // Ракета разбилась до того, как игрок нажал кэшаут
      if (clientMult > serverCrash + 0.05) {
        return send(400, { error: `Ракета уже взорвалась на ×${serverCrash}. Ставка сгорела.` });
      }

      const realMult = Math.min(serverCrash, Math.max(1.01, clientMult));
      const win = Math.floor(saved.bet * realMult);
      saved.cashed = true;

      const r = applyBalance(u, win, 'racket_cashout', `Ракетка · выигрыш ×${realMult} (+${win} ⬦)`, roundId);
      if (!r.ok) return send(500, { error: 'Не удалось начислить выигрыш' });

      try {
        db.saveRound({ roundId, userId: u.id, game: 'Ракетка', bet: saved.bet, mult: realMult, win, status: 'settled' });
      } catch (_) {}

      betsMonitor.recordBet({
        userId: u.id,
        name: u.username ? '@' + u.username : (u.name || String(u.id)),
        game: 'Ракетка',
        betTokens: saved.bet,
        winTokens: win,
        balanceAfter: u.tokens,
        totalDepositedRub: u.totalDepositedRub || u.lastDeposit || 0
      });

      return send(200, { ok: true, verdict: 'win', win, mult: realMult, tokens: u.tokens });
    }

    /* Запись результата ставки в отдельный файл мониторинга + серверный античит баланса */
    /* Игра: исход раунда решает СЕРВЕР.
       Клиент присылает только выбор игрока — игру, ставку и желаемый множитель.
       Никакие winTokens/tokens из тела запроса не читаются (это и был эксплойт:
       клиент сам сообщал, сколько выиграл). */
    if ((url.pathname === '/api/play' || url.pathname === '/api/record-bet') && req.method === 'POST') {
      if (process.env.BOT_DRY_RUN !== '1' && !checkRateLimit(`play:${u.id}`, 120, 60000)) {
        return send(429, { error: 'Слишком много игровых запросов. Пожалуйста, играйте чуть медленнее.' });
      }
      const bet = body.bet != null ? body.bet : body.betTokens;
      const res = playRound(
        u,
        body.game,
        bet,
        body.mult != null ? body.mult : body.targetMult,
        body.roundId || body.round_id
      );
      if (!res.ok) return send(400, { error: res.error });
      return send(200, {
        ok: true,
        roundId: res.roundId,
        game: res.game,
        verdict: res.verdict,   // 'win' | 'lose' — клиент обязан отрисовать ИМЕННО это
        win: res.win,
        mult: res.mult,
        tokens: res.tokens,
        // Для кейсов: какой предмет выпал. Клиент обязан показать ЭТОТ предмет,
        // а не выбранный им самим — иначе анимация разойдётся с инвентарём.
        drop: res.drop || null
      });
    }

    /* ── Инвентарь: список предметов игрока ──────────────────────────────────
       Отдаём только НЕпроданное. Цены — из БД, куда они попали из серверного
       каталога, а не из запроса клиента. */
    if (url.pathname === '/api/inventory') {
      const list = db.listInventory(u.id);
      const tot = db.inventoryTotals(u.id);
      return send(200, {
        ok: true,
        items: list.map(it => ({
          id: it.id, code: it.item_code, name: it.name, icon: it.icon,
          price: it.price, tier: it.tier, caseName: it.case_name, wonAt: it.acquired_at
        })),
        count: tot.count,
        value: tot.value,
        tokens: u.tokens
      });
    }

    /* ── Инвентарь: продажа одного предмета ──────────────────────────────────
       Начисление ровно один раз: предмет помечается проданным в той же
       транзакции, что защищает от двух одновременных продаж. */
    if (url.pathname === '/api/inventory/sell' && req.method === 'POST') {
      if (!checkRateLimit(`inv-sell:${u.id}`, 30, 60000)) return send(429, { error: 'Слишком много продаж. Подождите минуту.' });
      const id = Math.floor(Number(body.itemId ?? body.id) || 0);
      if (!id) return send(400, { error: 'Не указан предмет' });
      const it = db.getInventoryItem(id);
      // Чужой предмет и несуществующий отвечают одинаково: не подсказываем
      // игроку, какие id существуют у других.
      if (!it || Number(it.user_id) !== Number(u.id)) return send(404, { error: 'Предмет не найден' });
      if (it.sold_at) return send(400, { error: 'Предмет уже продан' });

      // Сначала помечаем проданным (атомарно, с условием sold_at IS NULL) —
      // если не вышло, значит продали параллельно, и начислять нельзя.
      if (!db.markInventorySold(id, u.id, it.price)) return send(400, { error: 'Предмет уже продан' });

      const r = applyBalance(u, it.price, 'inventory_sale', `Продажа: ${it.name} (${it.case_name})`, 'inv' + id);
      if (!r.ok) {
        // Начисление не прошло — возвращаем предмет владельцу, иначе он пропадёт
        try { db.db.prepare('UPDATE user_inventory SET sold_at = NULL, sold_for = NULL WHERE id = ?').run(id); } catch (_) {}
        return send(500, { error: 'Не удалось начислить токены, повторите позже' });
      }
      return send(200, { ok: true, sold: { id, name: it.name, price: it.price }, tokens: u.tokens });
    }

    /* ── Инвентарь: продать всё ─────────────────────────────────────────────
       Одно начисление на всю пачку (одна запись в ledger). */
    if (url.pathname === '/api/inventory/sell-all' && req.method === 'POST') {
      if (!checkRateLimit(`inv-sell:${u.id}`, 30, 60000)) return send(429, { error: 'Слишком много продаж. Подождите минуту.' });
      const list = db.listInventory(u.id);
      if (!list.length) return send(400, { error: 'Инвентарь пуст' });
      let total = 0;
      const sold = [];
      for (const it of list) {
        if (!db.markInventorySold(it.id, u.id, it.price)) continue;   // продали параллельно — пропускаем
        total += it.price;
        sold.push({ id: it.id, name: it.name, price: it.price });
      }
      if (!total) return send(400, { error: 'Предметы уже проданы' });
      const r = applyBalance(u, total, 'inventory_sale', `Продажа инвентаря: ${sold.length} шт`, 'invall' + Date.now());
      if (!r.ok) {
        for (const it of sold) {
          try { db.db.prepare('UPDATE user_inventory SET sold_at = NULL, sold_for = NULL WHERE id = ?').run(it.id); } catch (_) {}
        }
        return send(500, { error: 'Не удалось начислить токены, повторите позже' });
      }
      return send(200, { ok: true, count: sold.length, total, sold, tokens: u.tokens });
    }

    /* Синхронизация баланса (строго READ-ONLY: клиент не может устанавливать баланс напрямую) */
    if (url.pathname === '/api/sync-balance') {
      return send(200, { ok: true, tokens: u.tokens });
    }

    /* Получение актуальных платёжных реквизитов (только для авторизованных пользователей) */
    if (url.pathname === '/api/requisites') {
      return send(200, {
        ok: true,
        configured: { sbp: !!SBP_PHONE, tinkoff: !!CARD_TINKOFF, sber: !!CARD_SBER, ozon: !!CARD_OZON },
        sbp: { phone: SBP_PHONE, holder: SBP_HOLDER },
        cards: { tinkoff: CARD_TINKOFF, sber: CARD_SBER, ozon: CARD_OZON }
      });
    }

    /* Проверка статуса заявки на пополнение / вывод */
    if (url.pathname === '/api/check-order' && req.method === 'POST') {
      const ordId = String(body.order_id || '');
      const ord = getOrder(ordId);
      if (!ord || ord.userId !== u.id) return send(404, { error: 'Заявка не найдена' });
      return send(200, { status: ord.status, tokens: ord.tokens, rub: ord.rub, balance: u.tokens });
    }

    /* АДМИН-ПАНЕЛЬ: строго только для владельца (isAdmin) */
    if (url.pathname === '/api/admin/overview' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      const dbOrders = db.getAllOrders();
      const allOrders = (dbOrders.length ? dbOrders : [...orders.values()]).map(o => {
        const uId = o.user_id || o.userId;
        const usr = user(uId);
        const usrDep = usr.totalDepositedRub || usr.lastDeposit || 0;
        return {
          id: String(o.id),
          type: o.type || 'deposit',
          userId: uId,
          userName: usr.username ? '@' + usr.username : (usr.name || 'ID ' + uId),
          userDepositedRub: usrDep,
          rub: o.rub,
          tokens: o.tokens,
          method: o.method || o.bank || o.source || 'СБП / Карта',
          details: o.details || o.card || '',
          status: o.status,
          createdAt: o.created_at || o.createdAt || Date.now()
        };
      }).slice(0, 50);

      return send(200, {
        ok: true,
        deposits: allOrders.filter(x => x.type !== 'withdraw').slice(0, 30),
        withdrawals: allOrders.filter(x => x.type === 'withdraw').slice(0, 30),
        stats12h: betsMonitor.getAnalytics(12),
        stats24h: betsMonitor.getAnalytics(24),
        statsAll: betsMonitor.getAnalytics(0)
      });
    }

    if (url.pathname === '/api/admin/order-action' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      const res = await processOrderAction(body.orderId, body.action);
      if (!res.ok) return send(400, { error: res.error });
      return send(200, res);
    }

    if (url.pathname === '/api/terms' && req.method === 'POST') {
      u.termsAt = Date.now();
      return send(200, { termsAt: u.termsAt });
    }

    /* Бонус за подписку на канал @moneyforup (+50 токенов): ЕДИНОЖДЫ на пользователя.
       Гарантия — атомарная транзакция в БД (db.atomicClaimChannel), а не флаг
       в памяти: повторный запрос с любого устройства/после рестарта вернёт already. */
    if (url.pathname === '/api/claim-channel' && req.method === 'POST') {
      if (!checkRateLimit(`claim-channel:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много проверок подписки. Подождите минуту.' });
      if (u.easycashClaimed) return send(400, { error: 'Бонус за подписку уже получен' });

      const COOLDOWN_MS = 30 * 1000;
      const now = Date.now();
      if (u.channelCheckAt && (now - u.channelCheckAt < COOLDOWN_MS)) {
        const secLeft = Math.ceil((COOLDOWN_MS - (now - u.channelCheckAt)) / 1000);
        return send(429, { error: `Повторная проверка доступна через ${secLeft} сек.`, cooldown: secLeft });
      }
      u.channelCheckAt = now;

      try {
        const member = await bot.api.getChatMember('@moneyforup', u.id);
        const isSub = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
        if (!isSub) {
          return send(400, {
            error: 'Вы не подписаны на канал @moneyforup. Подпишитесь и нажмите кнопку снова.',
            cooldown: 30
          });
        }
      } catch (e) {
        console.error('Ошибка проверки подписки на @moneyforup:', e.message);
        return send(400, {
          error: 'Бот не может проверить подписку: добавьте бота администратором в канал @moneyforup.',
          cooldown: 30
        });
      }

      const r = db.atomicClaimChannel(u.id, 50);
      if (!r.ok) {
        if (r.already) { u.easycashClaimed = true; return send(400, { error: 'Бонус за подписку уже получен' }); }
        return send(500, { error: 'Не удалось начислить бонус, попробуйте позже' });
      }
      // Синхронизируем память из транзакции (БД — источник истины)
      u.easycashClaimed = true;
      u.tokens = r.newBalance;   // ledger-ok: значение посчитано внутри atomicClaimChannel, а не клиентом
      return send(200, { success: true, bonus: 50, tokens: u.tokens });
    }

    /* Еженедельный кэшбэк 5 % от последнего пополнения */
    if (url.pathname === '/api/claim-cashback' && req.method === 'POST') {
      if (!checkRateLimit(`claim-cashback:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много запросов кэшбэка. Подождите минуту.' });
      if (!u.lastDeposit || u.lastDeposit <= 0) {
        return send(400, { error: 'У вас ещё не было пополнений для начисления кэшбэка' });
      }
      if (u.cashbackClaimedDepositId === u.lastDepositId) {
        return send(400, { error: 'Кэшбэк с последнего пополнения уже получен' });
      }
      const WEEK_MS = 7 * 24 * 3600 * 1000;
      const now = Date.now();
      if (u.lastCashbackAt && (now - u.lastCashbackAt < WEEK_MS)) {
        const daysLeft = Math.ceil((WEEK_MS - (now - u.lastCashbackAt)) / (24 * 3600 * 1000));
        return send(400, { error: `Кэшбэк доступен раз в неделю. Осталось дней: ${daysLeft}` });
      }

      const cashback = Math.max(1, Math.floor(u.lastDeposit * 0.05));
      const r = applyBalance(u, cashback, 'bonus_cashback', 'Еженедельный кэшбэк 5%');
      if (!r.ok) return send(500, { error: 'Не удалось начислить кэшбэк, попробуйте позже' });
      u.cashbackClaimedDepositId = u.lastDepositId;
      u.lastCashbackAt = now;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (cashback):', e.message); }
      return send(200, { success: true, cashback, tokens: u.tokens });
    }

    /* Заявка на вывод средств (минимум 200 ₽ = 2000 токенов + обязательный депозит) */
    if (url.pathname === '/api/withdraw' && req.method === 'POST') {
      if (!checkRateLimit(`wd:${u.id}`, 5, 60000)) {
        return send(429, { error: 'Слишком много запросов на вывод. Попробуйте через минуту.' });
      }
      const rub = Math.floor(Number(body.rub || 0));
      const method = String(body.method || 'СБП / Карта').trim();
      const details = String(body.details || '').trim();
      const uLabel = tgUser.username ? '@' + tgUser.username : (u.name || 'ID ' + u.id);
      const userDep = u.totalDepositedRub || u.lastDeposit || 0;

      if (isNaN(rub) || rub < 200) {
        return send(400, { error: 'Минимальная сумма вывода — 200 ₽ (2 000 ⬦)' });
      }

      // АНТИЧИТ: запрещаем вывод средств игрокам с 0 ₽ пополнений!
      if (userDep <= 0 && !isAdmin(tgUser)) {
        betsMonitor.flagSuspicious({
          userId: u.id,
          name: uLabel,
          reason: 'Попытка вывода без депозитов (0 ₽)',
          details: `запросил ${rub} ₽ (${rub * TOKENS_PER_RUB} ⬦) на ${details}`
        });
        if (u.tokens > 400) {
          setBalanceTo(u, START_TOKENS, 'anticheat_reset', 'Сброс накрученного баланса (вывод без депозитов)');
        }
        try { db.saveUser(u); } catch (e) { console.error('saveUser (anticheat):', e.message); }
        if (ADMIN_ID) {
          const dossier = betsMonitor.getPlayerDossier(u.id, u);
          bot.api.sendMessage(
            ADMIN_ID,
            `🚨 <b>АНТИЧИТ ЗАБЛОКИРОВАЛ ВЫВОД БЕЗ ДЕПОЗИТА!</b>\n` +
            `├ Игрок: <b>${escHtml(uLabel)}</b> (id: <code>${u.id}</code>)\n` +
            `├ Попытался вывести: <b>${rub} ₽</b> (${rub * TOKENS_PER_RUB} ⬦)\n` +
            `├ Реквизиты: <code>${escHtml(details)}</code>\n` +
            `└ Накрученный баланс сброшен до ${u.tokens} ⬦.\n\n` +
            dossier,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
        return send(400, {
          error: 'Для вывода средств необходим хотя бы один подтверждённый депозит на аккаунте (верификация платёжных реквизитов).',
          remaining: u.tokens
        });
      }

      const neededTokens = rub * TOKENS_PER_RUB;
      if (u.tokens < neededTokens) {
        return send(400, { error: `Недостаточно токенов. Для вывода ${rub} ₽ требуется ${neededTokens} ⬦ (у вас ${Math.floor(u.tokens)} ⬦)` });
      }
      if (!details || details.length < 3) {
        return send(400, { error: 'Укажите корректные реквизиты для вывода (номер карты, телефон СБП или кошелёк)' });
      }

      // Списание ровно один раз; при сбое записи заявку НЕ создаём
      const wr = applyBalance(u, -neededTokens, 'withdraw', `Заявка на вывод ${rub} ₽ на ${details}`);
      if (!wr.ok) return send(500, { error: 'Не удалось списать баланс, попробуйте позже' });
      const orderId = 'WD' + crypto.randomBytes(16).toString('hex').toUpperCase();
      const wdOrder = {
        id: orderId,
        type: 'withdraw',
        userId: u.id,
        rub,
        tokens: neededTokens,
        method,
        details,
        createdAt: Date.now(),
        status: 'pending'
      };
      setOrder(orderId, wdOrder);

      if (ADMIN_ID) {
        const dossier = betsMonitor.getPlayerDossier(u.id, u);
        bot.api.sendMessage(
          ADMIN_ID,
          `💸 <b>Заявка на вывод средств #${escHtml(orderId)}</b>\n` +
          `├ Пользователь: <b>${escHtml(uLabel)}</b> (id: <code>${u.id}</code>)\n` +
          `├ Сумма: <b>${rub} ₽</b> (${neededTokens} ⬦)\n` +
          `├ Способ: <b>${escHtml(method)}</b>\n` +
          `└ Реквизиты: <code>${escHtml(details)}</code>\n\n` +
          dossier,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('☑️ Выплачено (галочка)', 'wd_ok:' + orderId)
              .text('❌ Отклонить', 'wd_no:' + orderId)
          }
        ).catch(e => console.error('Не удалось уведомить админа о выводе:', e.message));
      }

      return send(200, {
        success: true,
        orderId,
        rub,
        tokens: neededTokens,
        remaining: u.tokens
      });
    }

    /* стейкинг */
    if (url.pathname === '/api/stake' && req.method === 'POST') {
      if (!checkRateLimit(`stake:${u.id}`, 30, 60000)) return send(429, { error: 'Слишком много операций стейкинга. Подождите минуту.' });
      const r = stakeAdd(u, body.tokens);
      return send(r.error ? 400 : 200, { ...r, staked: u.staked, accrued: stakeAccrued(u), tokens: u.tokens });
    }
    if (url.pathname === '/api/claim' && req.method === 'POST') {
      if (!checkRateLimit(`stake:${u.id}`, 30, 60000)) return send(429, { error: 'Слишком много операций стейкинга. Подождите минуту.' });
      const r = stakeClaim(u);
      return send(r.error ? 400 : 200, { ...r, staked: u.staked, accrued: stakeAccrued(u) });
    }
    if (url.pathname === '/api/unstake' && req.method === 'POST') {
      if (!checkRateLimit(`stake:${u.id}`, 30, 60000)) return send(429, { error: 'Слишком много операций стейкинга. Подождите минуту.' });
      const r = stakeRemove(u, body.all !== false);
      return send(r.error ? 400 : 200, { ...r, accrued: stakeAccrued(u) });
    }
    if (url.pathname === '/api/refs') {
      const invited = [...users.values()].filter(x => Number(x.ref) === u.id).map(x => ({ name: x.name, tokens: Math.round(x.tokens) }));
      return send(200, { code: u.code, link: refLink(u.code), invited: countInvited(u.id), earned: Math.round(u.refEarned || 0),
                         percent: REF_PERCENT, list: invited });
    }

    /* буст и hot drop */
    if (url.pathname === '/api/boost-status') {
      const now = Date.now();
      const ONE_HOUR = 3600000;
      u.lastHotDrop = u.lastHotDrop || 0;
      const hotDropLeft = Math.max(0, ONE_HOUR - (now - u.lastHotDrop));
      return send(200, {
        hotDropAvailable: hotDropLeft === 0,
        hotDropLeftMs: hotDropLeft,
        balance: u.tokens
      });
    }
    if (url.pathname === '/api/claim-hotdrop' && req.method === 'POST') {
      if (!checkRateLimit(`claim-hotdrop:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много запросов Hot Drop. Подождите минуту.' });
      const now = Date.now();
      const ONE_HOUR = 3600000;
      u.lastHotDrop = u.lastHotDrop || 0;
      if (now - u.lastHotDrop < ONE_HOUR) {
        const leftSec = Math.ceil((ONE_HOUR - (now - u.lastHotDrop)) / 1000);
        return send(400, { error: `Hot Drop перезаряжается. Подождите ${leftSec} сек.` });
      }
      const rewards = [20, 25, 35, 50, 75, 100, 250];
      const win = rewards[Math.floor(Math.random() * rewards.length)];
      const r = applyBalance(u, win, 'bonus_hotdrop', 'Hot Drop');
      if (!r.ok) return send(500, { error: 'Не удалось начислить награду, попробуйте позже' });
      u.lastHotDrop = now;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (hotdrop):', e.message); }
      return send(200, { ok: true, reward: win, balance: u.tokens });
    }

    /* оплата: требуется принятое соглашение */
    if (url.pathname === '/api/invoice' && req.method === 'POST') {
      if (!checkRateLimit(`invoice:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много счетов. Подождите минуту.' });
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || 0));
      const link = await starsInvoiceLink(u.id, tokens);
      return send(200, { invoice_link: link, tokens });
    }
    if (url.pathname === '/api/promo' && req.method === 'POST') {
      if (!checkRateLimit(`promo:${u.id}`, 10, 60000)) {
        return send(429, { error: 'Слишком много попыток ввода промокода. Подождите минуту.' });
      }
      const code = String(body.code || '').trim();
      const res = applyPromo(u.id, code);
      if (!res.ok) {
        return send(400, { error: res.error });
      }
      return send(200, {
        ok: true,
        tokens: res.tokens,
        balance: res.newBalance,
        code: res.code,
        remainingUses: res.remainingUses,
        message: `Зачислено +${res.tokens} ⬦ по промокоду «${res.code}»`
      });
    }
    if (url.pathname === '/api/platega-invoice' && req.method === 'POST') {
      if (!checkRateLimit(`invoice:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много счетов. Подождите минуту.' });
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      if (!plategaOn()) return send(503, { error: 'Platega не настроена' });
      const rub = Math.max(1, Math.floor(Number(body.rub) || 0));
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || rub * TOKENS_PER_RUB));
      try {
        return send(200, await plategaCreate(u, rub, tokens, tgUser.first_name));
      } catch (e) {
        /* провайдер недоступен — отдаём пустой ответ, приложение предложит заявку вручную */
        return send(200, { error: String(e.message || e), tokens });
      }
    }
    if (url.pathname === '/api/check-platega' && req.method === 'POST') {
      if (!checkRateLimit(`check-pay:${u.id}`, 90, 60000)) return send(429, { error: 'Слишком много проверок оплаты. Подождите минуту.' });
      const tx = String(body.invoice_id || '');
      let r = { paid: false };
      try {
        const local = plategaTx.get(tx);
        const paid = (local && local.status === 'paid') || (await plategaStatus(tx)) === 'CONFIRMED';
        if (paid) r = await plategaCredit(tx, local && local.orderId);
      } catch (e) { r = { paid: false, error: String(e.message || e) }; }
      return send(200, { ...r, balance: u.tokens, staked: u.staked, tokens: r.tokens || u.tokens });
    }
    if (url.pathname === '/api/coinso-invoice' && req.method === 'POST') {
      if (!checkRateLimit(`invoice:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много счетов. Подождите минуту.' });
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      if (!coinsoOn()) return send(503, { error: 'Coinso не настроен' });
      const rub = Math.max(1, Math.floor(Number(body.rub) || 0));
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || rub * TOKENS_PER_RUB));
      try {
        const inv = await createCoinsoInvoice(u.id, tokens, rub);
        return send(200, inv);
      } catch (e) {
        return send(500, { error: String(e.message || e), tokens });
      }
    }
    if (url.pathname === '/api/check-coinso' && req.method === 'POST') {
      if (!checkRateLimit(`check-pay:${u.id}`, 90, 60000)) return send(429, { error: 'Слишком много проверок оплаты. Подождите минуту.' });
      const r = await checkCoinsoInvoice(body.invoice_id, body.order_id);
      return send(200, { ...r, balance: u.tokens, staked: u.staked });
    }
    if (url.pathname === '/api/order-sbp' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      if (!checkRateLimit(`order-sbp:${u.id}`, 10, 60000)) {
        return send(429, { error: 'Слишком много заявок на пополнение. Подождите минуту.' });
      }
      const rub = Math.max(1, Math.floor(Number(body.rub) || 0));
      const id = 'SBP_' + crypto.randomBytes(16).toString('hex');
      const tokens = rub * TOKENS_PER_RUB;
      const bank = String(body.bank || 'СБП / Карта').trim();
      const card = String(body.card || '').trim();
      const sender = String(body.sender || '').trim();
      const newOrder = { id, type: 'deposit', userId: u.id, tokens, rub, bank, card, sender, status: 'pending', source: 'СБП / Карта', createdAt: Date.now() };
      setOrder(id, newOrder);
      if (ADMIN_ID) {
        const uLabel = tgUser.username ? `@${tgUser.username}` : (tgUser.first_name || `ID ${u.id}`);
        const msg =
          `💳 <b>Новая заявка на пополнение №${escHtml(id)}</b>\n` +
          `├ Пользователь: <b>${escHtml(uLabel)}</b> (ID: <code>${u.id}</code>)\n` +
          `├ Сумма: <b>${rub} ₽</b> (к зачислению: <b>+${tokens} ⬦</b>)\n` +
          `├ Способ / Банк: <b>${escHtml(bank)}</b>\n` +
          (card ? `├ Реквизит: <code>${escHtml(card)}</code>\n` : '') +
          (sender ? `├ Отправитель / примечание: <code>${escHtml(sender)}</code>\n` : '') +
          `└ Статус: <i>Ожидает подтверждения</i>`;
        await bot.api.sendMessage(ADMIN_ID, msg, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Подтвердить', 'ok:' + id)
            .text('❌ Отклонить', 'no:' + id)
        }).catch(e => console.error('Не удалось отправить админу заявку СБП:', e.message));
      }
      return send(200, { order_id: id, tokens, rub });
    }

    /* Уведомления пользователю в бот (ежедневный кейс / шкала челленджа) */
    if (url.pathname === '/api/notify-event' && req.method === 'POST') {
      const type = String(body.type || '');
      let text = '';
      if (type === 'daily_ready') {
        text = `🎁 <b>Ваш ежедневный кейс готов к открытию!</b>\n\nЗаходите в MoneyForUp и забирайте бесплатные токены дня! 🚀`;
      } else if (type === 'challenge_completed') {
        text = `🎯 <b>Шкала челленджа 24ч полностью заполнена!</b>\n\nВсе ежедневные квесты выполнены! Заберите награды в приложении прямо сейчас! 🔥`;
      } else if (type === 'hotdrop_ready') {
        text = `🔥 <b>Hot Drop перезарядился!</b>\n\nБесплатный контейнер с рулеткой ждёт вас в MoneyForUp! 📦`;
      }
      if (text && u.id) {
        bot.api.sendMessage(u.id, text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp('🎮 Открыть MoneyForUp', APP_URL)
        }).catch(() => {});
      }
      return send(200, { ok: true });
    }

    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e.message || e) });
  }
});

async function initBotProfile() {
  if (process.env.BOT_DRY_RUN === '1' || !BOT_TOKEN) return;
  try {
    await bot.api.setMyDescription({
      description:
`🔥 MoneyForUp — игровая платформа, кейсы и стейкинг в Telegram!

Делай мани, ап-ап! 🚀

• 📦 Кейсы и дропы — скины и предметы
• 🚀 Ракетка 24/7 — успей забрать до взрыва
• 🍺 Скуф vs Альтушка, Dice, Колесо Фортуны
• 📈 Стейкинг 1 % в сутки с начислением каждую секунду
• 👥 Реферальная программа 15 % с пополнений
• 🎟 Промокоды и ежедневные бонусы

Жми «Старт» и забирай свои первые токены! 👇`
    });
    await bot.api.setMyShortDescription({
      short_description: 'MoneyForUp — Делай мани, ап-ап! 🚀 Кейсы, Ракетка и стейкинг.'
    });
    console.log('[Telegram] Описание профиля бота обновлено');
  } catch (e) {
    console.warn('[Telegram] Не удалось обновить описание бота:', e.message);
  }
}
initBotProfile();

bot.catch(err => {
  console.error('[Grammy Bot Error]:', err.message || err);
});

async function startBotSafely() {
  if (process.env.BOT_DRY_RUN === '1') {
    console.log('BOT_DRY_RUN: опрос Telegram отключён');
    return;
  }
  while (true) {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      await bot.start({
        drop_pending_updates: false,
        onStart: (botInfo) => {
          console.log(`✅ Telegram-бот @${botInfo.username} успешно запущен (Long Polling активен)`);
        }
      });
      break;
    } catch (err) {
      if (err && err.error_code === 409) {
        console.warn('⏳ [Render 409 Conflict]: Предыдущий экземпляр бота ещё завершает работу (или запущен второй инстанс). Повторное подключение через 5 сек...');
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.error('⚠️ Ошибка запуска бота, повтор через 5 сек:', err.message || err);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

// Плавное завершение при деплое на Render, чтобы не возникал 409 Conflict
process.once('SIGTERM', async () => {
  console.log('Получен SIGTERM, останавливаем опрос Telegram...');
  try { bot.stop(); } catch (_) {}
  if (db.waitForTurso) await db.waitForTurso(3000);
  process.exit(0);
});
process.once('SIGINT', async () => {
  console.log('Получен SIGINT, останавливаем опрос Telegram...');
  try { bot.stop(); } catch (_) {}
  if (db.waitForTurso) await db.waitForTurso(3000);
  process.exit(0);
});

// Автоматическая отправка сводки ставок и PnL проекта каждые 12 часов (полдня)
const HALF_DAY_MS = 12 * 3600 * 1000;
setInterval(() => {
  if (ADMIN_ID) {
    const report = betsMonitor.formatTelegramReport(12);
    bot.api.sendMessage(ADMIN_ID, '⏰ <b>АВТОМАТИЧЕСКИЙ ОТЧЁТ ЗА 12 ЧАСОВ (ПОЛДНЯ)</b>\n\n' + report, {
      parse_mode: 'HTML',
      reply_markup: getAdminStatsKeyboard()
    }).catch(e => console.error('Ошибка отправки 12ч отчёта админу:', e.message));
  }
}, HALF_DAY_MS);

async function initPersistence() {
  if (db.tursoOn && db.tursoOn()) {
    try {
      const res = await db.pullFromTurso();
      if (res && res.ok) {
        reloadOrdersFromDb();
      }
    } catch (e) {
      console.error('[Turso] Ошибка восстановления данных при старте:', e.message);
    }
  }
}
// ВАЖНО: сначала восстановление из Turso, и только потом приём запросов.
// Раньше listen стартовал параллельно pull, и вернувшийся игрок успевал
// создаться локально с 50 ⬦, затирая облачный баланс (см. turso.js).
(async () => {
  await initPersistence();
  server.listen(API_PORT, '0.0.0.0', () => console.log(`API слушает порт ${API_PORT}`));
  startBotSafely();
})();
console.log('Бот запущен. Стейкинг 1 %/сутки, рефералы ' + REF_PERCENT + ' %'
  + ' · Промокодов активно: ' + promoCodes.size
  + ' · Coinso (Крипта): ' + (coinsoOn() ? 'вкл' : 'выкл')
  + (PUBLIC_URL ? ' · вебхуки: ' + PUBLIC_URL : ' · PUBLIC_URL не задан: вебхуки не придут, работает опрос статуса'));

/* ── Проверка условий эксплуатации, от которых зависят деньги ─────────────── */
(function checkRuntime() {
  console.log('[DB] База: ' + db.DB_PATH);
  if (db.tursoOn && db.tursoOn()) {
    console.log('[DB] ✅ Подключено вечное облачное хранилище Turso (база сохраняется между деплоями)');
  } else {
    const onEphemeralHost = !!(process.env.RENDER || process.env.FLY_APP_NAME || process.env.DYNO);
    if (!process.env.DB_PATH) {
      console.warn(
        '[DB] ВНИМАНИЕ: DB_PATH не задан, база лежит внутри каталога проекта.\n' +
        '     На хостингах с эфемерной ФС (Render/Fly/Heroku) этот каталог СТИРАЕТСЯ\n' +
        '     при каждом деплое и рестарте — вместе с балансами, журналом и заявками.\n' +
        '     Смонтируйте постоянный диск или задайте TURSO_DATABASE_URL/TURSO_AUTH_TOKEN.' +
        (onEphemeralHost ? '\n     Обнаружена эфемерная среда — это ОПАСНО для денег.' : '')
      );
    }
  }
  if (!SBP_PHONE && !CARD_TINKOFF && !CARD_SBER && !CARD_OZON) {
    console.warn('[Payments] ВНИМАНИЕ: реквизиты пополнения не заданы (SBP_PHONE / CARD_TINKOFF / CARD_SBER / CARD_OZON). ' +
      'Игроки увидят «реквизиты не настроены» вместо номера карты. Заполните переменные в окружении хостинга.');
  }
  if (!PUBLIC_URL) {
    console.warn('[Webhooks] PUBLIC_URL не задан: вебхуки Platega/Coinso не придут, работаем опросом статуса.');
  }
  if (!process.env.PAYMENT_WEBHOOK_SECRET) {
    console.warn('[Webhooks] PAYMENT_WEBHOOK_SECRET не задан: авто-зачисление по СМС отключено (это безопасный режим).');
  }
})();
