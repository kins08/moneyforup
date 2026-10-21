'use strict';
/**
 * MoneyForUp — unit-тесты серверной математики Апгрейдера.
 * Не поднимает сервер: проверяет чистые функции upgrade.js и каталог items.js.
 */
const assert = require('assert');
const upgrade = require('./upgrade');
const items = require('./items');
const caseModes = require('./assets/case-modes.js');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log('  ✓', msg);
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log('=== UPGRADE MATH ===');

// 1. Единственный режим апгрейдера (DECISIONS.md, D4): потолок шанса 70%.
const modes = Object.values(upgrade.MODES);
ok(modes.length === 1 && modes[0].id === 'standard', 'один внутренний режим standard');
ok(modes.every(m => m.chanceCap === 0.70), 'потолок шанса 70%');
ok(modes.every(m => m.edge > 0 && m.edge < 0.2), 'edge в разумных пределах');
ok(upgrade.getMode('safe') && upgrade.getMode('safe').id === 'standard', 'старый id safe маппится в standard');
ok(upgrade.getMode('balanced') && upgrade.getMode('extreme'), 'старые id balanced/extreme маппятся');
ok(upgrade.getMode('bogus') === null, 'неизвестный режим отклоняется');

// 2. Каталог целей собран из существующего items.js и не содержит дублей.
ok(upgrade.TARGETS.length >= 20, `каталог целей: ${upgrade.TARGETS.length}`);
ok(new Set(upgrade.TARGETS.map(t => t.code)).size === upgrade.TARGETS.length, 'коды целей уникальны');
ok(upgrade.TARGETS.every(t => items.CASES[String(t.code).split('#')[0]]), 'каждая цель существует в items.js');

// 3. Формула шанса и EV для одиночной цели.
for (const m of modes) {
  const source = 1000;
  const target = upgrade.TARGETS.find(t => t.value > source * 2 && t.value < source * m.maxMult);
  ok(Boolean(target), `${m.label}: есть цель для проверки`);
  const v = upgrade.validateTargets(m, source, [target.code]);
  ok(v.ok, `${m.label}: цель проходит валидацию`);
  const p = v.targets[0].chance;
  const expectedP = Math.min(m.chanceCap, (1 - m.edge) * source / target.value);
  ok(close(p, expectedP), `${m.label}: шанс = min(cap, (1-edge)*S/T)`);
  const ev = p * target.value - source;
  ok(ev <= -m.edge * source + 1e-6, `${m.label}: EV не положительный (${ev.toFixed(2)} ≤ ${(-m.edge * source).toFixed(2)})`);
}

// 4. Валидация целей на сервере.
const m = upgrade.MODES.standard;
const cheap = upgrade.TARGETS.find(t => t.value <= 1000 * 1.05);
ok(!upgrade.validateTargets(m, 1000, [cheap.code]).ok, 'цель дешевле источника +5% отклонена');
const tooExpensive = upgrade.TARGETS.find(t => t.value > 10 * m.maxMult);
ok(Boolean(tooExpensive), 'в каталоге есть цель выше потолка для проверки');
ok(!upgrade.validateTargets(m, 10, [tooExpensive.code]).ok, 'цель выше потолка режима отклонена');
const two = upgrade.TARGETS.filter(t => t.value > 1200 && t.value < 5000).slice(0, 2);
ok(two.length === 2, 'есть две цели для мульти');
ok(!upgrade.validateTargets(m, 1000, [two[0].code, two[0].code]).ok, 'дубль цели отклонён');
ok(!upgrade.validateTargets(m, 1000, Array(6).fill(two[0].code)).ok, 'больше 5 целей отклонено');

// 5. Мульти-апгрейд: распределение не учитывает вероятности дважды.
const multi = upgrade.validateTargets(m, 1000, two.map(t => t.code));
ok(multi.ok, 'мульти-цели валидны');
const sumDist = multi.distribution.reduce((s, d) => s + d.chance, 0);
ok(close(sumDist, multi.aggregateChance, 1e-9), 'сумма распределения = совокупный шанс');
ok(close(multi.aggregateChance, multi.targets.reduce((s, t) => s + t.chance, 0) / multi.targets.length, 1e-9),
  'совокупный шанс = среднее шансов целей');
const roll = upgrade.rollUpgrade(m, 1000, multi.targets, 0.0, 0.0);
ok(roll.ok && roll.won === true, 'rollUpgrade: random01=0 выбирает первую цель и выигрывает');
const rollLose = upgrade.rollUpgrade(m, 1000, multi.targets, 0.999999, 0.999999);
ok(rollLose.ok && rollLose.won === false, 'rollUpgrade: random01≈1 проигрывает');

// 6. Лесенка: превью, множители и отрицательный EV на каждом шаге.
for (const steps of [3, 5, 10]) {
  for (const mode of modes) {
    const prev = upgrade.ladderPreview(mode, steps, 1000);
    ok(prev && prev.stepsData.length === steps, `${mode.label}/${steps}: превью содержит ${steps} шагов`);
    let value = 1000;
    for (const s of prev.stepsData) {
      value = Math.floor(value * s.mult);
      ok(s.chance > 0 && s.chance <= mode.chanceCap + 1e-12, `${mode.label}/${steps}: шанс шага ${s.step} в пределах cap`);
      ok(s.chance * s.mult - 1 <= -mode.edge + 1e-9, `${mode.label}/${steps}: EV шага ${s.step} ≤ -edge`);
      ok(s.valueAfter === value, `${mode.label}/${steps}: valueAfter шага ${s.step} пересчитан`);
    }
  }
}

// 7. Новые кейсы: возврат игроку 80–86% (снижен на 3 п.п.), веса 100, цены в диапазоне.
console.log('\n=== CASE MODES ===');
const modeIds = Object.keys(caseModes.MODES);
ok(modeIds.length === 5, 'пять новых режимов кейсов');
for (const id of modeIds) {
  const cm = caseModes.MODES[id];
  const economy = caseModes.caseEconomy(id);
  ok(cm.items.length === 14, `${id}: 14 предметов`);
  ok(cm.items.reduce((s, i) => s + i.w, 0) === 100, `${id}: сумма весов = 100`);
  ok(economy.returnRate >= 0.80 && economy.returnRate <= 0.86, `${id}: возврат ${economy.returnRate.toFixed(4)} в диапазоне 0.80–0.86`);
  ok(cm.items.every(i => i.price >= cm.priceMin && i.price <= cm.priceMax), `${id}: цены предметов в диапазоне режима`);
  ok(cm.price >= cm.priceMin && cm.price <= cm.priceMax, `${id}: цена открытия в диапазоне`);
  ok(new Set(cm.items.map(i => i.code)).size === cm.items.length, `${id}: коды предметов уникальны`);
  const drop = caseModes.rollItem(id, 0.999999);
  ok(drop && drop.modeId === id, `${id}: rollItem возвращает предмет режима`);
}

console.log(`\nИТОГ: ${passed} проверок пройдено.`);
