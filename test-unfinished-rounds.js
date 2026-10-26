'use strict';
/**
 * MoneyForUp — брошенные раунды (игрок закрыл приложение / сервер перезапустился).
 *
 * Проверяет:
 *  1) Pulse: идущий раунд возвращается как active, просроченный рассчитывается
 *     сервером; повторный recovery не начисляет второй раз; раунд закрыт в БД.
 *  2) Pulse после перезапуска сервера: раунд рассчитывается из game_rounds
 *     эндпоинтом /api/pulse/pending.
 *  3) Ракетка: незабранная ставка после взрыва закрывается проигрышем самим
 *     сервером (свип), деньги повторно не двигаются, ставка видна в closed.
 *  4) Ракетка после перезапуска: ставка восстанавливается из БД, кэшаут
 *     работает по сохранённой точке взрыва, повторный кэшаут не платит.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, sleep } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓', m); };
const eq = (a, b, m) => ok(a === b, `${m} (${a} === ${b})`);

const roundRow = (srv, roundId) => srv.db.db
  .prepare('SELECT round_id, user_id, status, bet_tokens, mult, win_tokens, params, settled_at FROM game_rounds WHERE round_id = ?')
  .get(roundId);

/* Подменяем params.crash в БД, пока сервер остановлен: после рестарта
   раунд восстановится именно с этой точкой взрыва. */
function patchRoundParams(tmp, roundId, patch) {
  const file = path.join(tmp, 'data', 'moneyforup.db');
  const raw = new DatabaseSync(file);
  try {
    const row = raw.prepare('SELECT params FROM game_rounds WHERE round_id = ?').get(roundId);
    assert.ok(row, 'раунд найден в БД для патча');
    const p = row.params ? JSON.parse(row.params) : {};
    raw.prepare('UPDATE game_rounds SET params = ? WHERE round_id = ?')
      .run(JSON.stringify({ ...p, ...patch }), roundId);
  } finally {
    raw.close();
  }
}

/* Ставка в Ракетке принимается только в первые 3 с раунда. Ждём начало
   раунда, чтобы после рестарта оставалось время на кэшаут. */
async function alignToRoundStart(maxInto = 2000) {
  const into = Date.now() % 12000;
  if (into > maxInto) await sleep(12000 - into + 300);
}

(async () => {
  console.log('=== PULSE: БРОШЕННЫЙ РАУНД И РЕСТАРТ ===');
  const tmpPulse = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-abandon-pulse-'));
  const UP = 880511;
  const srvP1 = await startServer({
    users: [{ id: UP, tokens: 10000, depositedRub: 1000, name: 'PulseAbandon' }],
    port: 34770,
    reuseTmp: tmpPulse
  });
  let pulseRoundId = '';
  try {
    const bet = await srvP1.post('/api/pulse/bet', {
      direction: 'up', leverage: 1, duration: 5, bet: 200, requestId: 'abandon-pulse-01'
    }, UP);
    eq(bet.status, 200, 'Pulse: ставка принята');
    eq(bet.body.tokens, 9800, 'Pulse: ставка списана один раз');
    pulseRoundId = bet.body.roundId;

    const flying = await srvP1.post('/api/pulse/pending', {}, UP);
    eq(flying.status, 200, 'Pulse: /pending доступен');
    ok(flying.body.active && flying.body.active.roundId === pulseRoundId,
      'Pulse: идущий раунд возвращён как active');
    eq(flying.body.active.dueAt, bet.body.dueAt, 'Pulse: dueAt совпадает с выданным при ставке');
    eq((flying.body.results || []).length, 0, 'Pulse: результат до таймера не выдаётся');
  } finally {
    await srvP1.stop();
  }

  // Игрок закрыл приложение — сервер перезапустился, ждём истечения таймера.
  await sleep(5200);
  const srvP2 = await startServer({ users: [], port: 34772, reuseTmp: tmpPulse });
  try {
    const rec = await srvP2.post('/api/pulse/pending', { since: Date.now() - 3600000 }, UP);
    eq(rec.status, 200, 'Pulse: recovery после рестарта отвечает');
    eq(rec.body.active, null, 'Pulse: просроченный раунд больше не active');
    eq((rec.body.results || []).length, 1, 'Pulse: брошенный раунд рассчитан сервером из БД');
    const r = rec.body.results[0];
    eq(r.roundId, pulseRoundId, 'Pulse: вернулся тот же раунд');
    eq(r.bet, 200, 'Pulse: сумма ставки восстановлена');
    const balAfter = 9800 + (r.won ? Number(r.payout) || 0 : 0);
    eq(rec.body.tokens, balAfter, 'Pulse: баланс = ставка + выплата');
    eq(srvP2.bal(UP), balAfter, 'Pulse: баланс в БД сходится с ответом');

    const row = roundRow(srvP2, pulseRoundId);
    eq(row.status, 'settled', 'Pulse: раунд закрыт в game_rounds');
    const params = JSON.parse(row.params || '{}');
    eq(params.auto, true, 'Pulse: раунд помечен auto — игрок его не видел');
    eq(Number(row.win_tokens), r.won ? Number(r.payout) || 0 : 0, 'Pulse: win_tokens сходится с выплатой');

    const again = await srvP2.post('/api/pulse/pending', { since: Date.now() - 3600000 }, UP);
    eq(again.body.tokens, balAfter, 'Pulse: повторный recovery не начисляет второй раз');
    const dup = await srvP2.post('/api/pulse/result', { roundId: pulseRoundId }, UP);
    eq(dup.body.duplicate, true, 'Pulse: повторный /result помечен duplicate');
    eq(dup.body.tokens, balAfter, 'Pulse: повторный /result не платит второй раз');
    eq(10000 + srvP2.ledgerSum(UP), srvP2.bal(UP), 'Pulse: инвариант ledger сохранён');
  } finally {
    await srvP2.stop();
    fs.rmSync(tmpPulse, { recursive: true, force: true });
  }

  console.log('\n=== РАКЕТКА: БРОШЕННАЯ СТАВКА ЗАКРЫВАЕТСЯ СЕРВЕРОМ ===');
  const tmpRacket = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-abandon-racket-'));
  const UR = 880513;
  const srvR1 = await startServer({
    users: [{ id: UR, tokens: 10000, depositedRub: 1000, name: 'RacketAbandon' }],
    port: 34774,
    reuseTmp: tmpRacket
  });
  let abandoned = null;
  try {
    await alignToRoundStart();
    abandoned = await srvR1.post('/api/racket/bet', { bet: 250 }, UR);
    eq(abandoned.status, 200, 'Ракетка: ставка принята');
    eq(abandoned.body.tokens, 9750, 'Ракетка: ставка списана один раз');
  } finally {
    await srvR1.stop();
  }

  // Ранний взрыв, чтобы тест не ждал до ~29 с; после рестарта ставка
  // восстанавливается из БД с этой же точкой взрыва.
  patchRoundParams(tmpRacket, abandoned.body.roundId, { crash: 1.00 });
  const srvR2 = await startServer({ users: [], port: 34776, reuseTmp: tmpRacket });
  try {
    // Клиент закрыт: никаких игровых запросов, раунд должен закрыть свип.
    let row = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      row = roundRow(srvR2, abandoned.body.roundId);
      if (row && row.status === 'settled') break;
      await sleep(400);
    }
    ok(row && row.status === 'settled', 'Ракетка: брошенная ставка закрыта сервером без клиента');
    eq(Number(row.win_tokens), 0, 'Ракетка: незабранная ставка — проигрыш');
    const params = JSON.parse(row.params || '{}');
    eq(params.autoClosed, true, 'Ракетка: раунд помечен autoClosed');
    eq(Number(params.crash), 1, 'Ракетка: сохранена точка взрыва раунда');
    eq(srvR2.bal(UR), 9750, 'Ракетка: после закрытия деньги не двигаются');

    const pend = await srvR2.post('/api/racket/pending', { since: Date.now() - 3600000 }, UR);
    eq(pend.status, 200, 'Ракетка: /pending отвечает');
    eq((pend.body.active || []).length, 0, 'Ракетка: закрытая ставка не показывается активной');
    const closed = (pend.body.closed || []).find(x => x.roundId === abandoned.body.roundId);
    ok(closed, 'Ракетка: потерянная ставка показана в closed');
    eq(Number(closed.crash), 1, 'Ракетка: клиент получает точку взрыва для сообщения');
    eq(pend.body.tokens, 9750, 'Ракетка: баланс не изменился восстановлением');
    eq(10000 + srvR2.ledgerSum(UR), srvR2.bal(UR), 'Ракетка: инвариант ledger сохранён');
  } finally {
    await srvR2.stop();
  }

  console.log('\n=== РАКЕТКА: КЭШАУТ ПОСЛЕ РЕСТАРТА ===');
  const tmpCash = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-racket-cashout-'));
  const UC = 880514;
  const srvC1 = await startServer({
    users: [{ id: UC, tokens: 6000, depositedRub: 600, name: 'RacketCash' }],
    port: 34778,
    reuseTmp: tmpCash
  });
  let cashBet = null;
  try {
    await alignToRoundStart();
    cashBet = await srvC1.post('/api/racket/bet', { bet: 200 }, UC);
    eq(cashBet.status, 200, 'Ракетка: вторая ставка принята');
    eq(cashBet.body.tokens, 5800, 'Ракетка: вторая ставка списана');
  } finally {
    await srvC1.stop();
  }

  // Реалистичный поздний взрыв: после рестарта кэшаут ещё успевает.
  patchRoundParams(tmpCash, cashBet.body.roundId, { crash: 8 });
  const srvC2 = await startServer({ users: [], port: 34780, reuseTmp: tmpCash });
  try {
    const pend = await srvC2.post('/api/racket/pending', {}, UC);
    const active = (pend.body.active || []).find(x => x.roundId === cashBet.body.roundId);
    ok(active, 'Ракетка: ставка восстановлена как active после рестарта');
    eq(Number(active.bet), 200, 'Ракетка: ставка восстановлена из БД');
    eq(Number(active.rIdx), Number(cashBet.body.rIdx), 'Ракетка: индекс раунда восстановлен');

    const co = await srvC2.post('/api/racket/cashout', { roundId: cashBet.body.roundId, mult: 1.5 }, UC);
    eq(co.status, 200, 'Ракетка: кэшаут после рестарта принят');
    eq(co.body.win, 300, 'Ракетка: выигрыш посчитан по множителю 1.5');
    eq(co.body.tokens, 6100, 'Ракетка: выигрыш начислен');
    eq(srvC2.bal(UC), 6100, 'Ракетка: баланс в БД сходится');

    const co2 = await srvC2.post('/api/racket/cashout', { roundId: cashBet.body.roundId, mult: 1.5 }, UC);
    eq(co2.status, 400, 'Ракетка: повторный кэшаут отклонён');
    eq(srvC2.bal(UC), 6100, 'Ракетка: повторный кэшаут не начислил второй раз');

    const row = roundRow(srvC2, cashBet.body.roundId);
    eq(row.status, 'settled', 'Ракетка: раунд закрыт в game_rounds');
    eq(Number(row.mult), 1.5, 'Ракетка: множитель записан');
    eq(Number(row.win_tokens), 300, 'Ракетка: выплата записана');
    eq(JSON.parse(row.params || '{}').cashedOut, true, 'Ракетка: раунд помечен cashedOut');
    eq(6000 + srvC2.ledgerSum(UC), srvC2.bal(UC), 'Ракетка: инвариант ledger сохранён');
  } finally {
    await srvC2.stop();
    fs.rmSync(tmpCash, { recursive: true, force: true });
    fs.rmSync(tmpRacket, { recursive: true, force: true });
  }

  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => {
  console.error('\nТЕСТ УПАЛ:', e.message);
  process.exit(1);
});
