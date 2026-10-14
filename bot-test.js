/* Интеграционный тест бэкенда (bot.js): Platega, Coinso, соглашение, реферальные 15 %.
   Поднимает мок-серверы платёжек и сам бот в режиме BOT_DRY_RUN=1 (без опроса Telegram),
   в изолированной временной БД (DB_PATH в /tmp — боевая data/ не трогается).

   Запуск:  node bot-test.js        (или npm test)                                   */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BOT_TOKEN = '123456789:AAaaBBccDDeeFFggHHiiJJkkLLmmNNoo';
const API_PORT = 3910;
const MOCK_PORT = 3999;
const PLATEGA = { id: 'merchant-777', secret: 'secret-888' };
const COINSO = { project: '4242', secret: 'coinso-secret-1' };

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- мок платёжных провайдеров ---------- */
const seen = { plategaCreate: null, plategaAuth: null, plategaOrders: {}, coinsoCreate: null, coinsoAuth: null };
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  /* Platega */
  if (req.url === '/transaction/process' && req.method === 'POST') {
    seen.plategaAuth = { id: req.headers['x-merchantid'], secret: req.headers['x-secret'] };
    seen.plategaCreate = body;
    seen.plategaOrders[body.payload] = body;
    return json(200, { transactionId: 'tx-' + Object.keys(seen.plategaOrders).length, status: 'PENDING',
                       url: 'https://pay.test/platega/' + encodeURIComponent(body.payload), expiresIn: '00:15:00' });
  }
  if (req.url.startsWith('/transaction/') && req.method === 'GET') return json(200, { status: 'CONFIRMED', amount: 300, currency: 'RUB' });

  /* Coinso: POST /payment/create, GET /payment/status?uuid=... */
  if (req.url === '/payment/create' && req.method === 'POST') {
    seen.coinsoAuth = req.headers.authorization;
    seen.coinsoCreate = body;
    return json(200, { payment_url: 'https://pay.test/coinso/' + encodeURIComponent(body.custom),
                       invoice_id: 'coin-inv-1' });
  }
  if (req.url.startsWith('/payment/status') && req.method === 'GET') return json(200, { status: 'paid' });

  json(404, { error: 'mock: ' + req.url });
});

/* ---------- initData как его подписывает Telegram ---------- */
function initData(userId, name) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'q' + userId,
    user: JSON.stringify({ id: userId, first_name: name })
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}
const A = { id: 111, name: 'Аня', data: initData(111, 'Аня') };
const B = { id: 222, name: 'Борис', data: initData(222, 'Борис') };

const call = async (path_, payload) => {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${path_}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {})
  });
  return { status: res.status, body: await res.json() };
};
const balance = async who => (await call('/api/balance', { initData: who.data })).body.tokens;

/* ---------- запуск ---------- */
let bot;
(async () => {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-test-')), 'test.db');
  bot = spawn(process.execPath, [path.join(__dirname, 'bot.js')], {
    env: { ...process.env,
      BOT_TOKEN, API_PORT: String(API_PORT), BOT_DRY_RUN: '1', APP_URL: 'https://app.test/moneyforup-tg.html',
      PUBLIC_URL: `http://127.0.0.1:${API_PORT}`, DB_PATH: tmpDb, BOT_USERNAME: 'your_bot',
      PLATEGA_MERCHANT_ID: PLATEGA.id, PLATEGA_SECRET: PLATEGA.secret, PLATEGA_API: `http://127.0.0.1:${MOCK_PORT}`,
      COINSO_PROJECT_ID: COINSO.project, COINSO_SECRET_KEY: COINSO.secret, COINSO_API: `http://127.0.0.1:${MOCK_PORT}`,
      TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let botLog = '';
  bot.stdout.on('data', d => botLog += d);
  bot.stderr.on('data', d => botLog += d);
  for (let i = 0; i < 60; i++) { await sleep(150); try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/balance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status) break; } catch {} }
  if (!botLog && bot.exitCode !== null) throw new Error('бот не поднялся');

  /* 1. защита initData */
  check((await call('/api/balance', { initData: 'query_id=x&user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeef' })).status === 401,
        'подделанный initData отбит (401)');

  /* 1b. auth_date из будущего (P1-3) */
  const future = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) + 3600), query_id: 'qf', user: JSON.stringify({ id: 111, first_name: 'Аня' }) });
  {
    const dcs = [...future.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    future.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  }
  check((await call('/api/balance', { initData: future.toString() })).status === 401,
        'initData с auth_date из будущего отбит (401, P1-3)');

  /* 1c. initData двухчасовой давности принимается: Telegram не обновляет
     auth_date внутри открытой сессии WebApp (иначе игры умирают через 5 минут) */
  const old2h = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - 2 * 3600), query_id: 'qo', user: JSON.stringify({ id: 111, first_name: 'Аня' }) });
  {
    const dcs = [...old2h.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    old2h.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  }
  check((await call('/api/balance', { initData: old2h.toString() })).status === 200,
        'initData 2-часовой давности принят (сессия WebApp живёт дольше 5 минут)');

  /* 2. реферальные коды: уникальность и ссылка */
  const codeA = (await call('/api/balance', { initData: A.data })).body.refCode;
  const codeB = (await call('/api/balance', { initData: B.data })).body.refCode;
  check(/^MF[A-HJ-NP-Z2-9]{6}$/.test(codeA || ''), 'сервер выдал код формата MF + 6 символов: ' + codeA);
  check(codeA !== codeB, 'коды у разных пользователей уникальны: ' + codeA + ' / ' + codeB);
  const refs0 = (await call('/api/refs', { initData: A.data })).body;
  check(refs0.link === `https://t.me/your_bot?startapp=${codeA}`, 'ссылка приглашения собрана из кода: ' + refs0.link);

  /* 3. регистрация по коду пригласившего */
  const reg = await call('/api/register', { initData: B.data, startParam: codeA, termsAcceptedAt: 0 });
  check(reg.body.referredBy === A.id, 'Борис пришёл по коду Ани (referredBy=' + reg.body.referredBy + ')');
  const reReg = await call('/api/register', { initData: B.data, startParam: String(A.id), termsAcceptedAt: 0 });
  check(reReg.body.referredBy === A.id, 'повторная регистрация не меняет пригласившего (обратная совместимость с числовым id)');
  const aBefore = await balance(A);
  const refsA = (await call('/api/refs', { initData: A.data })).body;
  check(refsA.invited === 1, 'в статистике Ани 1 приглашённый');
  check(refsA.code === codeA, 'код в статистике совпадает с выданным: ' + refsA.code);

  /* 3. соглашение обязательно */
  check((await call('/api/platega-invoice', { initData: B.data, rub: 300 })).status === 403, 'без соглашения счёт Platega не создаётся (403)');
  check((await call('/api/coinso-invoice', { initData: B.data, rub: 300 })).status === 403, 'без соглашения счёт Coinso не создаётся (403)');
  await call('/api/terms', { initData: B.data });

  /* 4. Platega: счёт */
  const pl = await call('/api/platega-invoice', { initData: B.data, rub: 300, tokens: 3000 });
  check(pl.status === 200 && /pay\.test\/platega/.test(pl.body.pay_url || ''), 'Platega: счёт создан, ссылка ' + (pl.body.pay_url || '(нет)'));
  check(seen.plategaAuth && seen.plategaAuth.id === PLATEGA.id && seen.plategaAuth.secret === PLATEGA.secret, 'Platega: авторизация заголовками X-MerchantId/X-Secret');
  check(seen.plategaCreate && seen.plategaCreate.paymentDetails && seen.plategaCreate.paymentDetails.amount === 300 && seen.plategaCreate.paymentDetails.currency === 'RUB',
        'Platega: сумма 300 RUB в paymentDetails');
  check(seen.plategaCreate && String(seen.plategaCreate.metadata.userId) === String(B.id), 'Platega: передан metadata.userId (антифрод)');
  check(/^PL[0-9a-f]{32}$/.test(pl.body.order_id || seen.plategaCreate.payload || ''), 'Platega: orderId непредсказуем, 16 байт энтропии (P1-4): ' + pl.body.order_id);

  /* 5. Platega: вебхук */
  const bBefore = await balance(B);
  const hookBad = await call('/platega-webhook', { id: 'tx-1', amount: 300, currency: 'RUB', status: 'CONFIRMED', payload: seen.plategaCreate.payload });
  check(hookBad.status === 403, 'Platega: вебхук без заголовков отбит (403)');

  const hook = async (payload, headers) => {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/platega-webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
    });
    return { status: res.status, body: await res.json() };
  };
  const good = { 'X-MerchantId': PLATEGA.id, 'X-Secret': PLATEGA.secret };
  const h1 = await hook({ id: 'tx-1', amount: 300, currency: 'RUB', status: 'CONFIRMED', paymentMethod: 2, payload: seen.plategaCreate.payload }, good);
  check(h1.status === 200 && h1.body.credited === true, 'Platega: вебхук CONFIRMED зачислил токены');
  check((await balance(B)) === bBefore + 3000, 'Platega: баланс Бориса ' + bBefore + ' → ' + (await balance(B)) + ' (+3000 ⬦)');
  check((await balance(A)) === aBefore + 450, 'реферальные 15 %: Аня получила +450 ⬦ (' + aBefore + ' → ' + (await balance(A)) + ')');

  const h2 = await hook({ id: 'tx-1', amount: 300, currency: 'RUB', status: 'CONFIRMED', payload: seen.plategaCreate.payload }, good);
  check(h2.body.already === true && (await balance(B)) === bBefore + 3000, 'Platega: повторный вебхук не зачисляет дважды (идемпотентность)');
  const chk = await call('/api/check-platega', { initData: B.data, invoice_id: pl.body.invoice_id });
  check(chk.body.paid === true, 'Platega: опрос /api/check-platega подтверждает оплату');

  /* 5b. Platega: параллельный шторм вебхуков + опроса не зачисляет дважды (P2-4) */
  const pl2 = await call('/api/platega-invoice', { initData: B.data, rub: 300, tokens: 3000 });
  const bBeforeStorm = await balance(B);
  const storm = await Promise.all([
    hook({ id: 'tx-2', amount: 300, currency: 'RUB', status: 'CONFIRMED', payload: pl2.body.order_id }, good),
    hook({ id: 'tx-2', amount: 300, currency: 'RUB', status: 'CONFIRMED', payload: pl2.body.order_id }, good),
    hook({ id: 'tx-2', amount: 300, currency: 'RUB', status: 'CONFIRMED', payload: pl2.body.order_id }, good),
    call('/api/check-platega', { initData: B.data, invoice_id: pl2.body.invoice_id }),
    call('/api/check-platega', { initData: B.data, invoice_id: pl2.body.invoice_id })
  ]);
  check(storm.filter(r => r.body && r.body.credited).length === 1, 'Platega: из 5 параллельных попыток зачислила ровно одна (P2-4)');
  check((await balance(B)) === bBeforeStorm + 3000, 'Platega: после шторма баланс ' + bBeforeStorm + ' → ' + (await balance(B)) + ' (ровно +3000 ⬦)');

  /* 6. Coinso: счёт */
  const cs = await call('/api/coinso-invoice', { initData: B.data, rub: 300, tokens: 3000 });
  check(cs.status === 200 && /pay\.test\/coinso/.test(cs.body.pay_url || ''), 'Coinso: счёт создан, ссылка ' + (cs.body.pay_url || '(нет)'));
  check(seen.coinsoAuth === 'Bearer ' + COINSO.secret, 'Coinso: авторизация Bearer COINSO_SECRET_KEY');
  check(seen.coinsoCreate && Number(seen.coinsoCreate.project_id) === Number(COINSO.project) && seen.coinsoCreate.amount === 300, 'Coinso: project_id и сумма 300 RUB');
  check(/^MF_COIN_[0-9a-f]{32}$/.test(cs.body.order_id || ''), 'Coinso: orderId непредсказуем, 16 байт энтропии (P1-4): ' + cs.body.order_id);

  /* 7. Coinso: вебхук с подписью X-Signature = HMAC-SHA256(raw, COINSO_SECRET_KEY) */
  const hookCs = async (payload, sign) => {
    const rawBody = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (sign !== null) headers['X-Signature'] = sign !== undefined ? sign : crypto.createHmac('sha256', COINSO.secret).update(rawBody).digest('hex');
    const res = await fetch(`http://127.0.0.1:${API_PORT}/coinso-webhook`, { method: 'POST', headers, body: rawBody });
    return { status: res.status, body: await res.json() };
  };
  const bBeforeCs = await balance(B);
  check((await hookCs({ custom: cs.body.order_id, event: 'payment.success', invoice_id: cs.body.invoice_id }, null)).status === 403,
        'Coinso: вебхук без подписи отбит (403)');
  check((await hookCs({ custom: cs.body.order_id, event: 'payment.success', invoice_id: cs.body.invoice_id }, 'deadbeef'.repeat(8))).status === 403,
        'Coinso: поддельная подпись отбита (403)');
  const csOk = await hookCs({ custom: cs.body.order_id, event: 'payment.success', invoice_id: cs.body.invoice_id });
  check(csOk.status === 200 && csOk.body.credited === true, 'Coinso: вебхук payment.success зачислен');
  check((await balance(B)) === bBeforeCs + 3000, 'Coinso: баланс Бориса ' + bBeforeCs + ' → ' + (await balance(B)) + ' (+3000 ⬦)');
  const csAgain = await hookCs({ custom: cs.body.order_id, event: 'payment.success', invoice_id: cs.body.invoice_id });
  check(csAgain.body.credited !== true && (await balance(B)) === bBeforeCs + 3000, 'Coinso: повторный вебхук не зачисляет дважды (идемпотентность)');
  const csChk = await call('/api/check-coinso', { initData: B.data, invoice_id: cs.body.invoice_id, order_id: cs.body.order_id });
  check(csChk.body.paid === true, 'Coinso: опрос /api/check-coinso подтверждает оплату');

  /* 8. итог: Аня получила 15 % со всех трёх пополнений Бориса */
  const aEnd = await balance(A);
  check(aEnd === aBefore + 1350, 'реферальные 15 % с трёх пополнений: Аня ' + aBefore + ' → ' + aEnd + ' (+1350 ⬦)');

  console.log('\n=== ПРОШЛО (' + ok.length + ') ===');
  ok.forEach(m => console.log('  ✓ ' + m));
  if (bad.length) { console.log('\n=== ПРОВАЛЫ (' + bad.length + ') ==='); bad.forEach(m => console.log('  ✗ ' + m)); }
  if (bad.length) console.log('\n--- лог бота (хвост) ---\n' + botLog.slice(-1500));
  bot.kill('SIGKILL'); mock.close();
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch {}
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('ТЕСТ УПАЛ:', e.stack); if (bot) bot.kill('SIGKILL'); mock.close(); process.exit(2); });
