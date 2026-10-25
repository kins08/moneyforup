'use strict';
/* Регрессия FREE-кейсов: ежедневный 1–6 ₽, одноразовые за 3/5 друзей,
   коллекционные предметы нельзя продать или улучшить, кулдаун-уведомления. */
const assert = require('assert');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const UID = 990001;
const OPENING = 500;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (${a} === ${b})`);

function addFriend(srv, mainId, n) {
  const id = mainId * 10 + n;
  srv.db.saveUser({
    id, numId: id % 100000, name: `Friend ${n}`, username: `friend_${n}`,
    tokens: 100, staked: 0, stakeSince: 0, accruedBase: 0,
    ref: mainId, refEarned: 0, refInvited: 0, termsAt: Date.now(),
    totalDepositedRub: 0, lastDeposit: 0, lastDepositId: 0,
    lastCashbackAt: 0, cashbackClaimedDepositId: 0, easycashClaimed: false,
    code: 'FR' + id
  });
  srv.db.saveRound({
    roundId: `FR_${id}_${Date.now()}_${n}`,
    userId: id, game: 'dice', bet: 10, mult: 2, win: 0, status: 'settled'
  });
}

(async () => {
  const srv = await startServer({
    users: [{ id: UID, tokens: OPENING, depositedRub: 100, name: 'Free' }],
    port: 34720
  });
  const post = (p, b) => srv.post(p, b, UID);
  const bal = () => srv.bal(UID);
  const ledger = () => srv.ledgerSum(UID);

  try {
    console.log('\n1) Стартовый статус FREE-кейсов');
    let r = await post('/api/free-case/status', {});
    eq(r.status, 200, 'статус доступен');
    eq(r.body.daily.ready, true, 'ежедневный кейс готов');
    eq(r.body.ref3.canClaim, false, 'кейс за 3 друзей закрыт');
    eq(r.body.ref5.canClaim, false, 'кейс за 5 друзей закрыт');
    eq(r.body.ref3.item.collectible, 1, 'предмет за 3 друзей — коллекционный');
    eq(r.body.ref5.item.collectible, 1, 'предмет за 5 друзей — коллекционный');

    console.log('\n2) Ежедневный кейс: 1–6 ₽ и защита от двойного клика');
    const before = bal();
    const [d1, d2] = await Promise.all([
      post('/api/free-case/daily', {}),
      post('/api/free-case/daily', {})
    ]);
    eq([d1.status, d2.status].filter(x => x === 200).length, 1, 'ровно один запрос прошёл');
    eq([d1.status, d2.status].filter(x => x === 400).length, 1, 'второй отклонён');
    const win = d1.status === 200 ? d1.body : d2.body;
    ok(win.prizeRub >= 1 && win.prizeRub <= 6, `приз в диапазоне 1–6 ₽ (${win.prizeRub})`);
    eq(win.prize, win.prizeRub * 10, 'внутри приз пересчитан в токены');
    eq(bal(), before + win.prize, 'баланс вырос ровно на приз');
    eq((await post('/api/free-case/daily', {})).status, 400, 'повтор до 24 ч отклонён');
    r = await post('/api/free-case/status', {});
    eq(r.body.daily.ready, false, 'таймер 24 ч запущен');

    console.log('\n3) Кейс за 3 друзей');
    for (let i = 1; i <= 3; i++) addFriend(srv, UID, i);
    r = await post('/api/free-case/status', {});
    eq(r.body.ref3.qualified, 3, 'три активных друга засчитаны');
    eq(r.body.ref3.canClaim, true, 'кейс за 3 друзей открыт');
    eq(r.body.ref5.canClaim, false, 'кейс за 5 друзей ещё закрыт');
    const r3 = await post('/api/free-case/ref', { level: 3 });
    eq(r3.status, 200, 'кейс за 3 друзей открыт');
    eq(r3.body.drop.code, 'ref3_tws_blackgold', 'выданы TWS-наушники Black Gold');
    eq(r3.body.drop.price, 1700, 'стоимость 170 ₽');
    eq(r3.body.drop.collectible, true, 'предмет помечен коллекционным');
    eq((await post('/api/free-case/ref', { level: 3 })).status, 400, 'повторное открытие запрещено');
    let inv = await post('/api/inventory', {});
    const item3 = inv.body.items.find(x => x.code === 'ref3_tws_blackgold');
    ok(Boolean(item3), 'предмет за 3 друзей лежит в инвентаре');
    eq(item3.collectible, true, 'в инвентаре стоит флаг collectible');
    let sell = await post('/api/inventory/sell', { itemId: item3.id });
    eq(sell.status, 400, 'продажа коллекционного предмета запрещена');
    ok(/Коллекционный/.test(sell.body.error), 'ошибка объясняет запрет продажи');
    let upg = await post('/api/upgrade/run', {
      mode: 'standard', sourceType: 'item', itemId: item3.id,
      targets: ['case_500#0'], requestId: 'free-collect-upg-' + Date.now()
    });
    eq(upg.status, 400, 'апгрейд коллекционного предмета запрещён');
    let play = await post('/api/play', { game: 'upgrader', itemId: item3.id, mult: 2 });
    eq(play.status, 400, 'старый /api/play тоже не берёт коллекцию');

    console.log('\n4) Кейс за 5 друзей');
    for (let i = 4; i <= 5; i++) addFriend(srv, UID, i);
    r = await post('/api/free-case/status', {});
    eq(r.body.ref5.qualified, 5, 'пять активных друзей засчитаны');
    eq(r.body.ref5.canClaim, true, 'кейс за 5 друзей открыт');
    const r5 = await post('/api/free-case/ref', { level: 5 });
    eq(r5.status, 200, 'кейс за 5 друзей открыт');
    eq(r5.body.drop.code, 'ref5_watch_onyx', 'выданы Смарт-часы Onyx Gold');
    eq(r5.body.drop.price, 2400, 'стоимость 240 ₽');
    eq(r5.body.drop.collectible, true, 'предмет коллекционный');
    eq((await post('/api/free-case/ref', { level: 5 })).status, 400, 'повторное открытие запрещено');
    inv = await post('/api/inventory', {});
    const item5 = inv.body.items.find(x => x.code === 'ref5_watch_onyx');
    ok(Boolean(item5), 'предмет за 5 друзей лежит в инвентаре');
    sell = await post('/api/inventory/sell-all', {});
    eq(sell.status, 400, 'продать всё не трогает коллекцию');

    console.log('\n5) Уведомления о закончившихся кулдаунах');
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    srv.db.db.prepare('UPDATE users SET free_daily_at = ?, last_seen_at = ?, free_notified_at = 0, free_notify_day = \'\' WHERE id = ?')
      .run(now - 2 * 86400000, now - 3600000, UID);
    const cands = srv.db.listCooldownNotifyCandidates(now, day, 100);
    ok(cands.some(x => Number(x.id) === UID), 'игрок с истёкшим кд попал в выборку');
    srv.db.setFreeNotified(UID, now, day);
    const again = srv.db.listCooldownNotifyCandidates(now, day, 100);
    ok(!again.some(x => Number(x.id) === UID && x.free_notify_day === day), 'после уведомления повторно не выбирается');

    srv.db.db.prepare('UPDATE users SET free_daily_at = 0, last_wheel_spin = ?, last_seen_at = ?, free_notified_at = 0, free_notify_day = ? WHERE id = ?')
      .run(now - 13 * 3600000, now, day, UID);
    const activeWheel = srv.db.listCooldownNotifyCandidates(now, day, 100);
    ok(activeWheel.some(x => Number(x.id) === UID), 'активный игрок с готовым колесом попал в выборку');

    console.log('\n6) Промокоды');
    srv.db.db.prepare('DELETE FROM promo_codes WHERE code = ?').run('__PURGE_20261025__');
    srv.db.upsertPromo('MONEYUP', 500, 100);
    srv.db.upsertPromo('START', 250, 50);
    srv.db.upsertPromo('WEEK42', 100, 200);
    const purge = srv.db.purgePromosExcept('WEEK42');
    ok(purge.ok, 'одноразовая очистка промокодов выполнена');
    eq(srv.db.listPromos(100).map(x => x.code).join(','), 'WEEK42', 'в базе остался только WEEK42');
    const markerUse = srv.db.atomicApplyPromo(UID, '__PURGE_20261025__');
    ok(!markerUse.ok, 'служебный маркер нельзя активировать');

    console.log('\n7) Стрик и квесты: серверная проверка');
    let ch = await post('/api/challenge/status', {});
    eq(ch.status, 200, 'статус челленджей доступен');
    eq(ch.body.quests.q1.progress, 0, 'q1 начинается с нуля');
    eq(ch.body.quests.q2.progress, 0, 'q2 начинается с нуля');
    eq(ch.body.quests.q3.progress, 0, 'q3 начинается с нуля');
    eq(ch.body.streakAvailable, true, 'первый стрик доступен');

    let streak = await post('/api/claim-challenge', { type: 'streak', amount: 250 });
    eq(streak.status, 200, 'первый стрик начислен');
    eq(streak.body.amount, 25, 'клиентская сумма 250 проигнорирована, начислено 25 ₽');
    eq(streak.body.streakDay, 1, 'сервер вернул день 1');
    eq((await post('/api/claim-challenge', { type: 'streak', amount: 250 })).status, 400, 'повторный стрик отклонён');

    for (const qid of ['q1', 'q2', 'q3']) {
      const bad = await post('/api/claim-challenge', { type: 'quest', questId: qid });
      eq(bad.status, 400, `${qid} без выполнения отклонён`);
    }
    for (let i = 1; i <= 3; i++) {
      srv.db.saveRound({
        roundId: `CH_RK_${i}_${Date.now()}`,
        userId: UID, game: 'Ракетка', bet: 100, mult: 2, win: 200, status: 'settled'
      });
    }
    ch = await post('/api/challenge/status', {});
    eq(ch.body.quests.q1.progress, 3, 'q1 видит 3 успешных кэшаута');
    eq(ch.body.quests.q2.progress, 1, 'q2 видит ставку');
    const q1 = await post('/api/claim-challenge', { type: 'quest', questId: 'q1' });
    eq(q1.status, 200, 'q1 начислен после выполнения');
    eq(q1.body.amount, 30, 'q1 начисляет 30 ₽');
    eq((await post('/api/claim-challenge', { type: 'quest', questId: 'q1' })).status, 400, 'q1 повторно не начисляется');
    const q2 = await post('/api/claim-challenge', { type: 'quest', questId: 'q2' });
    eq(q2.status, 200, 'q2 начислен после ставки');
    eq(q2.body.amount, 25, 'q2 начисляет 25 ₽');
    eq((await post('/api/claim-hotdrop', {})).status, 200, 'Hot Drop получен для q3');
    const q3 = await post('/api/claim-challenge', { type: 'quest', questId: 'q3' });
    eq(q3.status, 200, 'q3 начислен после Hot Drop');
    eq(q3.body.amount, 20, 'q3 начисляет 20 ₽');
    ch = await post('/api/challenge/status', {});
    eq(ch.body.quests.q1.claimed && ch.body.quests.q2.claimed && ch.body.quests.q3.claimed, true, 'статус отмечает все квесты полученными');
    eq(ch.body.streakAvailable, false, 'статус видит кулдаун стрика');

    console.log('\n8) Инвариант ledger');
    eq(OPENING + ledger(), bal(), 'opening + ledger == баланс');

    console.log(`\nИТОГ: ${passed} проверок пройдено.`);
  } finally {
    await srv.stop();
  }
})().catch(e => { console.error('\nFAIL:', e.message); process.exit(1); });
