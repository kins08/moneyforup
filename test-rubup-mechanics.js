'use strict';
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

// Config env before importing bot
const BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.BOT_DRY_RUN = '1';
process.env.API_PORT = '3099';
process.env.PORT = '3099';
process.env.APP_URL = 'http://127.0.0.1:3099';
process.env.BOT_USERNAME = 'moneyforup_bot';

const db = require('./db.js');
const bot = require('./bot.js');

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

    const u = new URL(p, 'http://127.0.0.1:3099');
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

function getOrCreateUser(id, name, refId = 0) {
  let u = db.getUser(id);
  if (!u) {
    u = {
      id,
      name,
      username: name,
      tokens: 50,
      staked: 0,
      stakeSince: 0,
      accruedBase: 0,
      ref: refId,
      refEarned: 0,
      refInvited: 0,
      termsAt: Date.now(),
      totalDepositedRub: 0,
      lastDeposit: 0,
      lastDepositId: null,
      rakeback: 0,
      code: 'MF' + id,
      freeCase5RefClaimed: 0
    };
    db.saveUser(u);
  }
  return u;
}

async function run() {
  await new Promise(r => setTimeout(r, 600));
  console.log('🧪 Запуск тестов механик RubUp (Бесплатный кейс за 5 друзей + Апгрейдер)...');

  const mainUserId = 880000 + Math.floor(Math.random() * 100000);
  const mainUserInitData = makeInitData(mainUserId, 'TestReferrer');

  // Регистрируем / инициализируем пользователя
  const mainUser = getOrCreateUser(mainUserId, 'TestReferrer');
  mainUser.freeCase5RefClaimed = 0;
  mainUser.tokens = 500;
  db.saveUser(mainUser);

  // 1. Проверяем статус кейса до приглашения 5 друзей
  let res = await request('/api/5ref-case/status', { initData: mainUserInitData });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.claimed, false);
  assert.strictEqual(res.data.canClaim, false);
  console.log('✓ 1. Начальный статус кейса: не получен, canClaim=false, qualified=' + res.data.qualified);

  // 2. Попытка открыть кейс без 5 друзей должна отклоняться
  res = await request('/api/5ref-case/open', { method: 'POST', initData: mainUserInitData, body: {} });
  assert.strictEqual(res.status, 400);
  console.log('✓ 2. Открытие кейса без 5 квалифицированных друзей отклонено (400)');

  // 3. Создаем 5 друзей и делаем их квалифицированными (сыграли 1 раунд)
  for (let i = 1; i <= 5; i++) {
    const friendId = mainUserId * 10 + i;
    const friend = getOrCreateUser(friendId, `Friend_${i}`, mainUser.id);
    friend.referredBy = mainUser.id;
    friend.ref = mainUser.id;
    friend.tokens = 100;
    db.saveUser(friend);

    // Добавляем раунд через db.saveRound
    db.saveRound({
      roundId: `FR_${friendId}_${Date.now()}_${i}`,
      userId: friendId,
      game: 'dice',
      bet: 10,
      mult: 2,
      win: 0,
      status: 'settled'
    });
  }

  const qCount = db.getQualifiedFriendsCount(mainUser.id);
  assert.strictEqual(qCount >= 5, true);
  console.log(`✓ 3. 5 друзей зарегистрированы и квалифицированы (в БД: ${qCount} квалифицированных)`);

  // 4. Проверяем статус кейса снова
  res = await request('/api/5ref-case/status', { initData: mainUserInitData });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.canClaim, true);
  assert.strictEqual(res.data.item.price, 2400);
  assert.strictEqual(res.data.item.collectible, 1);
  assert.strictEqual(res.data.item.upgradeOnly, 0);
  console.log('✓ 4. Статус обновился: canClaim=true, AWP | Blackout Gold 2400 ⬦ (240 ₽), коллекция');

  // 5. Открываем кейс
  res = await request('/api/5ref-case/open', { method: 'POST', initData: mainUserInitData, body: {} });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.ok, true);
  assert.strictEqual(res.data.drop.code, 'ref5_awp_blackout');
  assert.strictEqual(res.data.drop.price, 2400);
  assert.strictEqual(res.data.drop.collectible, true);
  assert.strictEqual(res.data.drop.upgradeOnly, 0);
  const droppedItemId = res.data.drop.id;
  console.log(`✓ 5. Кейс успешно открыт! Выпал коллекционный предмет id=${droppedItemId}`);

  // 6. Повторное открытие должно быть отклонено
  res = await request('/api/5ref-case/open', { method: 'POST', initData: mainUserInitData, body: {} });
  assert.strictEqual(res.status, 400);
  console.log('✓ 6. Повторное открытие кейса заблокировано сервером (400)');

  // 7. Попытка продать этот скин через /api/inventory/sell должна быть заблокирована
  res = await request('/api/inventory/sell', {
    method: 'POST',
    initData: mainUserInitData,
    body: { id: droppedItemId }
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error.includes('Коллекционный'), true);
  console.log('✓ 7. Продажа коллекционного предмета отклонена: ' + res.data.error);

  // 8. Попытка продать через /api/inventory/sell-all должна пропустить этот скин
  res = await request('/api/inventory/sell-all', {
    method: 'POST',
    initData: mainUserInitData,
    body: {}
  });
  assert.strictEqual(res.status, 400);
  console.log('✓ 8. Продажа всего инвентаря не трогает коллекционный предмет');

  // 9. Тестируем кастомные множители в Апгрейдере (до x100, ограничение шанса до 75%, возврат игроку 94%)
  const upgRound = await request('/api/play', {
    method: 'POST',
    initData: mainUserInitData,
    body: { game: 'upgrader', bet: 10, mult: 100 }
  });
  assert.strictEqual(upgRound.status, 200);
  assert.strictEqual(upgRound.data.mult, 100);
  console.log('✓ 9. Апгрейдер успешно принял кастомную ставку с множителем ×100');

  // 10. Симуляция 1,000 апгрейдов акционного скина (upgrade_only, не коллекционного)
  console.log('10. Запуск симуляции 1,000 раундов апгрейда для upgrade_only скина...');
  let wins = 0;
  let nearMisses = 0;
  const simTotal = 1000;

  for (let k = 0; k < simTotal; k++) {
    const tempItem = db.addInventoryItem({
      userId: mainUserId,
      itemCode: 'ref5_cyber_dagger',
      name: 'Cyber-Dagger | Neon Fade',
      icon: '🗡️',
      price: 2400,
      tier: 'secret',
      caseId: 'ref5',
      caseName: '5 друзей'
    });
    db.db.prepare('UPDATE user_inventory SET upgrade_only = 1 WHERE id = ?').run(tempItem.id);

    const playRes = await request('/api/play', {
      method: 'POST',
      initData: mainUserInitData,
      body: { game: 'upgrader', mult: 2.0, itemId: tempItem.id }
    });

    assert.strictEqual(playRes.status, 200);
    if (playRes.data.verdict === 'win') {
      wins++;
    } else {
      if (playRes.data.nearMiss) nearMisses++;
    }
  }

  const winRate = (wins / simTotal) * 100;
  const lossRate = 100 - winRate;
  console.log(`✓ 10. Результаты симуляции (${simTotal} раундов):`);
  console.log(`    - Побед: ${wins} (${winRate.toFixed(2)}%) — ожидалось ~3%`);
  console.log(`    - Поражений: ${simTotal - wins} (${lossRate.toFixed(2)}%) — ожидалось ~97%`);
  console.log(`    - Near-Miss байтов зафиксировано: ${nearMisses} (100% от всех проигрышей)`);

  assert.strictEqual(winRate < 6.0, true, 'Win rate must be around 3%');
  assert.strictEqual(lossRate > 94.0, true, 'Loss rate must be around 97%');
  assert.strictEqual(nearMisses, simTotal - wins, 'Every loss must be flagged as Near-Miss');

  console.log('\n🎉 ВСЕ ТЕСТЫ МЕХАНИК RUBUP УСПЕШНО ПРОЙДЕНЫ!');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Ошибка теста:', err);
  process.exit(1);
});
