'use strict';
/**
 * MoneyForUp — проверка полноты параметров раундов Pulse и Trend в game_rounds.
 * Читает строку напрямую из БД после каждого этапа (ставка, расчёт/ответ)
 * и сверяет с тем, что вернул сервер.
 */
const assert = require('assert');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const UID = 880555;
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(a === b, `${m} (${a} === ${b})`);

(async () => {
  const srv = await startServer({
    users: [{ id: UID, tokens: 10000, depositedRub: 1000, name: 'Params' }],
    port: 34760
  });
  try {
    console.log('=== PULSE: параметры раунда в game_rounds ===');
    const pb = await srv.post('/api/pulse/bet', { direction: 'down', leverage: 2, duration: 10, bet: 250, requestId: 'params-pulse-01' }, UID);
    eq(pb.status, 200, 'ставка Pulse принята');
    const row1 = srv.db.getRoundParams(pb.body.roundId, UID);
    ok(row1 && row1.seed && row1.seed.length === 64, 'после ставки сохранён seed (64 hex)');
    eq(row1.bet_tokens, 250, 'после ставки сохранена сумма ставки');
    eq(row1.status, 'pending', 'после ставки статус pending');
    eq(row1.params.direction, 'down', 'сохранено направление');
    eq(row1.params.leverage, 2, 'сохранено плечо');
    eq(row1.params.duration, 10, 'сохранена длительность');
    ok(typeof row1.params.startedAt === 'number' && row1.params.dueAt === row1.params.startedAt + 10000,
      'сохранены время старта и время окончания');

    await new Promise(r => setTimeout(r, 10200));
    const res = await srv.post('/api/pulse/result', { roundId: pb.body.roundId }, UID);
    eq(res.status, 200, 'результат Pulse получен');
    const row2 = srv.db.getRoundParams(pb.body.roundId, UID);
    eq(row2.status, 'settled', 'после расчёта статус settled');
    eq(row2.win_tokens, res.body.result.payout, 'выплата в win_tokens совпадает с ответом сервера');
    eq(row2.mult, res.body.result.won ? res.body.result.mult : 0, 'множитель в mult совпадает с ответом сервера');
    ok(['up', 'down', 'range'].includes(row2.params.outcome), 'после расчёта сохранён исход');
    eq(row2.params.won, res.body.result.won, 'после расчёта сохранён признак победы');
    eq(row2.params.payout, res.body.result.payout, 'после расчёта сохранена выплата');

    console.log('\n=== TREND: параметры раунда в game_rounds ===');
    const tb = await srv.post('/api/trend/start', { level: 2, bet: 120, requestId: 'params-trend-01' }, UID);
    eq(tb.status, 200, 'раунд Trend начат');
    const t1 = srv.db.getRoundParams(tb.body.roundId, UID);
    ok(t1 && t1.seed && t1.seed.length === 64, 'после старта сохранён seed');
    eq(t1.bet_tokens, 120, 'после старта сохранена ставка');
    eq(t1.params.level, 2, 'сохранён уровень сложности');
    ok(Array.isArray(t1.params.points) && t1.params.points.length > 0, 'сохранён график');
    ok(['rise', 'fall', 'flat'].includes(t1.params.pattern), 'сохранён правильный паттерн (серверный)');
    ok(typeof t1.params.seconds === 'number' && t1.params.seconds > 0, 'сохранено время на ответ');
    ok(typeof t1.params.startedAt === 'number', 'сохранено время старта');

    const ans = await srv.post('/api/trend/answer', { roundId: tb.body.roundId, answer: 'fall' }, UID);
    eq(ans.status, 200, 'ответ Trend принят');
    const t2 = srv.db.getRoundParams(tb.body.roundId, UID);
    eq(t2.status, 'settled', 'после ответа статус settled');
    eq(t2.params.answer, 'fall', 'сохранён ответ игрока');
    ok(typeof t2.params.answeredAt === 'number', 'сохранено время ответа');
    eq(t2.params.result.correct, ans.body.result.correct, 'признак верности совпадает с ответом сервера');
    eq(t2.params.result.payout, ans.body.result.payout, 'выплата в params.result совпадает с ответом сервера');
    eq(t2.win_tokens, ans.body.result.payout, 'выплата в win_tokens совпадает с ответом сервера');
    eq(t2.bet_tokens, 120, 'ставка не изменилась после ответа');
    eq(t2.params.pattern, t1.params.pattern, 'правильный паттерн не изменился после ответа');

    console.log('\n=== ПОЛНОТА ===');
    ok(srv.db.getRoundParams(pb.body.roundId, UID).params && srv.db.getRoundParams(tb.body.roundId, UID).params,
      'параметры читаются для обоих типов раундов');
    eq(10000 + srv.ledgerSum(UID), srv.bal(UID), 'инвариант ledger сохранён');
  } finally {
    await srv.stop();
  }
  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => { console.error('\nТЕСТ УПАЛ:', e.message); process.exit(1); });
