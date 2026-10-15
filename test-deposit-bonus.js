/**
 * Тест Hotfix +25% к первому депозиту и расширенной админ-аналитики.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BOT_TOKEN = '123456789:AAaaBBccDDeeFFggHHiiJJkkLLmmNNoo';
const API_PORT = 3912;
const ADMIN_ID = 999999;
const PAYMENT_SECRET = 'test_webhook_sec_123';

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
  console.log('=== ЗАПУСК ТЕСТА: +25% БОНУС К ДЕПОЗИТУ И АДМИН-АНАЛИТИКА ===\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-bonus-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const botProcess = spawn('node', ['bot.js'], {
    env: {
      ...process.env,
      BOT_TOKEN,
      API_PORT: String(API_PORT),
      DB_PATH: dbPath,
      BOT_DRY_RUN: '1',
      ADMIN_ID: String(ADMIN_ID),
      PAYMENT_WEBHOOK_SECRET: PAYMENT_SECRET,
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  botProcess.stdout.on('data', d => {
    // console.log('[bot stdout]', d.toString().trim());
  });
  botProcess.stderr.on('data', d => {
    // console.error('[bot stderr]', d.toString().trim());
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
    check(alive, 'Сервер bot.js успешно запустился на порту ' + API_PORT);
    if (!alive) throw new Error('Сервер не ответил на /');

    const user1Init = initData(1001, 'NewUserBonus');

    // 1. Создание пользователя 1 через /api/register с принятием соглашения
    const regRes = await request('/api/register', {
      body: { initData: user1Init, termsAcceptedAt: Date.now() }
    });
    check(regRes.status === 200 && regRes.body && regRes.body.id === 1001, 'Пользователь 1001 зарегистрирован и принял условия');

    // 2. Создание заказа СБП с акцией +25%
    const order1Res = await request('/api/order-sbp', {
      body: { initData: user1Init, rub: 150, bonus: '25' }
    });
    check(order1Res.status === 200 && order1Res.body.order_id, 'Заказ 1 создан успешно: ' + (order1Res.body.order_id || ''));
    check(order1Res.body.bonusApplied === true, 'В заказе 1 подтверждено право на бонус bonusApplied=true');
    check(order1Res.body.tokens === 1875, 'В заказе 1 рассчитано 1875 токенов (1500 базовых + 375 бонус)');
    const orderId1 = order1Res.body.order_id;

    // 3. Подтверждение оплаты через /api/payment-webhook
    const smsRes = await request('/api/payment-webhook', {
      body: { secret: PAYMENT_SECRET, text: `T-Bank +150.00 RUB Perevod MFU-${orderId1} Uspeshno` }
    });
    check(smsRes.status === 200 && smsRes.body.ok, 'SMS-вебхук подтвердил заказ на 150 ₽');

    // 4. Проверяем баланс пользователя 1 после первого депозита
    // У нового пользователя стартовый баланс START_TOKENS = 50 ⬦
    const u1Bal1 = await request('/api/balance', { body: { initData: user1Init } });
    const u1 = u1Bal1.body;
    check(u1.tokens === 1925, `Баланс пользователя после первого депозита ровно 1925 (50 стартовых + 1875 за деп, факт: ${u1.tokens})`);

    // 5. Повторный вебхук того же заказа (идемпотентность — заказ уже paid)
    const smsDupRes = await request('/api/payment-webhook', {
      body: { secret: PAYMENT_SECRET, text: `T-Bank +150.00 RUB Perevod MFU-${orderId1} Uspeshno` }
    });
    // Заказ уже paid, поэтому повторное начисление не происходит
    const u1BalDup = await request('/api/balance', { body: { initData: user1Init } });
    check(u1BalDup.body.tokens === 1925, 'Баланс не изменился при повторном вебхуке (строго 1925)');

    // 6. Второй депозит того же пользователя с попыткой снова указать bonus: '25'
    const order2Res = await request('/api/order-sbp', {
      body: { initData: user1Init, rub: 200, bonus: '25' }
    });
    check(order2Res.status === 200 && order2Res.body.order_id, 'Второй заказ создан');
    check(order2Res.body.bonusApplied === false, 'Сервер отклонил повторный бонус: bonusApplied=false');
    check(order2Res.body.tokens === 2000, 'Токены рассчитаны без бонуса: строго 2000 (200 руб * 10)');
    const orderId2 = order2Res.body.order_id;

    // Подтверждаем второй заказ
    await request('/api/payment-webhook', {
      body: { secret: PAYMENT_SECRET, text: `T-Bank +200.00 RUB Perevod MFU-${orderId2} Uspeshno` }
    });
    const u1Bal2 = await request('/api/balance', { body: { initData: user1Init } });
    check(u1Bal2.body.tokens === 3925, `Баланс после второго депозита = 1925 + 2000 = 3925 (факт: ${u1Bal2.body.tokens})`);

    // 7. Пользователь 2 с существующей историей депозитов пытается получить бонус
    const user2Init = initData(1002, 'OldDepositor');
    await request('/api/register', { body: { initData: user2Init, termsAcceptedAt: Date.now() } });

    // Имитируем первый депозит без бонуса
    const ordOld = await request('/api/order-sbp', {
      body: { initData: user2Init, rub: 150 }
    });
    await request('/api/payment-webhook', {
      body: { secret: PAYMENT_SECRET, text: `T-Bank +150.00 RUB Perevod MFU-${ordOld.body.order_id} Uspeshno` }
    });
    const u2Bal = await request('/api/balance', { body: { initData: user2Init } });
    check(u2Bal.body.tokens === 1550, `Пользователь 2 пополнил 1500 токенов без бонуса (50 стартовых + 1500 = 1550, факт: ${u2Bal.body.tokens})`);

    // Теперь пользователь 2 отправляет второй заказ с попыткой bonus: '25'
    const u2BonusTry = await request('/api/order-sbp', {
      body: { initData: user2Init, rub: 150, bonus: '25' }
    });
    check(u2BonusTry.body.bonusApplied === false, 'Для ранее пополнявшего пользователя 2 бонус отклонен сервером при создании заказа');
    check(u2BonusTry.body.tokens === 1500, 'Начисление рассчитано как базовые 1500 токенов');

    // 8. Админ-аналитика (/api/admin/metrics)
    const adminInit = initData(ADMIN_ID, 'MasterAdmin');
    await request('/api/register', { body: { initData: adminInit, termsAcceptedAt: Date.now() } });

    const metricsAll = await request('/api/admin/metrics', {
      body: { initData: adminInit, period: 'all' }
    });
    check(metricsAll.status === 200 && metricsAll.body.ok, 'Запрос /api/admin/metrics (period=all) успешен');
    const m = metricsAll.body.summary;
    check(m && m.firstBonusOrdersCount === 1, `firstBonusOrdersCount равен 1 (факт: ${m.firstBonusOrdersCount})`);
    check(m && m.firstBonusTokens === 375, `firstBonusTokens равен 375 (факт: ${m.firstBonusTokens})`);
    check(m && m.firstBonusRubVolume === 150, `firstBonusRubVolume равен 150 (факт: ${m.firstBonusRubVolume})`);
    check(m && m.depositsCount === 3, `Общее число оплаченных депозитов = 3 (факт: ${m.depositsCount})`);
    check(m && m.depositsRub === 500, `Сумма депозитов = 500 руб (150 + 200 + 150, факт: ${m.depositsRub})`);
    check(metricsAll.body && Array.isArray(metricsAll.body.recentLedger) && metricsAll.body.recentLedger.length > 0, 'Админ получает реальные транзакции из ledger');

    // Проверяем фильтр за сегодня
    const metricsToday = await request('/api/admin/metrics', {
      body: { initData: adminInit, period: 'today' }
    });
    check(metricsToday.status === 200 && metricsToday.body.summary.depositsCount === 3, 'Фильтр period=today корректно отражает сегодняшние депозиты');

    // Проверяем доступ не-админа к /api/admin/metrics
    const forbidden = await request('/api/admin/metrics', {
      body: { initData: user1Init, period: 'all' }
    });
    check(forbidden.status === 403, 'Обычный пользователь получает 403 Forbidden к /api/admin/metrics');

  } finally {
    botProcess.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\nИТОГ ТЕСТА: Пройдено: ${ok.length}, Ошибок: ${bad.length}`);
  if (bad.length > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Непредвиденная ошибка:', err);
  process.exit(1);
});
