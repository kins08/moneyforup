'use strict';
/**
 * MoneyForUp — E2E новых механик на РЕАЛЬНОМ bot.js в изолированной БД.
 *
 * Покрывает: пять новых кейсов, идемпотентность открытия, атомарность
 * списаний, мульти-апгрейд, предмет-источник, лесенку (включая гонку двух
 * шагов и повтор после потери ответа), скретч/сейф, атомарный +25% бонус.
 */
const assert = require('assert');
const path = require('path');
const {
  startServer
} = require('./.agents/skills/security-audit/scripts/lib/server-harness');

const UID = 880001;
const POOR = 880002;
const OPENING = 500000;
let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log('  ✓', msg);
};
const eq = (a, b, msg) => ok(a === b, `${msg} (${a} === ${b})`);

(async () => {
  const srv = await startServer({
    users: [
      { id: UID, tokens: OPENING, depositedRub: 1000, name: 'E2E' },
      { id: POOR, tokens: 50, depositedRub: 0, name: 'Poor' }
    ],
    port: 34690
  });
  const post = (p, b) => srv.post(p, b, UID);
  const bal = () => srv.bal(UID);
  const ledger = () => srv.ledgerSum(UID);
  const round = id => srv.db.getRound(id);

  try {
    console.log('\n1) Пять новых режимов кейсов');
    const cat = await post('/api/cases/catalog', {});
    eq(cat.status, 200, 'каталог кейсов доступен');
    eq(cat.body.modes.length, 5, 'ровно 5 режимов');
    const modeIds = cat.body.modes.map(m => m.id);
    for (const id of ['starter_drop', 'cyber_rush', 'golden_vault', 'glitch_mode', 'omega_core']) {
      ok(modeIds.includes(id), `режим ${id} присутствует`);
    }
    const prices = Object.fromEntries(cat.body.modes.map(m => [m.id, m.price]));
    ok(cat.body.modes.every(m => m.items.length === 14), 'у каждого режима 14 предметов');
    ok(cat.body.modes.every(m => m.items.every(i => i.chance > 0)), 'у предметов показаны шансы');

    let expected = bal();
    for (const m of cat.body.modes) {
      const r = await post('/api/cases/open', { modeId: m.id, requestId: 'case-open-' + m.id });
      eq(r.status, 200, `${m.name}: открытие успешно`);
      ok(r.body.drop && r.body.drop.id, `${m.name}: предмет выдан с серверным id`);
      expected -= m.price;
      eq(r.body.tokens, expected, `${m.name}: списана ровно цена ${m.price} ⬦`);
    }
    eq(bal(), expected, 'баланс после пяти кейсов сходится');
    const inv = await post('/api/inventory', {});
    eq(inv.body.count, 5, 'в инвентаре ровно 5 предметов');
    eq(OPENING + ledger(), bal(), 'ledger-инвариант после кейсов');

    console.log('\n2) Идемпотентность открытия кейса');
    const before = bal();
    const r1 = await post('/api/cases/open', { modeId: 'cyber_rush', requestId: 'case-dup-000001' });
    const r2 = await post('/api/cases/open', { modeId: 'cyber_rush', requestId: 'case-dup-000001' });
    eq(r1.status, 200, 'первое открытие прошло');
    eq(r2.status, 200, 'повтор вернул сохранённый результат');
    ok(r2.body.duplicate === true, 'повтор помечен duplicate=true');
    eq(bal(), before - prices.cyber_rush, 'повтор не списал вторую цену');
    const sameDrop = r1.body.drop && r2.body.drop && r1.body.drop.id === r2.body.drop.id;
    ok(sameDrop, 'повтор вернул тот же предмет');

    console.log('\n3) Параллельные открытия с одним requestId');
    const beforeRace = bal();
    const [a, b] = await Promise.all([
      post('/api/cases/open', { modeId: 'starter_drop', requestId: 'case-race-000001' }),
      post('/api/cases/open', { modeId: 'starter_drop', requestId: 'case-race-000001' })
    ]);
    eq([a.status, b.status].filter(x => x === 200).length, 2, 'оба запроса получили 200 (один — duplicate)');
    const duplicates = [a, b].filter(x => x.body.duplicate === true).length;
    eq(duplicates, 1, 'ровно один запрос помечен duplicate');
    eq(bal(), beforeRace - prices.starter_drop, 'списана ровно одна цена');

    console.log('\n4) Недостаточно баланса');
    const poorOpen = await srv.post('/api/cases/open', { modeId: 'omega_core', requestId: 'case-poor-00001' }, POOR);
    eq(poorOpen.status, 400, 'кейс за 35 000 недоступен игроку с 50 ⬦');
    eq(srv.bal(POOR), 50, 'баланс бедного игрока не тронут');

    console.log('\n5) Апгрейдер: каталог и одиночный апгрейд');
    const uc = await post('/api/upgrade/catalog', {});
    eq(uc.status, 200, 'каталог апгрейдера доступен');
    eq(uc.body.modes.length, 3, 'три режима риска');
    ok(uc.body.targets.length >= 20, 'каталог целей серверный');
    const target = uc.body.targets.find(t => t.value > 1500 && t.value < 8000);
    const beforeUp = bal();
    const up = await post('/api/upgrade/run', {
      mode: 'balanced', sourceType: 'tokens', amount: 1000,
      targets: [target.code], requestId: 'upgrade-single-0001'
    });
    eq(up.status, 200, 'одиночный апгрейд выполнен');
    eq(bal(), beforeUp - 1000, 'списан ровно источник');
    ok(up.body.chance > 0 && up.body.chance <= 0.75, 'шанс в пределах режима');
    ok(round('UPG_' + UID + '_upgrade-single-0001'), 'раунд записан в game_rounds');

    const beforeDup = bal();
    const upDup = await post('/api/upgrade/run', {
      mode: 'balanced', sourceType: 'tokens', amount: 1000,
      targets: [target.code], requestId: 'upgrade-single-0001'
    });
    ok(upDup.body.duplicate === true, 'повтор апгрейда помечен duplicate');
    eq(bal(), beforeDup, 'повтор не списал деньги');

    console.log('\n6) Валидация целей и суммы');
    const low = uc.body.targets.find(t => t.value < 1000);
    const badTarget = await post('/api/upgrade/run', {
      mode: 'balanced', sourceType: 'tokens', amount: 1000,
      targets: [low.code], requestId: 'upgrade-badtarget-01'
    });
    eq(badTarget.status, 400, 'цель дешевле источника отклонена');
    const badAmount = await post('/api/upgrade/run', {
      mode: 'balanced', sourceType: 'tokens', amount: 999999,
      targets: [target.code], requestId: 'upgrade-badamount-01'
    });
    eq(badAmount.status, 400, 'сумма выше лимита отклонена');
    const badMode = await post('/api/upgrade/run', {
      mode: 'hack', sourceType: 'tokens', amount: 100,
      targets: [target.code], requestId: 'upgrade-badmode-0001'
    });
    eq(badMode.status, 400, 'неизвестный режим отклонён');

    console.log('\n7) Мульти-апгрейд: распределение не удваивает шансы');
    const targets2 = uc.body.targets.filter(t => t.value > 1200 && t.value < 7000).slice(0, 3);
    const beforeMulti = bal();
    const multi = await post('/api/upgrade/run', {
      mode: 'extreme', sourceType: 'tokens', amount: 1000,
      targets: targets2.map(t => t.code), requestId: 'upgrade-multi-00001'
    });
    eq(multi.status, 200, 'мульти-апгрейд выполнен');
    eq(bal(), beforeMulti - 1000, 'списан один источник на мульти');
    eq(multi.body.distribution.length, 3, 'распределение содержит 3 цели');
    const sum = multi.body.distribution.reduce((s, d) => s + d.chance, 0);
    ok(Math.abs(sum - multi.body.aggregateChance) < 1e-9, 'сумма распределения = совокупный шанс');
    ok(multi.body.aggregateChance < 1, 'совокупный шанс меньше 100%');

    console.log('\n8) Апгрейд предмета-источника');
    const c = await post('/api/cases/open', { modeId: 'cyber_rush', requestId: 'item-source-case-01' });
    const src = c.body.drop;
    const t2 = uc.body.targets.find(t => t.value > src.price * 1.05 && t.value <= src.price * 3);
    const invBeforeItem = await post('/api/inventory', {});
    const beforeItem = bal();
    const itemUp = await post('/api/upgrade/run', {
      mode: 'safe', sourceType: 'item', itemId: src.id,
      targets: [t2.code], requestId: 'upgrade-item-000001'
    });
    eq(itemUp.status, 200, 'апгрейд предмета выполнен');
    eq(bal(), beforeItem, 'апгрейд предмета не двигает токены');
    const invAfter = await post('/api/inventory', {});
    const sourceStillThere = invAfter.body.items.some(x => x.id === src.id);
    ok(!sourceStillThere, 'предмет-источник списан из инвентаря');
    eq(invAfter.body.count, invBeforeItem.body.count - 1 + (itemUp.body.won ? 1 : 0),
      'инвентарь согласован (источник −1, цель +1 при победе)');
    // Повтор после списания источника: кэш должен вернуться, а не 400.
    const itemDup = await post('/api/upgrade/run', {
      mode: 'safe', sourceType: 'item', itemId: src.id,
      targets: [t2.code], requestId: 'upgrade-item-000001'
    });
    eq(itemDup.status, 200, 'повтор апгрейда списанного предмета возвращает кэш');
    ok(itemDup.body.duplicate === true, 'повтор предметного апгрейда помечен duplicate');
    eq(bal(), beforeItem, 'повтор предметного апгрейда не двигает токены');

    console.log('\n9) Лесенка: шаги, повтор, кэшаут');
    const lad = await post('/api/upgrade/ladder/start', {
      mode: 'safe', steps: 3, sourceType: 'tokens', amount: 1000,
      requestId: 'ladder-start-00001'
    });
    eq(lad.status, 200, 'лесенка запущена');
    ok(lad.body.session && lad.body.session.id, 'сервер выдал id сессии');
    const sid = lad.body.session.id;
    const step = await post('/api/upgrade/ladder/step', {
      sessionId: sid, expectedStep: 1, requestId: 'ladder-step-000001'
    });
    eq(step.status, 200, 'первый шаг выполнен');
    const stepDup = await post('/api/upgrade/ladder/step', {
      sessionId: sid, expectedStep: 1, requestId: 'ladder-step-000001'
    });
    eq(stepDup.status, 200, 'повтор шага вернул 200');
    ok(stepDup.body.duplicate === true, 'повтор шага помечен duplicate');
    const stepWrong = await post('/api/upgrade/ladder/step', {
      sessionId: sid, expectedStep: 1, requestId: 'ladder-step-wrong-01'
    });
    eq(stepWrong.status, 400, 'другой requestId на тот же шаг отклонён');
    const state = await post('/api/upgrade/ladder/state', { sessionId: sid });
    eq(state.status, 200, 'состояние сессии доступно после шага');
    ok(state.body.session.stepIndex >= 1, 'шаг сохранён на сервере');

    if (state.body.session.status === 'active') {
      const beforeCash = bal();
      const cash = await post('/api/upgrade/ladder/cashout', {
        sessionId: sid, requestId: 'ladder-cash-000001'
      });
      eq(cash.status, 200, 'кэшаут выполнен');
      const paid = cash.body.result.paid;
      eq(bal(), beforeCash + paid, 'кэшаут начислил ровно currentValue');
      const cashDup = await post('/api/upgrade/ladder/cashout', {
        sessionId: sid, requestId: 'ladder-cash-000001'
      });
      ok(cashDup.body.duplicate === true, 'повтор кэшаута помечен duplicate');
      eq(bal(), beforeCash + paid, 'повтор кэшаута не начислил второй раз');
    }

    console.log('\n10) Гонка двух шагов лесенки');
    const lad2 = await post('/api/upgrade/ladder/start', {
      mode: 'safe', steps: 5, sourceType: 'tokens', amount: 500,
      requestId: 'ladder-race-start-01'
    });
    const sid2 = lad2.body.session.id;
    const [s1, s2] = await Promise.all([
      post('/api/upgrade/ladder/step', { sessionId: sid2, expectedStep: 1, requestId: 'ladder-race-a-0001' }),
      post('/api/upgrade/ladder/step', { sessionId: sid2, expectedStep: 1, requestId: 'ladder-race-b-0001' })
    ]);
    eq([s1.status, s2.status].filter(x => x === 200).length, 1, 'только один параллельный шаг принят');
    eq([s1.status, s2.status].filter(x => x === 400).length, 1, 'второй параллельный шаг отклонён');
    // Закрываем возможную активную сессию, чтобы следующая лесенка не
    // упиралась в guard «одна активная сессия на игрока».
    const st2 = await post('/api/upgrade/ladder/state', { sessionId: sid2 });
    if (st2.body.session && st2.body.session.status === 'active') {
      await post('/api/upgrade/ladder/cashout', { sessionId: sid2, requestId: 'ladder-race-cash-01' });
    }
    eq(OPENING + ledger(), bal(), 'ledger-инвариант после лесенки');

    console.log('\n10b) Лесенка с предметом-источником и повтор старта');
    const c2 = await post('/api/cases/open', { modeId: 'starter_drop', requestId: 'ladder-item-case-01' });
    const ladderItem = c2.body.drop;
    const ladItem = await post('/api/upgrade/ladder/start', {
      mode: 'safe', steps: 3, sourceType: 'item', itemId: ladderItem.id,
      requestId: 'ladder-item-start-01'
    });
    eq(ladItem.status, 200, 'лесенка с предметом запущена');
    const ladItemDup = await post('/api/upgrade/ladder/start', {
      mode: 'safe', steps: 3, sourceType: 'item', itemId: ladderItem.id,
      requestId: 'ladder-item-start-01'
    });
    eq(ladItemDup.status, 200, 'повтор старта с уже списанным предметом возвращает сессию');
    ok(ladItemDup.body.duplicate === true, 'повтор старта лесенки помечен duplicate');
    eq(ladItemDup.body.session.id, ladItem.body.session.id, 'повтор вернул ту же сессию');
    // Закрываем сессию, чтобы не мешать следующим проверкам.
    const itemStep = await post('/api/upgrade/ladder/step', {
      sessionId: ladItem.body.session.id, expectedStep: 1, requestId: 'ladder-item-step-01'
    });
    eq(itemStep.status, 200, 'шаг предметной лесенки выполнен');
    if (itemStep.body.session && itemStep.body.session.status === 'active') {
      await post('/api/upgrade/ladder/cashout', {
        sessionId: ladItem.body.session.id, requestId: 'ladder-item-cash-01'
      });
    }

    console.log('\n10c) Револьвер: повторный старт и восстановление состояния');
    const rs1 = await post('/api/revolver/start', { bet: 100, insurance: false, requestId: 'revolver-start-0001' });
    eq(rs1.status, 200, 'первый старт револьвера принят');
    const rs2 = await post('/api/revolver/start', { bet: 100, insurance: false, requestId: 'revolver-start-0002' });
    eq(rs2.status, 409, 'второй старт при активном раунде отклонён');
    ok(rs2.body.state && rs2.body.state.step === 0, '409 вернул состояние активного раунда');
    const revState = await post('/api/revolver/state', {});
    ok(revState.body.active === true, 'state показывает активный раунд');
    const trig = await post('/api/revolver/trigger', { requestId: 'revolver-trigger-0001' });
    eq(trig.status, 200, 'выстрел выполнен');
    if (!trig.body.fired) {
      const cash = await post('/api/revolver/cashout', { requestId: 'revolver-cash-0001' });
      eq(cash.status, 200, 'кэшаут после холостого выстрела выполнен');
    }
    const revState2 = await post('/api/revolver/state', {});
    ok(revState2.body.active === false, 'после завершения активного раунда нет');

    console.log('\n11) Скретч и сейф: повтор запроса');
    const beforeScratch = bal();
    const sc1 = await post('/api/scratch/play', { bet: 50, insurance: false, requestId: 'scratch-dup-000001' });
    const sc2 = await post('/api/scratch/play', { bet: 50, insurance: false, requestId: 'scratch-dup-000001' });
    eq(sc1.status, 200, 'скретч куплен');
    ok(sc2.body.duplicate === true, 'повтор скретча помечен duplicate');
    eq(JSON.stringify(sc1.body.grid), JSON.stringify(sc2.body.grid), 'повтор вернул ту же сетку');
    eq(bal(), sc2.body.tokens, 'повтор не списал второй билет');
    ok(sc2.body.tokens !== beforeScratch, 'первый билет действительно списался');

    const safe1 = await post('/api/safe/guess', { code: '1234', requestId: 'safe-dup-000001' });
    const safe2 = await post('/api/safe/guess', { code: '1234', requestId: 'safe-dup-000001' });
    eq(safe1.status, 200, 'попытка сейфа принята');
    ok(safe2.body.duplicate === true, 'повтор сейфа помечен duplicate');
    eq(safe2.body.balance, safe1.body.balance, 'повтор сейфа не списал вторые 25 ⬦');

    console.log('\n11b) Бесплатный кейс: два параллельных клика');
    srv.db.db.prepare('UPDATE users SET free_cases = 1 WHERE id = ?').run(UID);
    const invBeforeFree = await post('/api/inventory', {});
    const [f1, f2] = await Promise.all([
      post('/api/open-free-case', {}),
      post('/api/open-free-case', {})
    ]);
    eq([f1.status, f2.status].filter(x => x === 200).length, 1, 'бесплатный кейс выдан ровно один раз');
    eq([f1.status, f2.status].filter(x => x === 400).length, 1, 'второй параллельный клик отклонён');
    const invAfterFree = await post('/api/inventory', {});
    eq(invAfterFree.body.count, invBeforeFree.body.count + 1, 'в инвентарь добавлен ровно один предмет');

    console.log('\n12) +25% бонус: атомарный claim');
    const first = srv.db.claimFirstDepositBonus(UID);
    const second = srv.db.claimFirstDepositBonus(UID);
    eq(first, true, 'первый claim бонуса успешен');
    eq(second, false, 'второй claim бонуса отклонён');

    console.log('\n13) Инвариант ledger');
    eq(OPENING + ledger(), bal(), 'opening + SUM(ledger) == итоговый баланс');

    console.log(`\nИТОГ: ${passed} проверок пройдено.`);
  } finally {
    await srv.stop();
  }
})().catch(e => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
