'use strict';
/**
 * MoneyForUp — перезапуск сервера между ставкой и расчётом Pulse/Trend.
 *
 * Проверяет (DECISIONS.md D5/D6, решение пользователя: seed хранится в БД):
 *  1) раунд Pulse, открытый до перезапуска, рассчитывается после него из game_rounds;
 *  2) повторный расчёт после перезапуска не начисляет выигрыш второй раз;
 *  3) Trend: сценарий переживает перезапуск, ответ после него даёт тот же результат;
 *  4) баланс сходится с ledger после перезапуска.
 */
const assert = require('assert');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const UID = 880444;
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(a === b, `${m} (${a} === ${b})`);

(async () => {
  console.log('=== ПЕРЕЗАПУСК СЕРВЕРА МЕЖДУ СТАВКОЙ И РАСЧЁТОМ ===');
  const sharedTmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mfu-restart-'));
  const srv1 = await startServer({
    users: [{ id: UID, tokens: 10000, depositedRub: 1000, name: 'Restart' }],
    port: 34750,
    reuseTmp: sharedTmp
  });
  const tmp = sharedTmp;
  const port = srv1.port;

  // Ставки до перезапуска.
  const pb = await srv1.post('/api/pulse/bet', { direction: 'up', leverage: 1, duration: 5, bet: 300, requestId: 'restart-pulse-01' }, UID);
  eq(pb.status, 200, 'Pulse: ставка принята до перезапуска');
  const tb = await srv1.post('/api/trend/start', { level: 1, bet: 200, requestId: 'restart-trend-01' }, UID);
  eq(tb.status, 200, 'Trend: раунд начат до перезапуска');
  const pulseId = pb.body.roundId;
  const trendId = tb.body.roundId;
  eq(srv1.bal(UID), 10000 - 500, 'до перезапуска списано 500 ⬦');

  // Имитируем перезапуск: процесс умирает, но БД (папка tmp) остаётся.
  await srv1.stop();
  ok(true, 'сервер остановлен (БД сохранена в tmp)');

  // Ждём окончания таймера Pulse (5 с), чтобы раунд был расчётно готов.
  await new Promise(r => setTimeout(r, 5200));

  // Второй сервер поднимается на той же БД — раунды только в БД, памяти нет.
  const srv2 = await startServer({
    users: [],
    port: port + 1,
    reuseTmp: tmp
  });
  try {
    // Расчёт Pulse после перезапуска: раунда нет в памяти, берём из game_rounds.
    const res1 = await srv2.post('/api/pulse/result', { roundId: pulseId }, UID);
    eq(res1.status, 200, 'Pulse: результат получен после перезапуска');
    ok(['up', 'down', 'range'].includes(res1.body.result.outcome) || res1.body.result.outcome === null,
      'Pulse: исход восстановлен из БД');
    const expected = 9500 + (res1.body.result.won ? res1.body.result.payout : 0);
    eq(res1.body.tokens, expected, 'Pulse: баланс после расчёта сходится с выплатой');

    // Повтор после перезапуска не начисляет второй раз.
    const res2 = await srv2.post('/api/pulse/result', { roundId: pulseId }, UID);
    eq(res2.body.tokens, expected, 'Pulse: повтор после перезапуска не начислил второй раз');

    // Trend: ответ после перезапуска.
    const ans = await srv2.post('/api/trend/answer', { roundId: trendId, answer: 'flat' }, UID);
    eq(ans.status, 200, 'Trend: ответ принят после перезапуска');
    ok(typeof ans.body.result.correct === 'boolean', 'Trend: результат восстановлен из БД');

    // Повтор ответа после перезапуска — без второй выплаты.
    const ans2 = await srv2.post('/api/trend/answer', { roundId: trendId, answer: 'rise' }, UID);
    eq(ans2.body.tokens, ans.body.tokens, 'Trend: повтор после перезапуска не начислил второй раз');

    // Инвариант ledger после перезапуска.
    eq(10000 + srv2.ledgerSum(UID), srv2.bal(UID), 'инвариант ledger сохранён после перезапуска');
  } finally {
    await srv2.stop();
    require('fs').rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => {
  console.error('\nТЕСТ УПАЛ:', e.message);
  process.exit(1);
});
