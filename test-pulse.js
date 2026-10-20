'use strict';
/**
 * MoneyForUp — тесты Pulse Market (DECISIONS.md D5).
 *   1) чистая математика pulse.js: RTP, распределение исходов, валидация;
 *   2) E2E на реальном bot.js: ставка списывается, дубль не списывает второй раз,
 *      результат не раскрывается до таймера, повтор результата не начисляет,
 *      seed не утекает в ответах API, баланс сходится с ledger.
 */
const assert = require('assert');
const crypto = require('crypto');
const pulse = require('./pulse');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const UID = 880111;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (${a} === ${b})`);

(async () => {
  console.log('=== PULSE MATH ===');
  // 1. Выплата и RTP по плечам.
  eq(pulse.payoutMultiplier(1), 2.76, 'плечо ×1: множитель 3 × (1 − 0.08) = 2.76');
  eq(pulse.payoutMultiplier(2), 1.84, 'плечо ×2: множитель 2 × (1 − 0.08) = 1.84');
  ok(Math.abs(pulse.winProbability(1) - 1 / 3) < 1e-12, 'вероятность направления ×1 = 1/3');
  ok(Math.abs(pulse.winProbability(2) - 1 / 2) < 1e-12, 'вероятность направления ×2 = 1/2');

  // 2. RTP по большой выборке ≈ 1 − edge для каждого плеча (касса всегда в плюсе).
  for (const lev of [1, 2]) {
    const N = 120000; let total = 0;
    for (let i = 0; i < N; i++) {
      const seed = crypto.randomBytes(16).toString('hex');
      const dir = lev === 2 ? (i % 2 ? 'up' : 'down') : ['up', 'down', 'range'][i % 3];
      total += pulse.settle({ seedHex: seed, roundId: 'R' + i, direction: dir, leverage: lev, bet: 100 }).payout;
    }
    const rtp = total / (N * 100);
    ok(Math.abs(rtp - 0.92) < 0.01, `RTP плеча ×${lev} ≈ 0.92 (получили ${rtp.toFixed(4)})`);
    ok(rtp < 1, `касса в плюсе при плече ×${lev}`);
  }

  // 3. Распределение исходов при ×1 — равновероятно (≈ 1/3 каждый).
  const cnt = { up: 0, down: 0, range: 0 }; const M = 150000;
  for (let i = 0; i < M; i++) cnt[pulse.outcomeFromSeed('seed-fixed', 'R' + i, 1).outcome]++;
  for (const k of ['up', 'down', 'range']) {
    ok(Math.abs(cnt[k] / M - 1 / 3) < 0.01, `исход ${k} ≈ 1/3 (получили ${(cnt[k] / M).toFixed(4)})`);
  }

  // 4. Детерминизм: один seed и roundId — один исход.
  const a = pulse.outcomeFromSeed('abc', 'round-1', 1);
  const b = pulse.outcomeFromSeed('abc', 'round-1', 1);
  ok(JSON.stringify(a) === JSON.stringify(b), 'исход детерминирован для одного seed и roundId');

  // 5. Плечо ×2 не даёт боковика.
  let rangeAtX2 = false;
  for (let i = 0; i < 20000; i++) if (pulse.outcomeFromSeed('s', 'R' + i, 2).outcome === 'range') rangeAtX2 = true;
  ok(!rangeAtX2, 'при плече ×2 исход RANGE не выпадает');

  // 6. Валидация параметров ставки.
  ok(!pulse.validateBet({ direction: 'sideways', leverage: 1, duration: 5, bet: 100 }).ok, 'неизвестное направление отклонено');
  ok(!pulse.validateBet({ direction: 'up', leverage: 3, duration: 5, bet: 100 }).ok, 'плечо ×3 отклонено');
  ok(!pulse.validateBet({ direction: 'up', leverage: 1, duration: 7, bet: 100 }).ok, 'длительность 7 с отклонена');
  ok(!pulse.validateBet({ direction: 'range', leverage: 2, duration: 5, bet: 100 }).ok, 'боковик при ×2 отклонён');
  ok(!pulse.validateBet({ direction: 'up', leverage: 1, duration: 5, bet: 5 }).ok, 'ставка ниже минимума отклонена');
  ok(!pulse.validateBet({ direction: 'up', leverage: 1, duration: 5, bet: 999999 }).ok, 'ставка выше максимума отклонена');
  ok(pulse.validateBet({ direction: 'up', leverage: 1, duration: 10, bet: 100 }).ok, 'корректная ставка принята');

  // 7. Публичная конфигурация не содержит seed и исходов.
  // Поле `outcomes` — это список возможных исходов в правилах (публично), не результат раунда.
  // Проверяем, что нет ключей с результатом или seed.
  const cfg = pulse.publicConfig();
  const flat = JSON.stringify(cfg);
  ok(!/"seed"|"move"|"result"|"outcome"\s*:\s*"(up|down|range)"/i.test(flat), 'публичная конфигурация не раскрывает seed и результат раунда');

  console.log('\n=== PULSE API (bot.js) ===');
  const srv = await startServer({
    users: [{ id: UID, tokens: 10000, depositedRub: 1000, name: 'Pulse' }],
    port: 34710
  });
  const post = (p, b) => srv.post(p, b, UID);
  try {
    const c = await post('/api/pulse/config', {});
    eq(c.status, 200, 'конфиг Pulse Market доступен');
    ok(c.body.config.disclaimer.includes('Учебная симуляция'), 'дисклеймер показан');
    ok(!/seed/i.test(JSON.stringify(c.body)), 'в конфиге нет seed');

    const start = await post('/api/pulse/bet', {
      direction: 'up', leverage: 1, duration: 5, bet: 200, requestId: 'pulse-req-00001'
    });
    eq(start.status, 200, 'ставка принята');
    eq(start.body.tokens, 9800, 'ставка 200 списана сервером');
    ok(!/seed/i.test(JSON.stringify(start.body)), 'ответ ставки не содержит seed');

    // Дубль с тем же requestId не списывает ставку повторно.
    const dup = await post('/api/pulse/bet', {
      direction: 'up', leverage: 1, duration: 5, bet: 200, requestId: 'pulse-req-00001'
    });
    eq(dup.body.duplicate, true, 'повтор помечен как duplicate');
    eq(dup.body.tokens, 9800, 'повтор не списал вторую ставку');

    // Результат до таймера не раскрывается.
    const early = await post('/api/pulse/result', { roundId: start.body.roundId });
    eq(early.status, 425, 'результат до окончания таймера не раскрыт');
    ok(!/outcome|move|seed/i.test(JSON.stringify(early.body)), 'ранний ответ не содержит исход и seed');

    // Ждём окончания таймера (5 с) и получаем результат.
    await new Promise(r => setTimeout(r, 5200));
    const res = await post('/api/pulse/result', { roundId: start.body.roundId });
    eq(res.status, 200, 'результат раскрыт после таймера');
    ok(['up', 'down', 'range'].includes(res.body.result.outcome), 'исход — один из трёх');
    const expectedTokens = 9800 + (res.body.result.won ? res.body.result.payout : 0);
    eq(res.body.tokens, expectedTokens, 'баланс после расчёта сходится с выплатой');

    // Повтор результата не начисляет выигрыш второй раз.
    const again = await post('/api/pulse/result', { roundId: start.body.roundId });
    eq(again.body.duplicate, true, 'повторный запрос результата помечен duplicate');
    eq(again.body.tokens, expectedTokens, 'повторный результат не начислил выигрыш второй раз');

    // Неверный пользователь не видит чужой раунд.
    const other = srv.post('/api/pulse/result', { roundId: start.body.roundId }, 880999);
    ok((await other).status !== 200, 'чужой раунд недоступен');

    // Инвариант ledger: стартовый баланс + сумма журнала = текущий баланс (как в e2e).
    eq(10000 + srv.ledgerSum(UID), srv.bal(UID), 'стартовый баланс + ledger = текущий баланс');
  } finally {
    await srv.stop();
  }

  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => {
  console.error('\nТЕСТ УПАЛ:', e.message);
  process.exit(1);
});
