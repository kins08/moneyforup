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
      w.HTMLElement.prototype.scrollIntoView = function(opts){ w.__mfuScroll = { el: this, opts: opts || {} }; };
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    }
  });
  const w = dom.window;
  const d = w.document;

  try {
    await wait(2200);
    console.log('\n0) Загрузочный экран');
    ok(Boolean(d.querySelector('#mupSplash .mup-splash-card')), 'загрузочный экран нарисован кодом');
    ok(Boolean(d.querySelector('#mupSplash svg.mup-splash-badge')), 'логотип — векторный SVG без картинки');
    ok(/MONEYFORUP/i.test(d.querySelector('#mupSplash').textContent), 'на загрузочном экране есть название бренда');

    console.log('\n1) Навигация и раздел кейсов');
    const nav = [...d.querySelectorAll('.nav button')].map(b => b.dataset.nav);
    ok(nav.length === 4, 'в нижней навигации 4 раздела');
    ok(nav.includes('casehub'), 'есть отдельный раздел casehub');
    ok(!nav.includes('ref'), 'отдельной кнопки «Рефералы» больше нет');

    d.querySelector('.nav button[data-nav="casehub"]').click();
    await wait(180);
    ok(d.querySelector('#casehub').classList.contains('active'), 'экран кейсов активирован');
    eq(d.querySelectorAll('#caseHubArea .casehub-card').length, 20, '20 кейсов: 15 классических + 5 новых');
    ok(Boolean(d.querySelector('.casehub-hero')), 'есть экран содержимого кейса');
    ok(Boolean(d.querySelector('#chOpen')), 'есть кнопка открытия');
    ok(Boolean(d.querySelector('.casehub-warmup')), 'есть блок демо-прокрута');
    ok(Boolean(d.querySelector('#chWarmup')), 'есть кнопка демо-прокрута');
    ok(/ДЕМО/i.test(d.querySelector('#chWarmup').textContent), 'кнопка демо-прокрута подписана');
    eq(d.querySelectorAll('.casehub-list .pct').length, 0, 'шансы предметов не показываются');
    const names = [...d.querySelectorAll('#caseHubArea .casehub-card .ch-name')].map(x => x.textContent.trim());
    for (const n of ['Первый шаг', 'Флагман', 'Старт', 'Неон-рывок', 'Золотое хранилище', 'Сбой системы', 'Омега-ядро']) {
      ok(names.includes(n), `кейс «${n}» отрисован`);
    }
    ok(!d.querySelector('.cards [data-nav="casehub"]'), 'кейсы не дублируются в сетке игр');
    ok(!d.querySelector('.cases-promo'), 'промо-кейсы убраны с экрана игр');
    ok(!d.querySelector('#gamesRefPromoBanner'), 'реферальный баннер убран с экрана игр');
    ok(Boolean(d.querySelector('#btnOpenWheel')), 'Колесо Фортуны осталось на экране игр');
    ok(Boolean(d.querySelector('#navCasesFree')), 'у вкладки «Кейсы» есть FREE-метка');
    eq(d.querySelectorAll('#caseHubArea .free-case').length, 3, 'в кейсах три FREE-кейса');
    eq(d.querySelectorAll('.casehub-case.is-active').length, 1, 'выбранный кейс подсвечен');
    eq(d.querySelectorAll('.casehub-case .ch-active-mark').length, 1, 'у выбранного кейса есть галочка');
    ok(d.querySelector('.casehub-grid').classList.contains('ch-anim'), 'у сетки кейсов есть анимация входа');
    eq(d.querySelectorAll('#caseHubArea .ch-online').length, 0, 'у кейсов нет метки «онлайн»');
    ok(!/онлайн/i.test(d.querySelector('#caseHubArea').textContent), 'в разделе кейсов нет слова «онлайн»');
    eq(d.querySelectorAll('#caseHubArea .ch-cover').length, 20, 'у каждого кейса обложка-изображение');
    // В играх зелёный кружок обязан быть слева от счётчика «онлайн».
    const gameDot = d.querySelector('[data-game="racket"] .game-online-badge .online-dot');
    ok(Boolean(gameDot), 'у игрового бейджа «онлайн» есть зелёный кружок');
    const gameDotStyle = w.getComputedStyle(gameDot);
    ok(gameDotStyle.display !== 'none', 'кружок онлайн не скрыт');
    ok(gameDotStyle.borderRadius === '50%', 'кружок онлайн круглый');
    ok(/rgb\(61,\s*220,\s*150\)/.test(gameDotStyle.backgroundColor), 'кружок онлайн зелёный');
    // Внешний rubup-catalog.css раньше скрывал все span в .game, включая точку.
    const rubupCss = fs.readFileSync(path.join(ROOT, 'assets', 'rubup-catalog.css'), 'utf8');
    ok(!/\.game span:not\(\.game-online-badge\):not\(\.game-online-val\)(?!:not\(\.online-dot\))/.test(rubupCss),
      'rubup-catalog.css не скрывает .online-dot');
    ok(/\.game span[^{]*:not\(\.online-dot\)/.test(rubupCss), 'в CSS есть явное исключение для .online-dot');
    ok(!d.querySelector('#fairPlay'), 'блок «Честная игра» убран из профиля');
    ok(!d.querySelector('#rtpSummary'), 'публичного блока RTP нет');
    eq(d.querySelectorAll('[data-chfilter]').length, 3, 'фильтры «Все / Классика / Новые режимы»');

    // Переключение на новый режим меняет hero.
    d.querySelector('[data-chfilter="mode"]').click();
    await wait(100);
    eq(d.querySelectorAll('#caseHubArea .casehub-card').length, 5, 'фильтр «Новые режимы» оставляет 5 кейсов');
    const cards = [...d.querySelectorAll('[data-chm]')];
    const omega = cards.find(x => x.dataset.chm === 'omega_core');
    ok(Boolean(omega), 'карточка «Омега-ядро» есть');
    omega.click();
    await wait(80);
    ok(d.querySelector('.chh-name').textContent.includes('Омега-ядро'), 'клик по карточке меняет детали режима');
    ok(w.__mfuScroll && w.__mfuScroll.el.classList.contains('casehub-hero'), 'клик по карточке перекидывает к деталям кейса');
    eq(w.__mfuScroll && w.__mfuScroll.opts.behavior, 'smooth', 'переход к деталям выполняется плавно');
    ok(d.querySelector('#chRes') && d.querySelector('#chRes').hidden === true, 'пустой статус кейса не занимает место');
    ok(d.querySelectorAll('.casehub-list .cli').length === 14, 'в содержимом 14 предметов');
    eq(d.querySelectorAll('.casehub-list .pct').length, 0, 'шансы не показываются и в новом режиме');

    console.log('\n1b) Рефералы внутри профиля');
    d.querySelector('.nav button[data-nav="profile"]').click();
    await wait(150);
    ok(Boolean(d.querySelector('#profileRef')), 'блок рефералов находится в профиле');
    ok(Boolean(d.querySelector('#profileRef #refCode')), 'код приглашения доступен');
    ok(Boolean(d.querySelector('#profileRef #refLink')), 'реферальная ссылка доступна');
    ok(Boolean(d.querySelector('#profileRef #copy')), 'кнопка копирования кода доступна');
    ok(Boolean(d.querySelector('#profileRef #refInvited')), 'статистика приглашённых доступна');
    ok(/^MF[A-Z0-9]{6}$/.test(d.querySelector('#refCode').textContent.trim()), 'реферальный код реально сгенерирован');
    ok(/startapp=/.test(d.querySelector('#refLink').textContent), 'реферальная ссылка содержит startapp-код');
    ok(!d.querySelector('#ref'), 'отдельного экрана #ref больше нет');
    const sndBtn = d.querySelector('#sndToggle');
    ok(Boolean(sndBtn), 'в профиле есть переключатель звука');
    eq(sndBtn.getAttribute('aria-pressed'), 'true', 'звук включён по умолчанию');
    sndBtn.click();
    await wait(60);
    eq(sndBtn.getAttribute('aria-pressed'), 'false', 'переключатель выключает звук');
    sndBtn.click();
    await wait(60);
    eq(sndBtn.getAttribute('aria-pressed'), 'true', 'переключатель возвращает звук');

    console.log('\n2) Upgrade Arena');
    d.querySelector('.nav button[data-nav="games"]').click();
    await wait(100);
    const upCard = d.querySelector('[data-game="upgrader"]');
    ok(Boolean(upCard), 'карточка Апгрейдера есть в играх');
    upCard.click();
    await wait(300);
    ok(d.querySelector('#play').classList.contains('active'), 'экран игры открыт');
    eq(d.querySelectorAll('.upg-mode').length, 0, 'режимы риска убраны из интерфейса (DECISIONS D4)');
    ok(Boolean(d.querySelector('.upg-wheel')), 'круговой индикатор шанса отрисован');
    ok(Boolean(d.querySelector('.upg-wheel__cap')), 'в апгрейдере есть подпись правил');
    ok(!/RTP|House Edge/i.test(d.querySelector('.upg-wheel__cap').textContent), 'в подписи апгрейдера нет RTP');
    ok(/70%/.test(d.querySelector('#play').textContent), 'виден потолок шанса 70%');
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

    // Шанс не выше 70% ни для одной цели (DECISIONS D4).
    const maxShown = Math.max(...[...d.querySelectorAll('.upg-target .ut-p')].map(x => parseFloat(x.textContent)).filter(n => !isNaN(n)));
    ok(maxShown <= 70.0001, `ни один шанс не выше 70% (макс. ${maxShown}%)`);

    console.log('\n3) Мульти-апгрейд');
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

    console.log('\n4b) Pulse Market');
    d.querySelector('.nav button[data-nav="games"]').click();
    await wait(100);
    const pulseCard = d.querySelector('[data-game="pulse"]');
    ok(Boolean(pulseCard), 'карточка Pulse Market есть в играх');
    pulseCard.click();
    await wait(300);
    ok(/PULSE MARKET/.test(d.querySelector('#gameArea').textContent), 'экран Pulse Market открыт');
    eq(d.querySelectorAll('[data-pdir]').length, 3, 'три направления: вверх / вниз / боковик');
    eq(d.querySelectorAll('[data-plev]').length, 2, 'два плеча: ×1 и ×2');
    eq(d.querySelectorAll('[data-pdur]').length, 3, 'три длительности: 5 / 10 / 20 с');
    ok(!/Учебная симуляция/.test(d.querySelector('#gameArea').textContent), 'на экране нет учебного дисклеймера');
    ok(Boolean(d.querySelector('#gameArea .mfu-chart')), 'на экране Pulse есть свечной график');
    ok(d.querySelectorAll('#gameArea .mfu-chart rect[rx="0.6"]').length > 20, 'график Pulse состоит из свечей');
    ok(d.querySelector('[data-plev="2"]') && d.querySelector('[data-plev="2"]').textContent.includes('без боковика'), 'на плече ×2 написано, что боковика нет');
    ok(Boolean(d.querySelector('#pmGo')), 'кнопка ставки Pulse на месте');
    const pmGo = d.querySelector('#pmGo'), pmChart = d.querySelector('#gameArea .mfu-chart');
    ok(Boolean(pmGo && pmChart && (pmGo.compareDocumentPosition(pmChart) & w.Node.DOCUMENT_POSITION_FOLLOWING)), 'кнопка ставки Pulse стоит выше графика');
    ok(Boolean(d.querySelector('[data-pbet="last"]')), 'в Pulse есть кнопка повторной ставки');
    ok(d.querySelector('[data-pbet="last"]').disabled === true, 'повтор ставки Pulse выключен без прошлой ставки');
    // На плече ×2 боковик недоступен.
    d.querySelector('[data-plev="2"]').click();
    await wait(60);
    ok(d.querySelector('[data-pdir="range"]').disabled === true, 'при плече ×2 кнопка «Боковик» отключена');

    console.log('\n4c) Trend Hunter удалён');
    d.querySelector('.nav button[data-nav="games"]').click();
    await wait(100);
    ok(!d.querySelector('[data-game="trend"]'), 'карточки Trend Hunter нет в играх');
    eq(d.querySelectorAll('.cards .game').length, 14, 'в сетке осталось 14 режимов');

    console.log('\n4d) Профиль: ранги и комментарии');
    d.querySelector('.nav button[data-nav="profile"]').click();
    await wait(150);
    ok(!d.querySelector('#progressBlock'), 'блок «Прогресс» убран из профиля');
    ok(!d.querySelector('#userRankPill'), 'пилюля «Новичок» убрана');
    ok(Boolean(d.querySelector('#vipCard')), 'ранги кэшбэка перенесены в профиль');
    ok(Boolean(d.querySelector('#commentsCard')), 'в профиле есть блок заработка на комментариях');
    ok(Boolean(d.querySelector('#cmDmBtn')), 'заявки на комментарии принимаются в личке');
    ok(Boolean(d.querySelector('#myOrdersList')), 'в профиле есть блок «Мои заявки» со статусом и таймером');
    ok(!d.querySelector('#adminLogTabs [data-admlog="comments"]'), 'вкладка «Комментарии» убрана из истории админки');

    console.log('\n5) Повторный вход и очистка');
    d.querySelector('.nav button[data-nav="profile"]').click();
    await wait(100);
    d.querySelector('.nav button[data-nav="games"]').click();
    await wait(100);
    d.querySelector('[data-game="upgrader"]').click();
    await wait(250);
    eq(d.querySelectorAll('.upg-mode').length, 0, 'повторный вход рендерит арену без дублей и без режимов');
    eq(d.querySelectorAll('[data-utab]').length, 4, 'после повторного входа вкладки не дублируются');
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
