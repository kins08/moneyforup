/* Интеграционный тест срока жизни заявки на пополнение (1 час в проде).
   Поднимает bot.js в BOT_DRY_RUN на временной БД и укорачивает TTL через
   DEPOSIT_TTL_MS, чтобы проверить истечение без ожидания часа.

   Запуск: node test-order-ttl.js                                              */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BOT_TOKEN = '123456789:AAaaBBccDDeeFFggHHiiJJkkLLmmNNoo';
const API_PORT = 3955;
const TTL_MS = 5000;
const ADMIN_ID = 111;

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function initData(userId, name) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'q' + userId + Date.now(),
    user: JSON.stringify({ id: userId, first_name: name })
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const A = { id: ADMIN_ID, data: initData(ADMIN_ID, 'Админ') };
const call = async (path_, payload) => {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${path_}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {})
  });
  return { status: res.status, body: await res.json() };
};

let bot;
(async () => {
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-ttl-')), 'ttl.db');
  bot = spawn(process.execPath, [path.join(__dirname, 'bot.js')], {
    env: {
      ...process.env,
      BOT_TOKEN, API_PORT: String(API_PORT), BOT_DRY_RUN: '1', ADMIN_ID: String(ADMIN_ID),
      APP_URL: 'https://app.test/moneyforup-tg.html', PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
      DB_PATH: tmpDb, BOT_USERNAME: 'your_bot', DEPOSIT_TTL_MS: String(TTL_MS),
      TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let botLog = '';
  bot.stdout.on('data', d => botLog += d);
  bot.stderr.on('data', d => botLog += d);
  const stop = () => { try { bot.kill(); } catch (_) {} };
  process.on('exit', stop);

  for (let i = 0; i < 60; i++) {
    await sleep(150);
    try {
      if ((await fetch(`http://127.0.0.1:${API_PORT}/api/balance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: A.data })
      })).status) break;
    } catch {}
  }

  await call('/api/balance', { initData: A.data });
  await call('/api/terms', { initData: A.data });

  const created = await call('/api/order-sbp', {
    initData: A.data, rub: 150, tokens: 1500, bank: 'Т-Банк', card: '0000', termsAcceptedAt: Date.now()
  });
  check(created.status === 200 && created.body.order_id, 'заявка создана: ' + (created.body.order_id || created.body.error));
  check(created.body.ttlMs === TTL_MS, 'сервер вернул TTL ' + created.body.ttlMs + ' мс');
  check(created.body.expiresAt - Date.now() <= TTL_MS && created.body.expiresAt > Date.now(),
        'expiresAt выставлен в пределах TTL');

  const mine1 = await call('/api/my-orders', { initData: A.data });
  const first = (mine1.body.orders || [])[0] || {};
  check(first.id === created.body.order_id && first.status === 'pending', 'в профиле заявка pending: ' + first.status);
  check(first.expiresAt === created.body.expiresAt, 'в профиле тот же expiresAt');

  await sleep(TTL_MS + 1500);

  const checked = await call('/api/check-order', { initData: A.data, order_id: created.body.order_id });
  check(checked.body.status === 'expired', 'после TTL статус expired: ' + checked.body.status);

  const overview = await call('/api/admin/overview', { initData: A.data, period: 'all' });
  const dep = (overview.body.deposits || []).find(o => o.id === created.body.order_id) || {};
  check(dep.status === 'expired', 'админка видит expired: ' + dep.status);
  check(Number(overview.body.adminMetrics.summary.expiredDeposits24h) >= 1,
        'метрика expiredDeposits24h ≥ 1: ' + overview.body.adminMetrics.summary.expiredDeposits24h);

  const act = await call('/api/admin/order-action', {
    initData: A.data, orderId: created.body.order_id, action: 'ok'
  });
  check(act.status === 400 && /истекла/i.test(act.body.error || ''),
        'просроченную заявку нельзя подтвердить: ' + act.status + ' ' + (act.body.error || ''));

  const mine2 = await call('/api/my-orders', { initData: A.data });
  const second = (mine2.body.orders || [])[0] || {};
  check(second.status === 'expired', 'в профиле статус expired: ' + second.status);
  check(botLog.includes('истекла'), 'в логе бота есть запись об истечении');

  stop();
  console.log('\nOK:', ok.length);
  ok.forEach(m => console.log(' ✓', m));
  if (bad.length) {
    console.log('\nFAIL:', bad.length);
    bad.forEach(m => console.log(' ✗', m));
    console.log('\n--- bot log ---\n' + botLog.slice(-4000));
    process.exit(1);
  }
})().catch(e => {
  console.error('TEST CRASH:', e);
  if (bot) try { bot.kill(); } catch (_) {}
  process.exit(1);
});
