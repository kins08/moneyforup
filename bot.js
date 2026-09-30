/**
 * MoneyForUp — бот + API для Telegram Mini App.
 *
 * Возможности:
 *   • Mini App по кнопке, реферальные ссылки (?startapp=<id>)
 *   • Стейкинг: 1 % в сутки, проценты считаются по секундам, снятие в любой момент
 *   • Реферальная программа: 15 % от каждого пополнения приглашённого — токенами рефереру
 *   • Оплата: Platega (карта / СБП), Telegram Stars, CryptoBot и Heleket (крипта), плюс заявки по СБП вручную
 *   • Проверка initData (HMAC-SHA256) на каждом запросе, фиксация принятия соглашения
 *
 * Запуск:
 *   npm i && BOT_TOKEN=... APP_URL=... node bot.js
 *
 * Демо-хранилище — в памяти (Map). Для продакшена заменить на БД, см. README.md.
 */
const http = require('http');
const crypto = require('crypto');
const { Bot, InlineKeyboard } = require('grammy');

const BOT_TOKEN     = process.env.BOT_TOKEN;
const APP_URL       = process.env.APP_URL || 'https://example.com/moneyforup-tg.html';
const API_PORT      = +(process.env.PORT || process.env.API_PORT || 3000);
const ADMIN_ID      = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : 0;
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN || '';      // токен из @CryptoBot → My Apps
const CRYPTOBOT_API = process.env.CRYPTOBOT_API || 'https://pay.crypt.bot/api';

/* Platega (карты РФ и СБП). Кабинет: platega.io → Настройки → API
   В ЛК укажите Callback URL: https://<бэкенд>/platega-webhook (только HTTPS, самоподписанные сертификаты не принимаются) */
const PLATEGA_MERCHANT_ID = process.env.PLATEGA_MERCHANT_ID || '';
const PLATEGA_SECRET      = process.env.PLATEGA_SECRET || '';
const PLATEGA_API         = process.env.PLATEGA_API || 'https://app.platega.io';

/* Heleket (крипта: USDT, BTC, ETH и др.). Кабинет: heleket.com → Настройки → API
   Вебхук задаётся в самом счёте (url_callback) — укажите PUBLIC_URL, чтобы он подставлялся */
const HELEKET_MERCHANT_ID = process.env.HELEKET_MERCHANT_ID || '';
const HELEKET_API_KEY     = process.env.HELEKET_API_KEY || '';
const HELEKET_API         = process.env.HELEKET_API || 'https://api.heleket.com';
const HELEKET_CURRENCY    = process.env.HELEKET_CURRENCY || 'RUB';       // валюта счёта; если RUB не подключён — поставьте USD и курс ниже
const HELEKET_RUB_PER_USD = +(process.env.HELEKET_RUB_PER_USD || 90);    // нужен только при HELEKET_CURRENCY=USD/EUR

/* Публичный адрес этого бэкенда (без слэша на конце) — для url_callback и вебхуков */
const PUBLIC_URL      = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const BOT_USERNAME    = (process.env.BOT_USERNAME || '').replace(/^@/, '');   // имя бота без @ (для реферальных ссылок)

const TOKENS_PER_RUB  = 10;     // 10 ⬦ = 1 ₽
const STARS_TO_TOKENS = 20;     // 1 звезда ≈ 2 ₽ ⇒ 20 ⬦
const START_TOKENS    = 50;
const STAKE_RATE      = 0.01;   // 1 % в сутки
const DAY_MS          = 86400000;
const REF_PERCENT     = 15;     // 15 % от пополнений приглашённых

if (!BOT_TOKEN) { console.error('Нет BOT_TOKEN. Пример: BOT_TOKEN=123:ABC node bot.js'); process.exit(1); }

const bot = new Bot(BOT_TOKEN);

/* ------------------------------------------------------------------ */
/* Хранилище (демо). Заменить на Postgres/SQLite — см. README.md        */
/* ------------------------------------------------------------------ */
const users = new Map();    // id → { name, code, tokens, staked, stakeSince, accruedBase, ref, refEarned, refInvited, termsAt, starsUsd }
const byCode = new Map();   // реферальный код → id пользователя
const orders = new Map();   // orderId → { userId, tokens, rub, status, source }
const invoices = new Map(); // cryptoBotInvoiceId → { userId, tokens, rub }
const plategaTx = new Map(); // transactionId Platega → { userId, tokens, rub }
const heleketInv = new Map(); // uuid счёта Heleket → { userId, tokens, rub }
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
  u.accruedBase = stakeAccrued(u);          // сохраняем уже накопленное
  u.tokens -= v;
  u.staked += v;
  u.stakeSince = Date.now();
  return { staked: u.staked, tokens: u.tokens, accrued: u.accruedBase };
}
function stakeClaim(u) {
  const acc = stakeAccrued(u);
  if (acc < 0.01) return { error: 'Пока нечего забирать' };
  u.tokens += acc; u.accruedBase = 0; u.stakeSince = Date.now();
  return { claimed: acc, tokens: u.tokens };
}
function stakeRemove(u, all) {
  const acc = stakeAccrued(u), body = u.staked;
  if (!body && acc < 0.01) return { error: 'Стейкинг пуст' };
  const take = all === false ? 0 : body;
  u.tokens += take + acc;
  u.staked -= take;
  u.accruedBase = 0;
  u.stakeSince = u.staked ? Date.now() : 0;
  return { removed: take + acc, tokens: u.tokens, staked: u.staked };
}

/* ------------------------------------------------------------------ */
/* Пополнение + реферальные 15 %                                       */
/* ------------------------------------------------------------------ */
async function creditDeposit(userId, tokens, source) {
  const u = user(userId);
  u.tokens += tokens;
    u.lastDeposit = tokens;
  u.lastDepositId = (u.lastDepositId || 0) + 1;
  let refPaid = 0, refErr = null;
  const refId = Number(u.ref);
  if (refId) {
    const referrer = user(refId);                              // реферер мог ещё не открыть бота — создаём запись
    if (Number(u.ref) !== u.id) {                              // самоприглашение отсекаем
      refPaid = Math.floor(tokens * REF_PERCENT / 100);
      referrer.tokens += refPaid;
      referrer.refEarned = (referrer.refEarned || 0) + refPaid;
      referrer.refInvited = countInvited(referrer.id);
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
  if (!authDate || Date.now() - authDate > 24 * 3600 * 1000) return null;
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
/* CryptoBot (USDT / TON / BTC)                                        */
/* ------------------------------------------------------------------ */
async function cryptoBot(method, payload) {
  if (!CRYPTOBOT_TOKEN) throw new Error('CRYPTOBOT_TOKEN не задан');
  const res = await fetch(`${CRYPTOBOT_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error('CryptoBot: ' + JSON.stringify(data.error || data));
  return data.result;
}
async function createCryptoInvoice(userId, tokens, rub) {
  const inv = await cryptoBot('createInvoice', {
    currency_type: 'fiat', fiat: 'RUB', amount: String(rub),
    description: `${tokens} ⬦ MoneyForUp (10 ⬦ = 1 ₽, вывод не предусмотрен)`,
    payload: JSON.stringify({ userId, tokens, kind: 'tokens' }),
    expires_in: 3600,
    allow_comments: false,
    allow_anonymous: false
  });
  invoices.set(String(inv.invoice_id), { userId, tokens, rub });
  return {
    invoice_id: inv.invoice_id,
    pay_url: inv.bot_invoice_url || inv.mini_app_invoice_url || inv.pay_url,
    tokens
  };
}
/** Проверка оплаты: либо вебхук, либо опрос getInvoices */
async function checkCryptoInvoice(invoiceId) {
  const list = await cryptoBot('getInvoices', { invoice_ids: String(invoiceId), count: 1 });
  const inv = (list.items || [])[0];
  if (!inv) return { paid: false };
  if (inv.status !== 'paid') return { paid: false, status: inv.status };
  const local = invoices.get(String(invoiceId));
  if (local && local.credited) return { paid: true, already: true, tokens: local.tokens };
  let tokens = local ? local.tokens : 0, userId = local ? local.userId : null;
  try {
    const p = JSON.parse(inv.payload || '{}');
    tokens = tokens || p.tokens; userId = userId || p.userId;
  } catch {}
  if (!userId || !tokens) return { paid: true, credited: false, error: 'нет привязки к пользователю' };
  const r = await creditDeposit(userId, tokens, 'CryptoBot');
  if (local) local.credited = true;
  return { paid: true, credited: true, tokens, refPaid: r.refPaid };
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
/* Heleket — крипта (USDT, BTC, ETH и др.)                             */
/* ------------------------------------------------------------------ */
const heleketOn = () => !!(HELEKET_MERCHANT_ID && HELEKET_API_KEY);
/* подпись = md5( base64(тело запроса) + API_KEY ) — см. doc.heleket.com/general/request-format */
const heleketSign = raw =>
  crypto.createHash('md5').update(Buffer.from(raw, 'utf8').toString('base64') + HELEKET_API_KEY).digest('hex');

async function heleketRequest(method, payload = {}) {
  if (!heleketOn()) throw new Error('Heleket не настроен: добавьте HELEKET_MERCHANT_ID и HELEKET_API_KEY');
  const raw = JSON.stringify(payload);
  const res = await fetch(`${HELEKET_API}/v1/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', merchant: HELEKET_MERCHANT_ID, sign: heleketSign(raw) },
    body: raw
  });
  const data = await res.json().catch(() => ({}));
  if (data.state !== 0) throw new Error('Heleket: ' + JSON.stringify(data.message || data));
  return data.result;
}
const heleketAmountIn = rub =>
  HELEKET_CURRENCY === 'RUB' ? rub.toFixed(2) : (rub / HELEKET_RUB_PER_USD).toFixed(2);

async function heleketCreate(u, rub, tokens) {
  const orderId = 'HL' + Date.now() + '-' + u.id;
  const result = await heleketRequest('payment', {
    amount: heleketAmountIn(rub),
    currency: HELEKET_CURRENCY,
    order_id: orderId,
    url_callback: PUBLIC_URL ? `${PUBLIC_URL}/heleket-webhook` : undefined,
    url_success: APP_URL,
    url_return: APP_URL,
    lifetime: 3600,
    additional_data: `${u.id}:${tokens}`,
    theme: 'dark'
  });
  orders.set(orderId, { userId: u.id, tokens, rub, status: 'pending', source: 'Heleket', uuid: result.uuid });
  heleketInv.set(String(result.uuid), { orderId, userId: u.id, tokens, rub, status: 'pending' });
  return { pay_url: result.url, invoice_id: result.uuid, order_id: orderId, tokens };
}

const heleketInfo = uuid => heleketRequest('payment/info', { uuid });

async function heleketCredit(uuid, orderIdFromHook) {
  const local = heleketInv.get(String(uuid));
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

/* проверка подписи вебхука Heleket: sign приходит в теле, считается по телу без поля sign */
function heleketVerify(body) {
  const got = body && body.sign;
  if (!got) return false;
  const rest = { ...body }; delete rest.sign;
  const expect = heleketSign(JSON.stringify(rest));
  const a = Buffer.from(expect), b = Buffer.from(String(got));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  const kb = new InlineKeyboard().webApp('🚀 Открыть MoneyForUp', APP_URL);
  await ctx.reply(
    `Привет, ${ctx.from.first_name}!\n` +
    `MoneyForUp — математические игры на токены (10 ⬦ = 1 ₽, вывод не предусмотрен).\n` +
    `Стейкинг: 1 % в сутки. Рефералы: ${REF_PERCENT} % с пополнений приглашённых.\n\n` +
    `Оплата: /pay — карта или СБП · /buy — звёздами · /crypto и /heleket — крипта.\n` +
    `На счету: ${u.tokens} ⬦. Открывай приложение 👇`,
    { reply_markup: kb }
  );
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

bot.command('crypto', async ctx => {
  if (!CRYPTOBOT_TOKEN) return ctx.reply('CryptoBot не настроен: добавьте CRYPTOBOT_TOKEN в .env');
  const arg = Number((ctx.match || '').trim());
  const tokens = arg > 0 ? Math.floor(arg) : 3000;
  try {
    const inv = await createCryptoInvoice(ctx.from.id, tokens, tokens / TOKENS_PER_RUB);
    await ctx.reply(`Счёт на ${tokens} ⬦ ≈ ${(tokens / TOKENS_PER_RUB).toFixed(2)} ₽ · CryptoBot`,
      { reply_markup: new InlineKeyboard().url('₿ Оплатить криптой', inv.pay_url) });
  } catch (e) { await ctx.reply('Не удалось создать счёт CryptoBot: ' + (e.message || e)); }
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

bot.command('heleket', async ctx => {
  if (!heleketOn()) return ctx.reply('Heleket не настроен: добавьте HELEKET_MERCHANT_ID и HELEKET_API_KEY в .env');
  const rub = Math.max(1, Math.floor(Number((ctx.match || '').trim()) || 300));
  const tokens = rub * TOKENS_PER_RUB;
  try {
    const r = await heleketCreate(user(ctx.from.id, ctx.from.first_name), rub, tokens);
    await ctx.reply(`Счёт на ${rub} ₽ (${tokens} ⬦) · Heleket: USDT, BTC, ETH`,
      { reply_markup: new InlineKeyboard().url('🪙 Оплатить криптой', r.pay_url) });
  } catch (e) { await ctx.reply('Не удалось создать счёт Heleket: ' + (e.message || e)); }
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

  try {
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
    const tgUser = checkInitData(body.initData || url.searchParams.get('initData'));

    /* вебхук CryptoBot (подпись = HMAC-SHA256(rawBody, SHA256(token))) */
    if (url.pathname === '/cryptobot-webhook' && req.method === 'POST') {
      if (!CRYPTOBOT_TOKEN) return send(400, { error: 'CryptoBot не настроен' });
      const secret = crypto.createHash('sha256').update(CRYPTOBOT_TOKEN).digest();
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (sig !== req.headers['crypto-pay-api-signature']) return send(403, { error: 'bad signature' });
      const upd = body;
      if (upd.update_type === 'invoice_paid' && upd.payload && upd.payload.status === 'paid') {
        const r = await checkCryptoInvoice(upd.payload.invoice_id);
        return send(200, { ok: true, ...r });
      }
      return send(200, { ok: true, ignored: true });
    }

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

    /* вебхук Heleket: подпись = md5(base64(тело без sign) + API_KEY) */
    if (url.pathname === '/heleket-webhook' && req.method === 'POST') {
      if (!heleketOn() || !heleketVerify(body)) return send(403, { error: 'bad signature' });
      const st = String(body.status || '');
      if (st === 'paid' || st === 'paid_over') return send(200, { ok: true, ...(await heleketCredit(body.uuid, body.order_id)) });
      if (st === 'cancel' || st === 'fail' || st === 'system_fail') {
        const order = orders.get(String(body.order_id || ''));
        if (order && order.status !== 'paid') order.status = 'canceled';
      }
      return send(200, { ok: true, status: st });
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

      u.tokens += 50;
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
      u.tokens += cashback;
      u.cashbackClaimedDepositId = u.lastDepositId;
      u.lastCashbackAt = now;
      return send(200, { success: true, cashback, tokens: u.tokens });
    }

    /* Заявка на вывод средств (минимум 50 ₽ = 500 токенов) */
    if (url.pathname === '/api/withdraw' && req.method === 'POST') {
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

      u.tokens -= neededTokens;
      const orderId = 'WD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
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
        success: true,
        orderId,
        rub,
        tokens: neededTokens,
        remaining: u.tokens
      });
    }

    /* стейкинг */
    if (url.pathname === '/api/stake' && req.method === 'POST') {
      const r = stakeAdd(u, body.tokens);
      return send(r.error ? 400 : 200, { ...r, staked: u.staked, accrued: stakeAccrued(u), tokens: u.tokens });
    }
    if (url.pathname === '/api/claim' && req.method === 'POST') {
      const r = stakeClaim(u);
      return send(r.error ? 400 : 200, { ...r, staked: u.staked, accrued: stakeAccrued(u) });
    }
    if (url.pathname === '/api/unstake' && req.method === 'POST') {
      const r = stakeRemove(u, body.all !== false);
      return send(r.error ? 400 : 200, { ...r, accrued: stakeAccrued(u) });
    }
    if (url.pathname === '/api/refs') {
      const invited = [...users.values()].filter(x => Number(x.ref) === u.id).map(x => ({ name: x.name, tokens: Math.round(x.tokens) }));
      return send(200, { code: u.code, link: refLink(u.code), invited: countInvited(u.id), earned: Math.round(u.refEarned || 0),
                         percent: REF_PERCENT, list: invited });
    }

    /* оплата: требуется принятое соглашение */
    if (url.pathname === '/api/invoice' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || 0));
      const link = await starsInvoiceLink(u.id, tokens);
      return send(200, { invoice_link: link, tokens });
    }
    if (url.pathname === '/api/crypto-invoice' && req.method === 'POST') {
      if (!u.termsAt && !body.termsAcceptedAt) return send(403, { error: 'Сначала примите пользовательское соглашение' });
      if (!CRYPTOBOT_TOKEN) return send(503, { error: 'CryptoBot не настроен' });
      const rub = Math.max(1, Math.floor(Number(body.rub) || 0));
      const tokens = Math.max(10, Math.floor(Number(body.tokens) || rub * TOKENS_PER_RUB));
      const inv = await createCryptoInvoice(u.id, tokens, rub);
      return send(200, inv);
    }
    if (url.pathname === '/api/check-crypto' && req.method === 'POST') {
      const r = await checkCryptoInvoice(body.invoice_id);
      return send(200, { ...r, tokens: u.tokens, staked: u.staked });
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
        return send(200, { error: String(e.message || e), tokens });
      }
    }
    if (url.pathname === '/api/check-heleket' && req.method === 'POST') {
      const uuid = String(body.invoice_id || '');
      let r = { paid: false };
      try {
        const local = heleketInv.get(uuid);
        if (local && local.status === 'paid') r = await heleketCredit(uuid, local.orderId);
        else {
          const info = await heleketInfo(uuid);
          const st = String((info && (info.payment_status || info.status)) || '');
          if (st === 'paid' || st === 'paid_over') r = await heleketCredit(uuid, info.order_id);
          else r = { paid: false, status: st };
        }
      } catch (e) { r = { paid: false, error: String(e.message || e) }; }
      return send(200, { ...r, balance: u.tokens, staked: u.staked, tokens: r.tokens || u.tokens });
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

    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e.message || e) });
  }
});

server.listen(API_PORT, () => console.log(`API: http://localhost:${API_PORT}`));
/* BOT_DRY_RUN=1 — не опрашивать Telegram (используется автотестами) */
if (process.env.BOT_DRY_RUN === '1') console.log('BOT_DRY_RUN: опрос Telegram отключён');
else bot.start();
console.log('Бот запущен. Стейкинг 1 %/сутки, рефералы ' + REF_PERCENT + ' %'
  + ' · Platega: ' + (plategaOn() ? 'вкл' : 'выкл')
  + ' · Heleket: ' + (heleketOn() ? 'вкл' : 'выкл')
  + ' · CryptoBot: ' + (CRYPTOBOT_TOKEN ? 'вкл' : 'выкл')
  + (PUBLIC_URL ? ' · вебхуки: ' + PUBLIC_URL : ' · PUBLIC_URL не задан: вебхуки не придут, работает опрос статуса'));
