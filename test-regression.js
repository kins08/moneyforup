'use strict';
/**
 * MoneyForUp — регрессионные проверки этапа 8 (ТЗ, раздел 8).
 * Автоматические пункты — здесь. Ручные сценарии — в REPORT.md.
 *
 * Пункты ТЗ, которые проверяются здесь:
 *  - обычный пользователь не видит административную аналитику;
 *  - двойной клик не даёт двойного списания и дублированного результата (Pulse, Trend, апгрейд);
 *  - ошибки API и отказ сервера не ломают баланс;
 *  - нет секретов в клиентском коде (поиск по index.html и public/).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const ADMIN = 880901;
const USER = 880902;
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(a === b, `${m} (${a} === ${b})`);

(async () => {
  console.log('=== 8.a: АДМИН-АНАЛИТИКА НЕ ВИДНА ОБЫЧНОМУ ПОЛЬЗОВАТЕЛЮ ===');
  const srv = await startServer({
    users: [
      { id: ADMIN, tokens: 5000, depositedRub: 1000, name: 'Owner' },
      { id: USER, tokens: 5000, depositedRub: 1000, name: 'Player' }
    ],
    adminId: ADMIN,
    port: 34740
  });
  try {
    for (const p of ['/api/admin/metrics', '/api/admin/overview']) {
      const r = await srv.post(p, { period: 'all' }, USER);
      eq(r.status, 403, `обычный пользователь: ${p} → 403`);
      ok(!r.body || !r.body.totals, `обычный пользователь: ${p} не отдаёт данные аналитики`);
    }
    const adm = await srv.post('/api/admin/metrics', { period: 'all' }, ADMIN);
    eq(adm.status, 200, 'владелец: /api/admin/metrics → 200');

    console.log('\n=== 8.b: ДВОЙНОЙ КЛИК НЕ СПИСЫВАЕТ ДВАЖДЫ ===');
    // Pulse: два одинаковых запроса параллельно
    const before = srv.bal(USER);
    const [p1, p2] = await Promise.all([
      srv.post('/api/pulse/bet', { direction: 'up', leverage: 1, duration: 5, bet: 200, requestId: 'dbl-pulse-0001' }, USER),
      srv.post('/api/pulse/bet', { direction: 'up', leverage: 1, duration: 5, bet: 200, requestId: 'dbl-pulse-0001' }, USER)
    ]);
    eq(srv.bal(USER), before - 200, 'Pulse: два параллельных клика списали ровно одну ставку');
    ok([p1.body, p2.body].some(b => b.duplicate === true), 'Pulse: один из двух ответов помечен duplicate');

    // Trend: два одинаковых старта параллельно
    const before2 = srv.bal(USER);
    const [t1, t2] = await Promise.all([
      srv.post('/api/trend/start', { level: 1, bet: 100, requestId: 'dbl-trend-0001' }, USER),
      srv.post('/api/trend/start', { level: 1, bet: 100, requestId: 'dbl-trend-0001' }, USER)
    ]);
    eq(srv.bal(USER), before2 - 100, 'Trend: два параллельных старта списали ровно одну ставку');
    ok([t1.body, t2.body].some(b => b.duplicate === true), 'Trend: один из двух ответов помечен duplicate');

    // Апгрейд: два одинаковых запроса параллельно
    const before3 = srv.bal(USER);
    const upgReq = { mode: 'standard', sourceType: 'tokens', amount: 100, targets: [], requestId: 'dbl-upg-000001' };
    const cat = await srv.post('/api/upgrade/catalog', {}, USER);
    const code = cat.body.targets.find(t => t.value > 150 && t.value <= 100 * 100 * 0.9)?.code || cat.body.targets[0].code;
    upgReq.targets = [code];
    const [u1, u2] = await Promise.all([
      srv.post('/api/upgrade/run', upgReq, USER),
      srv.post('/api/upgrade/run', upgReq, USER)
    ]);
    ok(srv.bal(USER) >= before3 - 100 && srv.bal(USER) <= before3, 'апгрейд: двойной клик не списал больше ставки');
    ok([u1.body, u2.body].filter(b => b && b.duplicate === true).length <= 1, 'апгрейд: не более одного дубля (второй — повтор)');

    console.log('\n=== 8.c: ОШИБКИ API НЕ ЛОМАЮТ БАЛАНС ===');
    const before4 = srv.bal(USER);
    const bad = await srv.post('/api/pulse/bet', { direction: 'sideways', leverage: 1, duration: 5, bet: 100, requestId: 'bad-pulse-00001' }, USER);
    eq(bad.status, 400, 'некорректная ставка Pulse отклонена');
    eq(srv.bal(USER), before4, 'отклонённая ставка не списала токены');
    const badRange = await srv.post('/api/pulse/bet', { direction: 'range', leverage: 2, duration: 5, bet: 100, requestId: 'bad-pulse-00002' }, USER);
    eq(badRange.status, 400, 'боковик при ×2 отклонён сервером');
    eq(srv.bal(USER), before4, 'отказ по боковику не списал токены');
    const huge = await srv.post('/api/trend/start', { level: 1, bet: 10 ** 9, requestId: 'bad-trend-00001' }, USER);
    eq(huge.status, 400, 'ставка больше максимума отклонена');
    eq(srv.bal(USER), before4, 'отказ по максимуму не списал токены');

    // Инвариант ledger после всех сценариев
    eq(5000 + srv.ledgerSum(USER), srv.bal(USER), 'инвариант ledger сохранён после всех сценариев');
  } finally {
    await srv.stop();
  }

  console.log('\n=== 8.d: НЕТ СЕКРЕТОВ В КЛИЕНТСКОМ КОДЕ ===');
  const clientFiles = ['index.html', path.join('public', 'index.html')];
  const secretPatterns = [
    /BOT_TOKEN\s*[:=]\s*['"][0-9]{6,}:[A-Za-z0-9_-]{20,}['"]/,   // токен Telegram
    /COINSO_SECRET_KEY\s*[:=]\s*['"][^'"]{8,}['"]/,
    /PAYMENT_WEBHOOK_SECRET\s*[:=]\s*['"][^'"]{8,}['"]/,
    /sk_live_[A-Za-z0-9]{10,}/,                                  // Stripe-подобные ключи
    /AKIA[0-9A-Z]{16}/                                           // ключи AWS
  ];
  for (const f of clientFiles) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const re of secretPatterns) {
      ok(!re.test(src), `${f}: нет секрета по шаблону ${re.source.slice(0, 40)}…`);
    }
  }

  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => {
  console.error('\nТЕСТ УПАЛ:', e.message);
  process.exit(1);
});
