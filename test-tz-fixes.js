'use strict';
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.BOT_DRY_RUN = '1';
process.env.API_PORT = '3098';
process.env.PORT = '3098';
process.env.APP_URL = 'http://127.0.0.1:3098';
process.env.BOT_USERNAME = 'moneyforup_bot';

const db = require('./db.js');
require('./bot.js');

function makeInitData(userId, name) {
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

async function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    let p = path;
    const bodyObj = opts.body || {};
    if (opts.initData) {
      if (opts.method === 'POST') {
        bodyObj.initData = opts.initData;
      } else {
        p += (p.includes('?') ? '&' : '?') + 'initData=' + encodeURIComponent(opts.initData);
      }
    }

    const u = new URL(p, 'http://127.0.0.1:3098');
    const req = http.request(u, {
      method: opts.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(opts.headers || {})
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (_) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (opts.method === 'POST') {
      req.write(JSON.stringify(bodyObj));
    }
    req.end();
  });
}

async function run() {
  await new Promise(r => setTimeout(r, 600));
  console.log('🧪 Тестирование доработок по ТЗ (Реферальный баннер, Кэшбэк, Упрощение аналитики)...');

  // --- ТЕСТ 1: Проверка HTML интерфейса ---
  const html = fs.readFileSync('index.html', 'utf8');
  const pubHtml = fs.readFileSync('public/index.html', 'utf8');

  assert.strictEqual(html, pubHtml, 'index.html and public/index.html must be 100% byte identical');
  console.log('✓ 1. Файлы index.html и public/index.html побайтово идентичны');

  // Проверка реферального баннера на главном экране
  assert.strictEqual(html.includes('id="gamesRefPromoBanner"'), true, 'gamesRefPromoBanner must be present');
  assert.strictEqual(html.includes('Приглашай друзей'), true, 'Promo text must be present');
  assert.strictEqual(html.includes('15%'), true, '15% must be mentioned in referral promo');
  console.log('✓ 2. Акция приглашения друзей размещена на главном экране (15% + кейс за 5 друзей)');

  // Проверка упрощения аналитики
  assert.strictEqual(html.includes('id="uStatWinRate"'), false, 'Winrate stat must be removed from user profile');
  assert.strictEqual(html.includes('id="uStatWinLost"'), false, 'Win/loss counts must be removed from user profile');
  assert.strictEqual(html.includes('id="userGamesBreakdown"'), false, 'Detailed breakdown table must be removed from user profile');
  assert.strictEqual(html.includes('id="uStatMaxWin"'), true, 'uStatMaxWin (Лучший дроп) must be present');
  assert.strictEqual(html.includes('id="uStatFavGame"'), true, 'uStatFavGame (Любимый режим) must be present');
  console.log('✓ 3. Аналитика выигрышей/проигрышей скрыта для игроков; оставлены карточки «Лучший дроп» и «Любимый режим»');

  // --- ТЕСТ 2: Проверка логики Кэшбэка (/api/claim-cashback) ---
  const noDepUserId = 991000 + Math.floor(Math.random() * 10000);
  const noDepInitData = makeInitData(noDepUserId, 'NoDepUser');

  // Создаем пользователя без депозитов в БД
  db.saveUser({
    id: noDepUserId,
    numId: noDepUserId,
    name: 'NoDepUser',
    username: 'NoDepUser',
    tokens: 100,
    staked: 0,
    stakeSince: 0,
    accruedBase: 0,
    ref: 0,
    refEarned: 0,
    refInvited: 0,
    termsAt: Date.now(),
    totalDepositedRub: 0,
    lastDeposit: 0,
    lastDepositId: 0,
    cashbackClaimedDepositId: 0,
    lastCashbackAt: 0,
    rakeback: 0,
    code: 'MF' + noDepUserId
  });

  // 1. Запрос кэшбэка БЕЗ пополнений -> 400
  let res = await request('/api/claim-cashback', { method: 'POST', initData: noDepInitData, body: {} });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error, 'У вас ещё нет подтверждённых пополнений');
  console.log('✓ 4. Кэшбэк без депозита корректно отклонён сервером: ' + res.data.error);

  // 2. Пользователь с подтвержденным пополнением на 1000 ₽ (10 000 ⬦)
  const depUserId = 992000 + Math.floor(Math.random() * 10000);
  const depInitData = makeInitData(depUserId, 'DepUser');

  db.saveUser({
    id: depUserId,
    numId: depUserId,
    name: 'DepUser',
    username: 'DepUser',
    tokens: 100,
    staked: 0,
    stakeSince: 0,
    accruedBase: 0,
    ref: 0,
    refEarned: 0,
    refInvited: 0,
    termsAt: Date.now(),
    totalDepositedRub: 1000,
    lastDeposit: 1000,
    lastDepositId: 1,
    cashbackClaimedDepositId: 0,
    lastCashbackAt: 0,
    rakeback: 0,
    code: 'MF' + depUserId
  });

  // 3. Запрос кэшбэка ПОСЛЕ пополнения -> успешное начисление
  res = await request('/api/claim-cashback', { method: 'POST', initData: depInitData, body: {} });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  // При 1000 ₽ ранг «Серебро» (3.5% кэшбэка от 10 000 ⬦ = 350 ⬦)
  assert.strictEqual(res.data.cashback, 350);
  assert.strictEqual(res.data.cbPct, 3.5);
  console.log(`✓ 5. Кэшбэк успешно начислен сервером: +${res.data.cashback} ⬦ (ставка VIP ${res.data.cbPct}%)`);

  // 4. Повторный запрос (идемпотентность / двойной клик) -> должен быть отклонён сервером
  res = await request('/api/claim-cashback', { method: 'POST', initData: depInitData, body: {} });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error.includes('уже получен'), true);
  console.log('✓ 6. Повторный запрос кэшбэка отклонён (идемпотентность соблюдена): ' + res.data.error);

  console.log('\n🎉 ВСЕ ТЕСТЫ ДОРАБОТОК ПО ТЗ УСПЕШНО ПРОЙДЕНЫ!');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Ошибка теста:', err);
  process.exit(1);
});
