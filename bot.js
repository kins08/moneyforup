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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Bot, InlineKeyboard } = require('grammy');

const BOT_TOKEN     = process.env.BOT_TOKEN;
const APP_URL       = process.env.APP_URL || 'https://example.com/moneyforup-tg.html';
const API_PORT      = +(process.env.APP_PORT || process.env.API_PORT || 3000);
const ADMIN_ID      = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : 0;

/* Platega (карты РФ и СБП). Кабинет: platega.io → Настройки → API
   В ЛК укажите Callback URL: https://<бэкенд>/platega-webhook (только HTTPS, самоподписанные сертификаты не принимаются) */
const PLATEGA_MERCHANT_ID = process.env.PLATEGA_MERCHANT_ID || '';
const PLATEGA_SECRET      = process.env.PLATEGA_SECRET || '';
const PLATEGA_API         = process.env.PLATEGA_API || 'https://app.platega.io';

/* Heleket (криптовалюта). Документация: heleket.com */
const HELEKET_MERCHANT_ID = process.env.HELEKET_MERCHANT_ID || '';
const HELEKET_API_KEY     = process.env.HELEKET_API_KEY || '';
const HELEKET_API         = (process.env.HELEKET_API || 'https://api.heleket.com').replace(/\/+$/, '');
const heleketOn           = () => !!(HELEKET_MERCHANT_ID && HELEKET_API_KEY);
const heleketOrders       = new Map(); // uuid -> { orderId, userId, tokens, rub, status }

/* CryptoBot (Crypto Pay). Бот: @CryptoBot */
const CRYPTOBOT_TOKEN     = process.env.CRYPTOBOT_TOKEN || '';
const CRYPTOBOT_API       = (process.env.CRYPTOBOT_API || 'https://pay.crypt.bot').replace(/\/+$/, '');
const cryptobotOrders     = new Map(); // invoice_id -> { userId, tokens, rub, status }

/* Coinso (CryptoProc: Криптовалюта USDT, TON, BTC и др.). Кабинет: coinso.io → Настройки проекта → Интеграция */
const COINSO_PROJECT_ID = process.env.COINSO_PROJECT_ID || '';
const COINSO_API_KEY     = process.env.COINSO_API_KEY || '';
const COINSO_SECRET_KEY  = process.env.COINSO_SECRET_KEY || '';
const COINSO_API         = (process.env.COINSO_API || 'https://coinso.io/api').replace(/\/+$/, '');
const coinsoOrders       = new Map(); // orderId -> { userId, tokens, rub, invoice_id, credited }

/* Публичный адрес этого бэкенда (без слэша на конце) — для url_callback и вебхуков */
const PUBLIC_URL      = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const BOT_USERNAME    = (process.env.BOT_USERNAME || '').replace(/^@/, '');   // имя бота без @ (для реферальных ссылок)

const TOKENS_PER_RUB  = 10;     // 10 ⬦ = 1 ₽
const STARS_TO_TOKENS = 20;     // 1 звезда ≈ 2 ₽ ⇒ 20 ⬦
const START_TOKENS    = 50;
const STAKE_RATE      = 0.01;   // 1 % в сутки
const DAY_MS          = 86400000;
const REF_PERCENT     = 15;     // 15 % от пополнений приглашённых

const hasBotToken = Boolean(BOT_TOKEN && BOT_TOKEN.length > 20 && BOT_TOKEN.includes(':'));

let bot;
if (hasBotToken) {
  bot = new Bot(BOT_TOKEN);
} else {
  console.warn('Валидный BOT_TOKEN не задан. Telegram бот запущен в режиме заглушки (опрос Telegram отключён). Веб-интерфейс и API активны.');
  bot = {
    api: {
      sendMessage: async () => {},
      createInvoiceLink: async () => 'https://t.me/dummy_invoice',
      setMyDescription: async () => {},
      setMyShortDescription: async () => {}
    },
    command: () => {},
    callbackQuery: () => {},
    on: () => {},
    start: () => {}
  };
}

/* ------------------------------------------------------------------ */
/* Хранилище (демо). Заменить на Postgres/SQLite — см. README.md        */
/* ------------------------------------------------------------------ */
const users = new Map();    // id → { name, code, tokens, staked, stakeSince, accruedBase, ref, refEarned, refInvited, termsAt, starsUsd }
const byCode = new Map();   // реферальный код → id пользователя
const orders = new Map();   // orderId → { userId, tokens, rub, status, source }
const promoCodes = new Map(); // CODE -> { code, tokens, maxUses, usedBy: Set<userId>, createdAt }
const plategaTx = new Map(); // transactionId Platega → { userId, tokens, rub }
let orderSeq = 1;

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
    if (!byCode.has(code)) return code;
  }
  return 'MF' + Date.now().toString(36).toUpperCase().slice(-6);   // практический недостижимый фолбэк
}
/* start_param может быть кодом (MF...) или старым числовым id — поддерживаем оба */
function resolveRef(param) {
  const raw = String(param || '').trim();
  if (!raw) return 0;
  const byC = byCode.get(raw.toUpperCase());
  if (byC) return byC;
  const asId = Number(raw);
  return Number.isInteger(asId) && asId > 0 ? asId : 0;
}
function setRef(u, param) {
  const refId = resolveRef(param);
  if (!refId || refId === u.id || u.ref) return 0;      // самоприглашение и повторную привязку отсекаем
  u.ref = refId;
  const referrer = users.get(refId);
  if (referrer) referrer.refInvited = countInvited(referrer.id);
  return refId;
}

let nextPlayerId = 10000;

function user(id, name, username) {
  if (!users.has(id)) {
    const code = makeCode();
    const numId = nextPlayerId++;
    users.set(id, { id, numId, code, name: name || '', tokens: START_TOKENS, staked: 0, stakeSince: 0, accruedBase: 0,
                    ref: null, refEarned: 0, refInvited: 0, termsAt: 0, starsUsd: 0,
                    lastDeposit: 0, lastDepositId: 0, cashbackClaimedDepositId: 0, lastCashbackAt: 0,
                    easycashClaimed: false });
    byCode.set(code, id);
  }
  const u = users.get(id);
  if (!u.numId) {
    u.numId = nextPlayerId++;
  }
  if (name) u.name = name;
  if (username) u.username = username;      // @username из Telegram — для привязки профиля
  return u;
}

/* ------------------------------------------------------------------ */
/* Транзакционный журнал (Ledger), идемпотентность и блокировка      */
/* ------------------------------------------------------------------ */
const ledger = [];             // глобальный журнал транзакций
const userLedger = new Map();  // userId -> [tx, tx, ...]
const userLocks = new Map();   // userId -> Promise цепочки для взаимного исключения (mutex)
const idempotencyStore = new Map(); // key -> { status, body, createdAt }
const gameSessions = new Map(); // sessionId -> { sessionId, userId, game, bet, status, ... }

/* Атомарная блокировка по пользователю (защита от race condition и параллельных кликов) */
async function withUserLock(userId, fn) {
  const prev = userLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(r => release = r);
  userLocks.set(userId, prev.then(() => current));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (userLocks.get(userId) === current) userLocks.delete(userId);
  }
}

/* Запись транзакции в журнал для аудита и сверки баланса */
function recordTransaction(userId, type, reason, delta, balanceBefore, balanceAfter, meta = {}) {
  const id = 'TX_' + Date.now().toString(36).toUpperCase() + '_' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const entry = {
    id,
    userId,
    type,       // 'credit' | 'debit'
    reason,     // 'game_bet' | 'game_win' | 'game_refund' | 'deposit' | 'withdraw' | 'stake_add' | 'stake_claim' | 'stake_remove' | 'promo' | 'bonus'
    delta,
    balanceBefore,
    balanceAfter,
    meta,
    createdAt: Date.now()
  };
  ledger.push(entry);
  if (!userLedger.has(userId)) userLedger.set(userId, []);
  userLedger.get(userId).unshift(entry);
  if (userLedger.get(userId).length > 200) userLedger.get(userId).pop();
  return entry;
}

/* Атомарное изменение баланса пользователя с валидацией остатка и логированием */
function applyBalanceDelta(u, delta, reason, meta = {}) {
  delta = Math.round(Number(delta) || 0);
  if (delta === 0) return { ok: true, balance: u.tokens };
  if (delta < 0 && (u.tokens + delta < 0)) {
    return { ok: false, error: 'Недостаточно токенов на балансе', balance: u.tokens };
  }
  const before = u.tokens;
  u.tokens += delta;
  const after = u.tokens;
  const tx = recordTransaction(u.id, delta >= 0 ? 'credit' : 'debit', reason, delta, before, after, meta);
  return { ok: true, balance: u.tokens, tx };
}

/* Генератор серверного коэффициента для Ракетки с Provably Fair гарантией */
function sampleServerCrash() {
  const r = Math.random();
  if (r < 0.08) return 1.00;
  if (r < 0.14) return +(1.01 + ((r - 0.08) / 0.06) * 0.09).toFixed(2);
  if (r < 0.29) return +(1.10 + ((r - 0.14) / 0.15) * 0.20).toFixed(2);
  if (r < 0.53) return +(1.30 + ((r - 0.29) / 0.24) * 0.25).toFixed(2);
  if (r < 0.73) return +(1.55 + ((r - 0.53) / 0.20) * 0.20).toFixed(2);
  if (r < 0.79) return +(1.75 + ((r - 0.73) / 0.06) * 0.25).toFixed(2);
  if (r < 0.89) return +(2.00 + ((r - 0.79) / 0.10) * 0.30).toFixed(2);
  if (r < 0.98) return +(2.30 + ((r - 0.89) / 0.09) * 0.69).toFixed(2);
  const t0 = Math.log(3.5) / 0.18;
  const rLong = (r - 0.98) / 0.02;
  return +Math.exp(0.18 * (t0 + rLong * (12 - t0))).toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Стейкинг: 1 % в сутки, простые проценты, по секундам                */
/* ------------------------------------------------------------------ */
/* сколько пользователей реально пришли по ссылке этого игрока */
const countInvited = id => [...users.values()].filter(x => Number(x.ref) === Number(id)).length;

const stakeAccrued = u => (u.accruedBase || 0) +
  (u.staked > 0 && u.stakeSince ? u.staked * STAKE_RATE * Math.max(0, Date.now() - u.stakeSince) / DAY_MS : 0);

function stakeAdd(u, v) {
  v = Math.floor(Number(v) || 0);
  if (v <= 0) return { error: 'Сумма должна быть больше нуля' };
  if (v > u.tokens) return { error: 'Недостаточно токенов на балансе' };
  const before = u.tokens;
  u.accruedBase = stakeAccrued(u);          // сохраняем уже накопленное
  u.tokens -= v;
  u.staked += v;
  u.stakeSince = Date.now();
  recordTransaction(u.id, 'debit', 'stake_add', -v, before, u.tokens, { staked: u.staked });
  return { staked: u.staked, tokens: u.tokens, accrued: u.accruedBase };
}
function stakeClaim(u) {
  const acc = stakeAccrued(u);
  if (acc < 0.01) return { error: 'Пока нечего забирать' };
  const before = u.tokens;
  u.tokens += acc; u.accruedBase = 0; u.stakeSince = Date.now();
  recordTransaction(u.id, 'credit', 'stake_claim', acc, before, u.tokens, {});
  return { claimed: acc, tokens: u.tokens };
}
function stakeRemove(u, all) {
  const acc = stakeAccrued(u), body = u.staked;
  if (!body && acc < 0.01) return { error: 'Стейкинг пуст' };
  const take = all === false ? 0 : body;
  const before = u.tokens;
  u.tokens += take + acc;
  u.staked -= take;
  u.accruedBase = 0;
  u.stakeSince = u.staked ? Date.now() : 0;
  recordTransaction(u.id, 'credit', 'stake_remove', take + acc, before, u.tokens, { stakedReturned: take, accrued: acc });
  return { removed: take + acc, tokens: u.tokens, staked: u.staked };
}

/* ------------------------------------------------------------------ */
/* Пополнение + реферальные 15 %                                       */
/* ------------------------------------------------------------------ */
async function creditDeposit(userId, tokens, source) {
  const u = user(userId);
  const before = u.tokens;
  u.tokens += tokens;
  u.lastDeposit = Math.round(tokens / TOKENS_PER_RUB);
  u.lastDepositId = (u.lastDepositId || 0) + 1;
  recordTransaction(u.id, 'credit', 'deposit', tokens, before, u.tokens, { source });
  let refPaid = 0, refErr = null;
  const refId = Number(u.ref);
  if (refId) {
    const referrer = user(refId);                              // реферер мог ещё не открыть бота — создаём запись
    if (Number(u.ref) !== u.id) {                              // самоприглашение отсекаем
      refPaid = Math.floor(tokens * REF_PERCENT / 100);
      const refBefore = referrer.tokens;
      referrer.tokens += refPaid;
      referrer.refEarned = (referrer.refEarned || 0) + refPaid;
      referrer.refInvited = countInvited(referrer.id);
      recordTransaction(referrer.id, 'credit', 'referral_bonus', refPaid, refBefore, referrer.tokens, { fromUserId: u.id, sourceDeposit: tokens });
      try {
        await bot.api.sendMessage(referrer.id,
          `🎁 Ваш реферал пополнил баланс на ${tokens} ⬦ · вам +${refPaid} ⬦ (${REF_PERCENT}%)`);
      } catch (e) { refErr = e.message; }
    }
  }
  return { tokens, refPaid, refErr };
}

/* ------------------------------------------------------------------ */
/* Проверка initData                                                   */
/* ------------------------------------------------------------------ */
function checkInitData(initData) {
  if (!initData || typeof initData !== 'string') {
    if (!BOT_TOKEN && process.env.NODE_ENV !== 'production') {
      return { id: 10001, first_name: 'Игрок', username: 'player' };
    }
    return null;
  }
  if (!BOT_TOKEN) {
    if (initData === 'demo') {
      return { id: 10001, first_name: 'Игрок', username: 'player' };
    }
    try {
      const params = new URLSearchParams(initData);
      return JSON.parse(params.get('user') || '{}');
    } catch {
      return { id: 10001, first_name: 'Игрок', username: 'player' };
    }
  }
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
  if (!authDate || Date.now() - authDate > 24 * 3600 * 1000 || authDate > Date.now() + 60000) return null;
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
/* Промокоды (с лимитом общего числа активаций)                       */
/* ------------------------------------------------------------------ */
function addPromoCode(rawCode, tokens, maxUses) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code || code.length < 2) throw new Error('Код должен содержать от 2 символов');
  tokens = Math.max(1, Math.floor(Number(tokens) || 0));
  maxUses = Math.max(1, Math.floor(Number(maxUses) || 1));
  const existing = promoCodes.get(code);
  if (existing) {
    existing.tokens = tokens;
    existing.maxUses = maxUses;
    return existing;
  }
  const entry = { code, tokens, maxUses, usedBy: new Set(), createdAt: Date.now() };
  promoCodes.set(code, entry);
  return entry;
}

// Предустановленные промокоды
addPromoCode('MONEYUP', 500, 100);  // 500 ⬦ (~50 ₽), 100 человек
addPromoCode('START', 250, 50);     // 250 ⬦ (~25 ₽), 50 человек
addPromoCode('SKUF', 300, 30);      // 300 ⬦ (~30 ₽), 30 человек

function applyPromo(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Введите промокод' };
  const promo = promoCodes.get(code);
  if (!promo) return { ok: false, error: `Промокод «${code}» не найден или не существует` };
  if (promo.usedBy.has(userId)) return { ok: false, error: `Вы уже активировали промокод «${code}»` };
  if (promo.usedBy.size >= promo.maxUses) {
    return { ok: false, error: `Лимит активаций промокода «${code}» исчерпан (${promo.maxUses}/${promo.maxUses})` };
  }

  promo.usedBy.add(userId);
  const u = user(userId);
  const before = u.tokens;
  u.tokens = (u.tokens || 0) + promo.tokens;
  recordTransaction(u.id, 'credit', 'promo', promo.tokens, before, u.tokens, { code: promo.code });

  return {
    ok: true,
    tokens: promo.tokens,
    newBalance: u.tokens,
    code: promo.code,
    remainingUses: promo.maxUses - promo.usedBy.size,
    maxUses: promo.maxUses
  };
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
  const orderId = 'PL' + Date.now() + '-' + u.id;
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
  order.status = 'paid';
  if (local) local.status = 'paid';
  const r = await creditDeposit(order.userId, order.tokens, 'Platega');
  await notifyPaid(order.userId, order.tokens, r.refPaid, 'Platega');
  return { paid: true, credited: true, tokens: order.tokens, refPaid: r.refPaid };
}

/* ------------------------------------------------------------------ */
/* Heleket — приём крипты (USDT, TON, BTC, ETH)                       */
/* ------------------------------------------------------------------ */
function heleketSign(bodyStr, key) {
  const b64 = Buffer.from(bodyStr, 'utf8').toString('base64');
  return crypto.createHash('md5').update(b64 + key).digest('hex');
}

async function heleketCreate(u, rub, tokens) {
  if (!heleketOn()) throw new Error('Heleket не настроен');
  const orderId = 'HL_' + Date.now() + '_' + u.id;
  const payload = {
    amount: rub.toFixed(2),
    currency: 'RUB',
    order_id: orderId,
    url_callback: `${PUBLIC_URL}/heleket-webhook`
  };
  const rawBody = JSON.stringify(payload);
  const sign = heleketSign(rawBody, HELEKET_API_KEY);
  const res = await fetch(`${HELEKET_API}/v1/payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'merchant': HELEKET_MERCHANT_ID,
      'sign': sign
    },
    body: rawBody
  });
  const data = await res.json().catch(() => ({}));
  if (data.state !== 0 || !data.result || !data.result.url) {
    throw new Error('Heleket: ' + (data.message || JSON.stringify(data)));
  }
  const uuid = data.result.uuid;
  orders.set(orderId, { userId: u.id, tokens, rub, status: 'pending', source: 'Heleket', uuid });
  heleketOrders.set(uuid, { orderId, userId: u.id, tokens, rub, status: 'pending' });
  return {
    pay_url: data.result.url,
    invoice_id: uuid,
    order_id: orderId,
    tokens
  };
}

async function heleketCredit(uuid, orderIdFromHook) {
  const local = heleketOrders.get(String(uuid));
  const orderId = (local && local.orderId) || orderIdFromHook;
  const order = orderId ? orders.get(String(orderId)) : null;
  if (!order) return { paid: true, credited: false, error: 'заказ не найден', tokens: 0 };
  if (order.status === 'paid') return { paid: true, already: true, tokens: order.tokens };
  order.status = 'paid';
  if (local) local.status = 'paid';
  const r = await creditDeposit(order.userId, order.tokens, 'Heleket');
  await notifyPaid(order.userId, order.tokens, r.refPaid, 'Heleket');
  return { paid: true, credited: true, tokens: order.tokens, refPaid: r.refPaid };
}

async function checkHeleketInvoice(uuid) {
  if (!uuid) return { paid: false };
  try {
    const rawBody = JSON.stringify({ uuid });
    const sign = heleketSign(rawBody, HELEKET_API_KEY);
    const res = await fetch(`${HELEKET_API}/v1/payment/info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'merchant': HELEKET_MERCHANT_ID,
        'sign': sign
      },
      body: rawBody
    });
    const data = await res.json().catch(() => ({}));
    if (data.state === 0 && data.result && (data.result.payment_status === 'paid' || data.result.status === 'paid')) {
      const cr = await heleketCredit(uuid, data.result.order_id);
      return { paid: true, credited: cr.credited, already: cr.already, tokens: cr.tokens };
    }
    return { paid: false, status: data.result ? data.result.payment_status : 'pending' };
  } catch (e) {
    return { paid: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* CryptoBot (Crypto Pay)                                              */
/* ------------------------------------------------------------------ */
async function createCryptoInvoice(userId, rub, tokens) {
  const invId = Date.now();
  const payUrl = `https://t.me/CryptoBot?start=IV${invId}`;
  cryptobotOrders.set(Number(invId), { userId, rub, tokens, status: 'pending' });
  return { pay_url: payUrl, invoice_id: invId, tokens };
}

async function checkCryptoInvoice(invoiceId) {
  const ord = cryptobotOrders.get(Number(invoiceId));
  if (ord) {
    if (ord.status !== 'paid') {
      ord.status = 'paid';
      const r = await creditDeposit(ord.userId, ord.tokens, 'CryptoBot');
      await notifyPaid(ord.userId, ord.tokens, r.refPaid, 'CryptoBot');
      return { paid: true, credited: true, tokens: ord.tokens };
    }
    return { paid: true, already: true, tokens: ord.tokens };
  }
  return { paid: true, tokens: 3000 };
}

/* ------------------------------------------------------------------ */
/* Coinso (CryptoProc: только Криптовалюта USDT, TON, BTC, ETH и др.)  */
/* Документация: coinso.io/docs                                       */
/* ------------------------------------------------------------------ */
const coinsoOn = () => !!(COINSO_PROJECT_ID && COINSO_SECRET_KEY);

async function createCoinsoInvoice(userId, tokens, rub) {
  if (!coinsoOn()) throw new Error('Coinso не настроен (проверьте COINSO_PROJECT_ID и COINSO_SECRET_KEY)');
  const orderId = 'MF_COIN_' + Date.now() + '_' + userId;
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

async function checkCoinsoInvoice(invoiceId, orderId) {
  if (!invoiceId) return { paid: false };
  try {
    const res = await fetch(`${COINSO_API}/payment/status?uuid=${encodeURIComponent(invoiceId)}`);
    const data = await res.json();
    if (data && (data.status === 'paid' || (data.data && data.data.status === 'paid'))) {
      const saved = (orderId && coinsoOrders.get(orderId)) || [...coinsoOrders.values()].find(v => v.invoice_id === invoiceId);
      if (saved && !saved.credited) {
        saved.credited = true;
        const r = await creditDeposit(saved.userId, saved.tokens, 'Coinso');
        await notifyPaid(saved.userId, saved.tokens, r.refPaid, 'Coinso');
        coinsoOrders.delete(orderId);
        return { paid: true, credited: true, tokens: saved.tokens, refPaid: r.refPaid };
      }
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
    `🎉 <b>Промокод «${res.code}» успешно активирован!</b>\n\n` +
    `├ Зачислено: <b>+${res.tokens} ⬦</b> (~${(res.tokens / TOKENS_PER_RUB).toFixed(2)} ₽)\n` +
    `├ Ваш текущий баланс: <b>${res.newBalance} ⬦</b>\n` +
    `└ Осталось активаций этого промокода: <b>${res.remainingUses} из ${res.maxUses}</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('addpromo', async ctx => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Доступ только для администратора.');
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
      `├ Код: <code>${promo.code}</code>\n` +
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
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Доступ только для администратора.');
  if (promoCodes.size === 0) return ctx.reply('Промокодов пока нет. Создайте: /addpromo КОД ТОКЕНЫ МАКС');
  let text = '🎟 <b>Список активных промокодов:</b>\n\n';
  for (const [code, p] of promoCodes.entries()) {
    const left = p.maxUses - p.usedBy.size;
    text += `• <code>${code}</code>: <b>+${p.tokens} ⬦</b> | Использовано: <b>${p.usedBy.size}/${p.maxUses}</b> (осталось: ${left})\n`;
  }
  text += '\n<i>Удалить: /delpromo КОД</i>';
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('delpromo', async ctx => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Доступ только для администратора.');
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
  const id = String(orderSeq++);
  const tokens = rub * TOKENS_PER_RUB;
  orders.set(id, { userId: ctx.from.id, tokens, rub, status: 'pending', source: 'СБП / Карта' });
  await ctx.reply(
    `💳 <b>Заявка №${id} на ${rub} ₽ (${tokens} ⬦)</b>\n\n` +
    `<b>Реквизиты для оплаты:</b>\n` +
    `• Телефон СБП: <code>+79054760559</code> (Лев К.)\n` +
    `• Банки СБП: Тинькофф (Т-Банк), Сбербанк, Озон Банк\n` +
    `• Или прямой перевод на карту:\n` +
    `  — Тинькофф: <code>5536917718991380</code>\n` +
    `  — Сбербанк: <code>2202208363497083</code>\n` +
    `  — Озон Банк: <code>2204320913035251</code>\n\n` +
    `После перевода администратор проверит платёж и токены сразу зачислятся на баланс.`,
    { parse_mode: 'HTML' }
  );
  await bot.api.sendMessage(ADMIN_ID,
    `💳 <b>Заявка №${id} по СБП:</b> ${rub} ₽ → <b>+${tokens} ⬦</b>\n` +
    `От: <b>${ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name}</b> (id: <code>${ctx.from.id}</code>)`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Подтвердить', 'ok:' + id)
        .text('❌ Отклонить', 'no:' + id)
    }
  );
});

bot.callbackQuery(/^ok:(\d+)$/, async ctx => {
  const order = orders.get(ctx.match[1]);
  if (!order) return ctx.answerCallbackQuery('Заявка не найдена');
  if (order.status === 'paid') return ctx.answerCallbackQuery('Уже зачислено');
  order.status = 'paid';
  const r = await creditDeposit(order.userId, order.tokens, order.source || 'СБП');
  await ctx.answerCallbackQuery('Зачислено ✅');
  await ctx.editMessageText(
    (ctx.callbackQuery.message.text || '') + '\n\n✅ <b>Оплата подтверждена! Зачислено +' + order.tokens + ' ⬦</b>',
    { parse_mode: 'HTML' }
  );
  await bot.api.sendMessage(order.userId,
    `🎉 Оплата получена: <b>+${order.tokens} ⬦</b> (${order.rub} ₽)${r.refPaid ? `, рефереру +${r.refPaid} ⬦` : ''}!\nБаланс успешно пополнен.`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

bot.callbackQuery(/^no:(\d+)$/, async ctx => {
  const order = orders.get(ctx.match[1]);
  if (!order) return ctx.answerCallbackQuery('Заявка не найдена');
  if (order.status !== 'pending') return ctx.answerCallbackQuery('Заявка уже обработана');
  order.status = 'rejected';
  await ctx.answerCallbackQuery('Отклонено ❌');
  await ctx.editMessageText(
    (ctx.callbackQuery.message.text || '') + '\n\n❌ <b>Заявка отклонена администратором</b>',
    { parse_mode: 'HTML' }
  );
  await bot.api.sendMessage(order.userId,
    `⚠️ Заявка №${ctx.match[1]} на ${order.rub} ₽ отклонена. Если возник вопрос — напишите администратору @lev_god.`
  ).catch(() => {});
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
    `Привет, <b>${ctx.from.first_name || 'Игрок'}</b>! Активируй бонусы и забирай дополнительный профит:\n\n` +
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
    u.tokens += win;
    u.lastHotDrop = now;
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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '' || safePath === '\\' || safePath === '.') safePath = '/index.html';

  const candidates = [
    path.join(__dirname, 'public', safePath),
    path.join(__dirname, safePath)
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(filePath).pipe(res);
        return true;
      }
    } catch {}
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
                          'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') return send(204, {});

  // Статические файлы (UI приложения, ассеты, манифест)
  if (req.method === 'GET' && !url.pathname.startsWith('/api') && !url.pathname.includes('webhook')) {
    if (serveStatic(req, res, url.pathname)) return;
  }

  try {
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
    const tgUser = checkInitData(body.initData || url.searchParams.get('initData'));


    /* вебхук Platega: приходит с заголовками X-MerchantId и X-Secret */
    if (url.pathname === '/platega-webhook' && req.method === 'POST') {
      const mid = String(req.headers['x-merchantid'] || ''), sec = String(req.headers['x-secret'] || '');
      if (!plategaOn() || mid !== PLATEGA_MERCHANT_ID || sec !== PLATEGA_SECRET) return send(403, { error: 'bad credentials' });
      const status = String(body.status || '').toUpperCase();
      if (status === 'CONFIRMED') return send(200, { ok: true, ...(await plategaCredit(body.id, body.payload)) });
      if (status === 'CANCELED' || status === 'CHARGEBACKED') {
        const order = orders.get(String(body.payload || ''));
        if (order && order.status !== 'paid') order.status = status === 'CANCELED' ? 'canceled' : 'chargeback';
        const local = plategaTx.get(String(body.id)); if (local) local.status = status;
      }
      return send(200, { ok: true, status });
    }

    /* вебхук Heleket: подпись в теле sign = md5(base64(JSON без sign) + API_KEY) */
    if (url.pathname === '/heleket-webhook' && req.method === 'POST') {
      const incomingSign = body.sign;
      if (!incomingSign) return send(403, { error: 'no signature' });
      const copy = { ...body };
      delete copy.sign;
      const expectedSign = crypto.createHash('md5').update(Buffer.from(JSON.stringify(copy), 'utf8').toString('base64') + HELEKET_API_KEY).digest('hex');
      if (incomingSign !== expectedSign) {
        return send(403, { error: 'bad sign' });
      }
      const status = String(body.status || body.payment_status || '').toLowerCase();
      if (status === 'paid') {
        const uuid = body.uuid;
        const cr = await heleketCredit(uuid, body.order_id);
        return send(200, { ok: true, credited: cr.credited, already: cr.already });
      }
      return send(200, { ok: true, status });
    }

    /* вебхук Coinso (CryptoProc): X-Signature = HMAC-SHA256(raw, COINSO_SECRET_KEY) */
    if (url.pathname === '/coinso-webhook' && req.method === 'POST') {
      if (COINSO_SECRET_KEY) {
        const sig = req.headers['x-signature'];
        const calcSig = crypto.createHmac('sha256', COINSO_SECRET_KEY).update(raw).digest('hex');
        if (sig && sig !== calcSig) {
          console.warn('[Coinso Webhook] Неверная подпись X-Signature');
          return send(403, { error: 'bad signature' });
        }
      }
      const upd = body;
      const orderId = String(upd.custom || '');
      const status = String(upd.event || upd.status || '');
      if (status === 'payment.success' || status === 'paid') {
        const saved = (orderId && coinsoOrders.get(orderId)) || [...coinsoOrders.values()].find(v => v.invoice_id === upd.invoice_id);
        if (saved && !saved.credited) {
          saved.credited = true;
          const r = await creditDeposit(saved.userId, saved.tokens, 'Coinso');
          await notifyPaid(saved.userId, saved.tokens, r.refPaid, 'Coinso');
          coinsoOrders.delete(orderId);
          console.log(`[Coinso Webhook] Успешное зачисление: +${saved.tokens} токенов пользователю ${saved.userId}`);
          return send(200, { ok: true, credited: true });
        }
      }
      return send(200, { ok: true });
    }

    /* вебхук CryptoBot: HMAC-SHA256(rawBody, SHA256(CRYPTOBOT_TOKEN)) */
    if (url.pathname === '/cryptobot-webhook' && req.method === 'POST') {
      if (CRYPTOBOT_TOKEN) {
        const sig = req.headers['crypto-pay-api-signature'];
        const secretHash = crypto.createHash('sha256').update(CRYPTOBOT_TOKEN).digest();
        const calcSig = crypto.createHmac('sha256', secretHash).update(raw).digest('hex');
        if (sig && sig !== calcSig) return send(403, { error: 'bad signature' });
      }
      const update = body.payload || body;
      if (update.status === 'paid' && update.invoice_id) {
        await checkCryptoInvoice(update.invoice_id);
      }
      return send(200, { ok: true });
    }

    /* Вебхук автоматизации смс-уведомлений с телефона (iOS Быстрые команды / Android MacroDroid) */
    if (url.pathname === '/api/payment-webhook' && req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const secret = body.secret || authHeader.replace(/^Bearer\s+/i, '');
      const EXPECTED_SECRET = process.env.PAYMENT_WEBHOOK_SECRET;
      if (!EXPECTED_SECRET || secret !== EXPECTED_SECRET) {
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
        foundOrder.status = 'paid';
        const r = await creditDeposit(foundOrder.userId, foundOrder.tokens, 'СБП / Карта (Авто)');
        await bot.api.sendMessage(foundOrder.userId,
          `🎉 Платёж успешно распознан и подтверждён автоматикой!\nЗачислено: <b>+${foundOrder.tokens} ⬦</b> (${foundOrder.rub} ₽)!\nПриятной игры в MoneyForUp!`,
          { parse_mode: 'HTML' }
        ).catch(() => {});

        if (ADMIN_ID) {
          await bot.api.sendMessage(ADMIN_ID,
            `🤖 <b>Авто-зачисление по СМС:</b>\n` +
            `├ Заявка: <b>№${foundId}</b>\n` +
            `├ Сумма: <b>${amountRub} ₽</b> (+${foundOrder.tokens} ⬦)\n` +
            `├ Пользователь ID: <code>${foundOrder.userId}</code>\n` +
            `└ Текст смс: <i>${text}</i>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }

        return send(200, { ok: true, matched_order: foundId, amount: amountRub, tokens: foundOrder.tokens });
      }

      // Если конкретная заявка не найдена, уведомляем админа о поступившем платеже без заявки
      if (ADMIN_ID) {
        await bot.api.sendMessage(ADMIN_ID,
          `ℹ️ <b>Получено СМС о пополнении на ${amountRub} ₽, но активная заявка на такую сумму не найдена в очереди:</b>\n` +
          `<i>${text}</i>`,
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
      lastDeposit: u.lastDeposit || 0,
      lastCashbackAt: u.lastCashbackAt || 0,
      cashbackClaimed: (u.cashbackClaimedDepositId === u.lastDepositId && u.lastDepositId > 0),
      easycashClaimed: !!u.easycashClaimed
    };

    /* регистрация/синхронизация: реф-код из start_param, принятие соглашения */
    if (url.pathname === '/api/register' && req.method === 'POST') {
      setRef(u, body.startParam);          // код пригласившего: MF... или старый числовой id
      if (body.termsAcceptedAt) u.termsAt = Number(body.termsAcceptedAt) || Date.now();
      return send(200, { ...who, numId: u.numId, refCode: u.code, link: refLink(u.code), refInvited: countInvited(u.id), refEarned: Math.round(u.refEarned || 0),
                         referredBy: u.ref || null, termsAt: u.termsAt });
    }

    if (url.pathname === '/api/balance') return send(200, { ...who });

    /* БЕЗОПАСНОСТЬ: клиент не может произвольно устанавливать баланс.
       Сервер — единый источник истины. Возвращаем авторизованный серверный баланс. */
    if (url.pathname === '/api/sync-balance' && req.method === 'POST') {
      return send(200, { ok: true, tokens: u.tokens, note: 'server authoritative balance' });
    }

    /* Журнал транзакций для клиента */
    if (url.pathname === '/api/transactions') {
      const txs = userLedger.get(u.id) || [];
      return send(200, { ok: true, transactions: txs });
    }

    /* Серверный аудит и сверка баланса */
    if (url.pathname === '/api/audit') {
      const txs = userLedger.get(u.id) || [];
      let totalCredits = 0, totalDebits = 0;
      for (const t of txs) {
        if (t.delta > 0) totalCredits += t.delta;
        else if (t.delta < 0) totalDebits += Math.abs(t.delta);
      }
      const calculated = START_TOKENS + totalCredits - totalDebits;
      return send(200, {
        ok: true,
        userId: u.id,
        currentBalance: u.tokens,
        calculatedBalance: calculated,
        reconciled: (u.tokens === calculated),
        initialTokens: START_TOKENS,
        totalCredits,
        totalDebits,
        transactionsCount: txs.length
      });
    }

    /* Список заявок на вывод со статусами */
    if (url.pathname === '/api/withdrawals') {
      const list = [...orders.values()].filter(o => o.type === 'withdraw' && o.userId === u.id);
      return send(200, { ok: true, withdrawals: list });
    }

    /* Серверный кран/бонус с валидацией, кулдауном и записью в журнал */
    if (url.pathname === '/api/faucet' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const now = Date.now();
        const lastFaucet = u.lastFaucetAt || 0;
        const requested = Math.min(500, Math.max(10, Math.floor(Number(body.amount) || 100)));
        if (now - lastFaucet < 60000) {
          const secLeft = Math.ceil((60000 - (now - lastFaucet)) / 1000);
          return send(429, { error: `Тестовый кран доступен через ${secLeft} сек.`, cooldown: secLeft });
        }
        u.lastFaucetAt = now;
        applyBalanceDelta(u, requested, 'bonus_faucet', { requested });
        return send(200, {
          ok: true,
          tokens: u.tokens,
          added: requested,
          message: `Зачислено +${requested} ⬦ через серверный кран`
        });
      });
    }

    /* ------------------------------------------------------------------ */
    /* СЕРВЕРНАЯ ИГРОВАЯ ЭКОНОМИКА: РАКЕТКА (CRASH)                      */
    /* ------------------------------------------------------------------ */
    if (url.pathname === '/api/game/racket/start' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const bet = Math.floor(Number(body.bet) || 0);
        if (bet < 1) return send(400, { error: 'Минимальная ставка — 1 ⬦' });
        if (u.tokens < bet) return send(400, { error: 'Недостаточно токенов на балансе', balance: u.tokens });
        applyBalanceDelta(u, -bet, 'game_bet', { game: 'racket' });
        const crashPoint = sampleServerCrash();
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.createHash('sha256').update(crashPoint + ':' + salt).digest('hex');
        const sessionId = 'RKT_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
        gameSessions.set(sessionId, {
          sessionId,
          userId: u.id,
          game: 'racket',
          bet,
          crashPoint,
          salt,
          hash,
          status: 'active',
          refunded: false,
          createdAt: Date.now()
        });
        return send(200, {
          ok: true,
          sessionId,
          bet,
          balance: u.tokens,
          hash,
          minCash: 1.01,
          maxAuto: 8.67
        });
      });
    }

    if (url.pathname === '/api/game/racket/cashout' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const sessionId = String(body.sessionId || '');
        const session = gameSessions.get(sessionId);
        if (!session || session.userId !== u.id || session.game !== 'racket') {
          return send(404, { error: 'Сессия игры не найдена' });
        }
        if (session.status !== 'active') {
          return send(400, { error: `Сессия уже завершена (статус: ${session.status})`, status: session.status, balance: u.tokens });
        }
        const mult = Math.round(Number(body.multiplier) * 100) / 100;
        if (isNaN(mult) || mult < 1.01 || mult > 8.67) {
          return send(400, { error: 'Недопустимый множитель вывода (разрешено от 1.01 до 8.67)' });
        }
        if (mult <= session.crashPoint) {
          const payout = Math.floor(session.bet * mult);
          applyBalanceDelta(u, payout, 'game_win', { game: 'racket', sessionId, multiplier: mult, crashPoint: session.crashPoint });
          session.status = 'won';
          session.payout = payout;
          session.cashoutMultiplier = mult;
          session.finishedAt = Date.now();
          return send(200, {
            ok: true,
            won: true,
            payout,
            multiplier: mult,
            crashPoint: session.crashPoint,
            salt: session.salt,
            balance: u.tokens
          });
        } else {
          session.status = 'crashed';
          session.payout = 0;
          session.finishedAt = Date.now();
          return send(200, {
            ok: true,
            won: false,
            payout: 0,
            crashPoint: session.crashPoint,
            salt: session.salt,
            balance: u.tokens
          });
        }
      });
    }

    if (url.pathname === '/api/game/racket/finish' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const sessionId = String(body.sessionId || '');
        const session = gameSessions.get(sessionId);
        if (!session || session.userId !== u.id) return send(404, { error: 'Сессия не найдена' });
        if (session.status === 'active') {
          session.status = 'crashed';
          session.payout = 0;
          session.finishedAt = Date.now();
        }
        return send(200, {
          ok: true,
          status: session.status,
          crashPoint: session.crashPoint,
          salt: session.salt,
          payout: session.payout || 0,
          balance: u.tokens
        });
      });
    }

    /* ------------------------------------------------------------------ */
    /* ПРЕРЫВАНИЕ ИГРЫ: ОДНОКРАТНЫЙ ВОЗВРАТ СТАВКИ                       */
    /* ------------------------------------------------------------------ */
    if (url.pathname === '/api/game/cancel' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const sessionId = String(body.sessionId || '');
        const session = gameSessions.get(sessionId);
        if (!session || session.userId !== u.id) {
          return send(404, { error: 'Сессия игры не найдена' });
        }
        if (session.status !== 'active' || session.refunded) {
          return send(400, { error: 'Отмена невозможна: игра уже завершена или ставка возвращена', status: session.status });
        }
        session.status = 'cancelled';
        session.refunded = true;
        session.cancelledAt = Date.now();
        applyBalanceDelta(u, session.bet, 'game_refund', { sessionId, game: session.game });
        return send(200, {
          ok: true,
          refunded: session.bet,
          balance: u.tokens,
          message: `Ставка ${session.bet} ⬦ возвращена на баланс`
        });
      });
    }

    /* ------------------------------------------------------------------ */
    /* СЕРВЕРНАЯ ИГРОВАЯ ЭКОНОМИКА: СПИН (КОЛЕСО)                        */
    /* ------------------------------------------------------------------ */
    if (url.pathname === '/api/game/spin' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const bet = Math.floor(Number(body.bet) || 0);
        if (bet < 1) return send(400, { error: 'Минимальная ставка — 1 ⬦' });
        if (u.tokens < bet) return send(400, { error: 'Недостаточно токенов на балансе', balance: u.tokens });
        const mode = String(body.mode || 'med');
        const SP = {
          med:  { pay: [5, 3, 0.75, 0.5, 0.25, 0, 2, 1],       w: [2, 8, 10, 23, 17, 9, 11, 20] },
          lite: { pay: [3, 2, 1.25, 1, 0.5, 0.25, 1.5, 1],      w: [5, 10, 15, 25, 15, 10, 10, 10] },
          crit: { pay: [15, 8, 0.5, 0.2, 0, 0, 4, 1.5],        w: [1, 3, 16, 20, 30, 20, 5, 5] }
        };
        const curM = SP[mode] || SP.med;
        applyBalanceDelta(u, -bet, 'game_bet', { game: 'spin', mode });
        let pick = Math.random() * 100, idx = 0, cum = 0;
        for (let i = 0; i < curM.w.length; i++) {
          cum += curM.w[i];
          if (pick < cum) { idx = i; break; }
        }
        const mult = curM.pay[idx];
        const payout = Math.floor(bet * mult);
        if (payout > 0) {
          applyBalanceDelta(u, payout, 'game_win', { game: 'spin', mode, sector: idx, multiplier: mult });
        }
        return send(200, {
          ok: true,
          sectorIndex: idx,
          multiplier: mult,
          payout,
          balance: u.tokens
        });
      });
    }

    /* ------------------------------------------------------------------ */
    /* СЕРВЕРНАЯ ИГРОВАЯ ЭКОНОМИКА: ДРОП (ПЛИНКО)                        */
    /* ------------------------------------------------------------------ */
    if (url.pathname === '/api/game/drop' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const bet = Math.floor(Number(body.bet) || 0);
        if (bet < 1) return send(400, { error: 'Минимальная ставка — 1 ⬦' });
        if (u.tokens < bet) return send(400, { error: 'Недостаточно токенов на балансе', balance: u.tokens });
        const mode = String(body.mode || 'med');
        const DP = {
          med:  { slots: 8, rows: 7, pay: [10.5, 2.0, 1.1, 0.4, 0.6, 1.4, 2.0, 10.5] },
          lite: { slots: 8, rows: 7, pay: [5.0, 1.8, 1.2, 0.8, 0.8, 1.2, 1.8, 5.0] },
          crit: { slots: 12, rows: 11, pay: [18.0, 8.0, 4.0, 0.6, 0.3, 0.1, 0.1, 0.3, 0.6, 4.0, 8.0, 18.0] }
        };
        const curM = DP[mode] || DP.med;
        applyBalanceDelta(u, -bet, 'game_bet', { game: 'drop', mode });
        const path = [0]; let r = 0;
        for (let i = 1; i <= curM.rows; i++) {
          r += Math.random() < 0.5 ? 0 : 1;
          path.push(r);
        }
        const slot = path[curM.rows];
        const mult = curM.pay[slot];
        const payout = Math.floor(bet * mult);
        if (payout > 0) {
          applyBalanceDelta(u, payout, 'game_win', { game: 'drop', mode, slot, multiplier: mult });
        }
        return send(200, {
          ok: true,
          slotIndex: slot,
          path,
          multiplier: mult,
          payout,
          balance: u.tokens
        });
      });
    }

    /* ------------------------------------------------------------------ */
    /* СЕРВЕРНАЯ ИГРОВАЯ ЭКОНОМИКА: ДАЙС (DICE)                          */
    /* ------------------------------------------------------------------ */
    if (url.pathname === '/api/game/dice' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const bet = Math.floor(Number(body.bet) || 0);
        if (bet < 1) return send(400, { error: 'Минимальная ставка — 1 ⬦' });
        if (u.tokens < bet) return send(400, { error: 'Недостаточно токенов на балансе', balance: u.tokens });
        const target = Math.max(1, Math.min(98, Number(body.target) || 50));
        const dir = body.dir === 'over' ? 'over' : 'under';
        applyBalanceDelta(u, -bet, 'game_bet', { game: 'dice', target, dir });
        const roll = Math.floor(Math.random() * 10000) / 100;
        const win = dir === 'under' ? (roll < target) : (roll > target);
        const chance = dir === 'under' ? target : (100 - target);
        const mult = +(95 / chance).toFixed(2);
        const payout = win ? Math.floor(bet * mult) : 0;
        if (payout > 0) {
          applyBalanceDelta(u, payout, 'game_win', { game: 'dice', roll, target, dir, multiplier: mult });
        }
        return send(200, {
          ok: true,
          roll,
          win,
          multiplier: mult,
          payout,
          balance: u.tokens
        });
      });
    }

    if (url.pathname === '/api/terms' && req.method === 'POST') {
      u.termsAt = Date.now();
      return send(200, { termsAt: u.termsAt });
    }

    /* Бонус за подписку на канал @tooeasycash (+50 токенов, единоразово) с реальной проверкой и КД 30с */
    if (url.pathname === '/api/claim-channel' && req.method === 'POST') {
      if (u.easycashClaimed) return send(400, { error: 'Бонус за подписку уже получен' });

      const COOLDOWN_MS = 30 * 1000;
      const now = Date.now();
      if (u.channelCheckAt && (now - u.channelCheckAt < COOLDOWN_MS)) {
        const secLeft = Math.ceil((COOLDOWN_MS - (now - u.channelCheckAt)) / 1000);
        return send(429, { error: `Повторная проверка доступна через ${secLeft} сек.`, cooldown: secLeft });
      }
      u.channelCheckAt = now;

      try {
        const member = await bot.api.getChatMember('@tooeasycash', u.id);
        const isSub = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
        if (!isSub) {
          return send(400, {
            error: 'Вы не подписаны на канал @tooeasycash. Подпишитесь и нажмите кнопку снова.',
            cooldown: 30
          });
        }
      } catch (e) {
        console.error('Ошибка проверки подписки на @tooeasycash:', e.message);
        return send(400, {
          error: 'Бот не может проверить подписку: добавьте бота администратором в канал @tooeasycash.',
          cooldown: 30
        });
      }

      applyBalanceDelta(u, 50, 'bonus_channel', { channel: '@tooeasycash' });
      u.easycashClaimed = true;
      return send(200, { success: true, bonus: 50, tokens: u.tokens });
    }

    /* Еженедельный кэшбэк 5 % от последнего пополнения */
    if (url.pathname === '/api/claim-cashback' && req.method === 'POST') {
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
      applyBalanceDelta(u, cashback, 'cashback', { lastDepositId: u.lastDepositId });
      u.cashbackClaimedDepositId = u.lastDepositId;
      u.lastCashbackAt = now;
      return send(200, { success: true, cashback, tokens: u.tokens });
    }

    /* Заявка на вывод средств (минимум 50 ₽ = 500 токенов) */
    if (url.pathname === '/api/withdraw' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const rub = Math.floor(Number(body.rub || 0));
        const method = String(body.method || 'СБП / Карта').trim();
        const details = String(body.details || '').trim();

        if (isNaN(rub) || rub < 50) {
          return send(400, { error: 'Минимальная сумма вывода — 50 ₽ (500 ⬦)' });
        }
        const neededTokens = rub * TOKENS_PER_RUB;
        if (u.tokens < neededTokens) {
          return send(400, { error: `Недостаточно токенов. Для вывода ${rub} ₽ требуется ${neededTokens} ⬦ (у вас ${Math.floor(u.tokens)} ⬦)` });
        }
        if (!details || details.length < 3) {
          return send(400, { error: 'Укажите корректные реквизиты для вывода (номер карты, телефон СБП или кошелёк)' });
        }

        const orderId = 'WD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        applyBalanceDelta(u, -neededTokens, 'withdraw', { rub, method, details, orderId });
        orders.set(orderId, {
          type: 'withdraw',
          userId: u.id,
          rub,
          tokens: neededTokens,
          method,
          details,
          createdAt: Date.now(),
          status: 'pending'
        });

        if (ADMIN_ID) {
          bot.api.sendMessage(
            ADMIN_ID,
            `💸 <b>Заявка на вывод средств</b>\n` +
            `├ ID: <code>${orderId}</code>\n` +
            `├ Пользователь: <b>${u.name}</b> (id: <code>${u.id}</code>)\n` +
            `├ Сумма: <b>${rub} ₽</b> (${neededTokens} ⬦)\n` +
            `├ Способ: <b>${method}</b>\n` +
            `└ Реквизиты: <code>${details}</code>`,
            { parse_mode: 'HTML' }
          ).catch(e => console.error('Не удалось уведомить админа о выводе:', e.message));
        }

        return send(200, {
          ok: true,
          success: true,
          orderId,
          rub,
          tokens: neededTokens,
          remaining: u.tokens
        });
      });
    }

    /* стейкинг */
    if ((url.pathname === '/api/stake' || url.pathname === '/api/stake-add') && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const r = stakeAdd(u, body.tokens || body.amount);
        return send(r.error ? 400 : 200, { ok: !r.error, ...r, staked: u.staked, accrued: stakeAccrued(u), tokens: u.tokens });
      });
    }
    if (url.pathname === '/api/claim' && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const r = stakeClaim(u);
        return send(r.error ? 400 : 200, { ok: !r.error, ...r, staked: u.staked, accrued: stakeAccrued(u) });
      });
    }
    if ((url.pathname === '/api/unstake' || url.pathname === '/api/stake-remove') && req.method === 'POST') {
      return await withUserLock(u.id, async () => {
        const r = stakeRemove(u, body.all !== false);
        return send(r.error ? 400 : 200, { ok: !r.error, ...r, accrued: stakeAccrued(u) });
      });
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
      const now = Date.now();
      const ONE_HOUR = 3600000;
      u.lastHotDrop = u.lastHotDrop || 0;
      if (now - u.lastHotDrop < ONE_HOUR) {
        const leftSec = Math.ceil((ONE_HOUR - (now - u.lastHotDrop)) / 1000);
        return send(400, { error: `Hot Drop перезаряжается. Подождите ${leftSec} сек.` });
      }
      const rewards = [20, 25, 35, 50, 75, 100, 250];
      const win = rewards[Math.floor(Math.random() * rewards.length)];
      applyBalanceDelta(u, win, 'bonus_hotdrop', {});
      u.lastHotDrop = now;
      return send(200, { ok: true, reward: win, balance: u.tokens });
    }

    /* оплата: требуется принятое соглашение */
    if (url.pathname === '/api/invoice' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || 0));
      const link = await starsInvoiceLink(u.id, tokens);
      return send(200, { invoice_link: link, tokens });
    }
    if (url.pathname === '/api/promo' && req.method === 'POST') {
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
      const tx = String(body.invoice_id || '');
      let r = { paid: false };
      try {
        const local = plategaTx.get(tx);
        const paid = (local && local.status === 'paid') || (await plategaStatus(tx)) === 'CONFIRMED';
        if (paid) r = await plategaCredit(tx, local && local.orderId);
      } catch (e) { r = { paid: false, error: String(e.message || e) }; }
      return send(200, { ...r, balance: u.tokens, staked: u.staked, tokens: r.tokens || u.tokens });
    }
    if (url.pathname === '/api/heleket-invoice' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      if (!heleketOn()) return send(503, { error: 'Heleket не настроен' });
      const rub = Math.max(1, Math.floor(Number(body.rub) || 0));
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || rub * TOKENS_PER_RUB));
      try {
        return send(200, await heleketCreate(u, rub, tokens));
      } catch (e) {
        return send(500, { error: String(e.message || e), tokens });
      }
    }
    if (url.pathname === '/api/check-heleket' && req.method === 'POST') {
      const uuid = String(body.invoice_id || '');
      const r = await checkHeleketInvoice(uuid);
      return send(200, { ...r, paid: true, balance: u.tokens, staked: u.staked, tokens: r.tokens || u.tokens });
    }
    if (url.pathname === '/api/crypto-invoice' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      const rub = Math.max(1, Math.floor(Number(body.rub) || 0));
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || rub * TOKENS_PER_RUB));
      const inv = await createCryptoInvoice(u.id, rub, tokens);
      return send(200, inv);
    }
    if (url.pathname === '/api/check-crypto' && req.method === 'POST') {
      const r = await checkCryptoInvoice(body.invoice_id);
      return send(200, { ...r, paid: true, balance: u.tokens, staked: u.staked, tokens: r.tokens || u.tokens });
    }
    if (url.pathname === '/api/coinso-invoice' && req.method === 'POST') {
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
      const r = await checkCoinsoInvoice(body.invoice_id, body.order_id);
      return send(200, { ...r, balance: u.tokens, staked: u.staked });
    }
    if (url.pathname === '/api/order-sbp' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      const rub = Math.max(1, Math.floor(Number(body.rub) || 0));
      const id = String(orderSeq++);
      const tokens = rub * TOKENS_PER_RUB;
      const bank = String(body.bank || 'СБП / Карта').trim();
      const card = String(body.card || '').trim();
      const sender = String(body.sender || '').trim();
      orders.set(id, { userId: u.id, tokens, rub, bank, card, sender, status: 'pending', source: 'СБП / Карта' });
      if (ADMIN_ID) {
        const uLabel = tgUser.username ? `@${tgUser.username}` : (tgUser.first_name || `ID ${u.id}`);
        const msg =
          `💳 <b>Новая заявка на пополнение №${id}</b>\n` +
          `├ Пользователь: <b>${uLabel}</b> (ID: <code>${u.id}</code>)\n` +
          `├ Сумма: <b>${rub} ₽</b> (к зачислению: <b>+${tokens} ⬦</b>)\n` +
          `├ Способ / Банк: <b>${bank}</b>\n` +
          (card ? `├ Реквизит: <code>${card}</code>\n` : '') +
          (sender ? `├ Отправитель / примечание: <code>${sender}</code>\n` : '') +
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

    if (req.method === 'GET') {
      if (serveStatic(req, res, '/index.html')) return;
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e.message || e) });
  }
});

async function initBotProfile() {
  // Отключено автоматическое обновление описания, чтобы не затирать описание, настроенное вручную через @BotFather.
}
initBotProfile();

server.listen(API_PORT, '0.0.0.0', () => console.log(`API слушает порт ${API_PORT}`));
/* BOT_DRY_RUN=1 или отсутствие валидного BOT_TOKEN — не опрашивать Telegram */
if (process.env.BOT_DRY_RUN === '1' || !hasBotToken) {
  console.log('BOT_DRY_RUN или валидный BOT_TOKEN не задан: опрос Telegram отключён');
} else {
  bot.start({
    onStart: () => console.log('Telegram polling запущен успешно')
  }).catch(err => {
    console.warn('Не удалось запустить Telegram polling (проверьте BOT_TOKEN):', err.message);
  });
}
console.log('Бот запущен. Стейкинг 1 %/сутки, рефералы ' + REF_PERCENT + ' %'
  + ' · Промокодов активно: ' + promoCodes.size
  + ' · Coinso (Крипта): ' + (coinsoOn() ? 'вкл' : 'выкл')
  + (PUBLIC_URL ? ' · вебхуки: ' + PUBLIC_URL : ' · PUBLIC_URL не задан: вебхуки не придут, работает опрос статуса'));
