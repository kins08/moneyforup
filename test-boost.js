'use strict';
/**
 * MoneyForUp — тесты персонального буста дропа.
 *   1) чистая логика boost.js;
 *   2) админ-эндпоинты: доступ только владельцу, поиск, выдача и снятие;
 *   3) буст реально влияет на исходы (dice и Pulse) и не раскрывается клиенту.
 */
const assert = require('assert');
const boost = require('./boost');
const upgrade = require('./upgrade');
const { startServer } = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const ADMIN = 990001;
const PLAYER = 880777;
const OTHER = 880778;

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (${a} === ${b})`);

(async () => {
  console.log('=== BOOST MATH ===');
  eq(boost.normalizeLuck(-5), 0, 'отрицательная удача приводится к 0');
  eq(boost.normalizeLuck(150), 100, 'удача выше 100 обрезается');
  eq(boost.normalizeLuck('55'), 55, 'строковое число принимается');
  eq(boost.normalizeLuck('abc'), 0, 'нечисловое значение — 0');
  ok(!boost.triggers(0, 0), 'при 0% буст никогда не срабатывает');
  ok(boost.triggers(100, 0.999999), 'при 100% буст срабатывает всегда');
  ok(!boost.triggers(50, 0.5), 'на границе 50% строгое сравнение');
  ok(boost.triggers(51, 0.5), '51% ловит бросок 0.5');

  const seq = (items) => { let i = 0; return () => items[i++]; };
  let calls = 0;
  const noBoost = boost.boostDrop(0, 0, () => { calls++; return { price: 10 }; });
  eq(noBoost.price, 10, 'без буста возвращается первый дроп');
  eq(calls, 1, 'без буста делается ровно один бросок');

  const rolls = seq([{ price: 10 }, { price: 100 }, { price: 300 }]);
  const boosted = boost.boostDrop(100, 0, rolls);
  eq(boosted.price, 300, 'буст оставляет самый дорогой из трёх дропов');

  const seeds = seq(['a', 'b', 'c']);
  const picked = boost.pickPulseSeed(() => seeds(), s => s === 'b');
  eq(picked, 'b', 'подбор seed находит выигрышное направление');

  eq(boost.cashoutBonus(100, 0, 0).win, 100, 'без буста кэшаут не меняется');
  eq(boost.cashoutBonus(100, 0, 0).boosted, false, 'без буста флаг boosted = false');
  eq(boost.cashoutBonus(100, 100, 0).win, 150, 'буст даёт +50% к кэшауту');
  eq(boost.cashoutBonus(101, 100, 0).win, 151, 'бонус округляется вниз');

  console.log('\n=== BOOST API ===');
  const srv = await startServer({
    adminId: ADMIN,
    users: [
      { id: ADMIN, tokens: 10000, depositedRub: 1000, name: 'Владелец' },
      { id: PLAYER, tokens: 100000, depositedRub: 1000, name: 'Избранный' },
      { id: OTHER, tokens: 10000, depositedRub: 1000, name: 'Обычный' }
    ],
    port: 34740
  });
  const asAdmin = (p, b) => srv.post(p, b, ADMIN);
  const asPlayer = (p, b) => srv.post(p, b, PLAYER);
  try {
    const denied = await asPlayer('/api/admin/luck/list', {});
    eq(denied.status, 403, 'обычный игрок не видит список бустов');
    const deniedSet = await asPlayer('/api/admin/luck/set', { userId: PLAYER, luck: 100 });
    eq(deniedSet.status, 403, 'обычный игрок не может выдать буст');

    const empty = await asAdmin('/api/admin/luck/list', {});
    eq(empty.status, 200, 'владелец получает список бустов');
    eq(empty.body.boosts.length, 0, 'изначально список пуст');

    const found = await asAdmin('/api/admin/luck/search', { query: String(PLAYER) });
    eq(found.status, 200, 'поиск по ID работает');
    ok(found.body.users.some(u => u.id === PLAYER), 'нужный игрок найден');
    ok(found.body.users.every(u => !('password' in u)), 'поиск не отдаёт лишние поля');

    const set = await asAdmin('/api/admin/luck/set', { userId: PLAYER, luck: 100 });
    eq(set.status, 200, 'буст 100% выдан');
    eq(set.body.luck, 100, 'сервер вернул фактическую удачу');
    eq(set.body.user.id, PLAYER, 'сервер вернул выбранного игрока');

    const badLuck = await asAdmin('/api/admin/luck/set', { userId: PLAYER, luck: 101 });
    eq(badLuck.status, 400, 'удача выше 100 отклонена');
    const unknown = await asAdmin('/api/admin/luck/set', { userId: 123456789, luck: 50 });
    eq(unknown.status, 404, 'несуществующий игрок отклонён');

    const list = await asAdmin('/api/admin/luck/list', {});
    eq(list.body.boosts.length, 1, 'в списке один бустнутый игрок');
    eq(list.body.boosts[0].userId, PLAYER, 'в списке именно избранный игрок');
    eq(list.body.boosts[0].luck, 100, 'в списке удача 100%');

    const searchBoosted = await asAdmin('/api/admin/luck/search', { query: '@audit_' + PLAYER });
    ok(searchBoosted.body.users.some(u => u.id === PLAYER && u.luck === 100), 'поиск показывает текущий буст');

    // Буст 100% превращает каждый раунд dice с ×20 в победу.
    let wins = 0;
    for (let i = 0; i < 5; i++) {
      const r = await asPlayer('/api/play', { game: 'dice', bet: 10, mult: 20, roundId: 'boost-dice-' + i });
      eq(r.status, 200, `раунд dice #${i + 1} принят`);
      if (r.body.verdict === 'win' && r.body.win === 200) wins++;
    }
    eq(wins, 5, 'с бустом 100% выиграны все 5 раундов dice');

    // Pulse: сервер подбирает seed под направление игрока.
    const start = await asPlayer('/api/pulse/bet', {
      direction: 'up', leverage: 1, duration: 5, bet: 100, requestId: 'boost-pulse-0001'
    });
    eq(start.status, 200, 'ставка Pulse принята');
    ok(!/seed/i.test(JSON.stringify(start.body)), 'ответ Pulse не содержит seed');
    await new Promise(r => setTimeout(r, 5200));
    const res = await asPlayer('/api/pulse/result', { roundId: start.body.roundId });
    eq(res.status, 200, 'результат Pulse раскрыт после таймера');
    eq(res.body.result.won, true, 'с бустом 100% Pulse засчитан как победа');
    eq(res.body.result.outcome, 'up', 'исход совпал с выбранным направлением');

    // Буст 100% обязан форсировать победу и в новом серверном апгрейдере:
    // клиент рисует стрелку по ответу сервера, поэтому won должен быть true.
    const upgCat = await asPlayer('/api/upgrade/catalog', {});
    eq(upgCat.status, 200, 'каталог апгрейдера доступен');
    const validTargets = upgCat.body.targets
      .filter(t => t.value > 105 && t.value <= 10000)
      .sort((a, b) => a.value - b.value);
    ok(validTargets.length >= 2, 'есть минимум две цели для апгрейда');
    const cheap = validTargets[0];
    const expensive = validTargets[validTargets.length - 1];
    const upgBefore = srv.bal(PLAYER);
    const upg = await asPlayer('/api/upgrade/run', {
      mode: 'standard', sourceType: 'tokens', amount: 100,
      targets: [cheap.code, expensive.code], requestId: 'boost-upg-0001'
    });
    eq(upg.status, 200, 'апгрейд с бустом принят');
    eq(upg.body.won, true, 'с бустом апгрейд всегда успешен');
    eq(upg.body.target && upg.body.target.code, expensive.code, 'буст выбирает самую дорогую цель');
    eq(srv.bal(PLAYER), upgBefore - 100, 'источник апгрейда списан ровно один раз');
    ok(upg.body.drop && upg.body.drop.id, 'выигрышный предмет выдан с серверным id');
    const upgInv = await asPlayer('/api/inventory', {});
    ok(upgInv.body.items.some(x => x.id === upg.body.drop.id), 'выигрышный предмет лежит в инвентаре');

    // Снятие буста: список пустеет, поиск показывает 0.
    const reset = await asAdmin('/api/admin/luck/set', { userId: PLAYER, luck: 0 });
    eq(reset.status, 200, 'буст снят');
    const listAfter = await asAdmin('/api/admin/luck/list', {});
    eq(listAfter.body.boosts.length, 0, 'после снятия список пуст');
    const searchAfter = await asAdmin('/api/admin/luck/search', { query: String(PLAYER) });
    ok(searchAfter.body.users.some(u => u.id === PLAYER && u.luck === 0), 'поиск показывает 0% после снятия');

    const bal = await asPlayer('/api/balance', {});
    ok(!('luck' in bal.body) && !('boost' in bal.body), 'баланс игрока не раскрывает буст');

    eq(100000 + srv.ledgerSum(PLAYER), srv.bal(PLAYER), 'стартовый баланс + ledger = текущий баланс');
  } finally {
    await srv.stop();
  }

  console.log(`\nИТОГ: ${passed} проверок пройдено.`);
})().catch(e => {
  console.error('\nТЕСТ УПАЛ:', e.message);
  process.exit(1);
});
