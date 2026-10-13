/* Интеграционный тест бэкенда (bot/bot.js): Platega, Heleket, соглашение, реферальные 15 %.
   Поднимает мок-сервер платёжек и сам бот в режиме BOT_DRY_RUN=1 (без опроса Telegram).

   Запуск:  cd tests && node bot-test.js                     */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const BOT_TOKEN = '123456789:AAaaBBccDDeeFFggHHiiJJkkLLmmNNoo';
const API_PORT = 3910;
const MOCK_PORT = 3999;
const PLATEGA = { id: 'merchant-777', secret: 'secret-888' };
const HELEKET = { merchant: 'uuid-1', key: 'heleket-key-1' };

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- мок платёжных провайдеров ---------- */
const seen = { plategaCreate: null, plategaAuth: null, heleketCreate: null, heleketSignOk: null, plategaOrders: {} };
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
    return json(200, { transactionId: 'tx-' + (Object.keys(seen.plategaOrders).length), status: 'PENDING',
                       url: 'https://pay.test/platega/' + encodeURIComponent(body.payload), expiresIn: '00:15:00' });
  }
  if (req.url.startsWith('/transaction/') && req.method === 'GET') return json(200, { status: 'CONFIRMED', amount: 300, currency: 'RUB' });

  /* Heleket */
  if (req.url === '/v1/payment' && req.method === 'POST') {
    const sign = crypto.createHash('md5').update(Buffer.from(raw, 'utf8').toString('base64') + HELEKET.key).digest('hex');
    seen.heleketSignOk = sign === req.headers.sign && req.headers.merchant === HELEKET.merchant;
    seen.heleketCreate = body;
    if (!seen.heleketSignOk) return json(401, { state: 1, message: 'bad sign' });
    return json(200, { state: 0, result: { uuid: 'hl-uuid-1', url: 'https://pay.test/heleket/hl-uuid-1', order_id: body.order_id,
                                            payment_status: 'check', amount: body.amount, currency: body.currency } });
  }
  if (req.url === '/v1/payment/info' && req.method === 'POST') {
    const sign = crypto.createHash('md5').update(Buffer.from(raw, 'utf8').toString('base64') + HELEKET.key).digest('hex');
    if (sign !== req.headers.sign) return json(401, { state: 1, message: 'bad sign' });
    return json(200, { state: 0, result: { uuid: body.uuid, order_id: seen.heleketCreate.order_id, payment_status: 'paid' } });
  }
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
  bot = spawn(process.execPath, [path.join(__dirname, '..', 'bot', 'bot.js')], {
    env: { ...process.env,
      BOT_TOKEN, API_PORT: String(API_PORT), BOT_DRY_RUN: '1', APP_URL: 'https://app.test/moneyforup-tg.html',
      PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
      PLATEGA_MERCHANT_ID: PLATEGA.id, PLATEGA_SECRET: PLATEGA.secret, PLATEGA_API: `http://127.0.0.1:${MOCK_PORT}`,
      HELEKET_MERCHANT_ID: HELEKET.merchant, HELEKET_API_KEY: HELEKET.key, HELEKET_API: `http://127.0.0.1:${MOCK_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  bot.stderr.on('data', d => bad.push('ОШИБКА БОТА: ' + String(d).trim().slice(0, 200)));
  for (let i = 0; i < 40; i++) { await sleep(150); try { if ((await fetch(`http://127.0.0.1:${API_PORT}/api/balance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status) break; } catch {} }

  /* 1. защита initData */
  check((await call('/api/balance', { initData: 'query_id=x&user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeef' })).status === 401,
        'подделанный initData отбит (401)');

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
  if (refsA.invited !== 1) console.log('DEBUG refs:', JSON.stringify(refsA), 'REG:', JSON.stringify(reg.body));
  check(refsA.invited === 1, 'в статистике Ани 1 приглашённый');
  check(refsA.code === codeA, 'код в статистике совпадает с выданным: ' + refsA.code);

  /* 3. соглашение обязательно */
  check((await call('/api/platega-invoice', { initData: B.data, rub: 300 })).status === 403, 'без соглашения счёт Platega не создаётся (403)');
  check((await call('/api/heleket-invoice', { initData: B.data, rub: 300 })).status === 403, 'без соглашения счёт Heleket не создаётся (403)');
  await call('/api/terms', { initData: B.data });

  /* 4. Platega: счёт */
  const pl = await call('/api/platega-invoice', { initData: B.data, rub: 300, tokens: 3000 });
  check(pl.status === 200 && /pay\.test\/platega/.test(pl.body.pay_url || ''), 'Platega: счёт создан, ссылка ' + (pl.body.pay_url || '(нет)'));
  check(seen.plategaAuth && seen.plategaAuth.id === PLATEGA.id && seen.plategaAuth.secret === PLATEGA.secret, 'Platega: авторизация заголовками X-MerchantId/X-Secret');
  check(seen.plategaCreate && seen.plategaCreate.paymentDetails && seen.plategaCreate.paymentDetails.amount === 300 && seen.plategaCreate.paymentDetails.currency === 'RUB',
        'Platega: сумма 300 RUB в paymentDetails');
  check(seen.plategaCreate && String(seen.plategaCreate.metadata.userId) === String(B.id), 'Platega: передан metadata.userId (антифрод)');

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

  /* 6. Heleket: счёт */
  const hl = await call('/api/heleket-invoice', { initData: B.data, rub: 300, tokens: 3000 });
  check(hl.status === 200 && /pay\.test\/heleket/.test(hl.body.pay_url || ''), 'Heleket: счёт создан, ссылка ' + (hl.body.pay_url || '(нет)'));
  check(seen.heleketSignOk === true, 'Heleket: подпись запроса md5(base64(body) + API_KEY) верна');
  check(seen.heleketCreate && seen.heleketCreate.currency === 'RUB' && seen.heleketCreate.amount === '300.00', 'Heleket: сумма 300.00 RUB');
  check(seen.heleketCreate && seen.heleketCreate.url_callback === `http://127.0.0.1:${API_PORT}/heleket-webhook`, 'Heleket: url_callback указывает на бэкенд');

  /* 7. Heleket: вебхук с подписью */
  const signOf = obj => crypto.createHash('md5').update(Buffer.from(JSON.stringify(obj), 'utf8').toString('base64') + HELEKET.key).digest('hex');
  const hookHl = async payload => {
    const withSign = { ...payload };
    withSign.sign = signOf(payload);
    const res = await fetch(`http://127.0.0.1:${API_PORT}/heleket-webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withSign)
    });
    return { status: res.status, body: await res.json() };
  };
  const bBeforeHl = await balance(B);
  const badSign = await hookHl({ uuid: 'hl-uuid-1', order_id: seen.heleketCreate.order_id, status: 'paid', amount: '300', sign: 'deadbeef' });
  check(badSign.status === 403, 'Heleket: поддельная подпись отбита (403)');
  const hlOk = await hookHl({ type: 'payment', uuid: 'hl-uuid-1', order_id: seen.heleketCreate.order_id, status: 'paid', amount: '300', payment_amount: '300', merchant_amount: '298', is_final: true });
  check(hlOk.status === 200 && hlOk.body.credited === true, 'Heleket: вебхук paid зачислен');
  check((await balance(B)) === bBeforeHl + 3000, 'Heleket: баланс Бориса ' + bBeforeHl + ' → ' + (await balance(B)) + ' (+3000 ⬦)');
  const hlChk = await call('/api/check-heleket', { initData: B.data, invoice_id: 'hl-uuid-1' });
  check(hlChk.body.paid === true, 'Heleket: опрос /api/check-heleket подтверждает оплату');

  /* 8. итог: Аня получила 15 % ещё и со второго пополнения */
  const aEnd = await balance(A);
  check(aEnd === aBefore + 900, 'реферальные 15 % с двух пополнений: Аня ' + aBefore + ' → ' + aEnd + ' (+900 ⬦)');

  console.log('\n=== ПРОШЛО (' + ok.length + ') ===');
  ok.forEach(m => console.log('  ✓ ' + m));
  if (bad.length) { console.log('\n=== ПРОВАЛЫ (' + bad.length + ') ==='); bad.forEach(m => console.log('  ✗ ' + m)); }
  bot.kill('SIGKILL'); mock.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('ТЕСТ УПАЛ:', e.stack); if (bot) bot.kill('SIGKILL'); mock.close(); process.exit(2); });
