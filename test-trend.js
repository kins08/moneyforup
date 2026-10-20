'use strict';
/**
 * MoneyForUp — тесты Trend Hunter (DECISIONS.md D6).
 *   1) математика trend.js: RTP на всех уровнях, распределение, детерминизм, комбо;
 *   2) E2E на реальном bot.js: ставка списывается, дубль не списывает, правильный
 *      ответ не отдаётся клиенту, повтор ответа не платит второй раз, ledger сходится.
 */
const assert = require('assert');
const crypto = require('crypto');
const trend = require('./trend');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const UID = 880222;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (${a} === ${b})`);

(async () => {
  console.log('=== TREND MATH ===');
  // 1. RTP на всех уровнях = (1/3) × множитель = 1 − edge.
  for (const lvl of [1, 2, 3]) {
    const rtp = (1 / 3) * trend.payoutMultiplier(lvl);
    ok(Math.abs(rtp - (1 - trend.TREND.edge)) < 1e-9, `уровень ${lvl}: RTP = ${rtp.toFixed(4)} = 1 − edge`);
    ok(rtp < 1, `уровень ${lvl}: касса в плюсе`);
  }

  // 2. Распределение паттернов ≈ 1/3 каждый.
  const cnt = { rise: 0, fall: 0, flat: 0 }; const M = 90000;
  for (let i = 0; i < M; i++) cnt[trend.generateScenario({ seedHex: 'seed-x', level: 1, scenarioId: 'S' + i }).pattern]++;
  for (const k of ['rise', 'fall', 'flat']) {
    ok(Math.abs(cnt[k] / M - 1 / 3) < 0.01, `паттерн ${k} ≈ 1/3 (получили ${(cnt[k] / M).toFixed(4)})`);
  }

  // 3. Детерминизм сценария.
  const a = trend.generateScenario({ seedHex: 'k', level: 2, scenarioId: 'id1' });
  const b = trend.generateScenario({ seedHex: 'k', level: 2, scenarioId: 'id1' });
  ok(JSON.stringify(a) === JSON.stringify(b), 'сценарий детерминирован для одного seed и id');

  // 4. Публичная конфигурация не раскрывает правильный ответ.
  const pubNoAnswer = JSON.stringify(trend.publicConfig()).replace(/"patterns":\[[^\]]*\]/g, '');
  ok(!/"pattern"|"correct"|"answer"/i.test(pubNoAnswer), 'публичная конфигурация не раскрывает ответ');

  // 5. Проверка ответа и комбо (только отображение, выплата от него не зависит).
  ok(trend.checkAnswer({ pattern: 'rise' }, 'rise') === true, 'верный ответ распознан');
  ok(trend.checkAnswer({ pattern: 'rise' }, 'fall') === false, 'неверный ответ распознан');
  let c = 0; c = trend.nextCombo(c, true); c = trend.nextCombo(c, true);
  eq(c, 2, 'комбо растёт при верных ответах');
  c = trend.nextCombo(c, false);
  eq(c, 0, 'комбо сбрасывается при ошибке');

  console.log('\n=== TREND API (bot.js) ===');
  const srv = await startServer({
    users: [{ id: UID, tokens: 10000, depositedRub: 1000, name: 'Trend' }],
    port: 34720
  });
  const post = (p, b) => srv.post(p, b, UID);
  try {
    const cfg = await post('/api/trend/config', {});
    eq(cfg.status, 200, 'конфиг Trend Hunter доступен');
    ok(cfg.body.config.levels.length === 3, 'три уровня сложности');

    const st = await post('/api/trend/start', { level: 1, bet: 300, requestId: 'trend-req-00001' });
    eq(st.status, 200, 'раунд начат');
    eq(st.body.tokens, 9700, 'ставка 300 списана сервером');
    ok(Array.isArray(st.body.points) && st.body.points.length === 12, 'клиент получил график уровня 1');
    ok(!/"pattern"|"answer"|"correct"/i.test(JSON.stringify(st.body)), 'ответ старта не содержит правильный паттерн');

    const dup = await post('/api/trend/start', { level: 1, bet: 300, requestId: 'trend-req-00001' });
    eq(dup.body.duplicate, true, 'повтор старта помечен duplicate');
    eq(dup.body.tokens, 9700, 'повтор старта не списал вторую ставку');

    const ans = await post('/api/trend/answer', { roundId: st.body.roundId, answer: 'rise' });
    eq(ans.status, 200, 'ответ принят');
    ok(typeof ans.body.result.correct === 'boolean', 'результат содержит признак верности');
    ok(typeof ans.body.result.pattern === 'string', 'правильный паттерн раскрыт ПОСЛЕ ответа');
    const expected = 9700 + (ans.body.result.correct ? ans.body.result.payout : 0);
    eq(ans.body.tokens, expected, 'баланс сходится с выплатой');

    const again = await post('/api/trend/answer', { roundId: st.body.roundId, answer: 'fall' });
    eq(again.body.duplicate, true, 'повторный ответ помечен duplicate');
    eq(again.body.tokens, expected, 'повторный ответ не начислил выплату второй раз');
    ok(again.body.result.correct === ans.body.result.correct, 'изменить ответ после отправки нельзя');

    const bad = await post('/api/trend/answer', { roundId: 'TH_nope', answer: 'rise' });
    ok(bad.status === 404, 'несуществующий раунд отклонён');
    const badAns = await post('/api/trend/start', { level: 1, bet: 100, requestId: 'trend-req-00002' });
    const wrongAnswer = await post('/api/trend/answer', { roundId: badAns.body.roundId, answer: 'sideways' });
    eq(wrongAnswer.status, 400, 'неизвестный паттерн отклонён');

    eq(10000 + srv.ledgerSum(UID), srv.bal(UID), 'стартовый баланс + ledger = текущий баланс');
  } finally {
    await srv.stop();
  }

  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => {
  console.error('\nТЕСТ УПАЛ:', e.message);
  process.exit(1);
});
