'use strict';
/**
 * MoneyForUp — тесты прогрессии (DECISIONS.md D7, D8).
 *   1) чистая логика progress.js: статистика, титулы, миссии, Replay, сезон;
 *   2) API: раунды Pulse и Trend из реального bot.js попадают в прогресс,
 *      прогресс не меняет баланс (токены не начисляются за миссии).
 */
const assert = require('assert');
const P = require('./progress');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const UID = 880333;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (${a} === ${b})`);
const DAY = 24 * 60 * 60 * 1000;

(async () => {
  console.log('=== PROGRESS LOGIC ===');
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  const start = P.startOfDay(now);
  const rounds = [
    { round_id: 'PM_a', game: 'PULSE MARKET', status: 'settled', bet_tokens: 100, win_tokens: 276, mult: 2.76, created_at: start + 1000 },
    { round_id: 'PM_b', game: 'PULSE MARKET', status: 'settled', bet_tokens: 100, win_tokens: 0, mult: 0, created_at: start + 2000 },
    { round_id: 'TH_c', game: 'TREND HUNTER', status: 'settled', bet_tokens: 50, win_tokens: 138, mult: 2.76, created_at: start + 3000 },
    { round_id: 'TH_d', game: 'TREND HUNTER', status: 'settled', bet_tokens: 50, win_tokens: 0, mult: 0, created_at: start + 4000 },
    { round_id: 'UPG', game: 'Апгрейд · АПГРЕЙДЕР', status: 'settled', bet_tokens: 500, win_tokens: 900, created_at: start + 5000 },
    { round_id: 'PM_old', game: 'PULSE MARKET', status: 'settled', bet_tokens: 100, win_tokens: 0, mult: 0, created_at: start - DAY + 1000 },
    { round_id: 'PM_run', game: 'PULSE MARKET', status: 'pending', bet_tokens: 100, win_tokens: 0, created_at: start + 6000 }
  ];

  const s = P.stats(rounds);
  eq(s.rounds, 5, 'статистика: 2 Pulse + 2 Trend + вчерашний Pulse; апгрейд и pending не учитываются');
  eq(s.wins, 2, 'статистика: выигрышных раундов 2 (по win_tokens > 0)');
  eq(s.bestWin, 276, 'статистика: лучший выигрыш 276 ⬦');
  eq(s.favorite, 'PULSE MARKET', 'статистика: любимая игра — Pulse Market');

  eq(P.titleFor(0).current.id, 'rookie', 'титул: 0 раундов — Новичок');
  eq(P.titleFor(25).current.id, 'trader', 'титул: 25 раундов — Трейдер');
  eq(P.titleFor(25).next.id, 'analyst', 'титул: следующий — Аналитик');
  eq(P.titleFor(25).leftToNext, 35, 'титул: до Аналитика осталось 35 раундов');

  const daily = P.dailyMissions(rounds, now);
  eq(daily.length, 3, 'три ежедневные миссии');
  eq(daily[0].progress, 3, 'миссия «три раунда»: прогресс кап 3 (фактически 4 за сегодня)');
  ok(daily[0].done === true, 'миссия «три раунда» выполнена');
  eq(daily[1].progress, 2, 'миссия «два выигрыша»: 2 выигрыша за сегодня');
  ok(daily[2].done === false, 'миссия Trend (3 ответа) не выполнена — сыграно 2');
  ok(daily.every(m => m.reward && (m.reward.type === 'frame' || m.reward.type === 'color' || m.reward.type === 'badge')),
    'награды миссий — только косметика (рамка, цвет, значок), без токенов');

  const rp = P.replay(rounds, 10);
  eq(rp[0].roundId, 'PM_b', 'Replay: самый свежий завершённый раунд первым');
  ok(rp.every(r => r.roundId !== 'PM_run'), 'Replay не показывает незавершённый раунд');
  ok(rp.every(r => r.roundId !== 'UPG'), 'Replay не показывает апгрейд (только Pulse Market)');

  const sp = P.seasonProgress(rounds, start - 2 * DAY, now);
  ok(sp.rounds >= 1, 'сезон: раунды внутри сезона учтены');
  ok(sp.reached.every(r => r.type && r.id && r.name), 'награды сезона — косметика с id и названием');
  ok(P.SEASON.tiers.every(t => t.reward.type !== 'tokens'), 'награды сезона не содержат токенов');
  ok(P.DAILY_MISSIONS.every(m => m.reward.type !== 'tokens'), 'награды ежедневных миссий не содержат токенов');

  console.log('\n=== PROGRESS API (bot.js) ===');
  const srv = await startServer({
    users: [{ id: UID, tokens: 20000, depositedRub: 1000, name: 'Prog' }],
    port: 34730
  });
  const post = (p, b) => srv.post(p, b, UID);
  try {
    const before = srv.bal(UID);
    const empty = await post('/api/progress', {});
    eq(empty.status, 200, 'прогресс доступен');
    eq(empty.body.stats.rounds, 0, 'у нового игрока 0 раундов');
    eq(empty.body.title.current.id, 'rookie', 'новичок получает титул «Новичок»');

    // Играем реальные раунды: Pulse (ставка + результат) и Trend (ставка + ответ).
    const pb = await post('/api/pulse/bet', { direction: 'up', leverage: 1, duration: 5, bet: 100, requestId: 'prog-pulse-0001' });
    eq(pb.status, 200, 'Pulse: ставка принята для прогресса');
    await new Promise(r => setTimeout(r, 5200));
    await post('/api/pulse/result', { roundId: pb.body.roundId });

    const ts = await post('/api/trend/start', { level: 1, bet: 50, requestId: 'prog-trend-0001' });
    eq(ts.status, 200, 'Trend: раунд начат для прогресса');
    await post('/api/trend/answer', { roundId: ts.body.roundId, answer: 'flat' });

    const after = await post('/api/progress', {});
    ok(after.body.stats.rounds >= 2, `прогресс видит сыгранные раунды (${after.body.stats.rounds})`);
    ok(after.body.stats.favorite === 'PULSE MARKET' || after.body.stats.favorite === 'TREND HUNTER', 'прогресс назвал любимую игру');
    ok(after.body.replay.some(r => r.roundId === pb.body.roundId), 'Replay содержит сыгранный Pulse-раунд');
    ok(after.body.missions.some(m => m.progress > 0), 'миссии обновились по сыгранным раундам');

    // Прогресс не меняет баланс: токены не начисляются за миссии и статистику.
    const balNow = srv.bal(UID);
    eq(balNow, after.body.tokens, 'ответ прогресса содержит текущий баланс');
    ok(before >= balNow, 'баланс не вырос от прогресса (токены только ставками)');
    eq(20000 + srv.ledgerSum(UID), srv.bal(UID), 'инвариант ledger сохранён');
  } finally {
    await srv.stop();
  }

  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => {
  console.error('\nТЕСТ УПАЛ:', e.message);
  process.exit(1);
});
