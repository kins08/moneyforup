#!/usr/bin/env node
/**
 * E2E-тест: инвентарь принадлежит серверу (P1-5).
 *
 * Поднимает реальный bot.js и проверяет, что предметы нельзя подделать,
 * продать дважды, продать чужое или назначить им цену с клиента.
 * Плюс проверяет, что экономика кейса не печатает деньги: предмет — это
 * ЕДИНСТВЕННАЯ выплата за раунд (токены сверху не начисляются).
 *
 * Запуск: node .agents/skills/security-audit/scripts/e2e-inventory-test.js
 *   exit 0 — инвентарь серверный, экономика сходится
 *   exit 1 — регрессия
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { startServer, C, ROOT } = require(path.join(__dirname, 'lib', 'server-harness'));
const items = require(path.join(ROOT, 'items.js'));

const PORT = 34521;
const UID = 616161;
const OTHER = 616162;          // второй игрок — для проверки чужого предмета
const START = 100000;
const ADMIN_ID = 999999999;

let failures = 0;
const ok = m => console.log(`   ${C.grn('✅')} ${m}`);
const bad = m => { failures++; console.log(`   ${C.red('❌')} ${m}`); };

(async () => {
  console.log('\nE2E: инвентарь — MoneyForUp');

  const srv = await startServer({
    port: PORT, adminId: ADMIN_ID,
    users: [
      { id: UID,   tokens: START, depositedRub: 3000 },
      { id: OTHER, tokens: 5000,  depositedRub: 1000 }
    ]
  });
  const { post, bal, db } = srv;
  console.log(C.dim('изолированная копия: ' + srv.tmp + '\n'));

  // ── 1. Каталог на сервере совпадает с клиентским ─────────────────────────
  console.log('1) Каталог предметов — на сервере, а не в браузере');
  const caseIds = Object.keys(items.CASES);
  const itemCount = caseIds.reduce((n, id) => n + items.CASES[id].items.length, 0);
  console.log(`   кейсов: ${caseIds.length}, предметов: ${itemCount}`);
  if (caseIds.length === 15 && itemCount === 255) ok('каталог сервера: 15 кейсов, 255 предметов');
  else bad(`неожиданный каталог: ${caseIds.length} кейсов, ${itemCount} предметов`);

  // Сверка с таблицей, вшитой в клиент: если они разойдутся, игрок увидит
  // в анимации один предмет, а в инвентаре другой.
  // Сравниваем ЧИСЛА (4.0 в тексте клиента и 4 в JSON — одно и то же значение),
  // поэтому парсим клиентскую таблицу, а не ищем строку целиком.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const attrRe = /\{ name: '([^']*)', icon: '([^']*)', price: (\d+), w: ([\d.]+), tier: '(\w+)' \}/g;
  let mismatches = 0, compared = 0;
  for (const id of caseIds) {
    const c = items.CASES[id];
    const from = html.indexOf(`\n  ${id}: {`);
    const nextIds = caseIds.filter(x => x !== id)
      .map(x => html.indexOf(`\n  ${x}: {`, from + 1))
      .filter(x => x !== -1);
    const to = nextIds.length ? Math.min(...nextIds) : html.length;
    const seg = html.slice(from, to);
    const clientItems = [...seg.matchAll(attrRe)].map(m => ({
      name: m[1], icon: m[2], price: Number(m[3]), w: Number(m[4]), tier: m[5]
    }));
    if (clientItems.length !== c.items.length) {
      mismatches++;
      console.log(`   ${C.yel('⚠️')} ${id}: у клиента ${clientItems.length} предметов, на сервере ${c.items.length}`);
      continue;
    }
    for (let i = 0; i < c.items.length; i++) {
      const a = c.items[i], b = clientItems[i];
      compared++;
      if (a.name !== b.name || a.icon !== b.icon || a.price !== b.price ||
          Math.abs(a.w - b.w) > 1e-9 || a.tier !== b.tier) {
        mismatches++;
        if (mismatches <= 3) console.log(`   ${C.yel('⚠️')} расхождение: ${id} · «${b.name}» против «${a.name}»`);
      }
    }
  }
  console.log(`   сверено предметов: ${compared}`);
  if (mismatches === 0) ok('клиентская таблица совпадает с серверным каталогом — анимация не разойдётся с инвентарём');
  else bad(`${mismatches} расхождений между клиентом и сервером`);

  // ── 2. Экономика кейсов в разумных границах ──────────────────────────────
  console.log('\n2) Экономика кейсов (предмет = выплата)');
  let minReturn = 9, maxReturn = 0, worst = '';
  for (const id of caseIds) {
    const r = items.caseEconomy(id);
    if (r.returnRate < minReturn) { minReturn = r.returnRate; worst = id; }
    if (r.returnRate > maxReturn) maxReturn = r.returnRate;
  }
  console.log(`   Возврат игроку: от ${minReturn.toFixed(3)} (${worst}) до ${maxReturn.toFixed(3)}`);
  if (minReturn > 0.5 && maxReturn < 1.0) ok('ни один кейс не отдаёт больше, чем берёт');
  else bad(`Возврат вне границ: ${minReturn.toFixed(3)}…${maxReturn.toFixed(3)} — кейс печатает деньги`);

  // ── 3. Открытие кейса: ставка = цена кейса, предмет уходит в инвентарь ────
  console.log('\n3) Открытие кейса: предмет попадает в СЕРВЕРНЫЙ инвентарь');
  const c500 = items.CASES.case_500;
  const b3 = bal(UID);
  const r3 = await post('/api/play', { game: 'Кейс: ' + c500.name, bet: c500.cost }, UID);
  const drop3 = r3.body && r3.body.drop;
  console.log(`   ответ: ${r3.status} ${C.dim(JSON.stringify(drop3 || r3.body).slice(0, 130))}`);
  if (r3.status === 200 && drop3 && drop3.code) ok(`выпал предмет: ${drop3.icon} ${drop3.name} — ${drop3.price} ⬦`);
  else bad('сервер не вернул предмет в ответе на открытие кейса');
  if (bal(UID) === b3 - c500.cost) ok(`списана ровно цена кейса: −${c500.cost} ⬦ (токены за раунд не начислены)`);
  else bad(`баланс изменился не на цену кейса: ${bal(UID) - b3} ⬦ вместо ${-c500.cost}`);
  if (r3.body && r3.body.win === 0) ok('выигрыш в токенах = 0 — выплата идёт предметом, а не токенами');
  else bad(`за раунд начислены токены (win=${r3.body && r3.body.win}) — двойная выплата`);

  // ── 4. Предмет виден в инвентаре через API ───────────────────────────────
  console.log('\n4) GET /api/inventory показывает предмет игрока');
  const inv4 = await post('/api/inventory', {}, UID);
  const myItems = (inv4.body && inv4.body.items) || [];
  console.log(`   предметов: ${myItems.length}, стоимость: ${inv4.body && inv4.body.value} ⬦`);
  const found = myItems.find(x => x.id === (drop3 && drop3.id));
  if (found) ok(`предмет #${found.id} «${found.name}» есть в инвентаре, цена из сервера: ${found.price} ⬦`);
  else bad('выпавший предмет не найден в инвентаре через API');
  if (found && found.price === drop3.price) ok('цена в инвентаре совпадает с ценой выдачи');
  else bad('цена предмета в инвентаре разошлась с выданной');

  // ── 5. Продажа: начисление ровно один раз ────────────────────────────────
  console.log('\n5) Продажа предмета');
  const b5 = bal(UID);
  const r5 = await post('/api/inventory/sell', { itemId: found.id }, UID);
  console.log(`   ответ: ${r5.status} ${C.dim(JSON.stringify(r5.body).slice(0, 110))}`);
  if (bal(UID) === b5 + found.price) ok(`начислено ровно ${found.price} ⬦ — цена сервера, не клиента`);
  else bad(`начислено ${bal(UID) - b5} ⬦ вместо ${found.price} ⬦`);

  const r5b = await post('/api/inventory/sell', { itemId: found.id }, UID);
  if (r5b.status === 400 && bal(UID) === b5 + found.price) ok('повторная продажа отклонена, баланс не изменился');
  else bad(`повтор продал предмет второй раз (${r5b.status}, баланс ${bal(UID)})`);

  // ── 6. Подмена цены и чужой предмет ──────────────────────────────────────
  console.log('\n6) Клиент не может назначить цену или продать чужое');
  const r6 = await post('/api/play', { game: 'Кейс: ' + c500.name, bet: c500.cost }, UID);
  const drop6 = r6.body && r6.body.drop;
  const b6 = bal(UID);
  const r6b = await post('/api/inventory/sell', { itemId: drop6.id, price: 999999, value: 999999 }, UID);
  console.log(`   продажа с price:999999 → начислено ${bal(UID) - b6} ⬦`);
  if (bal(UID) - b6 === drop6.price) ok('присланная цена проигнорирована — начислена цена сервера');
  else bad(`клиент повлиял на сумму продажи: ${bal(UID) - b6} ⬦ вместо ${drop6.price} ⬦`);

  // Предмет второго игрока
  const r6c = await post('/api/play', { game: 'Кейс: ' + c500.name, bet: c500.cost }, OTHER);
  const foreign = r6c.body && r6c.body.drop;
  const b6d = bal(UID);
  const r6d = await post('/api/inventory/sell', { itemId: foreign.id }, UID);
  if (r6d.status === 404 && bal(UID) === b6d) ok('чужой предмет не продаётся (404, баланс не тронут)');
  else bad(`чужой предмет удалось продать (${r6d.status}, баланс ${bal(UID)})`);

  // Несуществующий предмет
  const r6e = await post('/api/inventory/sell', { itemId: 99999999 }, UID);
  if (r6e.status === 404) ok('несуществующий предмет отклонён с 404');
  else bad(`несуществующий предмет дал ${r6e.status}`);

  // ── 7. Ставка меньше цены кейса не открывает кейс ────────────────────────
  console.log('\n7) Кейс за 500 ⬦ нельзя открыть ставкой 10 ⬦');
  const b7 = bal(UID);
  const r7 = await post('/api/play', { game: 'Кейс: ' + c500.name, bet: 10 }, UID);
  console.log(`   ответ: ${r7.status} ${C.dim(JSON.stringify(r7.body).slice(0, 90))}`);
  if (r7.status === 400 && bal(UID) === b7) ok('отклонено, баланс не тронут — предмет не выдан за копейки');
  else bad(`кейс открылся неверной ставкой (${r7.status})`);

  // ── 8. Продать всё ───────────────────────────────────────────────────────
  console.log('\n8) Продажа всего инвентаря');
  const big = items.CASES.case_10000;
  for (let i = 0; i < 3; i++) await post('/api/play', { game: 'Кейс: ' + big.name, bet: big.cost }, UID);
  const inv8 = await post('/api/inventory', {}, UID);
  const expect8 = inv8.body.items.reduce((s, x) => s + x.price, 0);
  const b8 = bal(UID);
  const r8 = await post('/api/inventory/sell-all', {}, UID);
  console.log(`   продано ${r8.body && r8.body.count} шт на ${expect8} ⬦`);
  if (bal(UID) === b8 + expect8) ok(`начислено ровно ${expect8} ⬦ одним движением`);
  else bad(`начислено ${bal(UID) - b8} ⬦ вместо ${expect8} ⬦`);
  const inv8b = await post('/api/inventory', {}, UID);
  if ((inv8b.body.items || []).length === 0) ok('инвентарь пуст после продажи всего');
  else bad(`в инвентаре осталось ${inv8b.body.items.length} предметов`);

  // ── 9. Инвариант ledger всё ещё держится ─────────────────────────────────
  console.log('\n9) Инвариант ledger после продаж');
  const START_TOKENS = 50;
  const led = db.db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM transactions_ledger WHERE user_id = ?').get(UID).s;
  const openBal = START;         // задали при создании игрока в харнессе
  if (openBal + led === bal(UID)) ok(`игрок ${UID}: ${openBal} + (${led}) == ${bal(UID)} ⬦`);
  else bad(`расхождение: ${openBal} + (${led}) != ${bal(UID)} ⬦`);

  // ── 10. Раунды с дропом записаны ─────────────────────────────────────────
  console.log('\n10) Журнал раундов хранит выпавший предмет');
  const rounds = db.db.prepare(
    "SELECT round_id, item_code, item_price FROM game_rounds WHERE user_id = ? AND item_code IS NOT NULL"
  ).all(UID);
  console.log(`   раундов с предметом: ${rounds.length}`);
  if (rounds.length >= 5 && rounds.every(r => r.item_code && r.item_price > 0)) {
    ok('по каждому кейсу видно, что выпало и сколько это стоило — инцидент расследуем');
  } else bad('дроп не записан в журнал раундов');

  // ── 11. Рассинхрон ───────────────────────────────────────────────────────
  console.log('\n11) Детектор рассинхрона за весь тест');
  const drifts = (srv.log.match(/\[Ledger\] Рассинхрон/g) || []).length;
  if (drifts === 0) ok('ни одного случая рассинхрона');
  else bad(`${drifts} случаев рассинхрона`);

  console.log('\n' + '─'.repeat(64));
  await srv.stop();

  if (failures) {
    console.log(C.red(`ИТОГ: ${failures} провал(ов) — инвентарь не полностью серверный.`));
    process.exit(1);
  }
  console.log(C.grn('ИТОГ: инвентарь серверный — предмет нельзя подделать, продать дважды или по своей цене.'));
  console.log('Экономика кейса: предмет И ЕСТЬ выплата, токены сверху не начисляются.\n');
  process.exit(0);
})().catch(e => { console.error('Ошибка теста:', e.message || e); process.exit(2); });
