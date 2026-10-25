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
const rtp           = require('./rtp');     // единый RTP/edge для всех режимов
const upgrade       = require('./upgrade'); // серверная модель Апгрейдера
const pulse         = require('./pulse');   // Pulse Market: исход и выплаты (DECISIONS D5)
const boost         = require('./boost');   // персональный буст дропа из админки
const trend         = require('./trend');   // Trend Hunter: сценарии и проверка ответа (DECISIONS D6)
const progress      = require('./progress'); // прогрессия: миссии, титулы, сезон — без токенов (D7/D8)
// Старт сезона фиксирован в коде, чтобы не сдвигался при перезапуске.
const SEASON_START_MS = Date.UTC(2026, 9, 1);   // 1 октября 2026 (UTC)
/* Каталог пяти новых режимов кейсов — единый UMD-файл: его же грузит браузер
   как статику. Поэтому цены/предметы не дублируются между фронтом и бэком. */
const caseModes     = require('./assets/case-modes.js');
// Цена режима и цены предметов лежат в одном конфиге. Если после правки
// цены доля возврата игроку вышла из безопасного коридора — предупреждаем
// на старте, чтобы кейс не начал печатать токены.
for (const __cm of Object.values(caseModes.MODES || {})) {
  try {
    const __economy = caseModes.caseEconomy(__cm.id);
    if (!__economy || !Number.isFinite(__economy.returnRate) || __economy.returnRate < 0.78 || __economy.returnRate > 0.90) {
      console.warn(`[CaseModes] ${__cm.name}: возврат игроку ${__economy ? (__economy.returnRate * 100).toFixed(2) + '%' : '?'} вне коридора 78–90% — проверьте цены в assets/case-modes.js`);
    }
  } catch (e) {
    console.warn(`[CaseModes] ${__cm && __cm.id}: не удалось посчитать экономику: ${e.message}`);
  }
}

function isAdmin(u) {
  if (!u || !ADMIN_ID) return false;
  return Number(u.id) === ADMIN_ID;
}

/* Персональный буст читается из БД на каждый раунд: админка меняет его на лету.
   Ошибка чтения = играем без буста, чтобы сбой таблицы не блокировал игры. */
function playerLuck(userId) {
  try {
    return db.getPlayerBoost ? db.getPlayerBoost(userId) : 0;
  } catch (e) {
    console.error('[Boost] read failed:', e.message);
    return 0;
  }
}

/* Кейс с шансом на улучшенный дроп. classic=true — старый каталог items.js,
   иначе — режимы из assets/case-modes.js. */
function rollCaseDrop(userId, caseId, classic) {
  const roll = () => classic
    ? items.rollItem(caseId, rnd01())
    : caseModes.rollItem(caseId, rnd01());
  return boost.boostDrop(playerLuck(userId), rnd01(), roll);
}

/* Два одноразовых FREE-кейса за друзей. Предметы коллекционные:
   их нельзя продать, апгрейднуть или обменять — только хранить. */
const FREE_REF_CASES = {
  3: {
    level: 3, needed: 3, caseId: 'case_free3', caseName: 'FREE · Кейс за 3 друзей',
    code: 'ref3_tws_blackgold', name: 'TWS-наушники Black Gold', icon: '🎧',
    price: 1700, tier: 'secret'
  },
  5: {
    level: 5, needed: 5, caseId: 'case_free5', caseName: 'FREE · Кейс за 5 друзей',
    code: 'ref5_watch_onyx', name: 'Смарт-часы Onyx Gold', icon: '⌚',
    price: 2400, tier: 'secret'
  }
};
function publicFreeRefItem(def) {
  return {
    code: def.code, name: def.name, icon: def.icon, price: def.price,
    priceRub: Math.round(def.price / TOKENS_PER_RUB),
    tier: def.tier, needed: def.needed, collectible: 1, upgradeOnly: 0
  };
}
function grantReferralFreeCase(u, level) {
  const def = FREE_REF_CASES[level];
  if (!def) return { ok: false, error: 'Неизвестный бесплатный кейс' };
  const claimed = level === 3 ? Number(u.freeCase3RefClaimed || 0) : Number(u.freeCase5RefClaimed || 0);
  if (claimed) return { ok: false, error: 'Этот бесплатный кейс уже открыт — он одноразовый.' };
  const qualified = db.getQualifiedFriendsCount ? db.getQualifiedFriendsCount(u.id) : 0;
  if (qualified < def.needed) {
    return { ok: false, error: `Нужно пригласить ${def.needed} активных друзей (сейчас ${qualified}/${def.needed}).` };
  }
  const claimedNow = level === 3 ? db.claim3RefCase(u.id) : db.claim5RefCase(u.id);
  if (!claimedNow) return { ok: false, error: 'Этот бесплатный кейс уже открыт — он одноразовый.' };
  if (level === 3) u.freeCase3RefClaimed = 1; else u.freeCase5RefClaimed = 1;

  const roundId = 'FREE' + level + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  let itemId = null;
  try {
    const saved = db.addInventoryItem({
      userId: u.id, itemCode: def.code, name: def.name, icon: def.icon,
      price: def.price, tier: def.tier, caseId: def.caseId, caseName: def.caseName,
      roundId, collectible: 1
    });
    itemId = saved.id;
  } catch (e) {
    console.error(`[Inventory] FREE-предмет ${def.code} не сохранён игроку ${u.id}: ${e.message}`);
    if (level === 3) { db.release3RefCase(u.id); u.freeCase3RefClaimed = 0; }
    else { db.release5RefCase(u.id); u.freeCase5RefClaimed = 0; }
    try { db.saveUser(u); } catch (_) {}
    return { ok: false, error: 'Не удалось выдать предмет, право на кейс сохранено.' };
  }
  try { db.saveUser(u); } catch (_) {}
  try {
    db.saveRound({
      roundId, userId: u.id, game: def.caseName, bet: 0, mult: 1, win: 0,
      status: 'settled', itemCode: def.code, itemPrice: def.price
    });
  } catch (e) { console.error('[Round] FREE-кейс не сохранён:', e.message); }
  return {
    ok: true, roundId,
    drop: {
      id: itemId, code: def.code, name: def.name, icon: def.icon,
      price: def.price, tier: def.tier, caseName: def.caseName,
      collectible: true, upgradeOnly: 0
    }
  };
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
/* CSPRNG для ДЕНЕЖНЫХ исходов. Math.random() (xorshift) наблюдаем и при большом
   числе запросов предсказуем — для ставок и секретных кодов не годится. */
const rnd01 = () => crypto.randomInt(0, 1_000_000) / 1_000_000;
const rndInt = (n) => crypto.randomInt(0, n);
/* IP клиента для rate-limit. X-Forwarded-For подделывается кем угодно, поэтому
   доверяем ему ТОЛЬКО если приложение реально стоит за доверенным прокси
   (TRUST_PROXY=1). Иначе берём настоящий адрес сокета. */
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
/* CORS: по умолчанию разрешаем origin из APP_URL. Дополнительные origin
   (например, web.telegram.org) можно перечислить в CORS_ORIGINS через запятую. */
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
function corsOrigin(req) {
  const origin = String((req.headers && req.headers.origin) || '');
  if (!origin) return '';
  if (CORS_ORIGINS.length) return CORS_ORIGINS.includes(origin) ? origin : '';
  try {
    const appOrigin = new URL(APP_URL).origin;
    return (origin === appOrigin || origin === 'https://web.telegram.org') ? origin : '';
  } catch (_) { return ''; }
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

const TOKENS_PER_RUB  = 10;     // внутренние единицы; игрок видит рубли (10 = 1 ₽)
const STARS_TO_TOKENS = 20;     // 1 звезда ≈ 2 ₽
const START_TOKENS    = 50;
const STAKE_RATE      = 0.01;   // 1 % в сутки
const DAY_MS          = 86400000;
const REF_PERCENT     = 15;     // 15 % от пополнений приглашённых
/* Ежедневные награды. Суммы всегда берутся отсюда, а не из тела запроса. */
const STREAK_REWARDS = [25, 45, 70, 100, 140, 180, 250];
const QUEST_REWARDS = { q1: 30, q2: 25, q3: 20 };
/* Заявка на пополнение живёт ровно час: это окно оплаты. По истечении
   она отменяется автоматически и в мини-аппе, и в чате админа. */
const DEPOSIT_TTL_MS   = Math.max(5000, Number(process.env.DEPOSIT_TTL_MS) || 60 * 60 * 1000);
const DEPOSIT_TTL_TEXT = '1 час';
const DEPOSIT_SWEEP_MS = 30000;
/* Все суммы игроку показываем в рублях: делим внутренние единицы на курс. */
const rubOf = tk => Math.round((Number(tk) || 0) / TOKENS_PER_RUB * 100) / 100;
const rub = tk => rubOf(tk).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
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
        updatedAt: o.updated_at,
        expiresAt: o.expires_at,
        adminMsgId: o.admin_msg_id,
        adminChatId: o.admin_chat_id
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
        updatedAt: fromDb.updated_at,
        expiresAt: fromDb.expires_at,
        adminMsgId: fromDb.admin_msg_id,
        adminChatId: fromDb.admin_chat_id
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

/* ---------- срок жизни заявок на пополнение -------------------------------
   Ручная заявка (СБП/карта) — это окно оплаты ровно на час. Автоматические
   счета Platega/Coinso сюда не попадают: у них свой вебхук и статус. */
function orderExpiresAt(order) {
  if (!order || order.type === 'withdraw') return 0;
  const stored = Number(order.expiresAt || 0);
  if (stored > 0) return stored;
  const created = Number(order.createdAt || 0);
  return created > 0 ? created + DEPOSIT_TTL_MS : 0;
}

function isManualDeposit(order) {
  return !!order && order.type !== 'withdraw' &&
    (order.source === 'СБП / Карта' || Boolean(order.bank) || Boolean(order.card));
}

const ordersExpiring = new Set();

async function expireDepositOrder(order, now = Date.now(), opts = {}) {
  if (!order || order.status !== 'pending' || !isManualDeposit(order)) return false;
  const expiresAt = orderExpiresAt(order);
  if (!expiresAt || now < expiresAt) return false;
  const key = String(order.id);
  if (ordersExpiring.has(key)) return false;
  ordersExpiring.add(key);
  const notifyUser = opts.notify !== false;
  try {
    order.status = 'expired';
    order.completedAt = now;
    try { db.updateOrderStatus(order.id, 'expired'); } catch (e) { console.error('[Orders] expire db:', e.message); }
    const until = new Date(expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const chatId = Number(order.adminChatId || 0);
    const msgId = Number(order.adminMsgId || 0);
    if (chatId && msgId) {
      bot.api.editMessageText(chatId, msgId,
        `⌛ <b>Заявка №${escHtml(order.id)} истекла</b>\n` +
        `├ Игрок: <code>${order.userId}</code>\n` +
        `├ Сумма: <b>${order.rub} ₽</b>\n` +
        `└ Срок — ${DEPOSIT_TTL_TEXT} (до ${until}). Заявка отменена, подтвердить её нельзя.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      ).catch(() => {});
    }
    if (notifyUser) {
      bot.api.sendMessage(Number(order.userId),
        `⌛ <b>Заявка на пополнение №${escHtml(order.id)} на ${order.rub} ₽ истекла.</b>\n\n` +
        `Окно оплаты — ${DEPOSIT_TTL_TEXT}. Если вы уже перевели деньги, напишите @lev_god и приложите чек. ` +
        `Иначе создайте новую заявку в приложении.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    console.log(`[Orders] заявка ${order.id} истекла (${order.rub} ₽, user ${order.userId}${notifyUser ? '' : ', без уведомления'})`);
    return true;
  } finally {
    ordersExpiring.delete(key);
  }
}

async function sweepExpiredDeposits(now = Date.now()) {
  let rows = [];
  try {
    rows = db.listPendingManualDeposits();
  } catch (e) {
    console.warn('[Orders] sweep db:', e.message);
    rows = [...orders.values()].filter(o => o.status === 'pending' && isManualDeposit(o));
  }
  for (const row of rows) {
    const order = getOrder(row.id);
    if (!order || order.status !== 'pending' || !isManualDeposit(order)) continue;
    if (!Number(order.expiresAt || 0)) {
      // Старые заявки до этой миграции: срок отсчитывается от создания.
      order.expiresAt = orderExpiresAt(order);
      try { setOrder(order.id, order); } catch (_) {}
    }
    const lateMs = now - orderExpiresAt(order);
    // Заявки, просроченные давно (бот лежал/старая база), закрываем без
    // сообщения игроку, чтобы первый запуск не рассылал пачку уведомлений.
    await expireDepositOrder(order, now, { notify: lateMs <= 6 * 60 * 60 * 1000 });
  }
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
  // Запрещаем циклы в реферальном графе (A→B→A и длиннее): иначе два своих
  // аккаунта можно привязать друг к другу и раскручивать бонусы взаимно.
  let cur = Number(refId), hops = 0;
  while (cur && hops++ < 50) {
    if (cur === Number(u.id)) return 0;
    const next = users.get(cur) || db.getUser(cur);
    if (!next) break;
    cur = Number(next.ref) || 0;
  }
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
      u.rakeback = Number(u.rakeback || 0);
      u.freeCases = Number(u.freeCases || 0);
      u.freeCase5RefClaimed = Number(u.freeCase5RefClaimed || 0);
      u.freeCase3RefClaimed = Number(u.freeCase3RefClaimed || 0);
      u.freeDailyAt = Number(u.freeDailyAt || 0);
      u.freeNotifiedAt = Number(u.freeNotifiedAt || 0);
      u.freeNotifyDay = String(u.freeNotifyDay || '');
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
        easycashClaimed: false, rakeback: 0, freeCases: 0, freeCase5RefClaimed: 0,
        freeCase3RefClaimed: 0, freeDailyAt: 0, freeNotifiedAt: 0, freeNotifyDay: '',
        lastHotDrop: 0, lastWheelSpin: 0, lastStreakAt: 0, streakDay: 1,
        notifications: []
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
  dice:          { label: 'Dice',              minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: rtp.edgeOf('dice'), defaultMult: 1.95 },
  jumper:        { label: 'Попрыгун',          minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 120,  edge: rtp.edgeOf('jumper'),  defaultMult: 2.0 },
  spin:          { label: 'Спин',              minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: rtp.edgeOf('spin'),  defaultMult: 2.0 },
  drop:          { label: 'Дроп',              minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: rtp.edgeOf('drop'),  defaultMult: 2.0 },
  skuf:          { label: 'Скуф vs Альтушка',  minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: rtp.edgeOf('skuf'),  defaultMult: 2.0 },
  avito:         { label: 'Перекуп на Авито',  minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: rtp.edgeOf('avito'),  defaultMult: 2.0 },
  cases:         { label: 'Апгрейд кейса',     minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 30,   edge: rtp.edgeOf('cases'),  defaultMult: 2.0 },
  upgrader:      { label: 'Апгрейдер',         minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 100,  edge: rtp.edgeOf('upgrader'),  defaultMult: 2.0 },
  auction:       { label: 'Тайный аукцион',    minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: rtp.edgeOf('auction'),  defaultMult: 1.8 },
  racket:        { label: 'Ракетка',           minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 30,   edge: rtp.edgeOf('racket'),  defaultMult: 1.7 },
  hotdrop:       { label: 'Hot Drop',          minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: rtp.edgeOf('hotdrop'),  defaultMult: 2.0 },
  wheel:         { label: 'Колесо Фортуны',    minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: rtp.edgeOf('wheel'),  defaultMult: 2.0 },
  challenge:     { label: 'Челлендж 24ч',      minBet: 10, maxBet: 100000, minMult: 1.1, maxMult: 20,   edge: rtp.edgeOf('challenge'),  defaultMult: 1.8 },
  scratch:       { label: 'Скретч-карты',      minBet: 20, maxBet: 50000,  minMult: 1.5, maxMult: 200,  edge: rtp.edgeOf('scratch'), defaultMult: 2.0 },
  revolver:      { label: 'Револьвер',         minBet: 10, maxBet: 50000,  minMult: 1.18, maxMult: 29,  edge: rtp.edgeOf('revolver'),  defaultMult: 1.5 },
  safe:          { label: 'Взлом Сейфа',       minBet: 25, maxBet: 25,     minMult: 1.0, maxMult: 1000, edge: rtp.edgeOf('safe'),  defaultMult: 1.0 },
  // Неизвестная игра: консервативный профиль вместо отказа — чтобы клиент не ломался
  __default:     { label: 'Игра',              minBet: 10, maxBet: 10000,  minMult: 1.1, maxMult: 2,    edge: rtp.edgeOf('__default'),  defaultMult: 2.0 }
};

/* ── Ракетка (Crash Game 24/7): точка взрыва — СЕРВЕРНЫЙ секрет ──
   Раньше crash = sampleCrash(rIdx), где rIdx приходил от клиента, а сама функция
   детерминирована и есть в открытом index.html. Значит, читер считал точку взрыва
   заранее и ставил только на «хорошие» раунды — гарантированный плюс.
   Теперь r берётся из CSPRNG на сервере, раунд фиксируется по серверным часам,
   а точка взрыва раскрывается клиенту только когда полёт до неё уже дошёл. */
const RK = { tcap: 12, k: 0.18 };
const RACKET_ROUND_MS = 30000;
const RACKET_WAIT_MS = 10000;
const RACKET_SPEED = 0.58;

/* Раскладка точки взрыва по равномерному r∈[0,1) (та же математика, что была на клиенте). */
function crashFromRBase(r) {
  if (r < 0.08) return 1.00;                                   // мгновенный взрыв
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

/* Снижение RTP Crash: точки взрыва чуть ниже, минимальный множитель остаётся 1.00.
   Коэффициент общий с симулятором (rtp.js), поэтому проверка RTP не расходится с игрой. */
function crashFromR(r) {
  const base = crashFromRBase(r);
  if (base <= 1) return 1.00;
  return Math.max(1.00, Math.round(base * rtp.CRASH_POINT_SCALE * 100) / 100);
}

/* Точка взрыва раунда живёт только на сервере и раскрывается по факту (см. /api/racket/state). */
const racketRounds = new Map(); // rIdx -> { crash, createdAt }
function getRacketRound(rIdx) {
  let r = racketRounds.get(rIdx);
  if (!r) {
    r = { crash: crashFromR(rnd01()), createdAt: Date.now() };
    racketRounds.set(rIdx, r);
  }
  return r;
}
/* Момент времени (мс от начала раунда), когда множитель полёта достигает crash. */
function racketBustMs(crash) {
  const L = Math.log(Math.max(1, crash)) / RK.k;      // tau(s)*k = ln(crash)
  const s = (-1 + Math.sqrt(1 + 0.24 * L)) / 0.12;     // 0.06 s^2 + s - L = 0
  return RACKET_WAIT_MS + (s / RACKET_SPEED) * 1000;
}
/* Момент краха в абсолютном времени. После полуночи rIdx*ROUND_MS — это
   начало раунда, поэтому условие «уже взорвалась» не зависит от часов клиента. */
function racketBustAt(rIdx, crash) {
  return rIdx * RACKET_ROUND_MS + racketBustMs(crash);
}
/* Точка краха переживает перезапуск: сохраняем её в params ставки и
   восстанавливаем в память, чтобы кэшаут после рестарта считался по тому же
   секрету, а не по новому случайному. */
function rememberRacketRound(rIdx, crash) {
  if (Number.isFinite(crash) && crash >= 1) {
    let r = racketRounds.get(rIdx);
    if (!r) {
      r = { crash: Number(crash), createdAt: Date.now() };
      racketRounds.set(rIdx, r);
    }
    return r;
  }
  return getRacketRound(rIdx);
}
function racketRIdxFromRoundId(roundId) {
  const m = /^RK_(\d+)_/.exec(String(roundId || ''));
  return m ? Number(m[1]) : null;
}
/* Живым может быть только текущий раунд (или предыдущий — на границе 30 с).
   Будущий индекс из подделанного roundId не должен открывать кэшаут. */
function racketRoundIsLive(rIdx) {
  if (!Number.isFinite(rIdx)) return false;
  const nowIdx = Math.floor(Date.now() / RACKET_ROUND_MS);
  return rIdx === nowIdx || rIdx === nowIdx - 1;
}

const activeRacketBets = new Map(); // roundId -> { userId, bet, rIdx, crash, createdAt, cashed, settled }
// Pulse Market: серверный seed и параметры открытых раундов (до раскрытия результата).
const pulseRounds = new Map();     // roundId -> { userId, seed, startedAt, dueAt, direction, leverage, duration, bet, settled }
// Trend Hunter: открытые сценарии (с правильным ответом на сервере) и комбо игрока.
const trendRounds = new Map();     // roundId -> { userId, bet, level, scenario, answered, result, deadline, settledAt }
const trendComboState = new Map(); // userId -> число правильных подряд (только отображение)
function trendCombo(userId) { return trendComboState.get(userId) || 0; }
const activeRevolvers = new Map();  // userId -> { bet, bullet, step, insurance, createdAt }

setInterval(() => {
  const now = Date.now();
  for (const [id, bet] of activeRacketBets.entries()) {
    // Незакрытую ставку не выбрасываем: свип должен сначала записать проигрыш.
    if (now - bet.createdAt > 300000 && (bet.cashed || bet.settled)) activeRacketBets.delete(id);
  }
  for (const [rIdx, round] of racketRounds.entries()) {
    // держим только текущий и пару прошлых раундов (нужно для истории/поздних кэшаутов)
    if (now - rIdx * RACKET_ROUND_MS > 300000) racketRounds.delete(rIdx);
  }
  for (const [uid, rev] of activeRevolvers.entries()) {
    if (now - rev.createdAt > 300000) activeRevolvers.delete(uid);
  }
}, 60000).unref();

/* Незабранная ставка Ракетки — проигрыш, как только ракета взорвалась.
   Пишем финальный статус в game_rounds, чтобы раунд не висел active вечно
   после закрытия приложения и находился в истории. Денег здесь не трогаем:
   ставка уже списана при приёме. */
function settleRacketLoss(roundId, saved, force = false) {
  if (!saved || saved.cashed || saved.settled) return false;
  const r = rememberRacketRound(saved.rIdx, saved.crash);
  saved.crash = r.crash;
  if (!force && Date.now() <= racketBustAt(saved.rIdx, r.crash)) return false;
  const closed = db.settleRoundOnce({
    roundId, userId: saved.userId, game: 'Ракетка', bet: saved.bet,
    mult: 0, win: 0, status: 'settled', settledAt: Date.now()
  });
  saved.settled = true;
  if (!closed) return false;
  try {
    const row = db.getRoundParams(roundId, saved.userId);
    const p = (row && row.params) || {};
    db.setRoundParams(roundId, saved.userId, null, {
      ...p, rIdx: saved.rIdx, crash: r.crash, autoClosed: true, settledAt: Date.now()
    });
  } catch (e) { console.error('[Racket] loss params:', e.message); }
  return true;
}

/* Клиентский roundId превращаем в пространство имён пользователя. Иначе
   игрок мог занять чужой ключ идемпотентности и заблокировать чужой раунд. */
function scopedRoundId(userId, raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, roundId: '' };
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(s)) return { ok: false, error: 'Некорректный идентификатор раунда' };
  return { ok: true, roundId: `U${userId}_${s}` };
}

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
    'дис': 'dice', 'кости': 'dice', 'челлендж': 'challenge', 'challenge24': 'challenge',
    'челлендж_24ч': 'challenge', 'скретч': 'scratch', 'скретч_карты': 'scratch',
    'револьвер': 'revolver', 'русская_рулетка': 'revolver', 'сейф': 'safe', 'взлом_сейфа': 'safe'
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
 * Почему так: EV предмета в кейсах 0.74–0.88 от цены кейса (см. caseEconomy).
 * Если вдобавок платить токены по обычной формуле, суммарный возврат игроку станет ~1.7
 * и кейс начнёт печатать деньги. Ценность забирается продажей предмета.
 */
function playCaseRound(u, c, rawBet, rawRoundId) {
  const bet = Math.floor(Number(rawBet) || 0);
  // Ставка обязана равняться цене кейса: иначе игрок откроет кейс за 10000,
  // поставив 10 ⬦, и получит предмет со средним выигрышем ~8 750 ⬦.
  if (bet !== c.cost) {
    return { ok: false, error: `Кейс «${c.name}» стоит ${rub(c.cost)}` };
  }
  if (bet > Math.floor(u.tokens || 0)) return { ok: false, error: 'Недостаточно средств' };

  const scoped = scopedRoundId(u.id, rawRoundId);
  if (!scoped.ok) return { ok: false, error: scoped.error };
  const roundId = scoped.roundId ||
    ('C' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex'));

  // Атомарный claim: PRIMARY KEY round_id. Два параллельных запроса с одним
  // roundId не могут оба пройти проверку и списать цену дважды.
  let claimed = false;
  try {
    claimed = db.claimRound({ roundId, userId: u.id, game: 'Кейс: ' + c.name, bet });
  } catch (e) {
    console.error('[Round] claim failed:', e.message);
    return { ok: false, error: 'Не удалось начать раунд, повторите позже' };
  }
  if (!claimed) return { ok: false, error: 'Раунд уже проведён' };

  // Жребий предмета — серверный CSPRNG, веса из серверного каталога.
  // Персональный буст может добавить два броска и оставить лучший предмет.
  const drop = rollCaseDrop(u.id, c.id, true);
  if (!drop) {
    db.releaseRoundClaim(roundId, u.id);
    return { ok: false, error: 'Кейс недоступен' };
  }

  // Деньги: списываем ровно цену кейса. Выигрыш придёт ПРОДАЖЕЙ предмета.
  const r = applyBalance(u, -bet, 'game_round',
    `Кейс «${c.name}» · раунд ${roundId} (ставка ${bet}, выпало: ${drop.name})`, roundId);
  if (!r.ok) {
    db.releaseRoundClaim(roundId, u.id);
    return { ok: false, error: 'Не удалось провести раунд, повторите позже' };
  }

  // Предмет кладём ПОСЛЕ успешного списания: иначе предмет был бы, а оплаты нет
  let itemId = null;
  try {
    const saved = db.addInventoryItem({
      userId: u.id, itemCode: drop.code, name: drop.name, icon: drop.icon,
      price: drop.price, tier: drop.tier, caseId: c.id, caseName: c.name, roundId
    });
    itemId = saved.id;
  } catch (e) {
    // Предмет не сохранился — возвращаем деньги и освобождаем claim, чтобы
    // игрок не остался без предмета и без токенов.
    console.error(`[Inventory] предмет не сохранён игроку ${u.id}: ${e.message}`);
    applyBalance(u, bet, 'game_round', `Возврат за кейс «${c.name}»: предмет не сохранён`, roundId);
    db.releaseRoundClaim(roundId, u.id);
    return { ok: false, error: 'Не удалось выдать предмет, средства возвращены' };
  }

  const verdict = drop.price >= bet ? 'win' : 'lose';   // для анимации: отбился или нет
  try {
    db.settleRound({ roundId, userId: u.id, game: 'Кейс: ' + c.name, bet, mult: 1, win: 0,
      status: 'settled', itemCode: drop.code, itemPrice: drop.price });
  } catch (e) { console.error('[Round] не сохранён:', e.message); }

  betsMonitor.recordBet({
    userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
    game: 'Кейс: ' + c.name, betTokens: bet, winTokens: 0,
    balanceAfter: u.tokens, totalDepositedRub: u.totalDepositedRub || u.lastDeposit || 0
  });

  // Рейкбек: 0.5% от суммы ставки в кейсе
  u.rakeback = Math.round(((u.rakeback || 0) + (bet * 0.005)) * 100) / 100;
  try { db.saveUser(u); } catch (_) {}

  return {
    ok: true, roundId, game: 'Кейс: ' + c.name, gameKey: 'case',
    verdict, win: 0, mult: 1, tokens: u.tokens, case: c.id,
    drop: { id: itemId, code: drop.code, name: drop.name, icon: drop.icon,
            price: drop.price, tier: drop.tier, caseName: c.name }
  };
}

function playRound(u, rawGame, rawBet, rawMult, rawRoundId, rawItemId) {
  const cfg = gameConfig(rawGame);

  // Если передан предмет из инвентаря для апгрейда
  let invItem = null;
  if (rawItemId) {
    const itId = Math.floor(Number(rawItemId) || 0);
    if (itId) {
      const it = db.getInventoryItem(itId);
      if (!it || Number(it.user_id) !== Number(u.id)) {
        return { ok: false, error: 'Предмет не найден в вашем инвентаре' };
      }
      if (it.sold_at) {
        return { ok: false, error: 'Предмет уже продан или использован' };
      }
      if (it.collectible) {
        return { ok: false, error: 'Коллекционный предмет нельзя использовать в игре — он остаётся на память' };
      }
      invItem = it;
    }
  }

  const bet = invItem ? invItem.price : Math.floor(Number(rawBet) || 0);

  // Кейсы живут по другой модели (предмет = выигрыш) — уводим их в отдельную ветку
  const __case = items.findCaseByName(rawGame);
  if (__case) return playCaseRound(u, __case, rawBet, rawRoundId);

  if (!Number.isFinite(bet) || bet < cfg.minBet || bet > cfg.maxBet) {
    return { ok: false, error: `Ставка должна быть от ${rub(cfg.minBet)} до ${rub(cfg.maxBet)}` };
  }
  if (!invItem && bet > Math.floor(u.tokens || 0)) return { ok: false, error: 'Недостаточно средств' };

  // Множитель — выбор игрока, но строго в границах игры
  let mult = Number(rawMult);
  if (!Number.isFinite(mult) || mult <= 0) mult = cfg.defaultMult;
  mult = Math.min(cfg.maxMult, Math.max(cfg.minMult, mult));
  mult = Math.round(mult * 100) / 100;

  // Идемпотентность: PRIMARY KEY round_id. Claim ставится ДО списания,
  // поэтому два параллельных запроса с одним roundId не спишут ставку дважды.
  const scoped = scopedRoundId(u.id, rawRoundId);
  if (!scoped.ok) return { ok: false, error: scoped.error };
  const roundId = scoped.roundId ||
    ('R' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex'));
  let claimed = false;
  try {
    claimed = db.claimRound({ roundId, userId: u.id, game: cfg.label, bet });
  } catch (e) {
    console.error('[Round] claim failed:', e.message);
    return { ok: false, error: 'Не удалось начать раунд, повторите позже' };
  }
  if (!claimed) return { ok: false, error: 'Раунд уже проведён' };

  if (invItem) {
    // Атомарно помечаем предмет сгоревшим/использованным (0 токенов возврата)
    if (!db.markInventorySold(invItem.id, u.id, 0)) {
      db.releaseRoundClaim(roundId, u.id);
      return { ok: false, error: 'Не удалось использовать предмет' };
    }
  }

  // ── Жребий: серверный CSPRNG + комиссия
  let winChance;
  const isUpgradeOnlySkin = invItem && Boolean(invItem.upgrade_only);
  if (isUpgradeOnlySkin) {
    // Особый акционный скин за 5 друзей: в 97% случаев апгрейд НЕ летит (Near-Miss байт!)
    winChance = 0.03;
  } else {
    // возврат игроку = (1 − edge) ровно при любом множителе: winChance = (1 − edge) / mult.
    // Нижней отсечки быть НЕ должно: она поднимала шанс при больших mult (напр. safe ×1000)
    // и делала игру печатным станком (EV > 0). Верхний предел 0.75 уменьшает выплату
    // только в пользу кассы, поэтому он безопасен.
    winChance = Math.min(0.75, (1 - cfg.edge) / mult);
  }

  const lucky = boost.triggers(playerLuck(u.id), rnd01());
  const roll = rnd01();
  let win = (roll < winChance || lucky) ? Math.floor(bet * mult) : 0;

  // Бизнес-правило: игрок без единого депозита не поднимается выше потолка
  const userDep = u.totalDepositedRub || u.lastDeposit || 0;
  if (userDep <= 0 && !isAdmin(u)) {
    const after = Math.floor(u.tokens || 0) + (invItem ? win : (win - bet));
    if (after > NON_DEPOSITOR_CAP) {
      win = 0;   // ставка всё равно списывается — играть без депозита можно, выводить нельзя
      betsMonitor.flagSuspicious({
        userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
        reason: 'Потолок бездепозитного баланса (сервер)',
        details: `раунд ${cfg.label}: ставка ${rub(bet)}, попытка поднять до ${rub(after)}`
      });
    }
  }

  // ── Деньги: если играли токенами — списываем ставку и начисляем выигрыш;
  // Если предметом — предмет уже списан из инвентаря, начисляем выигрыш при победе
  if (invItem) {
    if (win > 0) {
      const r = applyBalance(u, win, 'game_round',
        `${cfg.label} · Апгрейд предмета ${invItem.name} (выигрыш +${rub(win)})`, roundId);
      if (!r.ok) {
        try { db.db.prepare('UPDATE user_inventory SET sold_at = NULL, sold_for = NULL WHERE id = ?').run(invItem.id); } catch (_) {}
        db.releaseRoundClaim(roundId, u.id);
        return { ok: false, error: 'Не удалось начислить выигрыш' };
      }
    }
  } else {
    const r = applyBalance(u, win - bet, 'game_round',
      `${cfg.label} · раунд ${roundId} (ставка ${bet}, ×${mult}, выигрыш ${win})`, roundId);
    if (!r.ok) {
      db.releaseRoundClaim(roundId, u.id);
      return { ok: false, error: 'Не удалось провести раунд, повторите позже' };
    }
  }

  try {
    db.settleRound({
      roundId, userId: u.id, game: cfg.label, bet, mult, win, status: 'settled',
      itemCode: invItem ? invItem.item_code : null,
      itemPrice: invItem ? invItem.price : null
    });
  } catch (e) { console.error('[Round] не сохранён:', e.message); }

  betsMonitor.recordBet({
    userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
    game: cfg.label, betTokens: bet, winTokens: win,
    balanceAfter: u.tokens, totalDepositedRub: userDep
  });

  // Рейкбек: 0.5% от суммы ставки в любой игре
  u.rakeback = Math.round(((u.rakeback || 0) + (bet * 0.005)) * 100) / 100;
  try { db.saveUser(u); } catch (_) {}

  return {
    ok: true, roundId, game: cfg.label, gameKey: cfg.key,
    verdict: win > 0 ? 'win' : 'lose', win, mult, tokens: u.tokens,
    nearMiss: Boolean(isUpgradeOnlySkin && win === 0)
  };
}

function stakeAdd(u, v) {
  v = Math.floor(Number(v) || 0);
  if (v <= 0) return { error: 'Сумма должна быть больше нуля' };
  if (v > u.tokens) return { error: 'Недостаточно средств на балансе' };
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
async function creditDeposit(userId, tokens, source, opts = {}) {
  const u = user(userId);
  const rubAmt = Math.round(Number(opts.rub || (tokens / TOKENS_PER_RUB)));
  const isFirstDeposit = (!u.totalDepositedRub || u.totalDepositedRub <= 0) &&
                         (!u.lastDeposit || u.lastDeposit <= 0) &&
                         !u.firstDepositBonusClaimed;

  let baseTokens = Math.floor(opts.baseTokens || (rubAmt * TOKENS_PER_RUB));
  let bonusTokens = 0;
  let bonusApplied = false;
  let bonusClaimedNow = false;

  // Право на +25% захватывается АТОМАРНО в БД. Раньше проверка была
  // «прочитали флаг в памяти → начислили → записали флаг», поэтому два
  // параллельных первых депозита могли получить бонус дважды.
  const explicitBonus = opts.bonus === '25' || opts.bonusTag === '25';
  const impliedBonus = !explicitBonus && Number(tokens) > baseTokens &&
    (Number(tokens) - baseTokens) === Math.floor(baseTokens * 0.25);
  if (isFirstDeposit && (explicitBonus || impliedBonus)) {
    if (db.claimFirstDepositBonus(u.id)) {
      bonusTokens = Math.floor(baseTokens * 0.25);
      bonusApplied = true;
      bonusClaimedNow = true;
      u.firstDepositBonusClaimed = 1;
    }
  }

  // Повторные депозиты: +15% на второй и +10% на третий, с потолком.
  // Первый депозит обрабатывается выше своим атомарным флагом.
  const prevDeposits = Number(u.depositCount) || 0;
  // Бонус на повторный депозит — только если игрок пришёл с бонусным оффером
  // (opts.bonus), а не «тихо» сверху к любому пополнению. Иначе выплаты
  // разъезжаются с заявкой и с тестами.
  const wantsBonus = explicitBonus || impliedBonus || Boolean(opts.bonus && String(opts.bonus) !== '0');
  let repeatPct = 0;
  if (!bonusApplied && wantsBonus && prevDeposits === 1) repeatPct = 15;
  else if (!bonusApplied && wantsBonus && prevDeposits === 2) repeatPct = 10;
  if (repeatPct > 0) {
    const capTokens = repeatPct === 15 ? 3000 : 2000; // 300 ₽ / 200 ₽
    bonusTokens = Math.min(capTokens, Math.floor(baseTokens * repeatPct / 100));
    bonusApplied = bonusTokens > 0;
  }
  const totalTokens = baseTokens + bonusTokens;
  const reason = bonusApplied
    ? `Пополнение через ${source} (+${isFirstDeposit ? 25 : repeatPct}% бонус: +${rub(bonusTokens)})`
    : `Пополнение через ${source}`;

  const credit = applyBalance(u, totalTokens, 'deposit', reason, String(opts.orderId || ''));
  if (!credit.ok) {
    // Зачисление не прошло — возвращаем право на бонус, чтобы игрок
    // не потерял его из-за сбоя БД.
    if (bonusClaimedNow) {
      try { db.releaseFirstDepositBonusClaim(u.id); } catch (_) {}
      u.firstDepositBonusClaimed = 0;
      bonusTokens = 0;
      bonusApplied = false;
    }
    console.error(`[Deposit] НЕ зачислено ${rub(totalTokens)} игроку ${userId}: ${credit.error}`);
    return { tokens: baseTokens, baseTokens, bonusTokens: 0, refPaid: 0, refErr: credit.error, credited: false, bonusApplied: false };
  }

  try { db.bumpDepositCount(u.id); u.depositCount = prevDeposits + 1; } catch (_) {}

  if (isFirstDeposit && rubAmt >= 150) {
    u.freeCases = (u.freeCases || 0) + 1;
    (u.notifications = u.notifications || []).push('🎁 Вам начислен бесплатный кейс за первый депозит!');
    try {
      bot.api.sendMessage(u.id, '🎁 Вам начислен <b>Бесплатный кейс за первый депозит</b>! Откройте его во вкладке «Кейсы».', { parse_mode: 'HTML' }).catch(() => {});
    } catch (_) {}
  } else if (rubAmt >= 300) {
    u.freeCases = (u.freeCases || 0) + 1;
    (u.notifications = u.notifications || []).push('🎁 Вам начислен подарочный Золотой кейс за пополнение от 300 ₽!');
    try {
      bot.api.sendMessage(u.id, '🎁 Вам начислен подарочный <b>Золотой кейс</b> за пополнение от 300 ₽! Откройте его во вкладке «Кейсы».', { parse_mode: 'HTML' }).catch(() => {});
    } catch (_) {}
  }

  u.lastDeposit = rubAmt;
  u.totalDepositedRub = (u.totalDepositedRub || 0) + rubAmt;
  u.lastDepositId = (u.lastDepositId || 0) + 1;
  try { db.saveUser(u); } catch (e) { console.error('saveUser (deposit):', e.message); }
  try { betsMonitor.recordCashflow('deposit', rubAmt, u.id, u.username ? '@' + u.username : u.name); } catch (_) {}

  let refPaid = 0, refErr = null;
  const refId = Number(u.ref);
  if (refId) {
    const referrer = user(refId);
    if (Number(u.ref) !== u.id) {
      refPaid = Math.floor(baseTokens * REF_PERCENT / 100);
      if (refPaid > 0) {
        const rp = applyBalance(referrer, refPaid, 'referral', `15% от депозита игрока ID ${u.id}`, String(u.id));
        if (rp.ok) {
          referrer.refEarned = (referrer.refEarned || 0) + refPaid;
          referrer.refInvited = countInvited(referrer.id);
          try { db.saveUser(referrer); } catch (e) { console.error('saveUser (referral):', e.message); }
          try {
            await bot.api.sendMessage(referrer.id,
              `🎁 Ваш реферал пополнил баланс на ${rub(baseTokens)} · вам +${rub(refPaid)} (${REF_PERCENT}%)`);
          } catch (e) { refErr = e.message; }
        } else {
          refPaid = 0; refErr = rp.error;
        }
      }
    }
  }
  return { tokens: totalTokens, baseTokens, bonusTokens, refPaid, refErr, credited: true, bonusApplied };
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
    'Пополнение MoneyForUp',
    `${rub(tokens)} — баланс для игры. Вывод в деньги не предусмотрен.`,
    JSON.stringify({ kind: 'tokens', userId, tokens }),
    '', 'XTR',
    [{ label: `${rub(tokens)}`, amount: stars }]
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
      `Оплата получена (${source}): +${rub(tokens)}` +
      (refPaid ? ` · пригласившему +${rub(refPaid)} (${REF_PERCENT} %)` : ''));
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

async function plategaCreate(u, rubAmt, tokens, name, opts = {}) {
  if (!plategaOn()) throw new Error('Platega не настроена: добавьте PLATEGA_MERCHANT_ID и PLATEGA_SECRET');
  const orderId = 'PL' + crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${PLATEGA_API}/transaction/process`, {
    method: 'POST',
    headers: plategaHeaders(),
    body: JSON.stringify({
      paymentDetails: { amount: rubAmt, currency: 'RUB' },
      description: `MoneyForUp · ${rub(tokens)} (заказ ${orderId})`,
      return: APP_URL,
      failedUrl: APP_URL,
      payload: orderId,
      metadata: { userId: String(u.id), userName: name || '' }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error('Platega: ' + JSON.stringify(data.message || data.error || data));
  const newOrder = {
    id: orderId,
    type: 'deposit',
    userId: u.id,
    tokens,
    rub: rubAmt,
    baseTokens: opts.baseTokens || (rubAmt * TOKENS_PER_RUB),
    bonusTokens: opts.bonusTokens || 0,
    bonus: opts.bonus || '',
    status: 'pending',
    source: 'Platega',
    tx: data.transactionId,
    createdAt: Date.now()
  };
  setOrder(orderId, newOrder);
  plategaTx.set(String(data.transactionId), { orderId, ...newOrder });
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
  const r = await creditDeposit(order.userId, order.tokens, 'Platega', {
    rub: order.rub,
    bonus: order.bonus,
    baseTokens: order.baseTokens,
    bonusTokens: order.bonusTokens,
    orderId: order.id
  });
  if (!r.credited) {
    // Зачисление не прошло — снимаем claim и НЕ помечаем заказ оплаченным, чтобы вебхук повторился
    order._crediting = false;
    return { paid: true, credited: false, retry: true, error: r.refErr, tokens: order.tokens };
  }
  order._crediting = false;
  order.status = 'paid';
  order.tokens = r.tokens;   // ledger-ok: поле заказа (кол-во токенов), не баланс игрока
  if (local) {
    local.status = 'paid';
    local.tokens = r.tokens;   // ledger-ok: поле заказа (кол-во токенов), не баланс игрока
  }
  try { db.updateOrderStatus(order.id, 'paid'); } catch (_) {}
  await notifyPaid(order.userId, r.tokens, r.refPaid, 'Platega');
  return { paid: true, credited: true, tokens: r.tokens, refPaid: r.refPaid, bonusApplied: r.bonusApplied };
}

/* ------------------------------------------------------------------ */
/* Coinso (CryptoProc: только Криптовалюта USDT, TON, BTC, ETH и др.)  */
/* Документация: coinso.io/docs                                       */
/* ------------------------------------------------------------------ */
const coinsoOn = () => !!(COINSO_PROJECT_ID && COINSO_SECRET_KEY);

async function createCoinsoInvoice(userId, tokens, rubAmt, opts = {}) {
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
      amount: rubAmt,
      method: 'crypto',
      description: `Пополнение ${rub(tokens)} MoneyForUp (Криптовалюта)`,
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
  const newOrder = {
    id: orderId,
    type: 'deposit',
    userId,
    tokens,
    rub: rubAmt,
    baseTokens: opts.baseTokens || (rubAmt * TOKENS_PER_RUB),
    bonusTokens: opts.bonusTokens || 0,
    bonus: opts.bonus || '',
    invoice_id: invId,
    source: 'Coinso',
    status: 'pending',
    credited: false,
    createdAt: Date.now()
  };
  setOrder(orderId, newOrder);
  coinsoOrders.set(orderId, newOrder);
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
  const r = await creditDeposit(saved.userId, saved.tokens, 'Coinso', {
    rub: saved.rub,
    bonus: saved.bonus,
    baseTokens: saved.baseTokens,
    bonusTokens: saved.bonusTokens,
    orderId: saved.orderId || key
  });
  if (!r.credited) { saved.credited = false; return { paid: true, credited: false, retry: true, error: r.refErr, tokens: saved.tokens }; }
  saved.tokens = r.tokens;   // ledger-ok: поле заказа (кол-во токенов), не баланс игрока
  try { db.updateOrderStatus(saved.orderId || key, 'paid'); } catch (_) {}
  await notifyPaid(saved.userId, r.tokens, r.refPaid, 'Coinso');
  const k = key || [...coinsoOrders.entries()].find(([, v]) => v === saved)?.[0];
  if (k) coinsoOrders.delete(k);
  return { paid: true, credited: true, tokens: r.tokens, refPaid: r.refPaid, bonusApplied: r.bonusApplied };
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
    `💎 <b>Ваш баланс:</b> <code>${rub(u.tokens)}</code>\n\n` +
    `Нажимайте кнопку ниже и начинайте игру! 👇`;

  const logoPath = path.join(__dirname, 'assets', 'logo_mup.jpg');
  if (fs.existsSync(logoPath)) {
    try {
      const { InputFile } = require('grammy');
      await ctx.replyWithPhoto(new InputFile(logoPath), {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: kb
      });
      return;
    } catch (err) {
      console.warn('[bot.start] Не удалось отправить фото, фолбэк на текст:', err.message);
    }
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.command('balance', async ctx => {
  const u = user(ctx.from.id);
  const acc = stakeAccrued(u);
  await ctx.reply(
    `Баланс: ${rub(u.tokens)}\n` +
    `В стейкинге: ${rub(u.staked)} · накоплено процентов: ${rub(acc)}\n` +
    `Приносит в сутки: ${rub(u.staked * STAKE_RATE)}`
  );
});

bot.command('stake', async ctx => {
  const arg = (ctx.match || '').trim();
  const u = user(ctx.from.id);
  if (!arg) {
    const acc = stakeAccrued(u);
    return ctx.reply(`Стейкинг 1 % в сутки.\nВ стейкинге: ${rub(u.staked)}\nНакоплено: ${rub(acc)}\nВ сутки: ${rub(u.staked * STAKE_RATE)}\n\n` +
      `Вложить: /stake 500 · Забрать проценты: /claim · Снять всё: /unstake`);
  }
  const stakeAmount = Math.round(Number(arg) || 0) * TOKENS_PER_RUB;
  const r = stakeAdd(u, stakeAmount);
  await ctx.reply(r.error ? '⚠️ ' + r.error : `В стейкинг добавлено ${rub(stakeAmount)}. Всего ${rub(r.staked)}, в сутки +${rub(r.staked * STAKE_RATE)}`);
});

bot.command('claim', async ctx => {
  const u = user(ctx.from.id);
  const r = stakeClaim(u);
  await ctx.reply(r.error ? '⚠️ ' + r.error : `Забрано ${rub(r.claimed)}. Баланс: ${rub(r.tokens)}`);
});

bot.command('unstake', async ctx => {
  const u = user(ctx.from.id);
  const r = stakeRemove(u, true);
  await ctx.reply(r.error ? '⚠️ ' + r.error : `Снято ${rub(r.removed)}. Баланс: ${rub(r.tokens)}`);
});

bot.command('ref', async ctx => {
  const u = user(ctx.from.id);
  await ctx.reply(
    `Ваш код: ${u.code}\nВаша ссылка: ${refLink(u.code)}\n\n` +
    `Приглашено: ${countInvited(u.id)}\nЗаработано: ${rub(u.refEarned || 0)}\n` +
    `Условие: ${REF_PERCENT} % от каждого пополнения приглашённого — средствами на баланс.`
  );
});

bot.command('buy', async ctx => {
  const arg = Number((ctx.match || '').trim());
  const tokens = arg > 0 ? Math.round(arg) * TOKENS_PER_RUB : 3000;
  try {
    const link = await starsInvoiceLink(ctx.from.id, tokens);
    await ctx.reply(`Счёт на ${rub(tokens)}`,
      { reply_markup: new InlineKeyboard().url('⭐ Оплатить звёздами', link) });
  } catch (e) { await ctx.reply('Не удалось создать счёт: ' + (e.message || e)); }
});

bot.command('promo', async ctx => {
  const arg = (ctx.match || '').trim();
  if (!arg) {
    return ctx.reply(
      '🎟 <b>Активация промокода</b>\n\n' +
      'Используйте: <code>/promo КОД</code>\n' +
      'Пример: <code>/promo WEEK42</code>\n\n' +
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
    `├ Зачислено: <b>+${rub(res.tokens)}</b>\n` +
    `├ Ваш текущий баланс: <b>${rub(res.newBalance)}</b>\n` +
    `└ Осталось активаций этого промокода: <b>${res.remainingUses} из ${res.maxUses}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('addpromo', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора проекта.');
  const parts = (ctx.match || '').trim().split(/\s+/);
  const [rawCode, rubStr, maxUsesStr] = parts;
  if (!rawCode || !rubStr) {
    return ctx.reply(
      'ℹ️ <b>Как создать промокод:</b>\n\n' +
      '<code>/addpromo КОД СУММА_₽ [МАКС_АКТИВАЦИЙ]</code>\n\n' +
      '<b>Пример:</b>\n' +
      '<code>/addpromo WEEK42 10 200</code> — 10 ₽ на 200 активаций\n\n' +
      '<i>Код: латиница/цифры/_- от 3 до 24 символов. Один игрок может активировать код один раз. ' +
      'Повторная команда с тем же кодом обновит сумму и лимит.</i>',
      { parse_mode: 'HTML' }
    );
  }
  const code = String(rawCode).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
    return ctx.reply('⚠️ Код должен быть 3–24 символа: латиница, цифры, «_» или «-».');
  }
  const rubAmt = Number(String(rubStr).replace(',', '.'));
  if (!Number.isFinite(rubAmt) || rubAmt < 1 || rubAmt > 10000) {
    return ctx.reply('⚠️ Сумма — от 1 ₽ до 10 000 ₽.');
  }
  const maxUses = maxUsesStr ? Math.floor(Number(maxUsesStr)) : 100;
  if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 100000) {
    return ctx.reply('⚠️ Лимит активаций — от 1 до 100 000.');
  }
  try {
    const tokens = Math.round(rubAmt * TOKENS_PER_RUB);
    db.upsertPromo(code, tokens, maxUses);
    const row = db.listPromos(300).find(x => x.code === code);
    await ctx.reply(
      `✅ <b>Промокод ${row && row.used ? 'обновлён' : 'создан'}!</b>\n\n` +
      `├ Код: <code>${escHtml(code)}</code>\n` +
      `├ Награда: <b>${rub(tokens)}</b>\n` +
      `├ Лимит активаций: <b>${maxUses}</b> человек\n` +
      `└ Уже активировали: <b>${row ? row.used : 0}</b>\n\n` +
      `<i>Игрок вводит код в приложении (Пополнение → Промокод) или командой <code>/promo ${escHtml(code)}</code>.</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    await ctx.reply('⚠️ Ошибка: ' + (e.message || e));
  }
});

bot.command(['promos', 'promocodes'], async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора проекта.');
  const list = db.listPromos(100);
  if (!list.length) return ctx.reply('Промокодов пока нет. Создайте: /addpromo КОД СУММА_₽ [ЛИМИТ]');
  let text = '🎟 <b>Промокоды:</b>\n\n';
  for (const p of list) {
    const left = Math.max(0, p.maxUses - p.used);
    text += `• <code>${escHtml(p.code)}</code>: <b>+${rub(p.tokens)}</b> | ${p.used}/${p.maxUses}` +
      (left > 0 ? ` (осталось ${left})` : ' — <b>исчерпан</b>') + '\n';
  }
  text += '\n<i>Удалить: /delpromo КОД</i>';
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('delpromo', async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора проекта.');
  const code = (ctx.match || '').trim().toUpperCase();
  if (!code) return ctx.reply('Используйте: /delpromo КОД');
  const res = db.deletePromo(code);
  if (!res.ok) return ctx.reply(`Промокод «${code}» не найден.`);
  await ctx.reply(`🗑 Промокод «${code}» удалён. Уже активированные начисления остаются на балансах.`);
});

bot.command('pay', async ctx => {
  if (!plategaOn()) return ctx.reply('Platega не настроена: добавьте PLATEGA_MERCHANT_ID и PLATEGA_SECRET в .env');
  const rubAmt = Math.max(1, Math.floor(Number((ctx.match || '').trim()) || 300));
  const tokens = rubAmt * TOKENS_PER_RUB;
  try {
    const r = await plategaCreate(user(ctx.from.id, ctx.from.first_name), rubAmt, tokens, ctx.from.first_name);
    await ctx.reply(`Счёт на ${rubAmt} ₽ · Platega: карта или СБП`,
      { reply_markup: new InlineKeyboard().url('💳 Оплатить', r.pay_url) });
  } catch (e) { await ctx.reply('Не удалось создать счёт Platega: ' + (e.message || e)); }
});

bot.command('coinso', async ctx => {
  if (!coinsoOn()) return ctx.reply('Coinso не настроен.');
  const rubAmt = Math.max(1, Math.floor(Number((ctx.match || '').trim()) || 300));
  const tokens = rubAmt * TOKENS_PER_RUB;
  try {
    const r = await createCoinsoInvoice(ctx.from.id, tokens, rubAmt);
    await ctx.reply(`Счёт на ${rubAmt} ₽ · Coinso (Криптовалюта USDT, TON, BTC)`,
      { reply_markup: new InlineKeyboard().url('🪙 Оплатить криптой', r.pay_url) });
  } catch (e) { await ctx.reply('Не удалось создать счёт Coinso: ' + (e.message || e)); }
});

bot.command('sbp', async ctx => {
  if (!ADMIN_ID) return ctx.reply('Оплата по СБП не настроена (нет ADMIN_ID).');
  const rubAmt = Math.max(1, Math.floor(Number((ctx.match || '').trim()) || 300));
  const id = 'SBP_' + crypto.randomBytes(16).toString('hex');
  const tokens = rubAmt * TOKENS_PER_RUB;
  const newOrder = { id, userId: ctx.from.id, tokens, rub: rubAmt, status: 'pending', source: 'СБП / Карта', createdAt: Date.now(), expiresAt: Date.now() + DEPOSIT_TTL_MS };
  setOrder(id, newOrder);
  const payUntil = new Date(newOrder.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

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
    `💳 <b>Заявка №${escHtml(id)} на ${rubAmt} ₽</b>\n\n` +
    `<b>Реквизиты для оплаты:</b>\n` +
    reqText + `\n` +
    `⏳ Заявка действует <b>${DEPOSIT_TTL_TEXT}</b> — до <b>${payUntil}</b>. После перевода админ проверит платёж, и средства зачислятся на баланс.`,
    { parse_mode: 'HTML' }
  );
  const senderLabel = ctx.from.username ? '@' + ctx.from.username : (ctx.from.first_name || 'ID ' + ctx.from.id);
  const sent = await bot.api.sendMessage(ADMIN_ID,
    `💳 <b>Заявка №${escHtml(id)} по СБП:</b> ${rubAmt} ₽ → <b>+${rub(tokens)}</b>\n` +
    `От: <b>${escHtml(senderLabel)}</b> (id: <code>${ctx.from.id}</code>)\n` +
    `⏳ Срок оплаты: <b>${DEPOSIT_TTL_TEXT}</b> (до ${payUntil})`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Подтвердить', 'ok:' + id)
        .text('❌ Отклонить', 'no:' + id)
    }
  ).catch(e => console.error('Не удалось отправить админу заявку СБП:', e.message));
  if (sent && sent.message_id) {
    newOrder.adminMsgId = sent.message_id;
    newOrder.adminChatId = Number(ADMIN_ID) || 0;
    try { db.setOrderMessage(id, sent.message_id, Number(ADMIN_ID) || 0); } catch (_) {}
  }
});

async function processOrderAction(orderId, action) {
  const order = getOrder(String(orderId));
  if (!order) return { ok: false, error: 'Заявка не найдена' };
  if (order.status === 'pending' && await expireDepositOrder(order)) {
    return { ok: false, error: `⌛ Заявка истекла: окно оплаты — ${DEPOSIT_TTL_TEXT}. Создайте новую.` };
  }
  if (order.status === 'expired') {
    return { ok: false, error: `⌛ Заявка истекла: окно оплаты — ${DEPOSIT_TTL_TEXT}. Создайте новую.` };
  }
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
        `├ Сумма выплаты: <b>${order.rub} ₽</b>\n` +
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
      const r = await creditDeposit(order.userId, order.tokens, order.source || 'СБП', {
        rub: order.rub,
        bonus: order.bonus,
        baseTokens: order.baseTokens,
        bonusTokens: order.bonusTokens,
        orderId: order.id
      });
      if (!r.credited) {
        order.status = 'pending';
        return { ok: false, error: 'Не удалось зачислить баланс — заявка оставлена в ожидании: ' + (r.refErr || '') };
      }
      order.tokens = r.tokens;   // ledger-ok: поле заказа (кол-во токенов), не баланс игрока
      order.completedAt = Date.now();
      try { db.updateOrderStatus(orderId, 'paid'); } catch (_) {}
      const bonusText = r.bonusApplied ? ` (включая бонус: +${rub(r.bonusTokens)})` : '';
      u.notifications = u.notifications || [];
      u.notifications.push({
        id: 'notif_' + Date.now(),
        text: `🎉 Пополнение подтверждено! Зачислено +${rub(r.tokens)}${bonusText}.`,
        t: Date.now()
      });
      await bot.api.sendMessage(order.userId,
        `🎉 Оплата получена: <b>+${rub(r.tokens)}</b>${bonusText}${r.refPaid ? `, рефереру +${rub(r.refPaid)}` : ''}!\nБаланс успешно пополнен.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return { ok: true, status: 'paid', order, refPaid: r.refPaid, creditedTokens: r.tokens, bonusApplied: r.bonusApplied };
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
    (ctx.callbackQuery.message.text || '') + '\n\n✅ <b>Оплата подтверждена! Зачислено +' + rub(res.order.tokens) + '</b>',
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

bot.command(['setdesc', 'updatedesc'], async ctx => {
  if (!isAdmin(ctx.from)) return ctx.reply('⛔ Доступ строго только для администратора.');
  await ctx.reply('⏳ Обновляю описание бота в Telegram API...');
  const ok = await initBotProfile();
  if (ok) {
    await ctx.reply('✅ Описание бота в Telegram успешно обновлено чистым текстом!\nВсе фигурные скобки {"description":...} и \\n удалены.');
  } else {
    await ctx.reply('❌ Ошибка при обновлении описания бота.');
  }
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
  await sweepExpiredDeposits();
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
        `├ Сумма: <b>${o.rub} ₽</b>\n` +
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
      const exp = orderExpiresAt(o);
      const leftMin = exp ? Math.max(1, Math.ceil((exp - Date.now()) / 60000)) : 0;
      await ctx.reply(
        `💳 <b>Ожидает пополнения #${escHtml(id)}</b>\n` +
        `├ Игрок: <b>${escHtml(pName)}</b> (<code>${o.userId}</code>)\n` +
        `├ Сумма: <b>${o.rub} ₽</b>\n` +
        (exp ? `├ Осталось: <b>${leftMin} мин</b>\n` : '') +
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
/* ---------- VIP и Ранги кэшбэка в Telegram-боте ---------- */
const VIP_RANKS_BOT = [
  { id: 1, name: 'Бронза', icon: '🥉', depReq: 0, cbPct: 2.0 },
  { id: 2, name: 'Серебро', icon: '🥈', depReq: 500, cbPct: 3.5, bonus: 250 },
  { id: 3, name: 'Золото', icon: '🥇', depReq: 2000, cbPct: 5.0, bonus: 1000 },
  { id: 4, name: 'Платина', icon: '💎', depReq: 5000, cbPct: 7.5, bonus: 3000 },
  { id: 5, name: 'Бриллиант', icon: '👑', depReq: 15000, cbPct: 10.0, bonus: 10000 }
];
function botVipInfo(depRub) {
  depRub = Math.max(0, depRub || 0);
  let cur = VIP_RANKS_BOT[0], next = null;
  for (let i = 0; i < VIP_RANKS_BOT.length; i++) {
    if (depRub >= VIP_RANKS_BOT[i].depReq) {
      cur = VIP_RANKS_BOT[i];
      next = VIP_RANKS_BOT[i + 1] || null;
    }
  }
  const leftRub = next ? Math.max(0, next.depReq - depRub) : 0;
  const leftTokens = leftRub * TOKENS_PER_RUB;
  const pct = next ? Math.min(100, Math.floor(((depRub - cur.depReq) / (next.depReq - cur.depReq)) * 100)) : 100;
  const barFilled = Math.min(10, Math.floor(pct / 10));
  const bar = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled);
  return { cur, next, leftRub, leftTokens, pct, bar };
}

/* ---------- Команда /boost: Супер-хаб ускорения и стимул к повторному депозиту ---------- */
bot.command('boost', async ctx => {
  const u = user(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const depRub = u.totalDepositedRub || u.lastDeposit || 0;
  const vip = botVipInfo(depRub);

  const kb = new InlineKeyboard()
    .webApp('🔥 Забрать +25% к депу (500 ₽)', `${APP_URL}#tokens?amt=500&bonus=25`)
    .webApp('🎁 Золотой кейс в подарок (300 ₽)', `${APP_URL}#tokens?amt=300&bonus=goldcase`)
    .row()
    .webApp('⚡️ Быстрый старт (150 ₽)', `${APP_URL}#tokens?amt=150`)
    .webApp('💳 Все способы (СБП/Карты/Крипта)', `${APP_URL}#tokens`)
    .row()
    .text('🔥 Hot Drop (Забрать)', 'boost_hotdrop')
    .text('🎯 Челленджи 24ч', 'boost_challenge')
    .row()
    .text('🤫 Тайный аукцион', 'boost_auction')
    .text('👑 VIP & Рейкбек', 'boost_vip')
    .row()
    .webApp('🚀 Открыть Boost-Центр в игре', `${APP_URL}#boost`);

  const text =
    `🚀 <b>MUP TURBO-BOOST HUB · РАЗГОНИ СВОЙ БАНКРОЛЛ!</b> ⚡️\n\n` +
    `Привет, <b>${escHtml(ctx.from.first_name || 'Игрок')}</b>! Твои персональные бонусы готовы к активации:\n\n` +
    `👤 <b>Твой статус:</b>\n` +
    `├ Баланс: <b>${rub(u.tokens)}</b>\n` +
    `├ VIP-ранг: <b>${vip.cur.icon} ${vip.cur.name}</b> (кэшбэк <b>${vip.cur.cbPct}%</b>)\n` +
    `├ Накопленный рейкбек: <b>${rub(u.rakeback || 0)}</b>\n` +
    (vip.next
      ? `└ Прогресс: <code>[${vip.bar}]</code> ${vip.pct}%\n  <i>(всего ${vip.leftRub} ₽ до ${vip.next.name} +${rub(vip.next.bonus)}!)</i>\n\n`
      : `└ Прогресс: <b>МАКСИМАЛЬНЫЙ РАНГ 👑</b>\n\n`) +
    `🔥 <b>ГОРЯЧИЕ ОФФЕРЫ (ОГРАНИЧЕННОЕ ВРЕМЯ!):</b>\n` +
    `💥 <b>ТУРБО-БОНУС +25% НА ДЕПОЗИТ</b>\n` +
    `└ <i>Пополни от 150 ₽ в течение 10 минут и получи +25% к балансу сверху!</i>\n\n` +
    `🎁 <b>СЕКРЕТНЫЙ ЗОЛОТОЙ КЕЙС В ПОДАРОК</b>\n` +
    `└ <i>При пополнении от 300 ₽ — мгновенный бонусный кейс с дропом до ${rub(15000)}!</i>\n\n` +
    `📦 <b>ЕЖЕЧАСНЫЙ HOT DROP</b>\n` +
    `└ <i>Бесплатный контейнер каждый час с гарантированным начислением!</i>\n\n` +
    `🎯 <b>СТРИК-ЧЕЛЛЕНДЖ 24Ч</b>\n` +
    `└ <i>3 ежедневных задания + растущий стрик наград до 7 дней!</i>\n\n` +
    `🤫 <b>ТАЙНЫЙ АУКЦИОН</b>\n` +
    `└ <i>Закрытые торги вслепую за редкие кибер-сейфы!</i>\n\n` +
    `👇 Выберите ускорение ниже или зарядите баланс прямо сейчас:`;

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

/* Обработчики колбэков Boost */
bot.callbackQuery(['boost_hotdrop', 'boost_v10'], async ctx => {
  await ctx.answerCallbackQuery();
  const u = user(ctx.from.id);
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  u.lastHotDrop = u.lastHotDrop || 0;
  const elapsed = now - u.lastHotDrop;
  if (elapsed >= ONE_HOUR) {
    const rewards = [20, 35, 50, 75, 120, 250];
    const win = rewards[rndInt(rewards.length)];
    applyBalance(u, win, 'bonus_hotdrop_tg', 'Hot Drop в боте');
    u.lastHotDrop = now;
    try { db.saveUser(u); } catch (e) { console.error('saveUser (hotdrop tg):', e.message); }
    const kb = new InlineKeyboard()
      .webApp('🔥 Умножить баланс (+25% на деп)', `${APP_URL}#tokens?bonus=25`)
      .row()
      .webApp('🎮 Играть в MoneyForUp', APP_URL);
    await ctx.reply(
      `🔥 <b>HOT DROP УСПЕШНО ОТКРЫТ!</b> 🎉\n\n` +
      `Вы открыли ежечасный дроп и получили: <b>+${rub(win)}</b>!\n` +
      `Ваш баланс: <b>${rub(u.tokens)}</b>\n\n` +
      `⚡️ <i>Совет: Разгони выигрыш прямо сейчас! Пополни баланс от 150 ₽ с бонусом +25% и выбей x20 в Ракетке!</i>\n\n` +
      `⏱ Следующий бесплатный Hot Drop будет доступен через 60 минут.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  } else {
    const leftMins = Math.ceil((ONE_HOUR - elapsed) / 60000);
    const kb = new InlineKeyboard()
      .webApp('⚡️ Забрать +25% к депозиту прямо сейчас', `${APP_URL}#tokens?bonus=25`)
      .row()
      .webApp('🚀 Открыть Hot Drop в приложении', `${APP_URL}#hotdrop`);
    await ctx.reply(
      `⏳ <b>Hot Drop пока на перезарядке!</b>\n\n` +
      `До следующего бесплатного контейнера осталось: <b>${leftMins} мин.</b>\n\n` +
      `🔥 <b>Не хочешь ждать?</b> Заряди баланс в 1 клик с горячим бонусом <b>+25%</b> прямо сейчас и забирай крупные иксы в играх!`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }
});

bot.callbackQuery(['boost_challenge', 'boost_v7'], async ctx => {
  await ctx.answerCallbackQuery();
  const u = user(ctx.from.id);
  const kb = new InlineKeyboard()
    .webApp('🎯 Открыть Челленджи в Mini App', `${APP_URL}#challenge24`)
    .row()
    .webApp('💳 Пополнить баланс для квестов', `${APP_URL}#tokens`);
  const text =
    `🎯 <b>Вариант 7: «Челлендж за 24 часа & Стрик»</b>\n\n` +
    `🔥 <b>Ваш статус:</b> Серия активна · Стрик 1..7 дней\n` +
    `⏱ <b>Таймер обновления заданий:</b> 24:00:00\n\n` +
    `<b>Задания на сегодня:</b>\n` +
    `1. 🚀 «Гонка на Ракете» — сделать 3 кэшаута в Ракетке (+${rub(30)})\n` +
    `2. 🤫 «Тайный Аукционер» — сделать ставку в Аукционе (+${rub(25)})\n` +
    `3. 🔥 «Горячий Трофей» — забрать Hot Drop (+${rub(20)})\n\n` +
    `<i>Выполняйте квесты прямо в игре и забирайте средства на баланс!</i>`;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(['boost_auction', 'boost_v4'], async ctx => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .webApp('🤫 Войти в Тайный аукцион', `${APP_URL}#auction`)
    .row()
    .webApp('💳 Зарядить баланс для торгов', `${APP_URL}#tokens`);
  const text =
    `🤫 <b>Вариант 4: «Тайный аукцион» (Blind Auction)</b>\n\n` +
    `📦 <b>Текущий лот:</b> Секретный Кибер-Сейф MUP #088\n` +
    `💎 <b>Содержимое:</b> от ${rub(500)} до ${rub(1500)}\n` +
    `⏱ <b>Статус торгов:</b> Идёт приём тайных ставок\n\n` +
    `Делайте ставки вслепую, блефуйте и забирайте сейф по лучшей цене с супер-дисконтом!`;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('boost_vip', async ctx => {
  await ctx.answerCallbackQuery();
  const u = user(ctx.from.id);
  const depRub = u.totalDepositedRub || u.lastDeposit || 0;
  const vip = botVipInfo(depRub);
  const kb = new InlineKeyboard()
    .webApp('⚡️ Повысить ранг пополнением', `${APP_URL}#tokens`)
    .row()
    .webApp('🎮 Играть в MoneyForUp', APP_URL);
  const text =
    `👑 <b>VIP-КЭШБЭК & СИСТЕМА РАНГОВ MONEYFORUP</b>\n\n` +
    `👤 <b>Ваш статус:</b>\n` +
    `├ Текущий ранг: <b>${vip.cur.icon} ${vip.cur.name}</b>\n` +
    `├ Пожизненный кэшбэк: <b>${vip.cur.cbPct}%</b> на каждое пополнение!\n` +
    `├ Накопленный рейкбек: <b>${rub(u.rakeback || 0)}</b> (0.5% с каждой ставки)\n` +
    (vip.next
      ? `├ До ранга <b>${vip.next.icon} ${vip.next.name}</b>: всего <b>${vip.leftRub} ₽</b>\n` +
        `└ Прогресс: <code>[${vip.bar}]</code> ${vip.pct}%\n\n`
      : `└ Прогресс: <b>МАКСИМАЛЬНЫЙ РАНГ ДОСТИГНУТ! 💎</b>\n\n`) +
    `🔥 <i>Повышайте ранг — получайте повышенный кэшбэк до 10% и щедрые бонусы на баланс на каждом уровне!</i>`;
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
  await ctx.reply(`Оплачено ${sp.total_amount} ⭐ — зачислено ${rub(tokens)}` +
    (r.refPaid ? `, пригласившему +${rub(r.refPaid)} (${REF_PERCENT} %)` : '') +
    `.\nБаланс: ${rub(u.tokens)}`);
});

/* ------------------------------------------------------------------ */
/* HTTP-API для Mini App                                               */
/* ------------------------------------------------------------------ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    let done = false;
    req.on('data', c => {
      if (done) return;
      b += c;
      if (b.length > 1e6) {
        done = true;
        const err = new Error('Слишком большой запрос');
        err.statusCode = 413;
        req.resume();          // дочитываем и закрываем поток, но отвечаем 413
        reject(err);
      }
    });
    req.on('end', () => { if (!done) { done = true; resolve(b); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}
function readJson(req) { return readBody(req).then(b => { try { return JSON.parse(b || '{}'); } catch { return {}; } }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
    };
    const origin = corsOrigin(req);
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Telegram-Init-Data';
    headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    res.writeHead(code, headers);
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') return send(204, {});

  // Если открыли адрес в обычном браузере — отдаём красивую страницу статуса
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    });
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
    // initData — bearer-секрет. Принимаем только тело или заголовок, но не query:
    // URL попадает в логи прокси/хостинга и историю браузера.
    const tgUser = checkInitData(body.initData || req.headers['x-telegram-init-data']);


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
      // Публичный плейсхолдер из .env.example — не секрет (репозиторий открыт).
      // Поэтому вебхук выключается, если секрет не задан, слишком короткий или равен
      // известному значению-примеру. Ошибка видна в логе, а не «тихо работает как публичный ключ».
      const INSECURE_WEBHOOK_SECRETS = new Set([
        'your_super_secret_key_here', 'MUP_SECRET_KEY_2026', 'changeme', 'secret'
      ]);
      const secretConfigured = !!EXPECTED_SECRET &&
        EXPECTED_SECRET.length >= 16 &&
        !INSECURE_WEBHOOK_SECRETS.has(EXPECTED_SECRET);
      if (!secretConfigured) {
        console.error('[Payment Webhook] PAYMENT_WEBHOOK_SECRET не задан или небезопасен — зачисление по SMS отключено');
        return send(503, { error: 'payment webhook disabled: check PAYMENT_WEBHOOK_SECRET' });
      }
      if (!safeEqualStr(String(secret || ''), EXPECTED_SECRET)) {
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

      // Ищем заявку по сумме среди ожидающих (pending). Если подходящих
      // несколько — не угадываем: зачисление на чужой баланс хуже, чем
      // ручное подтверждение админом.
      const candidates = [];
      for (const [id, ord] of orders.entries()) {
        if (ord.status === 'pending' && Number(ord.rub) === amountRub) candidates.push([id, ord]);
      }
      let foundOrder = null;
      let foundId = null;
      if (candidates.length === 1) {
        [foundId, foundOrder] = candidates[0];
      } else if (candidates.length > 1) {
        const senderDigits = senderPhone.replace(/\D/g, '').slice(-10);
        const bySender = candidates.filter(([, ord]) => {
          const d = String(ord.sender || ord.card || '').replace(/\D/g, '');
          return senderDigits && d && d.endsWith(senderDigits);
        });
        if (bySender.length === 1) {
          [foundId, foundOrder] = bySender[0];
        } else {
          console.warn(`[Payment Webhook] ${candidates.length} заявок на ${amountRub} ₽ — автозачисление остановлено, нужно подтверждение админа`);
          return send(409, { error: 'several pending orders with the same amount; manual review required' });
        }
      }

      if (foundOrder) {
        // Claim ДО await: параллельное СМС-уведомление на ту же сумму не зачислит второй раз
        foundOrder.status = 'paid';
        const r = await creditDeposit(foundOrder.userId, foundOrder.tokens, 'СБП / Карта (Авто)', {
          rub: foundOrder.rub,
          bonus: foundOrder.bonus,
          baseTokens: foundOrder.baseTokens,
          bonusTokens: foundOrder.bonusTokens,
          orderId: foundId
        });
        if (!r.credited) {
          foundOrder.status = 'pending';
          return send(500, { error: 'credit failed, retry', amount: amountRub });
        }
        foundOrder.tokens = r.tokens;   // ledger-ok: поле заказа (кол-во токенов), не баланс игрока
        try { db.updateOrderStatus(foundId, 'paid'); } catch (_) {}
        const bonusText = r.bonusApplied ? ` (включая бонус: +${rub(r.bonusTokens)})` : '';
        await bot.api.sendMessage(foundOrder.userId,
          `🎉 Платёж успешно распознан и подтверждён автоматикой!\nЗачислено: <b>+${rub(r.tokens)}</b>${bonusText}!\nПриятной игры в MoneyForUp!`,
          { parse_mode: 'HTML' }
        ).catch(() => {});

        if (ADMIN_ID) {
          await bot.api.sendMessage(ADMIN_ID,
            `🤖 <b>Авто-зачисление по СМС:</b>\n` +
            `├ Заявка: <b>№${escHtml(foundId)}</b>\n` +
            `├ Сумма: <b>${amountRub} ₽</b>\n` +
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
    const dbStats = db.getUserRoundStats ? db.getUserRoundStats(u.id) : { summary: {}, byGame: [] };
    const userStats = betsMonitor.getPlayerStats(u.id, dbStats);
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
      cashbackClaimed: Boolean(u.cashbackClaimedDepositId && (u.cashbackClaimedDepositId === (Number(u.lastDepositId) || 1)) && (u.lastDeposit > 0 || u.totalDepositedRub > 0)),
      easycashClaimed: !!u.easycashClaimed,
      rakeback: +(Number(u.rakeback || 0).toFixed(2)),
      freeCases: Math.floor(Number(u.freeCases || 0)),
      freeCase5RefClaimed: Number(u.freeCase5RefClaimed || 0),
      freeCase3RefClaimed: Number(u.freeCase3RefClaimed || 0),
      freeDailyAt: Number(u.freeDailyAt || 0),
      freeDailyNextAt: Number(u.freeDailyAt || 0) ? Number(u.freeDailyAt) + 24 * 3600 * 1000 : 0,
      refQualified: db.getQualifiedFriendsCount ? db.getQualifiedFriendsCount(u.id) : 0,
      lastHotDrop: u.lastHotDrop || 0,
      lastWheelSpin: u.lastWheelSpin || 0,
      isAdmin: isAdmin(tgUser),
      stats: userStats,
      notifications: (u.notifications || []).slice(-5)
    };
    if (u.notifications && u.notifications.length > 0) {
      u.notifications = []; // очищаем после доставки клиенту
    }

    /* регистрация/синхронизация: реф-код из start_param, принятие соглашения */
    if (url.pathname === '/api/register' && req.method === 'POST') {
      setRef(u, body.startParam);          // код пригласившего: MF... или старый числовой id
      if (body.termsAcceptedAt) u.termsAt = Number(body.termsAcceptedAt) || Date.now();
      try { db.touchUserSeen(u.id, Date.now()); } catch (_) {}
      return send(200, {
        ...who, numId: u.numId, refCode: u.code, link: refLink(u.code),
        refInvited: countInvited(u.id), refEarned: Math.round(u.refEarned || 0),
        refQualified: db.getQualifiedFriendsCount ? db.getQualifiedFriendsCount(u.id) : 0,
        freeCase5RefClaimed: Number(u.freeCase5RefClaimed || 0),
        referredBy: u.ref || null, termsAt: u.termsAt
      });
    }

    if (url.pathname === '/api/balance') return send(200, { ...who });
    if (url.pathname === '/api/user-stats') return send(200, { ok: true, stats: userStats });

    /* Статус стрика и ежедневных квестов: прогресс считает сервер. */
    if (url.pathname === '/api/challenge/status' && req.method === 'POST') {
      if (!checkRateLimit(`challenge-status:${u.id}`, 60, 60000)) return send(429, { error: 'Слишком много запросов. Подождите минуту.' });
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const dayStart = Date.parse(day + 'T00:00:00.000Z');
      const st = db.getChallengeStatus(u.id, day, dayStart);
      const last = Number(u.lastStreakAt || 0);
      const storedDay = Math.max(1, Math.min(7, Number(u.streakDay || 1)));
      const available = !last || now - last >= 20 * 3600 * 1000;
      const displayDay = available
        ? (last && now - last <= 48 * 3600 * 1000 ? Math.min(7, storedDay + 1) : 1)
        : storedDay;
      const hotDropToday = Number(u.lastHotDrop || 0) >= dayStart;
      return send(200, {
        ok: true,
        streakDay: displayDay,
        streakReward: STREAK_REWARDS[displayDay - 1],
        streakAvailable: available,
        streakNextAt: available ? 0 : last + 20 * 3600 * 1000,
        quests: {
          q1: { progress: Math.min(3, st.racketWins), target: 3, claimed: st.claims.includes('q1') },
          q2: { progress: Math.min(1, st.bets), target: 1, claimed: st.claims.includes('q2') },
          q3: { progress: hotDropToday ? 1 : 0, target: 1, claimed: st.claims.includes('q3') }
        }
      });
    }

    /* Реальные выигрыши за последние 24 часа — для лайв-тикера без фейков. */
    if (url.pathname === '/api/live-wins' && req.method === 'POST') {
      if (!checkRateLimit(`wins:${u.id}`, 60, 60000)) return send(429, { error: 'Слишком много запросов. Подождите минуту.' });
      const wins = db.listRecentWins(30, Date.now() - 86400000);
      return send(200, { ok: true, wins });
    }

    /* ── Сбор рейкбека (от 3 ₽) ──────────────────────────────────────────────── */
    if (url.pathname === '/api/claim-rakeback' && req.method === 'POST') {
      if (!checkRateLimit(`rb:${u.id}`, 10, 60000)) {
        return send(429, { error: 'Слишком много запросов. Подождите минуту.' });
      }
      const curRb = Number(u.rakeback || 0);
      if (curRb < 30) {
        return send(400, { error: `Минимальная сумма сбора рейкбека — ${rub(30)} (у вас ${rub(curRb)})` });
      }
      const claimAmt = Math.floor(curRb);
      const remaining = Math.round((curRb - claimAmt) * 100) / 100;
      const r = applyBalance(u, claimAmt, 'rakeback_claim', `Сбор рейкбека (+${rub(claimAmt)})`);
      if (!r.ok) return send(500, { error: 'Не удалось начислить рейкбек' });
      u.rakeback = remaining;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (rakeback):', e.message); }
      return send(200, { ok: true, claimed: claimAmt, rakeback: u.rakeback, tokens: u.tokens });
    }

    /* ── Бесплатный кейс за первый депозит ───────────────────────────────────── */
    if (url.pathname === '/api/open-free-case' && req.method === 'POST') {
      if (!checkRateLimit(`freecase:${u.id}`, 10, 60000)) {
        return send(429, { error: 'Слишком много запросов. Подождите немного.' });
      }
      // Атомарно списываем бесплатный кейс в БД: два параллельных клика не
      // могут оба увидеть free_cases=1 и получить два предмета.
      if (!db.claimFreeCase(u.id)) {
        return send(400, { error: 'У вас нет доступных бесплатных кейсов' });
      }
      const freshFree = db.getUser(u.id);
      u.freeCases = freshFree ? Number(freshFree.freeCases || 0) : 0;

      const drop = rollCaseDrop(u.id, 'case_500', true);
      if (!drop) {
        db.refundFreeCase(u.id);
        const back = db.getUser(u.id);
        u.freeCases = back ? Number(back.freeCases || 0) : 0;
        return send(500, { error: 'Не удалось открыть кейс, попробуйте позже' });
      }

      const roundId = 'FREE_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      let itemId = null;
      try {
        const saved = db.addInventoryItem({
          userId: u.id,
          itemCode: drop.code,
          name: drop.name,
          icon: drop.icon,
          price: drop.price,
          tier: drop.tier,
          caseId: 'case_500',
          caseName: 'Бесплатный кейс за депозит',
          roundId
        });
        itemId = saved.id;
      } catch (e) {
        console.error(`[Inventory] бесплатный предмет не сохранён игроку ${u.id}: ${e.message}`);
        db.refundFreeCase(u.id);
        const back = db.getUser(u.id);
        u.freeCases = back ? Number(back.freeCases || 0) : 0;
        try { db.saveUser(u); } catch (_) {}
        return send(500, { error: 'Не удалось выдать предмет, бесплатный кейс не списан' });
      }

      try {
        db.saveRound({
          roundId,
          userId: u.id,
          game: 'Бесплатный кейс',
          bet: 0,
          mult: 1,
          win: 0,
          status: 'settled',
          itemCode: drop.code,
          itemPrice: drop.price
        });
      } catch (e) {
        console.error('[Round] бесплатный кейс не сохранён:', e.message);
      }

      try { db.saveUser(u); } catch (_) {}

      return send(200, {
        ok: true,
        roundId,
        freeCases: u.freeCases,
        drop: {
          id: itemId,
          code: drop.code,
          name: drop.name,
          icon: drop.icon,
          price: drop.price,
          tier: drop.tier,
          caseName: 'Бесплатный кейс за депозит'
        }
      });
    }

    /* ── FREE-кейсы: один ежедневный (1–6 ₽) и два за друзей ──────────────── */
    if (url.pathname === '/api/free-case/status') {
      const qualified = db.getQualifiedFriendsCount ? db.getQualifiedFriendsCount(u.id) : 0;
      const now = Date.now();
      const dailyReady = !u.freeDailyAt || now - Number(u.freeDailyAt) >= 24 * 3600 * 1000;
      return send(200, {
        ok: true,
        daily: {
          ready: dailyReady,
          nextAt: dailyReady ? 0 : Number(u.freeDailyAt) + 24 * 3600 * 1000,
          prizeMin: 1, prizeMax: 6
        },
        ref3: {
          level: 3, qualified, needed: 3,
          claimed: Boolean(u.freeCase3RefClaimed),
          canClaim: !u.freeCase3RefClaimed && qualified >= 3,
          item: publicFreeRefItem(FREE_REF_CASES[3])
        },
        ref5: {
          level: 5, qualified, needed: 5,
          claimed: Boolean(u.freeCase5RefClaimed),
          canClaim: !u.freeCase5RefClaimed && qualified >= 5,
          item: publicFreeRefItem(FREE_REF_CASES[5])
        },
        refCode: u.code,
        refLink: refLink(u.code)
      });
    }

    if (url.pathname === '/api/free-case/daily' && req.method === 'POST') {
      if (!checkRateLimit(`free-daily:${u.id}`, 8, 60000)) {
        return send(429, { error: 'Слишком много запросов. Подождите немного.' });
      }
      const now = Date.now();
      const prevDaily = Number(u.freeDailyAt || 0);
      if (!db.claimDailyFreeCase(u.id, now, now - 24 * 3600 * 1000)) {
        const nextAt = prevDaily + 24 * 3600 * 1000;
        const leftH = Math.max(1, Math.ceil((nextAt - now) / 3600000));
        return send(400, { error: `Следующий бесплатный кейс будет доступен через ${leftH} ч.`, nextAt });
      }
      const prizeRub = 1 + rndInt(6);
      const prize = prizeRub * TOKENS_PER_RUB;
      const r = applyBalance(u, prize, 'bonus_daily_case', 'Ежедневный FREE-кейс');
      if (!r.ok) {
        db.releaseDailyFreeCase(u.id, prevDaily);
        u.freeDailyAt = prevDaily;
        return send(500, { error: 'Не удалось начислить приз, попробуйте позже.' });
      }
      u.freeDailyAt = now;
      try { db.saveUser(u); } catch (_) {}
      const roundId = 'DAILY_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      try {
        db.saveRound({
          roundId, userId: u.id, game: 'Ежедневный FREE-кейс',
          bet: 0, mult: prize / TOKENS_PER_RUB, win: prize,
          status: 'settled', itemCode: 'daily_cash_' + prizeRub, itemPrice: prize
        });
      } catch (e) { console.error('[Round] daily free не сохранён:', e.message); }
      return send(200, {
        ok: true, roundId,
        prize, prizeRub,
        tokens: u.tokens,
        nextAt: now + 24 * 3600 * 1000,
        drop: {
          code: 'daily_cash_' + prizeRub, name: `+${prizeRub} ₽ на баланс`,
          icon: '💸', price: prize, tier: 'cash', cash: true
        }
      });
    }

    if (url.pathname === '/api/free-case/ref' && req.method === 'POST') {
      if (!checkRateLimit(`free-ref:${u.id}`, 8, 60000)) {
        return send(429, { error: 'Слишком много запросов. Подождите немного.' });
      }
      const level = Number(body.level) === 5 ? 5 : 3;
      const granted = grantReferralFreeCase(u, level);
      if (!granted.ok) return send(400, { error: granted.error });
      return send(200, { ok: true, level, ...granted });
    }

    /* Совместимость со старым клиентом: те же кейсы, только 5-й уровень. */
    if (url.pathname === '/api/5ref-case/status') {
      const qualified = db.getQualifiedFriendsCount ? db.getQualifiedFriendsCount(u.id) : 0;
      const claimed = Boolean(u.freeCase5RefClaimed);
      return send(200, {
        ok: true, claimed, qualified, needed: 5,
        canClaim: !claimed && qualified >= 5,
        refCode: u.code, refLink: refLink(u.code),
        item: publicFreeRefItem(FREE_REF_CASES[5])
      });
    }
    if (url.pathname === '/api/5ref-case/open' && req.method === 'POST') {
      if (!checkRateLimit(`ref5case:${u.id}`, 10, 60000)) {
        return send(429, { error: 'Слишком много запросов. Подождите немного.' });
      }
      const granted = grantReferralFreeCase(u, 5);
      if (!granted.ok) return send(400, { error: granted.error });
      return send(200, { ok: true, claimed: true, ...granted });
    }

    /* ── Pulse Market: микрораунды крипто-рынка (DECISIONS.md D5) ──────────────
       Ставка списывается сервером; исход — из серверного seed; результат
       раскрывается только после окончания таймера раунда. */
    if (url.pathname === '/api/pulse/config' && req.method === 'POST') {
      return send(200, { ok: true, config: pulse.publicConfig(), tokens: u.tokens });
    }

    if (url.pathname === '/api/pulse/bet' && req.method === 'POST') {
      if (!checkRateLimit(`pulse-bet:${u.id}`, 30, 60000)) {
        return send(429, { error: 'Слишком часто. Подождите минуту.' });
      }
      const check = pulse.validateBet({
        direction: body.direction, leverage: body.leverage, duration: body.duration, bet: body.bet
      });
      if (!check.ok) return send(400, { error: check.error });
      if (check.bet > Math.floor(u.tokens || 0)) return send(400, { error: 'Недостаточно средств' });

      const clientKey = String(body.requestId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
        return send(400, { error: 'Некорректный идентификатор запроса' });
      }
      const roundId = `PM_${u.id}_${clientKey}`;
      const startedAt = Date.now();

      // Идемпотентность и защита от двойного списания: claim ДО списания.
      let claimed = false;
      try {
        claimed = db.claimRound({ roundId, userId: u.id, game: pulse.PULSE.label, bet: check.bet });
      } catch (e) {
        console.error('[Pulse] claim failed:', e.message);
        return send(500, { error: 'Не удалось начать раунд, повторите позже' });
      }
      if (!claimed) {
        // Повтор того же запроса: вернуть уже существующий раунд, без нового списания.
        // dueAt и параметры нужны, чтобы клиент продолжил таймер, а не гадал.
        const prev = db.getRoundParams(roundId, u.id);
        const p = (prev && prev.params) || {};
        return send(200, {
          ok: true, duplicate: true, roundId,
          status: prev ? prev.status : 'pending',
          startedAt: p.startedAt, dueAt: p.dueAt, duration: p.duration,
          direction: p.direction, leverage: p.leverage,
          bet: prev ? Number(prev.bet_tokens) || 0 : check.bet,
          tokens: u.tokens
        });
      }

      const r = applyBalance(u, -check.bet, 'pulse_bet',
        `Pulse Market · ${rub(check.bet)} · ${body.direction} ×${check.leverage} · ${check.duration} с`, roundId);
      if (!r.ok) {
        db.releaseRoundClaim(roundId, u.id);
        return send(400, { error: 'Не удалось списать ставку' });
      }
      u.rakeback = Math.round(((u.rakeback || 0) + (check.bet * 0.005)) * 100) / 100;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (pulse bet):', e.message); }

      // Буст: подбираем seed, при котором исход совпадёт с направлением игрока.
      // Seed по-прежнему не покидает сервер — клиент видит только результат.
      let seed = crypto.randomBytes(32).toString('hex');
      if (boost.triggers(playerLuck(u.id), rnd01())) {
        seed = boost.pickPulseSeed(
          () => crypto.randomBytes(32).toString('hex'),
          s => pulse.outcomeFromSeed(s, roundId, check.leverage).outcome === body.direction
        );
      }

      const pulseParams = {
        direction: body.direction, leverage: check.leverage, duration: check.duration,
        startedAt, dueAt: startedAt + check.duration * 1000
      };
      // Seed и параметры — в game_rounds: раунд переживает перезапуск сервера.
      db.setRoundParams(roundId, u.id, seed, pulseParams);
      pulseRounds.set(roundId, {
        userId: u.id, seed, startedAt, dueAt: pulseParams.dueAt,
        direction: body.direction, leverage: check.leverage, duration: check.duration,
        bet: check.bet, settled: false
      });
      return send(200, {
        ok: true, duplicate: false, roundId, startedAt, dueAt: startedAt + check.duration * 1000,
        duration: check.duration, direction: body.direction, leverage: check.leverage,
        bet: check.bet, tokens: u.tokens
      });
    }

    if (url.pathname === '/api/pulse/result' && req.method === 'POST') {
      const roundId = String(body.roundId || '');
      // Раунда может не быть в памяти (перезапуск) — ensurePulseRound поднимет его из БД.
      const rd = ensurePulseRound(roundId, u.id);
      if (!rd || rd.userId !== u.id) return send(404, { error: 'Раунд не найден' });
      // Результат раскрывается только по окончании таймера — не раньше.
      if (Date.now() < (rd.dueAt || 0)) {
        return send(425, { error: 'Раунд ещё идёт', dueAt: rd.dueAt });
      }
      if (rd.settled) {
        // Повтор: отдаём уже записанный результат, деньги второй раз не начисляем.
        return send(200, { ok: true, duplicate: true, result: rd.result, tokens: u.tokens });
      }
      const out = settlePulseOnce(rd, roundId, { auto: false });
      if (!out.settled) return send(500, { error: out.error || 'Не удалось рассчитать раунд' });
      return send(200, { ok: true, duplicate: false, result: out.result, tokens: out.tokens });
    }

    /* ── Pulse: восстановление после закрытия приложения/перезагрузки ────────
       Идущий раунд возвращается с dueAt — клиент продолжает таймер.
       Просроченный рассчитывается здесь же, результат отдаётся один раз. */
    if (url.pathname === '/api/pulse/pending' && req.method === 'POST') {
      if (process.env.BOT_DRY_RUN !== '1' && !checkRateLimit(`pulse-pending:${u.id}`, 60, 60000)) {
        return send(429, { error: 'Слишком часто. Подождите минуту.' });
      }
      const now = Date.now();
      const sinceReq = Number(body.since);
      const since = (Number.isFinite(sinceReq) && sinceReq > 0) ? Math.min(now, sinceReq) : now - 30 * 60 * 1000;

      let active = null;
      const pendingRows = db.listUserOpenRounds(u.id, pulse.PULSE.label, ['pending'], now - 24 * 60 * 60 * 1000, 20);
      for (const row of pendingRows) {
        const rd = ensurePulseRound(row.round_id, u.id);
        if (!rd) continue;
        if (rd.dueAt && now < rd.dueAt) {
          if (!active || (rd.startedAt || 0) > (active.startedAt || 0)) {
            active = {
              roundId: row.round_id, startedAt: rd.startedAt, dueAt: rd.dueAt,
              duration: rd.duration, direction: rd.direction,
              leverage: rd.leverage, bet: rd.bet
            };
          }
        } else {
          settlePulseOnce(rd, row.round_id, { auto: true });
        }
      }

      // Только автоматически закрытые раунды: те, что игрок не увидел сам.
      const results = db.listUserRoundsSince(u.id, pulse.PULSE.label, since, 50)
        .filter(r => r.status === 'settled' && r.params && r.params.auto)
        .slice(0, 10)
        .map(r => ({
          roundId: r.round_id,
          direction: r.params.direction,
          leverage: r.params.leverage,
          bet: Number(r.bet_tokens) || 0,
          won: !!r.params.won,
          outcome: r.params.outcome,
          move: r.params.move,
          duration: Number(r.params.duration) || 5,
          mult: Number(r.params.mult) || 0,
          payout: Number(r.win_tokens) || 0,
          settledAt: r.settled_at
        }));

      return send(200, {
        ok: true, active, results, since, now: Date.now(), tokens: u.tokens
      });
    }

    /* ── Прогрессия (DECISIONS.md D7/D8): миссии, титул, статистика, Replay, сезон.
       Всё считается из game_rounds на сервере. Награды — только косметика. */
    if (url.pathname === '/api/progress' && req.method === 'POST') {
      const rounds = db.getUserRounds(u.id, 500);
      const now = Date.now();
      return send(200, {
        ok: true,
        stats: progress.stats(rounds),
        title: progress.titleFor(progress.stats(rounds).rounds),
        missions: progress.dailyMissions(rounds, now),
        replay: progress.replay(rounds, 10),
        season: progress.seasonProgress(rounds, SEASON_START_MS, now),
        tokens: u.tokens
      });
    }

    /* ── Trend Hunter: распознавание паттерна (DECISIONS.md D6) ─────────────────
       Сценарий и правильный ответ фиксируются на сервере при генерации. */
    if (url.pathname === '/api/trend/config' && req.method === 'POST') {
      return send(200, { ok: true, config: trend.publicConfig(), combo: trendCombo(u.id), tokens: u.tokens });
    }

    if (url.pathname === '/api/trend/start' && req.method === 'POST') {
      if (!checkRateLimit(`trend-start:${u.id}`, 30, 60000)) {
        return send(429, { error: 'Слишком часто. Подождите минуту.' });
      }
      const level = Math.floor(Number(body.level) || 0);
      if (!trend.TREND.levels[level]) return send(400, { error: 'Уровень: 1, 2 или 3' });
      const bet = Math.floor(Number(body.bet) || 0);
      if (!Number.isFinite(bet) || bet < trend.TREND.minBet || bet > trend.TREND.maxBet) {
        return send(400, { error: `Ставка от ${rub(trend.TREND.minBet)} до ${rub(trend.TREND.maxBet)}` });
      }
      if (bet > Math.floor(u.tokens || 0)) return send(400, { error: 'Недостаточно средств' });
      const clientKey = String(body.requestId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
        return send(400, { error: 'Некорректный идентификатор запроса' });
      }
      const roundId = `TH_${u.id}_${clientKey}`;
      let claimed = false;
      try {
        claimed = db.claimRound({ roundId, userId: u.id, game: trend.TREND.label, bet });
      } catch (e) {
        console.error('[Trend] claim failed:', e.message);
        return send(500, { error: 'Не удалось начать раунд, повторите позже' });
      }
      if (!claimed) return send(200, { ok: true, duplicate: true, roundId, tokens: u.tokens });

      const r = applyBalance(u, -bet, 'trend_bet', `Trend Hunter · ставка ${rub(bet)} · уровень ${level}`, roundId);
      if (!r.ok) {
        db.releaseRoundClaim(roundId, u.id);
        return send(400, { error: 'Не удалось списать ставку' });
      }
      u.rakeback = Math.round(((u.rakeback || 0) + (bet * 0.005)) * 100) / 100;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (trend start):', e.message); }

      const seed = crypto.randomBytes(32).toString('hex');
      const scenario = trend.generateScenario({ seedHex: seed, level, scenarioId: roundId });
      // Seed и сценарий (с правильным ответом) — в game_rounds: переживают перезапуск.
      db.setRoundParams(roundId, u.id, seed, {
        level, scenarioId: roundId, pattern: scenario.pattern, points: scenario.points,
        seconds: scenario.seconds, mult: scenario.mult, chart: scenario.chart, startedAt: Date.now()
      });
      trendRounds.set(roundId, {
        userId: u.id, bet, level, scenario, answered: false, answer: null, correct: null, payout: 0,
        startedAt: Date.now(), deadline: Date.now() + scenario.seconds * 1000
      });
      // Клиент получает график и параметры, но НЕ правильный ответ.
      return send(200, {
        ok: true, duplicate: false, roundId, level, bet,
        seconds: scenario.seconds, points: scenario.points, multiplier: scenario.mult,
        chart: scenario.chart,
        deadline: Date.now() + scenario.seconds * 1000, tokens: u.tokens
      });
    }

    if (url.pathname === '/api/trend/answer' && req.method === 'POST') {
      const roundId = String(body.roundId || '');
      let rd = trendRounds.get(roundId);
      if (!rd) {
        // Перезапуск сервера: восстанавливаем сценарий из game_rounds.
        const dbRow = db.getRoundParams(roundId, u.id);
        if (dbRow && dbRow.seed && dbRow.game === trend.TREND.label) {
          const p = dbRow.params || {};
          rd = {
            userId: u.id, bet: Number(dbRow.bet_tokens) || 0, level: p.level,
            scenario: { pattern: p.pattern, points: p.points, seconds: p.seconds, mult: p.mult },
            answered: Boolean(p.result), result: p.result || null,
            deadline: (p.startedAt || 0) + (p.seconds || 0) * 1000
          };
          trendRounds.set(roundId, rd);
        }
      }
      if (!rd || rd.userId !== u.id) return send(404, { error: 'Раунд не найден' });
      const answer = String(body.answer || '');
      if (!trend.TREND.patterns.includes(answer)) return send(400, { error: 'Выберите: рост, падение или боковик' });
      if (rd.answered) {
        // Повтор ответа: отдаём уже сохранённый результат, без второй выплаты.
        return send(200, { ok: true, duplicate: true, result: rd.result, combo: trendCombo(u.id), tokens: u.tokens });
      }
      // Время вышло — ответ не принимаем, ставка сгорает.
      const late = Date.now() > rd.deadline + 2000;
      const correct = !late && trend.checkAnswer(rd.scenario, answer);
      const payout = correct ? Math.floor(rd.bet * rd.scenario.mult) : 0;
      if (payout > 0) {
        const pr = applyBalance(u, payout, 'trend_win', `Trend Hunter · выигрыш +${rub(payout)}`, roundId);
        if (!pr.ok) return send(500, { error: 'Не удалось начислить выигрыш, повторите' });
      }
      trendComboState.set(u.id, trend.nextCombo(trendCombo(u.id), correct));
      rd.answered = true;
      rd.answer = answer;
      rd.correct = correct;
      rd.payout = payout;
      rd.result = { correct, late, pattern: rd.scenario.pattern, payout, mult: rd.scenario.mult };
      try {
        db.settleRound({
          roundId, userId: u.id, game: trend.TREND.label, bet: rd.bet,
          mult: correct ? rd.scenario.mult : 0, win: payout, status: 'settled'
        });
        const stored = db.getRoundParams(roundId, u.id);
        const prevParams = (stored && stored.params) || {};
        db.setRoundParams(roundId, u.id, stored ? stored.seed : null, {
          ...prevParams, answer, answeredAt: Date.now(), result: rd.result
        });
      } catch (e) { console.error('[Trend] settle not saved:', e.message); }
      try { db.saveUser(u); } catch (e) { console.error('saveUser (trend answer):', e.message); }
      rd.settledAt = Date.now();
      return send(200, { ok: true, duplicate: false, result: rd.result, combo: trendCombo(u.id), tokens: u.tokens });
    }

    /* ── Ракетка: приём ставки до старта полёта ────────────────────────────── */
    if (url.pathname === '/api/racket/bet' && req.method === 'POST') {
      if (process.env.BOT_DRY_RUN !== '1' && !checkRateLimit(`racket-bet:${u.id}`, 60, 60000)) {
        return send(429, { error: 'Слишком много запросов. Пожалуйста, подождите.' });
      }
      const bet = Math.floor(Number(body.bet != null ? body.bet : body.betTokens) || 0);
      if (bet < 10 || bet > 100000) return send(400, { error: `Ставка должна быть от ${rub(10)} до ${rub(100000)}` });
      if (bet > Math.floor(u.tokens || 0)) return send(400, { error: 'Недостаточно средств' });

      const rIdx = Math.floor(Date.now() / RACKET_ROUND_MS);   // раунд решает сервер, не клиент
      const round = getRacketRound(rIdx);                      // фиксируем (секретную) точку взрыва раунда
      // Очень ранний крах мог случиться прямо на границе окна ставок —
      // в мёртвый раунд ставку не принимаем.
      if (Date.now() > racketBustAt(rIdx, round.crash)) {
        return send(400, { error: 'Раунд уже завершился, подождите следующий' });
      }
      const roundId = String(body.roundId || ('RK_' + rIdx + '_' + u.id + '_' + crypto.randomBytes(4).toString('hex'))).trim();
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(roundId)) {
        return send(400, { error: 'Некорректный идентификатор раунда' });
      }

      // Claim ДО списания: повтор того же roundId (потерянный ответ, ретрай)
      // не спишет ставку второй раз.
      let claimed = false;
      try {
        claimed = db.claimRound({ roundId, userId: u.id, game: 'Ракетка', bet, status: 'active' });
      } catch (e) {
        console.error('[Racket] claim failed:', e.message);
        return send(500, { error: 'Не удалось начать раунд, повторите позже' });
      }
      if (!claimed) {
        const prev = db.getRound(roundId);
        return send(200, {
          ok: true, duplicate: true, roundId,
          status: prev ? prev.status : 'active', tokens: u.tokens
        });
      }

      const r = applyBalance(u, -bet, 'racket_bet', `Ракетка · ставка в раунде #${rIdx} (${rub(bet)})`, roundId);
      if (!r.ok) {
        db.releaseRoundClaim(roundId, u.id);
        return send(400, { error: 'Не удалось списать ставку' });
      }

      // Рейкбек: 0.5% от суммы ставки в Ракетке
      u.rakeback = Math.round(((u.rakeback || 0) + (bet * 0.005)) * 100) / 100;
      try { db.saveUser(u); } catch (_) {}

      activeRacketBets.set(roundId, {
        userId: u.id,
        bet,
        rIdx,
        crash: round.crash,
        createdAt: Date.now(),
        cashed: false,
        settled: false
      });

      // rIdx и точка взрыва — в БД: после перезапуска сервера раунд
      // восстанавливается по тому же секрету, а не по новому случайному.
      try {
        db.setRoundParams(roundId, u.id, null, {
          rIdx, crash: round.crash, startedAt: rIdx * RACKET_ROUND_MS
        });
      } catch (e) { console.error('[Racket] params:', e.message); }

      return send(200, { ok: true, roundId, bet, rIdx, tokens: u.tokens });
    }

    /* ── Ракетка: кэшаут (забрать выигрыш на текущем множителе) ─────────────── */
    if (url.pathname === '/api/racket/cashout' && req.method === 'POST') {
      const roundId = String(body.roundId || '');
      let saved = activeRacketBets.get(roundId);
      if (!saved) {
        // Сервер перезапустился, память пуста — ставка ещё лежит в game_rounds.
        const row = db.getRoundParams(roundId, u.id);
        if (row && row.game === 'Ракетка' && (row.status === 'active' || row.status === 'pending')) {
          const p = row.params || {};
          const rIdx = Number.isFinite(Number(p.rIdx)) ? Number(p.rIdx) : racketRIdxFromRoundId(roundId);
          if (rIdx != null) {
            saved = {
              userId: u.id, bet: Number(row.bet_tokens) || 0, rIdx,
              crash: p.crash, createdAt: row.created_at, cashed: false, settled: false
            };
            activeRacketBets.set(roundId, saved);
          }
        }
      }
      if (!saved || saved.userId !== u.id) {
        return send(400, { error: 'Активная ставка в Ракетке не найдена' });
      }
      if (saved.cashed || saved.settled) {
        return send(400, { error: 'Выигрыш уже забран или ставка сгорела' });
      }

      // Кэшаут возможен только в живом раунде. Просроченную ставку закрываем
      // проигрышем, а будущий индекс из подделанного roundId выплату не открывает.
      if (!racketRoundIsLive(saved.rIdx)) {
        const nowIdx = Math.floor(Date.now() / RACKET_ROUND_MS);
        if (saved.rIdx < nowIdx) {
          settleRacketLoss(roundId, saved, true);
          return send(400, { error: 'Раунд уже завершился. Ставка сгорела.' });
        }
        return send(400, { error: 'Раунд ещё не начался' });
      }

      const serverCrash = rememberRacketRound(saved.rIdx, saved.crash).crash;
      saved.crash = serverCrash;
      const clientMult = Math.round((Number(body.mult) || 1.01) * 100) / 100;

      // Ракета разбилась до того, как игрок нажал кэшаут (в том числе если
      // запрос пришёл уже после момента краха).
      if (serverCrash <= 1.00 || clientMult > serverCrash || Date.now() > racketBustAt(saved.rIdx, serverCrash)) {
        settleRacketLoss(roundId, saved);
        return send(400, { error: `Ракета уже взорвалась на ×${serverCrash}. Ставка сгорела.` });
      }

      const realMult = Math.min(serverCrash, Math.max(1.01, clientMult));
      // Общий краш раунда персонализировать нельзя. Буст влияет только на
      // выплату при кэшауте: с шансом удачи игрок забирает +50%.
      const cashout = boost.cashoutBonus(
        Math.floor(saved.bet * realMult), playerLuck(u.id), rnd01());
      const win = cashout.win;

      const r = applyBalance(u, win, 'racket_cashout', `Ракетка · выигрыш ×${realMult} (+${rub(win)})`, roundId);
      if (!r.ok) return send(500, { error: 'Не удалось начислить выигрыш' });

      saved.cashed = true;
      saved.settled = true;

      try {
        const closed = db.settleRoundOnce({
          roundId, userId: u.id, game: 'Ракетка', bet: saved.bet,
          mult: realMult, win, status: 'settled', settledAt: Date.now()
        });
        if (closed) {
          const row = db.getRoundParams(roundId, u.id);
          const p = (row && row.params) || {};
          db.setRoundParams(roundId, u.id, null, {
            ...p, rIdx: saved.rIdx, crash: serverCrash, cashedOut: true, mult: realMult,
            win, boosted: cashout.boosted, settledAt: Date.now()
          });
        }
      } catch (e) { console.error('[Racket] cashout settle not saved:', e.message); }

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

    /* ── Ракетка: состояние раунда. Точку взрыва отдаём ТОЛЬКО когда полёт до неё
       уже дошёл — иначе модифицированный клиент узнал бы её заранее и забрал выигрыш. */
    if (url.pathname === '/api/racket/state' && req.method === 'POST') {
      const serverIdx = Math.floor(Date.now() / RACKET_ROUND_MS);
      const reqIdx = Number(body.rIdx);
      // Принимаем клиентский индекс только в пределах ±1 раунда (защита от перебора
      // будущих/произвольных раундов); иначе берём серверный.
      const rIdx = (Number.isFinite(reqIdx) && Math.abs(reqIdx - serverIdx) <= 1) ? reqIdx : serverIdx;
      const round = getRacketRound(rIdx);
      const busted = (Date.now() - rIdx * RACKET_ROUND_MS) >= racketBustMs(round.crash);
      return send(200, {
        ok: true,
        rIdx,
        crashed: busted,
        crash: busted ? round.crash : null
      });
    }

    /* ── Ракетка: восстановление после закрытия приложения/перезагрузки ─────
       Возвращает только СВОИ незакрытые ставки. Если ракета уже взорвалась,
       ставка здесь же закрывается проигрышем (деньги не двигаются — они
       списаны при приёме). Точка краха не раскрывается, пока полёт идёт. */
    if (url.pathname === '/api/racket/pending' && req.method === 'POST') {
      if (process.env.BOT_DRY_RUN !== '1' && !checkRateLimit(`racket-pending:${u.id}`, 60, 60000)) {
        return send(429, { error: 'Слишком много запросов. Пожалуйста, подождите.' });
      }
      const now = Date.now();
      const sinceReq = Number(body.since);
      const since = (Number.isFinite(sinceReq) && sinceReq > 0) ? Math.min(now, sinceReq) : now - 30 * 60 * 1000;

      const rows = db.listUserOpenRounds(u.id, 'Ракетка', ['active', 'pending'], now - 24 * 60 * 60 * 1000, 20);
      const active = [];
      for (const row of rows) {
        const p = (row && row.params) || {};
        const parsedIdx = Number(p.rIdx);
        const rIdx = Number.isFinite(parsedIdx) ? parsedIdx : racketRIdxFromRoundId(row.round_id);
        const bet = Number(row.bet_tokens) || 0;
        if (rIdx == null) {
          const closed = db.settleRoundOnce({
            roundId: row.round_id, userId: u.id, game: 'Ракетка', bet,
            mult: 0, win: 0, status: 'settled', settledAt: now
          });
          if (closed) db.setRoundParams(row.round_id, u.id, null, { autoClosed: true, settledAt: now, crash: null });
          continue;
        }
        const round = rememberRacketRound(rIdx, p.crash);
        let saved = activeRacketBets.get(row.round_id);
        if (!saved) {
          saved = {
            userId: u.id, bet, rIdx, crash: round.crash,
            createdAt: row.created_at, cashed: false, settled: false
          };
          activeRacketBets.set(row.round_id, saved);
        }
        // Синхронизируем память с БД: там лежат настоящие индекс/ставка/крах,
        // даже если в памяти остался устаревший объект.
        saved.rIdx = rIdx;
        saved.bet = bet;
        saved.crash = round.crash;
        const nowIdx = Math.floor(now / RACKET_ROUND_MS);
        if (now > racketBustAt(rIdx, round.crash) || rIdx !== nowIdx) {
          // Взорвалась, закончилась или ещё не началась (битый индекс
          // из подделанного roundId) — кэшаут уже невозможен.
          settleRacketLoss(row.round_id, saved, true);
        } else {
          active.push({ roundId: row.round_id, bet, rIdx });
        }
      }

      // Ставки, закрытые автоматически, пока приложение было закрыто.
      const closed = db.listUserRoundsSince(u.id, 'Ракетка', since, 50)
        .filter(r => r.status === 'settled' && r.params && r.params.autoClosed)
        .slice(0, 10)
        .map(r => ({
          roundId: r.round_id,
          bet: Number(r.bet_tokens) || 0,
          crash: r.params.crash != null ? Number(r.params.crash) : null,
          settledAt: r.settled_at
        }));

      return send(200, {
        ok: true, active, closed, since, now: Date.now(), tokens: u.tokens
      });
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
        body.roundId || body.round_id,
        body.itemId || body.item_id
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
        drop: res.drop || null,
        nearMiss: Boolean(res.nearMiss)
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
          price: it.price, tier: it.tier, caseName: it.case_name, wonAt: it.acquired_at,
          upgrade_only: Boolean(it.upgrade_only),
          collectible: Boolean(it.collectible)
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
      if (it.collectible) {
        return send(400, { error: 'Коллекционный предмет нельзя продать — он остаётся в инвентаре на память.' });
      }
      if (it.upgrade_only) {
        return send(400, { error: 'Этот предмет нельзя продать — его можно только проапгрейдить в Upgrader!' });
      }

      // Сначала помечаем проданным (атомарно, с условием sold_at IS NULL) —
      // если не вышло, значит продали параллельно, и начислять нельзя.
      if (!db.markInventorySold(id, u.id, it.price)) return send(400, { error: 'Предмет уже продан' });

      const r = applyBalance(u, it.price, 'inventory_sale', `Продажа: ${it.name} (${it.case_name})`, 'inv' + id);
      if (!r.ok) {
        // Начисление не прошло — возвращаем предмет владельцу, иначе он пропадёт
        try { db.db.prepare('UPDATE user_inventory SET sold_at = NULL, sold_for = NULL WHERE id = ?').run(id); } catch (_) {}
        return send(500, { error: 'Не удалось начислить средства, повторите позже' });
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
        if (it.collectible) continue;   // коллекционные предметы не продаются и не апгрейдятся
        if (it.upgrade_only) continue;   // акционные предметы только для апгрейда, не продаются
        if (!db.markInventorySold(it.id, u.id, it.price)) continue;   // продали параллельно — пропускаем
        total += it.price;
        sold.push({ id: it.id, name: it.name, price: it.price });
      }
      if (!total) return send(400, { error: 'В инвентаре нет предметов для продажи — коллекционные и акционные вещи не продаются' });
      const r = applyBalance(u, total, 'inventory_sale', `Продажа инвентаря: ${sold.length} шт`, 'invall' + Date.now());
      if (!r.ok) {
        for (const it of sold) {
          try { db.db.prepare('UPDATE user_inventory SET sold_at = NULL, sold_for = NULL WHERE id = ?').run(it.id); } catch (_) {}
        }
        return send(500, { error: 'Не удалось начислить средства, повторите позже' });
      }
      return send(200, { ok: true, count: sold.length, total, sold, tokens: u.tokens });
    }

    /* ══════════════════════════════════════════════════════════════════════
       CASE HUB — ОДИН раздел для всех кейсов.
       15 классических кейсов живут в items.js, 5 новых режимов — в
       assets/case-modes.js. Оба каталога отдаются одним ответом; открытие
       идёт через один эндпоинт и одну атомарную транзакцию.
       ══════════════════════════════════════════════════════════════════════ */
    if (url.pathname === '/api/cases/catalog' && req.method === 'POST') {
      if (!checkRateLimit(`catalog:${u.id}`, 60, 60000)) return send(429, { error: 'Слишком много запросов каталога. Подождите минуту.' });
      const classic = Object.values(items.CASES).map(c => {
        const totalW = c.items.reduce((s, it) => s + it.w, 0);
        return {
          id: c.id, kind: 'classic', name: c.name, tagline: 'Классический кейс',
          desc: c.desc, icon: c.icon, cover: `assets/cases/${c.id}.jpg`,
          price: c.cost, theme: null,
          items: c.items.map(it => ({
            code: it.code, name: it.name, icon: it.icon, price: it.price, tier: it.tier,
            chance: Number(((it.w / totalW) * 100).toFixed(3))
          }))
        };
      });
      const modes = Object.values(caseModes.MODES).map(m => {
        const totalW = m.items.reduce((s, it) => s + it.w, 0);
        return {
          id: m.id, kind: 'mode', name: m.name, tagline: m.tagline, desc: m.desc,
          icon: m.icon, cover: `assets/cases/${m.id}.jpg`,
          price: m.price, priceMin: m.priceMin, priceMax: m.priceMax, theme: m.theme,
          items: m.items.map(it => ({
            code: it.code, name: it.name, icon: it.icon, price: it.price, tier: it.tier,
            chance: Number(((it.w / totalW) * 100).toFixed(3))
          }))
        };
      });
      return send(200, {
        ok: true,
        cases: [...classic, ...modes],
        classic,
        modes,
        history: db.getCaseHistory(u.id, 12),
        tokens: u.tokens
      });
    }

    /* Пробный прокрут: обычный ролл по тем же весам, что и платное открытие.
       Предмет не выдаётся, токены не списываются, на следующие открытия
       не влияет — но и «хороший дроп» больше не подкручивается. */
    if (url.pathname === '/api/cases/warmup' && req.method === 'POST') {
      if (!checkRateLimit(`case-warmup:${u.id}`, 30, 60000)) {
        return send(429, { error: 'Слишком часто. Подождите минуту.' });
      }
      const caseId = String(body.caseId || body.modeId || '').trim();
      const mode = caseModes.getMode(caseId);
      const classic = mode ? null : items.getCase(caseId);
      if (!mode && !classic) return send(400, { error: 'Кейс не найден' });
      const rnd = crypto.randomInt(0, 0x100000000) / 0x100000000;
      const demo = mode ? caseModes.rollItem(caseId, rnd) : items.rollItem(caseId, rnd);
      if (!demo) return send(500, { error: 'Кейс временно недоступен' });
      return send(200, {
        ok: true,
        demo: true,
        caseId,
        caseName: mode ? mode.name : classic.name,
        item: {
          code: demo.code, name: demo.name, icon: demo.icon,
          price: demo.price, tier: demo.tier
        },
        tokens: u.tokens
      });
    }

    if (url.pathname === '/api/cases/open' && req.method === 'POST') {
      if (!checkRateLimit(`case-open:${u.id}`, 30, 60000)) {
        return send(429, { error: 'Слишком часто открываете кейсы. Подождите минуту.' });
      }
      // Поддерживаем оба имени: caseId (новый клиент) и modeId (старый).
      const caseId = String(body.caseId || body.modeId || '').trim();
      const mode = caseModes.getMode(caseId);
      const classic = mode ? null : items.getCase(caseId);
      if (!mode && !classic) return send(400, { error: 'Кейс не найден' });
      const clientKey = String(body.requestId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
        return send(400, { error: 'Некорректный идентификатор запроса' });
      }
      const requestId = `CASE_${u.id}_${clientKey}`;
      const roundId = `CM_${u.id}_${clientKey}`;
      const price = mode ? mode.price : classic.cost;
      const caseName = mode ? mode.name : classic.name;
      const kind = mode ? 'mode' : 'classic';
      // Баланс проверяется внутри транзакции atomicOpenCase. Здесь нарочно
      // нет предварительной проверки: повтор уже успешного запроса должен
      // вернуть сохранённый результат даже если баланс с тех пор изменился.
      const drop = rollCaseDrop(u.id, mode ? mode.id : classic.id, !mode);
      if (!drop) return send(500, { error: 'Кейс временно недоступен' });

      let res;
      try {
        res = db.atomicOpenCase({
          requestId, userId: u.id, modeId: caseId, modeName: caseName,
          price, item: drop, roundId
        });
      } catch (e) {
        console.error('[CaseHub] open failed:', e.message);
        return send(500, { error: 'Не удалось открыть кейс, повторите позже' });
      }
      if (!res.ok) return send(400, { error: res.error || 'Не удалось открыть кейс' });

      u.tokens = Number(res.balanceAfter);   // ledger-ok: записано в БД атомарной транзакцией
      if (!res.duplicate) {
        u.rakeback = Math.round(((u.rakeback || 0) + (price * 0.005)) * 100) / 100;
      }
      try { db.saveUser(u); } catch (e) { console.error('saveUser (case hub):', e.message); }
      if (!res.duplicate) {
        betsMonitor.recordBet({
          userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
          game: 'Кейс: ' + caseName, betTokens: price, winTokens: 0,
          balanceAfter: u.tokens, totalDepositedRub: u.totalDepositedRub || u.lastDeposit || 0
        });
      }
      const open = res.open || {};
      // При повторе возвращаем СОХРАНЁННЫЙ предмет, а не результат нового
      // броска: иначе клиент увидит один id и другое имя.
      const out = open.item || drop;
      return send(200, {
        ok: true,
        duplicate: Boolean(res.duplicate),
        requestId: clientKey,
        caseId,
        kind,
        modeId: caseId,
        modeName: caseName,
        price: res.duplicate && open.price ? open.price : price,
        drop: {
          id: open.inventoryId || res.inventoryId || null,
          code: out.code, name: out.name, icon: out.icon,
          price: out.price, tier: out.tier, caseName
        },
        tokens: u.tokens
      });
    }

    if (url.pathname === '/api/cases/history' && req.method === 'POST') {
      return send(200, {
        ok: true,
        history: db.getCaseHistory(u.id, Math.min(50, Math.max(1, Number(body.limit) || 20))),
        tokens: u.tokens
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
       UPGRADE ARENA — серверная модель апгрейда.
       ══════════════════════════════════════════════════════════════════════ */
    if (url.pathname === '/api/upgrade/catalog' && req.method === 'POST') {
      if (!checkRateLimit(`upg-catalog:${u.id}`, 60, 60000)) return send(429, { error: 'Слишком много запросов каталога. Подождите минуту.' });
      return send(200, {
        ok: true,
        modes: Object.values(upgrade.MODES).map(m => ({
          id: m.id, label: m.label, title: m.title, desc: m.desc,
          edge: m.edge, chanceCap: m.chanceCap, maxMult: m.maxMult,
          minTargetRatio: m.minTargetRatio, color: m.color
        })),
        targets: upgrade.TARGETS,
        maxTargets: upgrade.MAX_TARGETS,
        limits: { minTokens: 10, maxTokens: 100000, maxTargets: upgrade.MAX_TARGETS },
        ladder: {
          3: upgrade.ladderPreview(upgrade.MODES.standard, 3, 1000),
          5: upgrade.ladderPreview(upgrade.MODES.standard, 5, 1000),
          10: upgrade.ladderPreview(upgrade.MODES.standard, 10, 1000)
        },
        ladderTables: upgrade.LADDER_MULTS,
        inventory: db.listInventory(u.id).filter(it => !it.collectible).map(it => ({
          id: it.id, code: it.item_code, name: it.name, icon: it.icon,
          price: it.price, tier: it.tier, caseName: it.case_name,
          upgrade_only: Boolean(it.upgrade_only)
        })),
        history: db.getUpgradeHistory(u.id, 12),
        tokens: u.tokens
      });
    }

    if (url.pathname === '/api/upgrade/run' && req.method === 'POST') {
      if (!checkRateLimit(`upgrade:${u.id}`, 60, 60000)) {
        return send(429, { error: 'Слишком много апгрейдов. Подождите минуту.' });
      }
      const mode = upgrade.getMode(body.mode);
      if (!mode) return send(400, { error: 'Неизвестный режим риска' });
      const clientKey = String(body.requestId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
        return send(400, { error: 'Некорректный идентификатор запроса' });
      }
      const requestId = `UPG_${u.id}_${clientKey}`;
      // Повтор уже выполненного апгрейда (ответ потерялся) возвращаем ДО
      // проверки источника: предмет-источник к этому моменту уже списан.
      const prevRun = db.getUpgradeRun(requestId, u.id);
      if (prevRun) {
        const prevTargets = Array.isArray(prevRun.targets) && prevRun.targets.length
          ? prevRun.targets : [];
        return send(200, {
          ok: true, duplicate: true, requestId: clientKey, mode: prevRun.mode,
          sourceType: prevRun.sourceType, sourceValue: prevRun.sourceValue,
          won: prevRun.won,
          chance: prevRun.chance,
          aggregateChance: prevRun.aggregateChance,
          distribution: prevTargets.map(t => ({
            code: t.code, chance: Number(t.chance || 0) / prevTargets.length
          })),
          target: prevRun.target,
          drop: prevRun.target ? { ...prevRun.target, id: prevRun.inventoryId, caseName: 'Апгрейд' } : null,
          tokens: u.tokens
        });
      }

      let sourceType = body.sourceType === 'item' ? 'item' : 'tokens';
      let sourceValue = 0;
      let sourceItemId = null;
      if (sourceType === 'item') {
        sourceItemId = Math.floor(Number(body.itemId) || 0);
        const it = db.getInventoryItem(sourceItemId);
        if (!it || Number(it.user_id) !== Number(u.id) || it.sold_at) {
          return send(400, { error: 'Предмет не найден в вашем инвентаре' });
        }
        if (it.collectible) {
          return send(400, { error: 'Коллекционный предмет нельзя апгрейдить — он остаётся на память.' });
        }
        sourceValue = Math.floor(Number(it.price) || 0);
      } else {
        sourceValue = Math.floor(Number(body.amount) || 0);
        if (!Number.isFinite(sourceValue) || sourceValue < 10) {
          return send(400, { error: `Минимальная сумма апгрейда — ${rub(10)}` });
        }
        if (sourceValue > 100000) {
          return send(400, { error: `Максимальная сумма апгрейда — ${rub(100000)}` });
        }
      }

      const valid = upgrade.validateTargets(mode, sourceValue, body.targets);
      if (!valid.ok) return send(400, { error: valid.error });
      const lucky = boost.triggers(playerLuck(u.id), rnd01());
      const roll = upgrade.rollUpgrade(mode, sourceValue, valid.targets, rnd01(), rnd01());
      if (!roll.ok) return send(400, { error: roll.error });
      if (lucky) {
        // Буст: цель — самая дорогая из выбранных, исход принудительно успешный.
        roll.target = valid.targets.reduce((best, t) =>
          Number(t.value) > Number(best.value) ? t : best, valid.targets[0]);
        roll.won = true;
        roll.chance = roll.target.chance;
      }

      let res;
      try {
        res = db.atomicUpgradeRun({
          requestId, userId: u.id, mode: mode.id,
          sourceType, sourceAmount: sourceValue, sourceItemId,
          target: roll.target, won: roll.won,
          chance: roll.chance, aggregateChance: roll.aggregateChance,
          targets: valid.targets.map(t => ({ code: t.code, name: t.name, value: t.value, tier: t.tier, chance: t.chance }))
        });
      } catch (e) {
        console.error('[Upgrade] run failed:', e.message);
        return send(500, { error: 'Не удалось выполнить апгрейд, повторите позже' });
      }
      if (!res.ok) return send(400, { error: res.error || 'Не удалось выполнить апгрейд' });

      u.tokens = Number(res.balanceAfter);   // ledger-ok: записано в БД атомарной транзакцией
      if (!res.duplicate) {
        u.rakeback = Math.round(((u.rakeback || 0) + (sourceValue * 0.005)) * 100) / 100;
      }
      try { db.saveUser(u); } catch (e) { console.error('saveUser (upgrade):', e.message); }
      if (!res.duplicate) {
        betsMonitor.recordBet({
          userId: u.id, name: u.username ? '@' + u.username : (u.name || String(u.id)),
          game: 'Апгрейд · ' + mode.label, betTokens: sourceValue,
          winTokens: roll.won ? roll.target.value : 0,
          balanceAfter: u.tokens, totalDepositedRub: u.totalDepositedRub || u.lastDeposit || 0
        });
      }
      const storedRun = res.run || {};
      const storedTargets = Array.isArray(storedRun.targets) && storedRun.targets.length
        ? storedRun.targets : valid.targets;
      const dist = storedTargets.map(t => ({
        code: t.code,
        chance: Number(t.chance || 0) / storedTargets.length
      }));
      return send(200, {
        ok: true,
        duplicate: Boolean(res.duplicate),
        requestId: clientKey,
        mode: mode.id,
        sourceType, sourceValue,
        won: Boolean(storedRun.won),
        chance: res.duplicate && storedRun.chance != null ? storedRun.chance : roll.chance,
        aggregateChance: res.duplicate && storedRun.aggregateChance != null ? storedRun.aggregateChance : roll.aggregateChance,
        distribution: res.duplicate ? dist : roll.distribution,
        target: storedRun && storedRun.target ? storedRun.target : (roll.won ? { ...roll.target, id: res.inventoryId } : null),
        drop: storedRun && storedRun.target ? { ...storedRun.target, id: res.inventoryId, caseName: 'Апгрейд' } : null,
        tokens: u.tokens
      });
    }

    if (url.pathname === '/api/upgrade/ladder/start' && req.method === 'POST') {
      if (!checkRateLimit(`ladder:${u.id}`, 30, 60000)) {
        return send(429, { error: 'Слишком много запусков. Подождите минуту.' });
      }
      const mode = upgrade.getMode(body.mode);
      if (!mode) return send(400, { error: 'Неизвестный режим риска' });
      const steps = Math.floor(Number(body.steps) || 0);
      if (![3, 5, 10].includes(steps)) return send(400, { error: 'Лесенка бывает на 3, 5 или 10 шагов' });
      const clientKey = String(body.requestId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
        return send(400, { error: 'Некорректный идентификатор запроса' });
      }
      const requestId = `LAD_${u.id}_${clientKey}`;
      // Повтор старта после потери ответа: сессия уже создана, предмет-источник
      // мог быть списан — возвращаем её, не проверяя источник заново.
      const prevLadder = db.getLadderByRequest(requestId, u.id);
      if (prevLadder) {
        const prevMode = upgrade.getMode(prevLadder.mode) || mode;
        return send(200, {
          ok: true, duplicate: true, session: prevLadder,
          preview: upgrade.ladderPreview(prevMode, prevLadder.stepsTotal, prevLadder.sourceValue),
          tokens: u.tokens
        });
      }
      const sourceType = body.sourceType === 'item' ? 'item' : 'tokens';
      let sourceValue = 0;
      let sourceItemId = null;
      if (sourceType === 'item') {
        sourceItemId = Math.floor(Number(body.itemId) || 0);
        const it = db.getInventoryItem(sourceItemId);
        if (!it || Number(it.user_id) !== Number(u.id) || it.sold_at) {
          return send(400, { error: 'Предмет не найден в вашем инвентаре' });
        }
        if (it.collectible) {
          return send(400, { error: 'Коллекционный предмет нельзя апгрейдить — он остаётся на память.' });
        }
        sourceValue = Math.floor(Number(it.price) || 0);
      } else {
        sourceValue = Math.floor(Number(body.amount) || 0);
        if (!Number.isFinite(sourceValue) || sourceValue < 10) {
          return send(400, { error: `Минимальная сумма — ${rub(10)}` });
        }
        if (sourceValue > 100000) return send(400, { error: `Максимальная сумма — ${rub(100000)}` });
      }
      const preview = upgrade.ladderPreview(mode, steps, sourceValue);
      if (!preview) return send(400, { error: 'Не удалось рассчитать лесенку' });
      const sessionId = 'LAD_' + crypto.randomBytes(10).toString('hex');
      let res;
      try {
        res = db.atomicLadderStart({
          sessionId, requestId, userId: u.id, mode: mode.id, stepsTotal: steps,
          sourceType, sourceAmount: sourceValue, sourceItemId, ladder: preview.stepsData
        });
      } catch (e) {
        console.error('[Ladder] start failed:', e.message);
        return send(500, { error: 'Не удалось начать лесенку, повторите позже' });
      }
      if (!res.ok) return send(400, { error: res.error || 'Не удалось начать лесенку' });
      u.tokens = Number(res.balanceAfter);   // ledger-ok: записано в БД атомарной транзакцией
      if (!res.duplicate) {
        u.rakeback = Math.round(((u.rakeback || 0) + (sourceValue * 0.005)) * 100) / 100;
      }
      try { db.saveUser(u); } catch (e) { console.error('saveUser (ladder start):', e.message); }
      // При повторе берём параметры СОХРАНЁННОЙ сессии, а не нового запроса.
      const outPreview = res.duplicate && res.session
        ? upgrade.ladderPreview(mode, res.session.stepsTotal, res.session.sourceValue)
        : preview;
      return send(200, {
        ok: true, duplicate: Boolean(res.duplicate), session: res.session,
        preview: outPreview, tokens: u.tokens
      });
    }

    if (url.pathname === '/api/upgrade/ladder/step' && req.method === 'POST') {
      if (!checkRateLimit(`ladder-step:${u.id}`, 90, 60000)) {
        return send(429, { error: 'Слишком часто. Подождите минуту.' });
      }
      const sessionId = String(body.sessionId || '').trim();
      const clientKey = String(body.requestId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
        return send(400, { error: 'Некорректный идентификатор запроса' });
      }
      const requestId = `LADSTEP_${u.id}_${clientKey}`;
      // Повтор уже выполненного шага (ответ потерялся в сети) обязан вернуть
      // ТОТ ЖЕ результат, а не 400 «шаг уже выполнен».
      const prevAction = db.getUpgradeAction(requestId, u.id);
      if (prevAction) {
        const prevSession = db.getLadderSession(sessionId, u.id);
        return send(200, {
          ok: true, duplicate: true, result: prevAction.result,
          session: prevSession, tokens: u.tokens
        });
      }
      const session = db.getLadderSession(sessionId, u.id);
      if (!session) return send(404, { error: 'Сессия лесенки не найдена' });
      if (session.status !== 'active') return send(400, { error: 'Сессия лесенки уже завершена' });
      const mode = upgrade.getMode(session.mode);
      if (!mode) return send(500, { error: 'Режим сессии недоступен' });
      const expectedStep = Math.floor(Number(body.expectedStep) || (session.stepIndex + 1));
      if (expectedStep !== session.stepIndex + 1) {
        return send(400, { error: 'Этот шаг уже выполнен или пропущен' });
      }
      const mults = upgrade.ladderSteps(session.stepsTotal, mode);
      if (!mults || expectedStep < 1 || expectedStep > mults.length) {
        return send(400, { error: 'Некорректный номер шага' });
      }
      const mult = mults[expectedStep - 1];
      const chance = upgrade.ladderChance(mode, mult);
      const won = boost.triggers(playerLuck(u.id), rnd01()) || rnd01() < chance;
      let res;
      try {
        res = db.atomicLadderStep({
          requestId, sessionId, userId: u.id, expectedStep, won, mult
        });
      } catch (e) {
        console.error('[Ladder] step failed:', e.message);
        return send(500, { error: 'Не удалось выполнить шаг, повторите позже' });
      }
      if (!res.ok) return send(400, { error: res.error || 'Не удалось выполнить шаг' });
      u.tokens = Number(res.balanceAfter);   // ledger-ok: записано в БД атомарной транзакцией
      try { db.saveUser(u); } catch (e) { console.error('saveUser (ladder step):', e.message); }
      const updated = db.getLadderSession(sessionId, u.id);
      return send(200, {
        ok: true, duplicate: Boolean(res.duplicate), result: res.result,
        session: updated, chance, mult, tokens: u.tokens
      });
    }

    if (url.pathname === '/api/upgrade/ladder/cashout' && req.method === 'POST') {
      if (!checkRateLimit(`ladder-cash:${u.id}`, 30, 60000)) {
        return send(429, { error: 'Слишком часто. Подождите минуту.' });
      }
      const sessionId = String(body.sessionId || '').trim();
      const clientKey = String(body.requestId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
        return send(400, { error: 'Некорректный идентификатор запроса' });
      }
      const requestId = `LADCASH_${u.id}_${clientKey}`;
      let res;
      try {
        res = db.atomicLadderCashout({ requestId, sessionId, userId: u.id });
      } catch (e) {
        console.error('[Ladder] cashout failed:', e.message);
        return send(500, { error: 'Не удалось забрать выигрыш, повторите позже' });
      }
      if (!res.ok) return send(400, { error: res.error || 'Не удалось забрать выигрыш' });
      u.tokens = Number(res.balanceAfter);   // ledger-ok: записано в БД атомарной транзакцией
      try { db.saveUser(u); } catch (e) { console.error('saveUser (ladder cashout):', e.message); }
      const updated = db.getLadderSession(sessionId, u.id);
      return send(200, {
        ok: true, duplicate: Boolean(res.duplicate), result: res.result,
        session: updated, tokens: u.tokens
      });
    }

    if (url.pathname === '/api/upgrade/ladder/state' && req.method === 'POST') {
      const sessionId = String(body.sessionId || '').trim();
      const session = sessionId
        ? db.getLadderSession(sessionId, u.id)
        : db.getActiveLadder(u.id);
      if (!session) return send(200, { ok: true, session: null, tokens: u.tokens });
      const mode = upgrade.getMode(session.mode);
      const preview = mode ? upgrade.ladderPreview(mode, session.stepsTotal, session.sourceValue) : null;
      return send(200, { ok: true, session, preview, tokens: u.tokens });
    }

    if (url.pathname === '/api/upgrade/history' && req.method === 'POST') {
      return send(200, {
        ok: true,
        history: db.getUpgradeHistory(u.id, Math.min(50, Math.max(1, Number(body.limit) || 20))),
        tokens: u.tokens
      });
    }

    /* Синхронизация баланса (строго READ-ONLY: клиент не может устанавливать баланс напрямую) */
    if (url.pathname === '/api/sync-balance') {
      return send(200, { ok: true, tokens: u.tokens });
    }

    /* ── Скретч-карты: «Сотри монеткой» ─────────────────────────────────────── */
    if (url.pathname === '/api/scratch/play' && req.method === 'POST') {
      if (!checkRateLimit(`scratch:${u.id}`, 60, 60000)) return send(429, { error: 'Слишком часто. Играйте чуть медленнее.' });
      const bet = Math.max(10, Math.floor(Number(body.bet) || 20));
      const withInsurance = Boolean(body.insurance);
      const cost = withInsurance ? Math.floor(bet * 1.15) : bet;
      // Баланс проверяет atomicScratchPlay внутри транзакции: повтор с тем же
      // requestId должен вернуть кэш даже при изменившемся балансе.

      const clientKey = String(body.requestId || '').trim();
      const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(clientKey)
        ? `SCR_${u.id}_${clientKey}`
        : `SCR_${u.id}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
      const roundId = requestId;

      const SYMBOLS = [
        { id: 'knife', name: 'Керамбит', mult: 50, weight: 1 },
        { id: 'gold',  name: 'Золото',   mult: 20, weight: 3 },
        { id: 'ruby',  name: 'Рубин',    mult: 10, weight: 6 },
        { id: 'chip',  name: 'Фишка',    mult: 5,  weight: 15 },
        { id: 'coin',  name: 'Монета',   mult: 2,  weight: 35 },
        { id: 'star',  name: 'Звезда',   mult: 1.5, weight: 40 }
      ];

      // Раньше стояло 0.37 — при среднем множителе выплаты 3.75 это возврат игроку ≈ 139%,
      // т.е. игрок стабильно зарабатывал. Держим возврат игроку = winChance * avgMult ≈ 93.75%
      // (winChance 0.25 × 3.75), как и было задумано комментарием ниже.
      const baseWin = rnd01() < 0.25;
      const willWin = boost.triggers(playerLuck(u.id), rnd01()) || baseWin;
      const grid = new Array(9).fill(null);
      let wonSymbol = null;
      let winTokens = 0;
      let winMult = 0;

      if (willWin) {
        // Выбираем выигрышный символ с учетом весов
        const totalWeight = SYMBOLS.reduce((s, x) => s + x.weight, 0);
        let roll = rnd01() * totalWeight;
        for (const s of SYMBOLS) {
          if (roll < s.weight) { wonSymbol = s; break; }
          roll -= s.weight;
        }
        if (!wonSymbol) wonSymbol = SYMBOLS[SYMBOLS.length - 1];

        winMult = wonSymbol.mult;
        winTokens = Math.floor(bet * winMult);

        // Ставим выигрышный символ ровно в 3 случайные позиции (крипто-перемешивание)
        const positions = [0, 1, 2, 3, 4, 5, 6, 7, 8];
        for (let i = positions.length - 1; i > 0; i--) {
          const j = rndInt(i + 1);
          [positions[i], positions[j]] = [positions[j], positions[i]];
        }
        positions.length = 3;
        positions.forEach(p => { grid[p] = wonSymbol.id; });

        // Заполняем остальные 6 ячеек случайными символами (не более 2 одинаковых)
        const counts = {};
        for (let i = 0; i < 9; i++) {
          if (grid[i]) continue;
          const candidates = SYMBOLS.filter(s => s.id !== wonSymbol.id && (counts[s.id] || 0) < 2);
          const pick = candidates[rndInt(candidates.length)] || SYMBOLS[SYMBOLS.length - 1];
          grid[i] = pick.id;
          counts[pick.id] = (counts[pick.id] || 0) + 1;
        }

      } else {
        // Проигрышная сетка: максимум 2 одинаковых символа (Near-miss!)
        const counts = {};
        for (let i = 0; i < 9; i++) {
          const candidates = SYMBOLS.filter(s => (counts[s.id] || 0) < 2);
          const pick = candidates[rndInt(candidates.length)] || SYMBOLS[rndInt(SYMBOLS.length)];
          grid[i] = pick.id;
          counts[pick.id] = (counts[pick.id] || 0) + 1;
        }
      }

      let insuredReturn = 0;
      if (!willWin && withInsurance) {
        // Возврат 20%, а не 35%: при winChance 0.25 и доплате +15% страховка с 35 %
        // давала игроку EV ≈ +5% за каждый билет (печатный станок). 0.20 держит EV ≈ −6.25%.
        insuredReturn = Math.floor(bet * 0.20);
      }

      // Списание билета, выигрыш, страховка и запись журнала — одной
      // транзакцией. Повтор с тем же requestId вернёт сохранённый результат.
      let played;
      try {
        played = db.atomicScratchPlay({
          requestId, userId: u.id, roundId, bet, cost, winTokens, winMult,
          insuredReturn, grid, won: willWin, winSymbol: wonSymbol ? wonSymbol.id : null
        });
      } catch (e) {
        console.error('[Scratch] play failed:', e.message);
        return send(500, { error: 'Не удалось провести розыгрыш, повторите позже' });
      }
      if (!played.ok) return send(400, { error: played.error || 'Не удалось купить билет' });

      u.tokens = Number(played.balanceAfter);   // ledger-ok: записано в БД атомарной транзакцией
      // Рейкбек начисляем только за реальный билет, не за повтор запроса.
      if (!played.duplicate) {
        u.rakeback = Math.round(((u.rakeback || 0) + (bet * 0.005)) * 100) / 100;
      }
      try { db.saveUser(u); } catch (_) {}
      const data = played.result || {};
      return send(200, {
        ok: true,
        duplicate: Boolean(played.duplicate),
        grid: data.grid || grid,
        won: Boolean(data.won),
        winSymbol: data.winSymbol || null,
        winMult: Number(data.winMult || 0),
        winTokens: Number(data.winTokens || 0),
        insuredReturn: Number(data.insuredReturn || 0),
        tokens: u.tokens
      });
    }

    /* ── Револьвер: Русская рулетка ─────────────────────────────────────────── */
    const REVOLVER_MULTS = { 1: 1.18, 2: 1.45, 3: 1.95, 4: 2.90, 5: 5.80, 6: 29.00 };

    function revolverState(rev) {
      if (!rev) return null;
      const mult = rev.step > 0 ? (REVOLVER_MULTS[rev.step] || 1.18) : 1;
      return {
        roundId: rev.roundId, step: rev.step, bet: rev.bet,
        mult, potWin: Math.floor(rev.bet * mult),
        insurance: Boolean(rev.insurance), balance: u.tokens
      };
    }

    if (url.pathname === '/api/revolver/state' && req.method === 'POST') {
      const rev = activeRevolvers.get(u.id);
      return send(200, { ok: true, active: Boolean(rev), state: revolverState(rev), balance: u.tokens });
    }

    if (url.pathname === '/api/revolver/start' && req.method === 'POST') {
      if (!checkRateLimit(`revolver:${u.id}`, 30, 60000)) return send(429, { error: 'Слишком часто. Подождите минуту.' });
      const clientKey = String(body.requestId || '').trim();
      const existing = activeRevolvers.get(u.id);
      if (existing) {
        // Повтор того же старта после тайм-аута — отдаём тот же раунд.
        if (clientKey && existing.startReq === clientKey) {
          return send(200, { ok: true, duplicate: true, ...revolverState(existing) });
        }
        return send(409, {
          error: 'У вас уже есть активный раунд. Завершите его или сделайте кэшаут.',
          state: revolverState(existing)
        });
      }

      const bet = Math.max(10, Math.floor(Number(body.bet) || 20));
      if (bet > 50000) return send(400, { error: `Максимальная ставка — ${rub(50000)}` });
      const withInsurance = Boolean(body.insurance);
      const cost = withInsurance ? Math.floor(bet * 1.15) : bet;
      if (Math.floor(u.tokens || 0) < cost) return send(400, { error: `Недостаточно средств (нужно ${rub(cost)})` });

      const roundId = 'REV_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
      // Claim до списания: два параллельных старта не создадут два раунда.
      if (!db.claimRound({ roundId, userId: u.id, game: 'Револьвер', bet })) {
        return send(400, { error: 'Не удалось начать раунд, попробуйте ещё раз' });
      }
      const debit = applyBalance(u, -cost, 'revolver_start', `Револьвер · Ставка (${rub(bet)}${withInsurance ? ' + страховка 15%' : ''})`, roundId);
      if (!debit.ok) {
        db.releaseRoundClaim(roundId, u.id);
        return send(400, { error: 'Не удалось списать ставку' });
      }

      // Заряжаем револьвер: 1 случайная камора из 6 боевая.
      // Буст ставит пулю в последнюю камору — первые пять спусков безопасны.
      let bullet = crypto.randomInt(1, 7);
      if (boost.triggers(playerLuck(u.id), rnd01())) bullet = 6;
      const rev = {
        roundId, bet, bullet, step: 0, insurance: withInsurance, createdAt: Date.now(),
        startReq: clientKey || null, processed: new Map()
      };
      activeRevolvers.set(u.id, rev);
      return send(200, { ok: true, ...revolverState(rev) });
    }

    if (url.pathname === '/api/revolver/trigger' && req.method === 'POST') {
      if (!checkRateLimit(`revolver-act:${u.id}`, 90, 60000)) return send(429, { error: 'Слишком часто. Подождите минуту.' });
      const rev = activeRevolvers.get(u.id);
      if (!rev) return send(400, { error: 'Нет активного раунда в Револьвере' });
      const clientKey = String(body.requestId || '').trim();
      if (clientKey && rev.processed.has('t:' + clientKey)) {
        return send(200, { ok: true, duplicate: true, ...rev.processed.get('t:' + clientKey) });
      }

      rev.step++;
      const isFired = (rev.step === rev.bullet);

      if (isFired) {
        // ВЫСТРЕЛ: проигрыш
        activeRevolvers.delete(u.id);
        let insuredReturn = 0;
        if (rev.insurance) {
          insuredReturn = Math.floor(rev.bet * 0.35);
          applyBalance(u, insuredReturn, 'insurance_refund', `🛡️ Страховка ставки: возврат 35% (+${rub(insuredReturn)})`, rev.roundId);
        }
        db.settleRound({ roundId: rev.roundId, userId: u.id, game: 'Револьвер', bet: rev.bet, mult: 0, win: 0, status: 'settled' });
        const out = { ok: true, fired: true, step: rev.step, bullet: rev.bullet, win: 0, insuredReturn, balance: u.tokens };
        if (clientKey) rev.processed.set('t:' + clientKey, out);
        return send(200, out);
      }

      // ХОЛОСТОЙ: осечка, игра продолжается
      const mult = REVOLVER_MULTS[rev.step] || 1.18;
      const potWin = Math.floor(rev.bet * mult);
      const out = { ok: true, fired: false, step: rev.step, mult, potWin, balance: u.tokens };
      if (clientKey) rev.processed.set('t:' + clientKey, out);
      return send(200, out);
    }

    if (url.pathname === '/api/revolver/cashout' && req.method === 'POST') {
      if (!checkRateLimit(`revolver-act:${u.id}`, 90, 60000)) return send(429, { error: 'Слишком часто. Подождите минуту.' });
      const rev = activeRevolvers.get(u.id);
      if (!rev) return send(400, { error: 'Нет активного раунда в Револьвере' });
      if (rev.step === 0) return send(400, { error: 'Сделайте хотя бы один спуск курка перед кэшаутом' });
      const clientKey = String(body.requestId || '').trim();
      if (clientKey && rev.processed.has('c:' + clientKey)) {
        return send(200, { ok: true, duplicate: true, ...rev.processed.get('c:' + clientKey) });
      }

      const mult = REVOLVER_MULTS[rev.step] || 1.18;
      const win = Math.floor(rev.bet * mult);
      activeRevolvers.delete(u.id);

      const paid = applyBalance(u, win, 'revolver_cashout', `Револьвер: кэшаут ×${mult} (+${rub(win)})`, rev.roundId);
      if (!paid.ok) {
        // Возвращаем состояние раунда: кэшаут не состоялся, игрок не теряет раунд.
        rev.processed.delete('c:' + clientKey);
        activeRevolvers.set(u.id, rev);
        return send(500, { error: 'Не удалось начислить выигрыш, повторите кэшаут' });
      }
      db.settleRound({ roundId: rev.roundId, userId: u.id, game: 'Револьвер', bet: rev.bet, mult, win, status: 'settled' });
      const out = { ok: true, win, mult, balance: u.tokens };
      if (clientKey) rev.processed.set('c:' + clientKey, out);
      return send(200, out);
    }

    /* ── Взлом Сейфа: Crack the Safe ────────────────────────────────────────── */
    if (url.pathname === '/api/safe/status' && req.method === 'POST') {
      if (!checkRateLimit(`safe-status:${u.id}`, 60, 60000)) return send(429, { error: 'Слишком много запросов. Подождите минуту.' });
      const data = db.getSafeData(u.id);
      return send(200, { ok: true, ...data, cost: 25, balance: u.tokens });
    }

    if (url.pathname === '/api/safe/guess' && req.method === 'POST') {
      if (!checkRateLimit(`safe:${u.id}`, 30, 60000)) return send(429, { error: 'Слишком часто. Попробуйте через минуту.' });
      const code = String(body.code || '').trim();
      if (!/^\d{4}$/.test(code)) return send(400, { error: 'Код должен состоять ровно из 4 цифр' });

      const cost = 25;
      // Баланс проверяется в atomicSafeGuess: повтор уже выполненной попытки
      // возвращает кэш, даже если баланс успел измениться.

      // requestId от клиента: повтор после тайм-аута вернёт тот же результат
      // и не спишет вторые 2,50 ₽. Без него сервер генерирует свой ключ.
      const clientKey = String(body.requestId || '').trim();
      const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(clientKey)
        ? `SAFE_${u.id}_${clientKey}`
        : `SAFE_${u.id}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

      let res;
      try {
        res = db.atomicSafeGuess(u.id, code, cost, requestId);
      } catch (e) {
        console.error('[Safe] guess failed:', e.message);
        return send(500, { error: 'Не удалось выполнить попытку, повторите позже' });
      }
      if (!res.ok) return send(400, { error: res.error || 'Не удалось выполнить попытку' });

      u.tokens = Number(res.balanceAfter);   // ledger-ok: записано в БД атомарной транзакцией
      try { db.saveUser(u); } catch (e) { console.error('saveUser (safe):', e.message); }
      const data = res.result || {};
      if (!res.duplicate && data.won && ADMIN_ID) {
        bot.api.sendMessage(ADMIN_ID, `🔓 <b>ИГРОК ВЗЛОМАЛ СЕЙФ!</b>\nПользователь ID: ${u.id}\nКод: ${code}\nКуш: <b>${rub(data.winTokens)}</b>!`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return send(200, {
        ok: true,
        duplicate: Boolean(res.duplicate),
        code,
        won: Boolean(data.won),
        bulls: Number(data.bulls || 0),
        cows: Number(data.cows || 0),
        winTokens: Number(data.winTokens || 0),
        jackpot: Number(data.jackpot || 0),
        guessesCount: Number(data.guessesCount || 0),
        balance: u.tokens
      });
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
      await expireDepositOrder(ord);
      const expiresAt = orderExpiresAt(ord);
      return send(200, {
        status: ord.status, tokens: ord.tokens, rub: ord.rub, balance: u.tokens,
        expiresAt, ttlMs: DEPOSIT_TTL_MS,
        remainingMs: expiresAt ? Math.max(0, expiresAt - Date.now()) : 0
      });
    }

    /* Мои заявки: статус и срок для профиля в мини-аппе */
    if (url.pathname === '/api/my-orders' && req.method === 'POST') {
      await sweepExpiredDeposits();
      const now = Date.now();
      const ordersList = db.listUserOrders(u.id, 12).map(o => {
        const type = o.type || 'deposit';
        const expiresAt = type === 'withdraw' ? 0 : Number(o.expires_at || 0);
        return {
          id: String(o.id),
          type,
          rub: Number(o.rub) || 0,
          tokens: Number(o.tokens) || 0,
          status: o.status || 'pending',
          method: o.method || o.bank || o.source || '',
          createdAt: Number(o.created_at) || 0,
          updatedAt: Number(o.updated_at) || 0,
          expiresAt,
          remainingMs: expiresAt ? Math.max(0, expiresAt - now) : 0
        };
      });
      return send(200, { ok: true, now, ttlMs: DEPOSIT_TTL_MS, orders: ordersList });
    }

    /* АДМИН-ПАНЕЛЬ: строго только для владельца (isAdmin) */
    if (url.pathname === '/api/admin/metrics' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      const period = String(body.period || 'all');
      return send(200, db.getAdminMetrics(period));
    }

        if (url.pathname === '/api/admin/overview' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      await sweepExpiredDeposits();
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
          bonus: o.bonus || '',
          method: o.method || o.bank || o.source || 'СБП / Карта',
          details: o.details || o.card || '',
          status: o.status,
          createdAt: o.created_at || o.createdAt || Date.now(),
          expiresAt: Number(o.expires_at || o.expiresAt || 0)
        };
      }).slice(0, 300);

      const period = String(body.period || 'all');
      return send(200, {
        ok: true,
        deposits: allOrders.filter(x => x.type !== 'withdraw').slice(0, 150),
        withdrawals: allOrders.filter(x => x.type === 'withdraw').slice(0, 150),
        adminMetrics: db.getAdminMetrics(period),
        stats12h: betsMonitor.getAnalytics(12),
        stats24h: betsMonitor.getAnalytics(24),
        statsAll: betsMonitor.getAnalytics(0),
        ledger: db.listRecentLedger(300),
        rounds: db.listRecentRounds(200),
      });
    }

    if (url.pathname === '/api/admin/order-action' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      const res = await processOrderAction(body.orderId, body.action);
      if (!res.ok) return send(400, { error: res.error });
      return send(200, res);
    }

    /* Персональный буст дропа: 0..100% удачи для конкретного игрока.
       Настройка видна только владельцу и не отдаётся клиенту в игровых ответах. */
    if (url.pathname === '/api/admin/luck/list' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      return send(200, { ok: true, boosts: db.listPlayerBoosts(100) });
    }

    if (url.pathname === '/api/admin/luck/search' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      const query = String(body.query || '').trim();
      if (query.length < 1 || query.length > 64) {
        return send(400, { error: 'Введите ID, @username или имя игрока' });
      }
      const found = db.searchUsersForAdmin(query, 10);
      const luckByUser = new Map(db.listPlayerBoosts(100).map(b => [b.userId, b.luck]));
      return send(200, {
        ok: true,
        users: found.map(x => ({ ...x, luck: luckByUser.get(x.id) || 0 }))
      });
    }

    if (url.pathname === '/api/admin/luck/set' && req.method === 'POST') {
      if (!isAdmin(tgUser)) return send(403, { error: '⛔ Доступ запрещён: только для администратора' });
      const userId = Math.floor(Number(body.userId) || 0);
      const luck = Math.round(Number(body.luck));
      if (!Number.isFinite(userId) || userId <= 0) return send(400, { error: 'Некорректный ID игрока' });
      if (!Number.isFinite(luck) || luck < 0 || luck > 100) {
        return send(400, { error: 'Удача должна быть от 0 до 100%' });
      }
      const target = db.getUser(userId);
      if (!target) return send(404, { error: 'Игрок не найден' });
      const res = db.setPlayerBoost(userId, luck);
      if (!res.ok) return send(500, { error: res.error || 'Не удалось сохранить буст' });
      console.log(`[Admin] буст ${res.luck}% выдан игроку ${userId}`);
      return send(200, {
        ok: true,
        luck: res.luck,
        user: { id: target.id, numId: target.numId, name: target.name, username: target.username }
      });
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

    /* Кэшбэк от последнего пополнения с учётом VIP-ранга (24ч кулдаун) */
    if (url.pathname === '/api/claim-cashback' && req.method === 'POST') {
      if (!checkRateLimit(`claim-cashback:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много запросов кэшбэка. Подождите минуту.' });
      const lastDepRub = Math.max(0, Number(u.lastDeposit) || 0);
      if (lastDepRub <= 0) {
        return send(400, { error: 'У вас ещё нет подтверждённых пополнений' });
      }
      const currentDepId = Number(u.lastDepositId) || 1;
      if (u.cashbackClaimedDepositId && u.cashbackClaimedDepositId === currentDepId) {
        return send(400, { error: 'Кэшбэк с последнего пополнения уже получен' });
      }
      const DAY_MS = 24 * 3600 * 1000;
      const now = Date.now();
      if (u.lastCashbackAt && (now - u.lastCashbackAt < DAY_MS)) {
        const hoursLeft = Math.ceil((DAY_MS - (now - u.lastCashbackAt)) / (3600 * 1000));
        return send(400, { error: `Кэшбэк доступен раз в 24 часа. Осталось ждать: ~${hoursLeft} ч.` });
      }

      // Расчет процента строго на сервере исходя из общей суммы депозитов (VIP-ранг)
      const totalDepRub = Math.max(lastDepRub, Number(u.totalDepositedRub) || 0);
      let cbPct = 2.0;
      if (totalDepRub >= 15000) cbPct = 10.0;
      else if (totalDepRub >= 5000) cbPct = 7.5;
      else if (totalDepRub >= 2000) cbPct = 5.0;
      else if (totalDepRub >= 500) cbPct = 3.5;

      const lastDepTk = lastDepRub * 10;
      const cashback = Math.max(1, Math.round(lastDepTk * (cbPct / 100)));
      const opId = 'cb_' + u.id + '_' + currentDepId;
      const r = applyBalance(u, cashback, 'bonus_cashback', `Кэшбэк ${cbPct}% за пополнение ${lastDepRub} ₽`, opId);
      if (!r.ok) return send(500, { error: 'Не удалось начислить кэшбэк, попробуйте позже' });

      u.cashbackClaimedDepositId = currentDepId;
      u.lastCashbackAt = now;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (cashback):', e.message); }
      return send(200, { success: true, cashback, tokens: u.tokens, cbPct });
    }

    /* Заявка на вывод средств (минимум 300 ₽ = 3000 токенов + обязательный депозит) */
    if (url.pathname === '/api/withdraw' && req.method === 'POST') {
      if (!checkRateLimit(`wd:${u.id}`, 5, 60000)) {
        return send(429, { error: 'Слишком много запросов на вывод. Попробуйте через минуту.' });
      }
      const rubAmt = Math.floor(Number(body.rub || 0));
      const method = String(body.method || 'СБП / Карта').trim();
      const details = String(body.details || '').trim();
      const uLabel = tgUser.username ? '@' + tgUser.username : (u.name || 'ID ' + u.id);
      const userDep = u.totalDepositedRub || u.lastDeposit || 0;

      if (isNaN(rubAmt) || rubAmt < 300) {
        return send(400, { error: 'Минимальная сумма вывода — 300 ₽' });
      }

      // АНТИЧИТ: запрещаем вывод средств игрокам с 0 ₽ пополнений!
      if (userDep <= 0 && !isAdmin(tgUser)) {
        betsMonitor.flagSuspicious({
          userId: u.id,
          name: uLabel,
          reason: 'Попытка вывода без депозитов (0 ₽)',
          details: `запросил ${rubAmt} ₽ на ${details}`
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
            `├ Попытался вывести: <b>${rubAmt} ₽</b>\n` +
            `├ Реквизиты: <code>${escHtml(details)}</code>\n` +
            `└ Накрученный баланс сброшен до ${rub(u.tokens)}.\n\n` +
            dossier,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
        return send(400, {
          error: 'Для вывода средств необходим хотя бы один подтверждённый депозит на аккаунте (верификация платёжных реквизитов).',
          remaining: u.tokens
        });
      }

      const neededTokens = rubAmt * TOKENS_PER_RUB;
      if (u.tokens < neededTokens) {
        return send(400, { error: `Недостаточно средств. Для вывода нужно ${rub(neededTokens)}, у вас ${rub(u.tokens)}` });
      }
      if (!details || details.length < 3) {
        return send(400, { error: 'Укажите корректные реквизиты для вывода (номер карты, телефон СБП или кошелёк)' });
      }

      // Списание ровно один раз; при сбое записи заявку НЕ создаём
      const wr = applyBalance(u, -neededTokens, 'withdraw', `Заявка на вывод ${rubAmt} ₽ на ${details}`);
      if (!wr.ok) return send(500, { error: 'Не удалось списать баланс, попробуйте позже' });
      const orderId = 'WD' + crypto.randomBytes(16).toString('hex').toUpperCase();
      const wdOrder = {
        id: orderId,
        type: 'withdraw',
        userId: u.id,
        rub: rubAmt,
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
          `├ Сумма: <b>${rubAmt} ₽</b>\n` +
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
        rub: rubAmt,
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
      // Баланс приглашённых рефереру не показываем — только имена.
      const invited = [...users.values()].filter(x => Number(x.ref) === u.id).map(x => ({ name: x.name }));
      const qualified = db.getQualifiedFriendsCount ? db.getQualifiedFriendsCount(u.id) : 0;
      return send(200, {
        code: u.code, link: refLink(u.code), invited: countInvited(u.id),
        qualified, earned: Math.round(u.refEarned || 0),
        freeCase5RefClaimed: Number(u.freeCase5RefClaimed || 0),
        percent: REF_PERCENT, list: invited
      });
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
      const win = boost.triggers(playerLuck(u.id), rnd01())
        ? rewards[rewards.length - 1]
        : rewards[rndInt(rewards.length)];
      const r = applyBalance(u, win, 'bonus_hotdrop', 'Hot Drop');
      if (!r.ok) return send(500, { error: 'Не удалось начислить награду, попробуйте позже' });
      u.lastHotDrop = now;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (hotdrop):', e.message); }
      return send(200, { ok: true, reward: win, balance: u.tokens });
    }

    /* Бесплатный спин в Колесе Фортуны (раз в 12 часов) */
    if (url.pathname === '/api/claim-wheel' && req.method === 'POST') {
      if (!checkRateLimit(`claim-wheel:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много запросов. Подождите минуту.' });
      const now = Date.now();
      const COOLDOWN = 12 * 3600 * 1000;
      u.lastWheelSpin = u.lastWheelSpin || 0;
      if (now - u.lastWheelSpin < COOLDOWN) {
        const leftSec = Math.ceil((COOLDOWN - (now - u.lastWheelSpin)) / 1000);
        const leftM = Math.ceil(leftSec / 60);
        return send(400, { error: `Колесо перезаряжается. Подождите ${leftM} мин.` });
      }
      const depRub = u.totalDepositedRub || u.lastDeposit || 0;
      let targetIdx = 0;
      const rand = rnd01();
      if (depRub <= 0) {
        targetIdx = (rand < 0.65) ? ((rnd01() < 0.5) ? 0 : 6) : ((rnd01() < 0.5) ? 1 : 4);
      } else {
        if (rand < 0.45) targetIdx = (rnd01() < 0.5) ? 0 : 6;
        else if (rand < 0.82) targetIdx = (rnd01() < 0.5) ? 1 : 4;
        else if (rand < 0.94) targetIdx = 2;
        else if (rand < 0.99) targetIdx = 3;
        else targetIdx = 5;
      }
      // Буст не поднимает бездепозитного игрока выше доступных ему секторов.
      if (depRub > 0 && boost.triggers(playerLuck(u.id), rnd01())) targetIdx = 7;
      const WHEEL_PRIZES = [25, 50, 100, 250, 50, 500, 25, 1000];
      const prize = WHEEL_PRIZES[targetIdx] || 25;
      const r = applyBalance(u, prize, 'bonus_wheel', 'Колесо Фортуны');
      if (!r.ok) return send(500, { error: 'Не удалось начислить награду' });
      u.lastWheelSpin = now;
      try { db.saveUser(u); } catch (e) { console.error('saveUser (wheel):', e.message); }
      return send(200, { ok: true, prize, targetIdx, balance: u.tokens });
    }

    /* Награды за челленджи и ежедневный стрик.
       Сервер — источник истины: сумму квеста берём из собственного списка, а не из
       тела запроса, и делаем клейм идемпотентным (одна выплата на квест в сутки).
       Раньше `amount` полностью управлялся клиентом, а кулдаун был только у стрика —
       это позволяло рисовать награды из воздуха бесконечным числом запросов. */
    if (url.pathname === '/api/claim-challenge' && req.method === 'POST') {
      if (!checkRateLimit(`claim-ch:${u.id}`, 20, 60000)) return send(429, { error: 'Слишком много запросов. Подождите минуту.' });
      const type = String(body.type || 'quest');
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10); // UTC-сутки
      const dayStart = Date.parse(day + 'T00:00:00.000Z');

      if (type === 'streak') {
        const last = Number(u.lastStreakAt || 0);
        if (last && now - last < 20 * 3600 * 1000) {
          return send(400, { error: 'Стрик-бонус уже получен. Возвращайтесь позже.' });
        }
        // Номер дня и сумма — только серверные. Клиентский amount игнорируется.
        const dayNo = last && now - last <= 48 * 3600 * 1000
          ? Math.min(7, Math.max(1, Number(u.streakDay || 1)) + 1)
          : 1;
        const amt = STREAK_REWARDS[dayNo - 1];
        const r = applyBalance(u, amt, 'bonus_challenge', `Ежедневный стрик · день ${dayNo}`);
        if (!r.ok) return send(500, { error: 'Не удалось начислить награду' });
        u.lastStreakAt = now;
        u.streakDay = dayNo;
        try { db.saveUser(u); } catch (_) {}
        return send(200, { ok: true, amount: amt, streakDay: dayNo, balance: u.tokens });
      }

      // Квесты: сервер проверяет, что действие реально было сегодня.
      const questId = String(body.questId || '');
      const amt = QUEST_REWARDS[questId];
      if (!amt) return send(400, { error: 'Неизвестный квест' });
      const st = db.getChallengeStatus(u.id, day, dayStart);
      if (questId === 'q1' && st.racketWins < 3) {
        return send(400, { error: 'Сначала сделайте 3 успешных кэшаута в Ракетке.' });
      }
      if (questId === 'q2' && st.bets < 1) {
        return send(400, { error: 'Сначала сделайте хотя бы одну ставку в игре.' });
      }
      if (questId === 'q3' && Number(u.lastHotDrop || 0) < dayStart) {
        return send(400, { error: 'Сначала заберите Hot Drop.' });
      }
      if (!db.tryClaimChallenge(u.id, questId, day)) {
        return send(400, { error: 'Награда за этот квест уже получена' });
      }
      const r = applyBalance(u, amt, 'bonus_challenge', `Челлендж 24ч · ${questId}`);
      if (!r.ok) return send(500, { error: 'Не удалось начислить награду' });
      try { db.saveUser(u); } catch (_) {}
      return send(200, { ok: true, amount: amt, questId, balance: u.tokens });
    }

    /* оплата: требуется принятое соглашение */
    if (url.pathname === '/api/invoice' && req.method === 'POST') {
      if (!checkRateLimit(`invoice:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много счетов. Подождите минуту.' });
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || 0));
      // Единый минимум пополнения 50 ₽ действует и для Stars: иначе через
      // прямой вызов API можно было пополнить на 1 ₽ в обход правила.
      if (tokens < 50 * TOKENS_PER_RUB) {
        return send(400, { error: 'Минимальная сумма пополнения — 50 ₽' });
      }
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
        message: `Зачислено +${rub(res.tokens)} по промокоду «${res.code}»`
      });
    }
    if (url.pathname === '/api/platega-invoice' && req.method === 'POST') {
      if (!checkRateLimit(`invoice:${u.id}`, 10, 60000)) return send(429, { error: 'Слишком много счетов. Подождите минуту.' });
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      if (!plategaOn()) return send(503, { error: 'Platega не настроена' });
      const rub = Math.max(0, Math.floor(Number(body.rub) || 0));
      if (rub < 50) return send(400, { error: 'Минимальная сумма пополнения — 50 ₽' });
      const baseTokens = Math.floor(rub * TOKENS_PER_RUB);
      const isEligible = (!u.totalDepositedRub || u.totalDepositedRub <= 0) &&
                         (!u.lastDeposit || u.lastDeposit <= 0) &&
                         !u.firstDepositBonusClaimed;
      const wantsBonus25 = String(body.bonus || '') === '25';
      const willGetBonus25 = wantsBonus25 && isEligible;
      const bonusTokens = willGetBonus25 ? Math.floor(baseTokens * 0.25) : 0;
      const tokens = baseTokens + bonusTokens;
      try {
        return send(200, await plategaCreate(u, rub, tokens, tgUser.first_name, {
          bonus: willGetBonus25 ? '25' : '',
          baseTokens,
          bonusTokens
        }));
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
      const rub = Math.max(0, Math.floor(Number(body.rub) || 0));
      if (rub < 50) return send(400, { error: 'Минимальная сумма пополнения — 50 ₽' });
      const baseTokens = Math.floor(rub * TOKENS_PER_RUB);
      const isEligible = (!u.totalDepositedRub || u.totalDepositedRub <= 0) &&
                         (!u.lastDeposit || u.lastDeposit <= 0) &&
                         !u.firstDepositBonusClaimed;
      const wantsBonus25 = String(body.bonus || '') === '25';
      const willGetBonus25 = wantsBonus25 && isEligible;
      const bonusTokens = willGetBonus25 ? Math.floor(baseTokens * 0.25) : 0;
      const tokens = baseTokens + bonusTokens;
      try {
        const inv = await createCoinsoInvoice(u.id, tokens, rub, {
          bonus: willGetBonus25 ? '25' : '',
          baseTokens,
          bonusTokens
        });
        return send(200, inv);
      } catch (e) {
        return send(500, { error: String(e.message || e), tokens });
      }
    }
    if (url.pathname === '/api/check-coinso' && req.method === 'POST') {
      if (!checkRateLimit(`check-pay:${u.id}`, 90, 60000)) return send(429, { error: 'Слишком много проверок оплаты. Подождите минуту.' });
      // Чужой счёт нельзя ни проверить, ни «дёрнуть» на зачисление.
      const [ordKey, savedOrder] = findCoinsoOrder(String(body.order_id || ''), String(body.invoice_id || ''));
      if (savedOrder && Number(savedOrder.userId) !== Number(u.id)) {
        return send(404, { error: 'Заявка не найдена' });
      }
      const r = await checkCoinsoInvoice(body.invoice_id, body.order_id);
      return send(200, { ...r, balance: u.tokens, staked: u.staked });
    }
    if (url.pathname === '/api/order-sbp' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      if (!checkRateLimit(`order-sbp:${u.id}`, 10, 60000)) {
        return send(429, { error: 'Слишком много заявок на пополнение. Подождите минуту.' });
      }
      const rubAmt = Math.max(0, Math.floor(Number(body.rub) || 0));
      if (rubAmt < 50) return send(400, { error: 'Минимальная сумма пополнения — 50 ₽' });
      const baseTokens = Math.floor(rubAmt * TOKENS_PER_RUB);
      const isEligible = (!u.totalDepositedRub || u.totalDepositedRub <= 0) &&
                         (!u.lastDeposit || u.lastDeposit <= 0) &&
                         !u.firstDepositBonusClaimed;
      const wantsBonus25 = String(body.bonus || '') === '25';
      const willGetBonus25 = wantsBonus25 && isEligible;
      const bonusTokens = willGetBonus25 ? Math.floor(baseTokens * 0.25) : 0;
      const tokens = baseTokens + bonusTokens;
      const id = 'SBP_' + crypto.randomBytes(16).toString('hex');
      const bank = String(body.bank || 'СБП / Карта').trim();
      const card = String(body.card || '').trim();
      const sender = String(body.sender || '').trim();
      const newOrder = {
        id,
        type: 'deposit',
        userId: u.id,
        tokens,
        baseTokens,
        bonusTokens,
        rub: rubAmt,
        bank,
        card,
        sender,
        status: 'pending',
        source: 'СБП / Карта',
        bonus: willGetBonus25 ? '25' : '',
        createdAt: Date.now(),
        expiresAt: Date.now() + DEPOSIT_TTL_MS
      };
      setOrder(id, newOrder);
      if (ADMIN_ID) {
        const uLabel = tgUser.username ? `@${tgUser.username}` : (tgUser.first_name || `ID ${u.id}`);
        const bonusTagText = willGetBonus25 ? ` (+${rub(bonusTokens)} бонус +25% на 1-й деп)` : '';
        const payUntil = new Date(newOrder.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const msg =
          `💳 <b>Новая заявка на пополнение №${escHtml(id)}</b>\n` +
          `├ Пользователь: <b>${escHtml(uLabel)}</b> (ID: <code>${u.id}</code>)\n` +
          `├ Сумма: <b>${rubAmt} ₽</b> (к зачислению: <b>+${rub(tokens)}</b>${bonusTagText})\n` +
          `├ Способ / Банк: <b>${escHtml(bank)}</b>\n` +
          (card ? `├ Реквизит: <code>${escHtml(card)}</code>\n` : '') +
          (sender ? `├ Отправитель / примечание: <code>${escHtml(sender)}</code>\n` : '') +
          `├ Срок оплаты: <b>${DEPOSIT_TTL_TEXT}</b> (до ${payUntil})\n` +
          `└ Статус: <i>Ожидает подтверждения</i>`;
        const sent = await bot.api.sendMessage(ADMIN_ID, msg, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Подтвердить', 'ok:' + id)
            .text('❌ Отклонить', 'no:' + id)
        }).catch(e => console.error('Не удалось отправить админу заявку СБП:', e.message));
        if (sent && sent.message_id) {
          newOrder.adminMsgId = sent.message_id;
          newOrder.adminChatId = Number(ADMIN_ID) || 0;
          try { db.setOrderMessage(id, sent.message_id, Number(ADMIN_ID) || 0); } catch (_) {}
        }
      }
      return send(200, { order_id: id, tokens, rub: rubAmt, bonusApplied: willGetBonus25, expiresAt: newOrder.expiresAt, ttlMs: DEPOSIT_TTL_MS });
    }

    /* Уведомления пользователю в бот (ежедневный кейс / шкала челленджа) */
    if (url.pathname === '/api/notify-event' && req.method === 'POST') {
      if (!checkRateLimit(`notify:${u.id}`, 5, 60000)) return send(429, { error: 'Слишком много уведомлений. Подождите минуту.' });
      const type = String(body.type || '');
      let text = '';
      if (type === 'daily_ready') {
        text = `🎁 <b>Ваш ежедневный кейс готов к открытию!</b>\n\nЗаходите в MoneyForUp и забирайте бесплатный бонус дня! 🚀`;
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
    if (e && e.statusCode === 413) return send(413, { error: 'Слишком большой запрос' });
    send(500, { error: String(e.message || e) });
  }
});

async function initBotProfile() {
  if (process.env.BOT_DRY_RUN === '1' || !BOT_TOKEN) return false;
  try {
    const desc =
`🔥 MoneyForUp — игровая платформа, кейсы и стейкинг в Telegram!

Делай мани, ап-ап! 🚀

• 📦 Кейсы и дропы — скины и предметы
• 🚀 Ракетка 24/7 — успей забрать до взрыва
• 🍺 Скуф vs Альтушка, Dice, Колесо Фортуны
• 📈 Стейкинг 1 % в сутки с начислением каждую секунду
• 👥 Реферальная программа 15 % с пополнений
• 🎟 Промокоды и ежедневные бонусы

Жми «Старт» и забирай свой первый бонус! 👇`;

    const shortDesc = 'MoneyForUp — Делай мани, ап-ап! 🚀 Кейсы, Ракетка и стейкинг.';

    // Важно: в grammY bot.api.setMyDescription(description: string, other?: object).
    // Передача объекта { description: "..." } приводила к тому, что Telegram сохранял
    // описание буквально как JSON строку {"description":"..."} со скобками и \n.
    // Передаем чистую строку напрямую (для языка по умолчанию и для русского):
    await bot.api.setMyDescription(desc);
    await bot.api.setMyDescription(desc, { language_code: 'ru' });
    await bot.api.setMyShortDescription(shortDesc);
    await bot.api.setMyShortDescription(shortDesc, { language_code: 'ru' });
    console.log('[Telegram] Описание профиля бота успешно обновлено чистым текстом (без JSON-скобок)');
    return true;
  } catch (e) {
    console.warn('[Telegram] Не удалось обновить описание бота:', e.message);
    return false;
  }
}
initBotProfile();

/* Заявки на пополнение живут час: свип раз в 30 секунд плюс один прогон
   после старта, чтобы просроченные не висели в чате и в админке. */
setInterval(() => {
  sweepExpiredDeposits().catch(e => console.warn('[Orders] sweep:', e.message));
}, DEPOSIT_SWEEP_MS).unref();
setTimeout(() => {
  sweepExpiredDeposits().catch(e => console.warn('[Orders] sweep start:', e.message));
}, 5000).unref();

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

/* ── Мягкая реактивация: не чаще одного сообщения в 3 дня и только
   при реальном поводе (подарочный кейс или рейкбек). ─────────────────── */
async function runReactivation() {
  try {
    const now = Date.now();
    const list = db.listReactivationCandidates(now - 24 * 3600 * 1000, now - 3 * 86400 * 1000, 40);
    for (const cand of list) {
      let text = '';
      if (cand.freeCases > 0) {
        text = '🎁 <b>У вас ждёт подарочный кейс</b>\n\nОн уже начислен на аккаунт — заберите в MoneyForUp.';
      } else if (cand.rakeback >= 30) {
        text = `💰 <b>Рейкбек ${rub(cand.rakeback)} ждёт вас</b>\n\nЗаберите его в профиле: накопления не сгорают.`;
      }
      if (!text) continue;
      try {
        await bot.api.sendMessage(cand.id, text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp('🎮 Открыть MoneyForUp', APP_URL)
        });
        db.setReactivationAt(cand.id, now);
      } catch (_) { /* бот заблокирован — больше не пишем */ }
      await new Promise(r => setTimeout(r, 120));
    }
  } catch (e) {
    console.error('[Reactivation] error:', e.message);
  }
}
setTimeout(runReactivation, 120000);
setInterval(runReactivation, 6 * 3600 * 1000);

/* ── Уведомления о закончившихся кулдаунах ────────────────────────────────
   Пишем всем, у кого кд действительно истёк, даже если игрок сейчас в
   приложении. Дедупликация — по конкретному событию в БД. */
async function runCooldownNotifications() {
  try {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const list = db.listCooldownNotifyCandidates(now, day, 200);
    for (const cand of list) {
      const dailyReady = cand.free_daily_at > 0
        && now - cand.free_daily_at >= 86400000
        && cand.free_notified_at < cand.free_daily_at + 86400000;
      const wheelReady = cand.last_wheel_spin > 0
        && now - cand.last_wheel_spin >= 12 * 3600000
        && cand.free_notified_at < cand.last_wheel_spin + 12 * 3600000;
      const hotReady = cand.last_hot_drop > 0
        && now - cand.last_hot_drop >= 3600000
        && cand.free_notified_at < cand.last_hot_drop + 3600000;
      const challengeReady = String(cand.free_notify_day || '') !== day;

      const parts = [];
      if (dailyReady) parts.push('🎁 <b>Бесплатный кейс</b> снова доступен — от 1 до 6 ₽');
      if (wheelReady) parts.push('🎡 <b>Бесплатный спин</b> в Колесе Фортуны готов');
      if (hotReady) parts.push('🔥 <b>Hot Drop</b> снова можно забрать');
      if (challengeReady) parts.push('🎯 <b>Челленджи и стрик</b> обновились');
      if (!parts.length) continue;

      const name = escHtml(String(cand.name || cand.username || 'друг').slice(0, 40));
      const text = `<b>${name}, у вас есть бесплатное</b>\n\n`
        + parts.map(p => '• ' + p).join('\n')
        + '\n\nЗаберите в MoneyForUp, пока не сгорело.';
      const kb = new InlineKeyboard();
      if (dailyReady) kb.webApp('🎁 Бесплатный кейс', APP_URL + '#casehub');
      if (wheelReady) kb.webApp('🎡 Колесо Фортуны', APP_URL + '#games');
      if (!dailyReady && !wheelReady) kb.webApp('🎁 Открыть MoneyForUp', APP_URL + '#casehub');
      try {
        await bot.api.sendMessage(cand.id, text, {
          parse_mode: 'HTML',
          reply_markup: kb
        });
      } catch (_) { /* бот заблокирован — не зацикливаемся на повторах */ }
      db.setFreeNotified(cand.id, now, day);
      const mem = users.get(cand.id);
      if (mem) { mem.freeNotifiedAt = now; mem.freeNotifyDay = day; }
      await new Promise(r => setTimeout(r, 160));
    }
  } catch (e) {
    console.error('[Cooldowns] error:', e.message);
  }
}
setTimeout(runCooldownNotifications, 180000);
setInterval(runCooldownNotifications, 10 * 60 * 1000);

let recoveryReady = false;
async function initPersistence() {
  let pulled = false;
  if (db.tursoOn && db.tursoOn()) {
    try {
      const res = await db.pullFromTurso();
      if (res && res.ok) {
        pulled = true;
        reloadOrdersFromDb();
      }
    } catch (e) {
      console.error('[Turso] Ошибка восстановления данных при старте:', e.message);
    }
  }
  if (!db.tursoOn || !db.tursoOn() || pulled) {
    try {
      const purged = db.purgePromosExcept('WEEK42');
      if (purged && purged.removed && purged.removed.length) {
        console.log('[Promo] удалены лишние коды:', purged.removed.join(', '));
      }
    } catch (e) {
      console.error('[Promo] cleanup error:', e.message);
    }
  }
  recoverPendingGameRounds();
  recoveryReady = true;
}

/* ── Pulse: единый путь расчёта для API, свипа и восстановления ─────────── */
function pulseRoundFromRow(row, userId) {
  const p = row.params || {};
  const settled = row.status !== 'pending';
  const rd = {
    userId: Number(userId != null ? userId : row.user_id),
    seed: row.seed,
    startedAt: p.startedAt,
    dueAt: p.dueAt,
    direction: p.direction,
    leverage: p.leverage,
    duration: p.duration,
    bet: Number(row.bet_tokens) || 0,
    settled,
    settledAt: p.settledAt || row.settled_at || null
  };
  if (settled) {
    rd.result = {
      outcome: p.outcome != null ? p.outcome : null,
      move: p.move != null ? p.move : null,
      won: p.won != null ? !!p.won : Number(row.win_tokens) > 0,
      mult: p.mult != null ? Number(p.mult) : (Number(row.mult) || 0),
      payout: p.payout != null ? Number(p.payout) : (Number(row.win_tokens) || 0)
    };
  }
  return rd;
}

function ensurePulseRound(roundId, userId) {
  let rd = pulseRounds.get(roundId);
  if (rd) return rd;
  const row = db.getRoundParams(roundId, userId);
  if (!row || !row.seed || row.game !== pulse.PULSE.label) return null;
  rd = pulseRoundFromRow(row, userId);
  pulseRounds.set(roundId, rd);
  return rd;
}

/* Рассчитывает Pulse-раунд ровно один раз. Функция синхронная: проверка,
   выплата и запись в БД идут в одном тике событийного цикла, поэтому
   параллельные запросы не могут начислить выигрыш дважды. */
function settlePulseOnce(rd, roundId, opts = {}) {
  if (!rd) return { settled: false, error: 'Раунд не найден' };
  if (rd.settled) {
    const usr = users.get(rd.userId);
    return { settled: true, result: rd.result, tokens: usr ? usr.tokens : 0 };
  }
  if (!rd.seed) return { settled: false, error: 'Раунд повреждён' };
  if (Date.now() < (rd.dueAt || 0)) return { settled: false, early: true };

  const res = pulse.settle({
    seedHex: rd.seed, roundId, direction: rd.direction, leverage: rd.leverage, bet: rd.bet
  });
  rd.settled = true;
  rd.settledAt = Date.now();
  rd.result = {
    outcome: res.outcome, move: res.move, won: res.won,
    mult: res.won ? res.mult : 0, payout: res.payout
  };
  const uid = Number(rd.userId);
  const usr = users.get(uid) || user(uid, null, null);
  if (res.payout > 0) {
    const pr = applyBalance(usr, res.payout, 'pulse_win',
      `Pulse Market · выигрыш +${rub(res.payout)} (×${res.mult})`, roundId);
    if (!pr.ok) {
      rd.settled = false;
      rd.result = null;
      return { settled: false, error: 'Не удалось начислить выигрыш' };
    }
  }
  try {
    db.settleRound({
      roundId, userId: uid, game: pulse.PULSE.label, bet: rd.bet,
      mult: res.won ? res.mult : 0, win: res.payout, status: 'settled'
    });
    db.setRoundParams(roundId, uid, rd.seed, {
      direction: rd.direction, leverage: rd.leverage, duration: rd.duration,
      startedAt: rd.startedAt, dueAt: rd.dueAt,
      outcome: res.outcome, move: res.move, won: res.won,
      payout: res.payout, mult: res.won ? res.mult : 0,
      settledAt: rd.settledAt, auto: !!opts.auto
    });
    db.saveUser(usr);
  } catch (e) { console.error('[Pulse] settle not saved:', e.message); }
  return { settled: true, result: rd.result, tokens: usr.tokens };
}

/* Свип: закрывает брошенные раунды, даже если игрок больше не открыл игру.
   Pulse — по истечении таймера, Ракетка — в момент взрыва. */
function sweepUnfinishedRounds() {
  const now = Date.now();
  for (const [roundId, rd] of pulseRounds) {
    if (rd.settled) {
      if (rd.settledAt && now - rd.settledAt > 10 * 60 * 1000) pulseRounds.delete(roundId);
      continue;
    }
    if (now >= (rd.dueAt || 0)) settlePulseOnce(rd, roundId, { auto: true });
  }
  for (const [roundId, saved] of activeRacketBets) {
    if (!saved.cashed && !saved.settled) settleRacketLoss(roundId, saved);
  }
}
setInterval(() => {
  // До завершения pull из Turso не трогаем деньги: локальная БД ещё не полная.
  if (!recoveryReady) return;
  try { sweepUnfinishedRounds(); } catch (e) { console.error('[Sweep]', e.message); }
}, 10000).unref();

/* Восстановление после перезапуска сервера.
   Pulse: незавершённые раунды возвращаем в память; истёкшие сразу считаем.
   Racket: активные ставки возвращаем в память (кэшаут работает даже до
   открытия игры), взорвавшиеся закрываем проигрышем.
   Trend: сценарий в params; если ответа не было, ставка сгорает после дедлайна. */
function recoverPendingGameRounds() {
  try {
    let fixed = 0;
    const pending = db.listPendingGameRounds([pulse.PULSE.label, trend.TREND.label]);
    for (const row of pending) {
      const p = row.params || {};
      if (row.game === pulse.PULSE.label) {
        let rd = pulseRounds.get(row.round_id);
        if (!rd) {
          rd = pulseRoundFromRow(row, Number(row.user_id));
          pulseRounds.set(row.round_id, rd);
        }
        if (Date.now() >= (rd.dueAt || 0)) {
          if (settlePulseOnce(rd, row.round_id, { auto: true }).settled) fixed++;
        }
      } else if (row.game === trend.TREND.label) {
        // Закрываем только после дедлайна: до него игрок ещё может ответить.
        const deadline = (p.startedAt || 0) + (p.seconds || 0) * 1000;
        if (Date.now() <= deadline + 2000) continue;
        db.settleRound({
          roundId: row.round_id, userId: Number(row.user_id), game: row.game, bet: row.bet_tokens,
          mult: 0, win: 0, status: 'settled'
        });
        fixed++;
      }
    }

    const racketRows = db.listUnsettledGameRounds(['Ракетка'], ['active', 'pending'], Date.now() - 24 * 60 * 60 * 1000, 1000);
    for (const row of racketRows) {
      const p = row.params || {};
      const parsedIdx = Number(p.rIdx);
      const rIdx = Number.isFinite(parsedIdx) ? parsedIdx : racketRIdxFromRoundId(row.round_id);
      const uid = Number(row.user_id);
      const bet = Number(row.bet_tokens) || 0;
      if (rIdx == null) {
        const closed = db.settleRoundOnce({
          roundId: row.round_id, userId: uid, game: 'Ракетка', bet,
          mult: 0, win: 0, status: 'settled', settledAt: Date.now()
        });
        if (closed) {
          db.setRoundParams(row.round_id, uid, null, { autoClosed: true, settledAt: Date.now(), crash: null });
          fixed++;
        }
        continue;
      }
      const round = rememberRacketRound(rIdx, p.crash);
      const saved = {
        userId: uid, bet, rIdx, crash: round.crash,
        createdAt: row.created_at, cashed: false, settled: false
      };
      activeRacketBets.set(row.round_id, saved);
      if (settleRacketLoss(row.round_id, saved)) fixed++;
    }
    if (fixed) console.log(`[Recovery] закрыто зависших раундов: ${fixed}`);
  } catch (e) {
    console.error('[Recovery] не удалось восстановить раунды:', e.message);
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
