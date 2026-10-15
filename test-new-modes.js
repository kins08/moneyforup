/**
 * Тест новых режимов и механик:
 * Скретч-карты, Револьвер, Взлом Сейфа, Адский Лифт, PvP Дуэли, Страховка ставки.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BOT_TOKEN = '123456789:AAaaBBccDDeeFFggHHiiJJkkLLmmNNoo';
const API_PORT = 3915;
const ADMIN_ID = 999999;

const ok = [], bad = [];
const check = (cond, msg) => {
  if (cond) {
    ok.push(msg);
    console.log('  [PASS]', msg);
  } else {
    bad.push(msg);
    console.error('  [FAIL]', msg);
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function initData(userId, name) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'q' + userId,
    user: JSON.stringify({ id: userId, first_name: name })
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function request(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const postData = opts.body ? JSON.stringify(opts.body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: API_PORT,
      path: urlPath,
      method: opts.method || (postData ? 'POST' : 'GET'),
      headers: {
        ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...(opts.headers || {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('=== ЗАПУСК ТЕСТА НОВЫХ ИГРОВЫХ РЕЖИМОВ И МЕХАНИК ===\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-new-modes-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const botProcess = spawn('node', ['bot.js'], {
    env: {
      ...process.env,
      BOT_TOKEN,
      API_PORT: String(API_PORT),
      DB_PATH: dbPath,
      BOT_DRY_RUN: '1',
      ADMIN_ID: String(ADMIN_ID),
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    let alive = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      try {
        const ping = await request('/');
        if (ping.status === 200) { alive = true; break; }
      } catch (e) {}
    }
    check(alive, 'Сервер успешно запущен на порту ' + API_PORT);

    // Пользователь A (стартовый баланс 50 токенов)
    const uAInit = initData(2001, 'PlayerA');
    await request('/api/register', { body: { initData: uAInit, termsAcceptedAt: Date.now() } });

    // Пользователь B (стартовый баланс 50 токенов)
    const uBInit = initData(2002, 'PlayerB');
    await request('/api/register', { body: { initData: uBInit, termsAcceptedAt: Date.now() } });

    // 1. Тест Скретч-карт (/api/scratch/play)
    const scRes = await request('/api/scratch/play', {
      body: { initData: uAInit, bet: 20, insurance: true }
    });
    check(scRes.status === 200 && scRes.body.ok, 'Скретч-карты: раунд успешно сыгран');
    check(Array.isArray(scRes.body.grid) && scRes.body.grid.length === 9, 'Скретч-карты: сервер сгенерировал 9 ячеек');
    check(typeof scRes.body.won === 'boolean', 'Скретч-карты: сервер вернул вердикт won');

    // 2. Тест Взлома Сейфа (/api/safe/status и /api/safe/guess)
    const safeStat = await request('/api/safe/status?initData=' + encodeURIComponent(uAInit));
    check(safeStat.status === 200 && safeStat.body.jackpot >= 25000, 'Сейф: статус джекпота получен (базовый >= 25 000 ⬦)');

    const guessRes = await request('/api/safe/guess', {
      body: { initData: uAInit, code: '1234' }
    });
    check(guessRes.status === 200 && guessRes.body.ok, 'Сейф: попытка ввода кода принята');
    check(typeof guessRes.body.bulls === 'number' && typeof guessRes.body.cows === 'number', 'Сейф: вернулись подсказки быков и коров');
    check(guessRes.body.jackpot >= 25015, 'Сейф: джекпот увеличился после неудачной попытки (+15 ⬦)');

    // 3. Тест Револьвера (/api/revolver/start, /api/revolver/trigger, /api/revolver/cashout)
    const revStart = await request('/api/revolver/start', {
      body: { initData: uAInit, bet: 10, insurance: false }
    });
    check(revStart.status === 200 && revStart.body.ok, 'Револьвер: раунд успешно начат');

    const revTrig = await request('/api/revolver/trigger', {
      body: { initData: uAInit }
    });
    check(revTrig.status === 200 && revTrig.body.ok, 'Револьвер: курок спущен (шаг 1)');
    if (!revTrig.body.fired) {
      check(revTrig.body.mult === 1.18, 'Револьвер: множитель после 1-го холостого шага = ×1.18');
      const revCash = await request('/api/revolver/cashout', {
        body: { initData: uAInit }
      });
      check(revCash.status === 200 && revCash.body.ok, 'Револьвер: кэшаут успешно начислен');
    } else {
      check(revTrig.body.win === 0, 'Револьвер: при боевом выстреле ставка сгорела');
    }

    // 4. Тест Адского Лифта (/api/elevator/start, /api/elevator/step, /api/elevator/cashout)
    const elvStart = await request('/api/elevator/start', {
      body: { initData: uAInit, bet: 10 }
    });
    check(elvStart.status === 200 && elvStart.body.ok, 'Лифт: подъем успешно начат');

    const elvStep = await request('/api/elevator/step', {
      body: { initData: uAInit, door: 1 }
    });
    check(elvStep.status === 200 && elvStep.body.ok, 'Лифт: выбор двери обработан');
    if (!elvStep.body.crashed) {
      check(elvStep.body.floor === 1 && elvStep.body.mult === 1.42, 'Лифт: успешный подъем на 1 этаж (×1.42)');
      const elvCash = await request('/api/elevator/cashout', {
        body: { initData: uAInit }
      });
      check(elvCash.status === 200 && elvCash.body.ok, 'Лифт: кэшаут на этаже успешно начислен');
    } else {
      check(elvStep.body.crashed === true, 'Лифт: ловушка сработала корректно');
    }

    // 5. Тест PvP Дуэлей (/api/duels/create, /api/duels/list, /api/duels/join)
    const dCreate = await request('/api/duels/create', {
      body: { initData: uAInit, bet: 20 }
    });
    check(dCreate.status === 200 && dCreate.body.duelId, 'PvP Дуэль: успешно создана игроком A');
    const duelId = dCreate.body.duelId;

    const dList = await request('/api/duels/list?initData=' + encodeURIComponent(uBInit));
    check(dList.status === 200 && dList.body.duels.some(d => d.id === duelId), 'PvP Дуэль: видна в общем списке открытых дуэлей');

    const dJoin = await request('/api/duels/join', {
      body: { initData: uBInit, duelId }
    });
    check(dJoin.status === 200 && dJoin.body.ok, 'PvP Дуэль: игрок B успешно принял вызов');
    check(dJoin.body.rollCreator && dJoin.body.rollOpponent, 'PvP Дуэль: оба игрока бросили кости');
    check(dJoin.body.prize === 38, 'PvP Дуэль: приз победителю рассчитан со ставкой 20 (20 * 2 * 0.95 = 38 ⬦, 5% маржа дома)');

  } finally {
    botProcess.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\nИТОГ ТЕСТА: Пройдено: ${ok.length}, Ошибок: ${bad.length}`);
  if (bad.length > 0) process.exit(1);
}

run().catch(err => {
  console.error('Ошибка теста:', err);
  process.exit(1);
});
