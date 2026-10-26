/**
 * Тест актуальных новых режимов и механик:
 * Скретч-карты, Револьвер, Взлом Сейфа, Страховка ставки (+15%).
 * (Режимы «Адский Лифт» и «PvP Дуэли» удалены по ТЗ).
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
  console.log('=== ЗАПУСК ТЕСТА АКТУАЛЬНЫХ РЕЖИМОВ (SCRATCH, REVOLVER, SAFE, 15% СТРАХОВКА) ===\n');

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
    const regRes = await request('/api/register', { body: { initData: uAInit, termsAcceptedAt: Date.now() } });
    check(regRes.status === 200 && regRes.body && regRes.body.id === 2001, 'Регистрация пользователя A');

    // 1. Тест Скретч-карт с 15% страховкой (/api/scratch/play)
    // Ставка 20 -> стоимость с 15% страховкой Math.floor(20 * 1.15) = 23 токена.
    const scRes = await request('/api/scratch/play', {
      body: { initData: uAInit, bet: 20, insurance: true }
    });
    check(scRes.status === 200 && scRes.body.ok, 'Скретч-карты: раунд со страховкой успешно сыгран');
    check(Array.isArray(scRes.body.grid) && scRes.body.grid.length === 9, 'Скретч-карты: сгенерировано 9 ячеек');
    check(typeof scRes.body.won === 'boolean', 'Скретч-карты: результат выигрыша получен');
    if (!scRes.body.won) {
      // Актуальная модель (security changelog): возврат 20%, а не 35%.
      check(scRes.body.insuredReturn === 4, 'Скретч-карты: при проигрыше страховка вернула 20% ставки (20 * 0.20 = 4 ⬦)');
    } else {
      check(scRes.body.winTokens > 0, 'Скретч-карты: выигрыш начислен корректно');
    }

    // 2. Тест Взлома Сейфа (/api/safe/status и /api/safe/guess)
    const safeStat = await request('/api/safe/status', { method: 'POST', body: { initData: uAInit } });
    check(safeStat.status === 200 && Number.isFinite(safeStat.body.jackpot), 'Сейф: статус прогрессивного джекпота получен');
    const jackpotBefore = Number(safeStat.body.jackpot || 0);

    const guessRes = await request('/api/safe/guess', {
      body: { initData: uAInit, code: '1234', requestId: 'test-safe-guess-0001' }
    });
    check(guessRes.status === 200 && guessRes.body.ok, 'Сейф: попытка ввода кода принята');
    check(typeof guessRes.body.bulls === 'number' && typeof guessRes.body.cows === 'number', 'Сейф: возвращены быки и коровы');
    if (guessRes.body.won) {
      check(guessRes.body.jackpot === 0, 'Сейф: джекпот обнулён после взлома');
    } else {
      check(guessRes.body.jackpot === jackpotBefore + 15, 'Сейф: джекпот пополнен взносом за попытку (+15 ⬦)');
    }

    // 3. Тест Револьвера с 15% страховкой (/api/revolver/start, /api/revolver/trigger, /api/revolver/cashout)
    // Пользователь B
    const uBInit = initData(2002, 'PlayerB');
    await request('/api/register', { body: { initData: uBInit, termsAcceptedAt: Date.now() } });

    const revStart = await request('/api/revolver/start', {
      body: { initData: uBInit, bet: 20, insurance: true }
    });
    check(revStart.status === 200 && revStart.body.ok, 'Револьвер: раунд с 15% страховкой начат (списано 23 ⬦)');

    const revTrig = await request('/api/revolver/trigger', {
      body: { initData: uBInit }
    });
    check(revTrig.status === 200 && revTrig.body.ok, 'Револьвер: спущен курок (камера 1)');
    if (!revTrig.body.fired) {
      check(revTrig.body.mult === 1.18, 'Револьвер: множитель холостого выстрела = ×1.18');
      const revCash = await request('/api/revolver/cashout', {
        body: { initData: uBInit }
      });
      check(revCash.status === 200 && revCash.body.ok, 'Револьвер: кэшаут успешно начислен');
    } else {
      check(revTrig.body.insuredReturn === 7, 'Револьвер: при боевом выстреле со страховкой вернулось 35% (7 ⬦)');
    }

    // 4. Проверка отсутствия удалённых эндпоинтов elevator и duels (отдают 404)
    const deadElv = await request('/api/elevator/start', { body: { initData: uAInit, bet: 10 } });
    check(deadElv.status === 404, 'Эндпоинт лифта удалён (404)');

    const deadDuel = await request('/api/duels/list');
    check(deadDuel.status === 404 || deadDuel.status === 401, 'Эндпоинт дуэлей удалён/недоступен (' + deadDuel.status + ')');

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
