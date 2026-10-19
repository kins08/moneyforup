'use strict';
/**
 * MoneyForUp — jsdom smoke-тест фронтенда.
 *
 * Проверяет, что:
 *   • в навигации появился отдельный раздел «Кейсы»;
 *   • пять новых режимов рендерятся из assets/case-modes.js;
 *   • Upgrade Arena открывается, показывает 3 режима риска, 4 вкладки,
 *     цели, пересчитывает шанс при изменении суммы и поддерживает мульти;
 *   • переключение экранов не оставляет JS-ошибок.
 *
 * Сеть не используется: IS_TG=false, поэтому приложение работает в
 * оффлайн-демо режиме, а серверные вызовы не выполняются.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = __dirname;
let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log('  ✓', msg);
};
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"><\/script>/, '')
    .replace('<script src="assets/case-modes.js"></script>',
      '<script>' + fs.readFileSync(path.join(ROOT, 'assets', 'case-modes.js'), 'utf8') + '</script>');

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
  vc.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.fetch = () => Promise.reject(new Error('offline test'));
      w.scrollTo = () => {};
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    }
  });
  const w = dom.window;
  const d = w.document;

  try {
    await wait(2200);
    console.log('\n1) Навигация и раздел кейсов');
    const nav = [...d.querySelectorAll('.nav button')].map(b => b.dataset.nav);
    ok(nav.length === 5, 'в нижней навигации 5 разделов');
    ok(nav.includes('casehub'), 'есть отдельный раздел casehub');

    d.querySelector('.nav button[data-nav="casehub"]').click();
    await wait(150);
    ok(d.querySelector('#casehub').classList.contains('active'), 'экран кейсов активирован');
    eq(d.querySelectorAll('#caseHubArea .casehub-card').length, 5, 'пять карточек режимов');
    ok(Boolean(d.querySelector('.casehub-hero')), 'есть экран содержимого кейса');
    ok(Boolean(d.querySelector('#chOpen')), 'есть кнопка открытия');
    const names = [...d.querySelectorAll('#caseHubArea .casehub-card .ch-name')].map(x => x.textContent.trim());
    for (const n of ['STARTER DROP', 'CYBER RUSH', 'GOLDEN VAULT', 'GLITCH MODE', 'OMEGA CORE']) {
      ok(names.includes(n), `режим ${n} отрисован`);
    }
    eq(d.querySelectorAll('#caseHubArea .ch-online .online-dot').length, 5, 'у каждого кейса зелёный кружок слева от «онлайн»');
    const dotStyle = w.getComputedStyle(d.querySelector('#caseHubArea .ch-online .online-dot'));
    ok(dotStyle.borderRadius === '50%', 'кружок «онлайн» круглый');
    ok(/rgb\(61,\s*220,\s*150\)/.test(dotStyle.backgroundColor), 'кружок «онлайн» зелёный');

    // Переключение режима меняет hero.
    const cards = [...d.querySelectorAll('[data-chm]')];
    cards[4].click();
    await wait(80);
    ok(d.querySelector('.chh-name').textContent.includes('OMEGA CORE'), 'клик по карточке меняет детали режима');
    ok(d.querySelectorAll('.casehub-list .cli').length === 14, 'в содержимом 14 предметов');

    console.log('\n2) Upgrade Arena');
    d.querySelector('.nav button[data-nav="games"]').click();
    await wait(100);
    const upCard = d.querySelector('[data-game="upgrader"]');
    ok(Boolean(upCard), 'карточка Апгрейдера есть в играх');
    upCard.click();
    await wait(300);
    ok(d.querySelector('#play').classList.contains('active'), 'экран игры открыт');
    eq(d.querySelectorAll('.upg-mode').length, 3, 'три режима риска');
    eq(d.querySelectorAll('[data-utab]').length, 4, 'четыре вкладки: одиночный/мульти/лесенка/серия');
    ok(d.querySelectorAll('[data-ut]').length > 10, 'каталог целей отрисован');

    const amount = d.querySelector('#upgAmount');
    ok(Boolean(amount), 'есть поле ручной суммы');
    ok(Boolean(d.querySelector('#upgRange')), 'есть ползунок суммы');
    eq(d.querySelectorAll('[data-uq]').length, 4, 'быстрые кнопки ½ / ×2 / MAX / MIN');

    amount.value = '500';
    amount.dispatchEvent(new w.Event('input', { bubbles: true }));
    const enabled = [...d.querySelectorAll('[data-ut]:not([disabled])')];
    ok(enabled.length > 0, 'при сумме 500 есть доступные цели');
    enabled[0].click();
    await wait(80);
    const chanceText = d.querySelector('#upgChance').textContent;
    ok(/%$/.test(chanceText) && parseFloat(chanceText) > 0, `шанс пересчитан: ${chanceText}`);

    const safe = d.querySelector('[data-umode="safe"]');
    safe.click();
    await wait(100);
    ok(d.querySelector('[data-umode="safe"]').classList.contains('on'), 'режим SAFE переключается');
    // Смена режима меняет допустимые цели, поэтому выбор сбрасывается —
    // выбираем заново и проверяем, что шанс посчитан по новому edge/cap.
    const safeTarget = d.querySelector('[data-ut]:not([disabled])');
    if (safeTarget) safeTarget.click();
    await wait(80);
    ok(parseFloat(d.querySelector('#upgChance').textContent) > 0, 'шанс пересчитан после смены режима');

    console.log('\n3) Мульти-апгрейд');
    // Для мульти нужен режим с несколькими допустимыми целями: SAFE при
    // ставке 500 разрешает только узкий диапазон.
    d.querySelector('[data-umode="balanced"]').click();
    await wait(100);
    const amount2 = d.querySelector('#upgAmount');
    amount2.value = '1000';
    amount2.dispatchEvent(new w.Event('input', { bubbles: true }));
    d.querySelector('[data-utab="multi"]').click();
    await wait(120);
    const multiTargets = [...d.querySelectorAll('[data-ut]:not([disabled])')].slice(0, 3);
    multiTargets.forEach(t => t.click());
    await wait(120);
    const selectedCount = d.querySelectorAll('.upg-target.on').length;
    ok(selectedCount >= 2, `выбрано несколько целей (${selectedCount})`);
    ok(d.querySelectorAll('#upgDist .udr').length >= 2, 'показано распределение результатов');
    ok(Boolean(d.querySelector('#upgRun')), 'кнопка запуска мульти-апгрейда есть');

    console.log('\n4) Лесенка и серия');
    d.querySelector('[data-utab="ladder"]').click();
    await wait(120);
    ok(Boolean(d.querySelector('#upgLadderStart')), 'кнопка старта лесенки есть');
    const step5 = d.querySelector('[data-ulsteps="5"]');
    ok(Boolean(step5), 'выбор 5 шагов доступен');
    step5.click();
    await wait(80);
    eq(d.querySelectorAll('.upg-ladder-steps .uls').length, 5, 'превью лесенки показывает 5 шагов');

    d.querySelector('[data-utab="serial"]').click();
    await wait(120);
    ok(Boolean(d.querySelector('#upgSerialStart')), 'кнопка серии есть');
    ok(Boolean(d.querySelector('#upgSerialCount')), 'настройка количества попыток есть');

    console.log('\n5) Повторный вход и очистка');
    d.querySelector('.nav button[data-nav="profile"]').click();
    await wait(100);
    d.querySelector('.nav button[data-nav="games"]').click();
    await wait(100);
    d.querySelector('[data-game="upgrader"]').click();
    await wait(250);
    eq(d.querySelectorAll('.upg-mode').length, 3, 'повторный вход рендерит арену без дублей');
    eq(errors.length, 0, `нет JS-ошибок (${errors.slice(0, 3).join(' | ')})`);

    console.log(`\nИТОГ: ${passed} проверок пройдено.`);
  } finally {
    w.close();
  }
})().catch(e => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});

function eq(a, b, msg) {
  ok(a === b, `${msg} (${a} === ${b})`);
}
