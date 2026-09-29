/* Автотест MoneyForUp: гоняет игру в jsdom, кликает по всем экранам и проверяет логику, цвета и вёрстку.
   Запуск:  npm i jsdom  &&  NODE_PATH=./node_modules node ui-test.js            */
const fs = require('fs');
const path = require('path');
const HTML = process.env.MONEYFORUP || process.env.MATHPLAY || path.join(__dirname, '..', 'moneyforup.html');

const { JSDOM, VirtualConsole } = require('jsdom');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail ? e.detail.stack || e.detail : e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' });
const { window } = dom, doc = window.document;

const ctx = new Proxy({}, { get: (t, p) => {
  if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
  if (p === 'measureText') return () => ({ width: 10 });
  if (p in t) return t[p];
  return () => {};
}, set: (t, p, v) => { t[p] = v; return true; } });
window.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
window.addEventListener('error', e => errors.push('window.error: ' + (e.error ? e.error.stack : e.message)));

const $ = s => doc.querySelector(s);
const $$ = s => [...doc.querySelectorAll(s)];
const click = el => { if (!el) throw new Error('нет элемента для клика'); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bal = () => +$$('.js-bal')[0].textContent.replace(/\s/g, '');
const active = () => $$('.screen').filter(s => s.classList.contains('active')).map(s => s.id);
const ok = [], bad = [];
const nbsp = t => t.split(String.fromCharCode(160)).join(' ');   // toLocaleString('ru-RU') ставит неразрывный пробел
const check = (c, m) => (c ? ok : bad).push(m);
const styleAll = () => $$('style').map(e => e.textContent).join(' ');

(async () => {
  await sleep(60);

  /* ---------- оболочка и тема ---------- */
  check(JSON.stringify([...$$('.nav button')].map(b => b.dataset.nav)) === '["profile","games","ref"]', 'меню: профиль → игры → рефералы');
  check(!$('[data-nav="home"]'), 'кнопки «Главная» нет');
  check(active()[0] === 'games', 'стартовый экран — игры');
  check(!!$('#terms') && $$('#termsList .item').length === 5, 'соглашение: 5 пунктов встроено в приложение');
  check(/15 % от каждого пополнения|15 % от суммы/.test($('#termsList').textContent), 'в соглашении прописаны 15 % реферальных');
  check(/1 % в сутки/.test($('#termsList').textContent), 'в соглашении прописан стейкинг 1 % в сутки');
  const termsText = $('#termsList').textContent;
  check(/не является азартной игрой/.test(termsText), 'в соглашении оговорён статус токенов');
  check(/добровольное пожертвование/.test(termsText), 'в соглашении сказано, что пополнение — добровольное пожертвование');
  check(/Участие в сервисе добровольное|добровольное/.test(termsText), 'в соглашении сказано про добровольную основу');
  check(!/вывод|выплат[аы]/i.test(termsText.replace(/денежных выплат/g, '')), 'в соглашении нет слов про вывод: ' + (termsText.match(/[^.]*вывод[^.]*/i) || ['—'])[0].trim().slice(0, 60));
  check(!/математическ/i.test(termsText), 'в соглашении нет слов про «математический» проект');
  check(!/виртуал/i.test($('#termsList').textContent), 'в соглашении нет слова «виртуальные»');
  check(!/18 лет|18\+/.test($('#termsList').textContent), 'из соглашения убрано требование 18+');
  check(!$('#termsRow'), 'отдельного пункта «Пользовательское соглашение» в профиле нет');
  check(/MoneyForUp/.test(doc.title) && /MoneyForUp/.test($('#app').textContent), 'название продукта — MoneyForUp');
  check($('.logo').textContent.trim() === 'MUP', 'логотип в шапке — MUP: ' + $('.logo').textContent.trim());
  check($('#pavatar').textContent.trim() === 'MUP', 'аватар по умолчанию — MUP: ' + $('#pavatar').textContent.trim());
  check(/data:image\/svg\+xml/.test($('link[rel="icon"]').getAttribute('href')) && /MUP/.test(decodeURIComponent($('link[rel="icon"]').getAttribute('href'))), 'favicon с логотипом MUP встроен в файл');
  check(!/лаборатор/i.test($('#app').textContent), 'подписи «Математическая лаборатория» нигде нет');
  check(!/Вывод токенов в деньги/.test($('#profile').textContent), 'в блоке пополнения нет дубля текста соглашения');
  check(!/Подписи|Платежи по СБП — вручную/.test($('#profile').textContent), 'в блоке пополнения нет лишних пояснений');
  check(!/MathPlay/.test($('#app').innerHTML), 'старого названия MathPlay в интерфейсе нет');
  check(!/виртуал/i.test($('#app').textContent), 'в интерфейсе нет слова «виртуальные»');
  check(!$('#st1') && !$('#st2') && !$('#st3'), 'на экране игр нет блока статистики');
  check(active()[0] === 'games' && !/Статистика/.test($('#games').textContent), 'заголовка «Статистика» на играх нет');
  check($$('[data-game="spin"] svg path').length === 8, 'иконка спина — колесо из 8 секторов (SVG)');
  check(/url\(#dropBall\)/.test($('[data-game="drop"]').innerHTML), 'иконка дропа — круглый шарик с бликом (SVG)');
  check($$('[data-game="drop"] svg circle').length >= 3, 'шарик рисуется окружностями');
  check(!/◉|🔷/.test($('#games').innerHTML), 'старых иконок ◉ и 🔷 нет');
  const wheelCols = $$('[data-game="spin"] svg path').map(p => p.getAttribute('fill'));
  check(wheelCols.includes('#3ddc96') && wheelCols.includes('#ffcf6b') && wheelCols.includes('#a175ff'), 'сектора окрашены палитрой игры: ' + wheelCols.join(' '));
  check(/10 ⬦ = 1 ₽/.test($('#games').textContent), 'на играх показан курс 10 ⬦ = 1 ₽');
  check($$('.js-rub')[0].textContent === '100,00 ₽', 'курс пересчитан: баланс 1000 ⬦ = ' + $$('.js-rub')[0].textContent);
  check($$('.model').length === 0, 'блоков «мат модель» нет');
  ['RTP', 'α', 'λ', 'p = ', 'C(7', 'вероятность', 'шанс', '2^7', 'f(x)'].forEach(w =>
    check(!$$('.screen').map(s => s.textContent).join(' ').includes(w), 'в интерфейсе нет «' + w + '»'));

  const st = styleAll();
  check(/--bg:#161b28/.test(st) && /--panel:#1e2433/.test(st), 'тема посветлела: фон #161b28, панели #1e2433');
  check(/--cta1:#2bd8b6/.test(st) && /--cta2:#1fa5ea/.test(st), 'кнопка ставки: бирюза #2bd8b6 → голубой #1fa5ea');
  check(/--ctaText:#08262c/.test(st), 'текст на кнопке ставки тёмный (контраст)');
  check(/linear-gradient\(135deg,var\(--cta1\),var\(--cta2\)\)/.test(st), 'градиент кнопки берётся из токенов CTA');
  check(/body\{margin:0;background:#0d1017/.test(st), 'фон страницы #0d1017 (светлее прежнего #050609)');
  check(/\.control\.ghost\{background:rgba\(43,216,182/.test(st), 'кнопка «Забрать» в тон ставки');
  check(!/#777dff|#9885ff|#050609|#11141c|#151a27/.test(st), 'старых тёмных/фиолетовых значений кнопки не осталось');

  /* ---------- ракетка ---------- */
  click($('[data-game="racket"]')); await sleep(60);
  check($('#gameTitle').textContent === 'Ракетка', 'заголовок: ' + $('#gameTitle').textContent);
  check($('#autoInput') && $('#autoTgl'), 'есть авто-вывод');
  check($('#autoInput').getAttribute('max') === '8.67', 'потолок коэффициента ×8.67');
  check($$('#betchips .chip').length === 6, 'пресеты ставок + «макс»');
  check(/ЗАПУСТИТЬ/.test($('#rgo').textContent), 'кнопка ставки на месте: ' + $('#rgo').textContent);

  const src = fs.readFileSync(HTML, 'utf8');
  check(!/🚀|💥/.test(src.slice(src.indexOf('function draw(){'), src.indexOf('function render(){'))), 'эмодзи ракеты нет');
  check(/drawRocket\(g,cx,cy,ang,bc,sp\)/.test(src), 'рисуется спрайт ракеты в точке полёта');
  check(/function drawRocket/.test(src) && /g\.rotate\(ang\)/.test(src), 'ракета поворачивается по траектории');
  check(/function drawBoom/.test(src), 'есть анимация взрыва');
  check(/const tau=t=>t\*\(1\+0\.06\*t\)/.test(src), 'двигатель постепенно раскручивается (tau)');
  check(/Math\.min\(2\.4,\(cur-1\)\/1\.2\)/.test(src), 'пламя растёт со скоростью (зависит от ×)');
  /* ---------- раскладка ракетки и математическое ожидание ---------- */
  const dbgC = window.MONEYFORUP_DEBUG;
  check(typeof dbgC.sampleCrash === 'function', 'сэмплер ракетки доступен для проверки');
  check(dbgC.MINCASH === 1.01, 'вывод доступен с самого начала: ×' + dbgC.MINCASH);
  check($('#autoInput').getAttribute('min') === '1.01', 'поле авто-вывода не даёт поставить меньше ×1.01');
  check(/Забрать можно с ×1\.01/.test($('#rr').textContent), 'подсказка про вывод с ×1.01: ' + $('#rr').textContent.slice(0, 34) + '…');
  const N = 200000, vals = new Float64Array(N);
  for (let i = 0; i < N; i++) vals[i] = dbgC.sampleCrash();
  const share = (a, b) => { let c = 0; for (let i = 0; i < N; i++) if (vals[i] >= a && vals[i] < b) c++; return c / N; };
  const fBust = share(0, 1.01), fLow = share(1.01, 1.10), f13 = share(1.30, 1.40);
  const fMid = share(1.55, 1.75), f2 = share(2.00, 2.30), fCut = share(3.00, 3.50), f3 = share(3, 99);
  check(Math.abs(fBust - 0.08) < 0.006, 'мгновенный взрыв ×1.00 — ' + (fBust * 100).toFixed(1) + '% раундов (раз в ' + (1 / fBust).toFixed(0) + ')');
  check(Math.abs(fLow - 0.06) < 0.006, 'низкий дроп 1.01-1.10 — раз в ' + (1 / fLow).toFixed(1) + ' (' + (fLow * 100).toFixed(1) + '%)');
  check(Math.abs(f13 - 0.096) < 0.008, '1.30-1.40 выпадает раз в ' + (1 / f13).toFixed(1) + ' (' + (f13 * 100).toFixed(1) + '%)');
  check(fMid > 0.18 && fMid < 0.22, 'зона 1.55-1.75 — ' + (fMid * 100).toFixed(1) + '% (раз в ' + (1 / fMid).toFixed(1) + ')');
  check(Math.abs(f2 - 0.10) < 0.006, '2.00-2.30 выпадает раз в ' + (1 / f2).toFixed(1) + ' (' + (f2 * 100).toFixed(1) + '%)');
  check(fCut === 0, 'полоса 3.00-3.50 не выпадает');
  check(f3 > 0.012 && f3 < 0.03, '3× и выше выпадает раз в ' + (1 / f3).toFixed(0) + ' (' + (f3 * 100).toFixed(2) + '%)');
  let mnV = vals[0], mxV = vals[0];
  for (let i = 1; i < N; i++) { if (vals[i] < mnV) mnV = vals[i]; if (vals[i] > mxV) mxV = vals[i]; }
  check(mnV === 1 && mxV <= 8.67, 'диапазон коэффициентов ×1.00–×' + mxV);
  // разнообразие: без «ступенек», самое частое значение реже 2,5 % (кроме мгновенного взрыва)
  const cnt = new Map();
  for (let i = 0; i < N; i++) cnt.set(vals[i], (cnt.get(vals[i]) || 0) + 1);
  let topVal = 0, topN = 0; for (const [v, c] of cnt) if (c > topN && v > 1) { topN = c; topVal = v; }
  check(topN / N < 0.025, 'нет залипания на одном коэффициенте: самое частое ×' + topVal.toFixed(2) + ' — ' + (topN / N * 100).toFixed(2) + '%');
  check(cnt.size > 500, 'разных значений коэффициента: ' + cnt.size);
  check(share(1.36, 1.39) > 0.005 && share(1.40, 1.405) < 0.02, 'под 1.4 есть разнообразие: 1.36-1.39 — ' + (share(1.36, 1.39) * 100).toFixed(1) + '%, ровно ×1.40 — ' + (share(1.40, 1.405) * 100).toFixed(2) + '%');
  check(share(1.01, 1.015) > 0.002, 'небольшой шанс ровно на ×1.01: ' + (share(1.01, 1.015) * 100).toFixed(2) + '% (раз в ' + Math.round(1 / share(1.01, 1.015)) + ')');
  let peak = 0, peakM = 0;
  for (const m of [1.01, 1.05, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2, 2.3, 2.5, 3, 4, 5, 8]) {
    let c = 0; for (let i = 0; i < N; i++) if (vals[i] >= m) c++;
    const rtp = m * c / N; if (rtp > peak) { peak = rtp; peakM = m; }
  }
  check(peak > 0.88 && peak < 0.96, 'лучшая стратегия (кэшаут ×' + peakM + ') даёт отдачу ' + (peak * 100).toFixed(1) + '% — перевес у сервиса ' + (100 - peak * 100).toFixed(1) + '%');
  const losersAfter = (m, rounds) => { let bad = 0; const S = 3000;
    for (let s = 0; s < S; s++) { let net = 0; for (let r = 0; r < rounds; r++) net += (vals[Math.floor(Math.random() * N)] >= m) ? (m - 1) : -1; if (net < 0) bad++; }
    return bad / S; };
  const lLow = losersAfter(1.05, 10), l10 = losersAfter(1.60, 10), l50 = losersAfter(1.60, 50);
  check(lLow > 0.55, 'кэшаут на ×1.05: после 10 раундов в минусе ' + (lLow * 100).toFixed(0) + '% игроков');
  check(l10 > 0.8, '10 раундов с авто ×1.60: в минусе ' + (l10 * 100).toFixed(0) + '% игроков');
  check(l50 > 0.95, '50 раундов с авто ×1.60: в минусе ' + (l50 * 100).toFixed(0) + '% игроков');

  check(/Ставка 50 ⬦ ≈ <b>5,00 ₽<\/b>/.test($('#betRub').innerHTML), 'под ставкой показан рублёвый эквивалент: ' + $('#betRub').textContent);
  type($('#betInput'), '7'); await sleep(20);
  check(/7 ⬦/.test($('#rgo').textContent), 'кнопка учитывает свою ставку');
  check(/7 ⬦ ≈ <b>0,70 ₽<\/b>/.test($('#betRub').innerHTML), 'эквивалент обновился на 7 ⬦ = 0,70 ₽: ' + $('#betRub').textContent);
  const b0 = bal();
  click($('#rgo')); await sleep(200);
  check(bal() === b0 - 7, 'списалась кастомная ставка 7: ' + b0 + ' → ' + bal());
  // вывод доступен почти сразу после старта; если раунд взорвался мгновенно — пробуем снова
  let cashedNow = false;
  for (let i = 0; i < 8 && !cashedNow; i++) {
    await sleep(120);
    if (/ЗАБРАТЬ/.test($('#rgo').textContent)) { click($('#rgo')); cashedNow = true; break; }
    if (/СНОВА/.test($('#rgo').textContent)) click($('#rgo'));
  }
  check(cashedNow, 'кэшаут доступен сразу после старта полёта: ' + $('#rgo').textContent.trim());
  check(/Забрано на <b[^>]*>×1\.0\d/.test($('#rr').innerHTML), 'забрано на низком коэффициенте: ' + $('#rr').textContent.slice(0, 46));
  const histBefore = $$('#rHist .hitem').length;
  check(/ЗАБРАНО/.test($('#rgo').textContent) && $('#rgo').disabled === true, 'после вывода ракета ещё летит, кнопка заблокирована: ' + $('#rgo').textContent.trim());
  check($$('#rHist .hitem').length === histBefore, 'итог раунда не записан, пока ракета не остановилась: ' + histBefore + ' записей');
  const balAfterCash = bal();
  for (let i = 0; i < 100 && !/ЗАПУСТИТЬ СНОВА/.test($('#rgo').textContent); i++) await sleep(150);
  check(/ЗАПУСТИТЬ СНОВА/.test($('#rgo').textContent) && $('#rgo').disabled === false, 'ракета остановилась, кнопка свободна: ' + $('#rgo').textContent.trim());
  check(bal() === balAfterCash, 'после вывода баланс не меняется (ставка уже зачислена): ' + bal());
  check(/Итог раунда: ракета остановилась на <b[^>]*>×/.test($('#rr').innerHTML), 'итоговый коэффициент показан по остановке ракеты: ' + $('#rr').textContent.slice(0, 60));
  check(/ваш вывод был на <b[^>]*>×1\.0\d/.test($('#rr').innerHTML), 'в итоге указан коэффициент вывода: ' + $('#rr').textContent.slice(-70));
  {
    const fm = $('#rr').textContent.match(/остановилась на ×([\d.]+)/);
    const fin = fm ? parseFloat(fm[1]) : 0;
    const inHist = parseFloat(($$('#rHist .hitem')[0] || { textContent: '×0' }).textContent.slice(1));
    check(Math.abs(fin - inHist) < 0.005, 'в ленту записан итоговый коэффициент остановки: ×' + inHist + ' (в сообщении ×' + fin + ')');
    check($$('#rHist .hitem').length === histBefore + 1, 'за раунд в ленту добавляется ровно одна запись: ' + $$('#rHist .hitem').length);
  }

  type($('#autoInput'), '1.05'); click($('#autoTgl')); await sleep(20);
  check(/вкл/.test($('#autoTgl').textContent), 'авто-вывод включается');
  let autoSeen = false;
  for (let i = 0; i < 12 && !autoSeen; i++) {
    click($('#rgo')); await sleep(1500);
    if (/Итог раунда/.test($('#rr').textContent)) autoSeen = true;   // итог — в момент остановки ракеты
  }
  check(autoSeen, 'авто-вывод сработал, итог показан на остановке: ' + $('#rr').textContent.slice(0, 60));
  check(/ваш вывод был на <b[^>]*>×1\.05/.test($('#rr').innerHTML), 'в итоге авто-вывода указан ×1.05: ' + $('#rr').textContent.slice(-80));
  check(/#3ddc96/.test($('#rr').innerHTML), 'итог с выводом подсвечен зелёным (гамма 1–1.5)');
  // история последних результатов под полем ставок
  check(!!$('#rHist'), 'под полем ставок есть блок последних результатов');
  check(/Последние 20 результатов/.test($('#gameArea').textContent), 'у блока подпись «Последние 20 результатов»');
  const histItems = $$('#rHist .hitem');
  check(histItems.length >= 1, 'результаты раундов записываются: ' + histItems.length);
  check(/^×\d+(\.\d{2})?$/.test(histItems[0].textContent), 'коэффициент в ленте — до сотых: ' + histItems[0].textContent);
  check(/rgb\(|#[0-9a-f]{6}/i.test(histItems[0].style.color), 'запись окрашена по гамме коэффициента: ' + histItems[0].style.color);
  check(/≈ \d+,\d{2} ₽/.test($('#rr').textContent), 'в сообщении ракетки есть рубли: ' + $('#rr').textContent.slice(0, 70));
  {
    const fm2 = $('#rr').textContent.match(/остановилась на ×([\d.]+)/);
    check($('#rx').textContent === '×' + (fm2 ? fm2[1] : '?'), 'на табло — итоговый коэффициент остановки: ' + $('#rx').textContent);
    check(/rgb\((61, 220, 150|161, 117, 255|255, 115, 134|255, 207, 107)\)/.test($('#rx').style.color) && !$('#rx').classList.contains('bad'),
      'табло окрашено по гамме итога и не горит красным, т.к. вывод успел: ' + $('#rx').style.color);
  }

  // лента не растёт бесконечно: 25 фиктивных + один настоящий раунд → максимум 20
  const stR = window.MONEYFORUP_DEBUG.state;
  for (let i = 0; i < 25; i++) stR.rHist.unshift(1 + i / 10);
  stR.rHist = stR.rHist.slice(0, 20);
  stR.rHist[0] = 1.9; stR.rHist[1] = 3.07;          // проверяем сотые у дробных значений
  click($('#rgo'));
  for (let i = 0; i < 100 && !/ЗАПУСТИТЬ СНОВА/.test($('#rgo').textContent); i++) {
    if (/^ЗАБРАТЬ/.test($('#rgo').textContent.trim())) click($('#rgo'));
    await sleep(150);
  }
  const items2 = $$('#rHist .hitem');
  check(items2.length <= 20, 'в истории не больше 20 результатов: ' + items2.length);
  check(stR.rHist.length === items2.length, 'состояние и лента совпадают: ' + stR.rHist.length);
  check(stR.rHist[0] <= 8.67 && stR.rHist.length === 20, 'новый результат пишется первым и не вытесняет лимит: ' + stR.rHist[0]);
  check(/×1\.90/.test($('#rHist').textContent) && /×3\.07/.test($('#rHist').textContent), 'дробные результаты показаны до сотых: ×1.90 и ×3.07 на месте');
  click($('#back')); await sleep(30);

  /* ---------- попрыгун ---------- */
  click($('[data-game="jumper"]')); await sleep(60);
  check($$('.dash').length === 12, 'в башне 12 черточек');
  const labels = $$('.dash span').map(e => e.textContent);
  check(labels[0] === '×1.19' && labels[11] === '×8.10', 'множители при p=0.84: ' + labels[0] + ' … ' + labels[11]);
  check(/width:16px;height:16px/.test(st) && $('#jb').style.width === '16px', 'шарик 16px: ' + $('#jb').style.width);
  check(/61, 220, 150/.test($$('.dash')[0].style.background), 'нижняя черта зелёная: ' + $$('.dash')[0].style.background);
  check(/255, 207, 107/.test($$('.dash')[11].style.background), 'верхняя черта жёлтая: ' + $$('.dash')[11].style.background);
  check(!/шанс|вероятность/.test($('#jr').textContent), 'нет текста про шансы');
  check(parseFloat($('#jb').style.bottom) === 10, 'шарик стоит на земле');
  type($('#betInput'), '10'); await sleep(20);
  const waitIdle = async () => { for (let i = 0; i < 40 && $('#jj').disabled; i++) await sleep(120); };
  let passed = false, failed = false, landedOn = null;
  for (let i = 0; i < 10 && !passed && !failed; i++) {
    await waitIdle();
    if ($('#jj').disabled) break;
    click($('#jj')); await sleep(560);                 // прыжок 380 мс + запас
    if (/пройден/.test($('#jr').textContent)) {
      passed = true;
      landedOn = parseFloat($('#jb').style.bottom);    // позиция сразу после удачной посадки
    } else if (/сорвался|Срыв/.test($('#jr').textContent)) {
      failed = true;
      await sleep(700);                                // дать шарику упасть на землю
    }
  }
  check(passed, 'есть успешный прыжок на черту');
  {
    const ds = $$('.dash').map(e => parseFloat(e.style.bottom));
    const lvl = ds.findIndex(v => Math.abs(v + 3 - landedOn) < 0.01);   // индекс черты, на которой стоит шарик
    check(lvl >= 0, 'шарик стоит на верхней поверхности черты: низ шарика ' + landedOn + ', черта ' + (lvl >= 0 ? ds[lvl] : '?') + ' (уровень ' + (lvl + 1) + ')');
    check(ds[lvl + 1] - (landedOn + parseFloat($('#jb').style.height || 16)) >= 1,
      'шарик не задевает следующую черту: зазор ' + (ds[lvl + 1] - landedOn - 16).toFixed(0) + 'px');
  }
  if (passed && !$('#jt2').disabled) { click($('#jt2')); await sleep(80); }   // забрать и завершить заход
  check(/61, 220, 150/.test($$('.dash')[0].style.background), 'пройденная черта зелёная');
  await sleep(700);
  check($('#jj').disabled === false, 'кнопка прыжка активна');
  click($('#back')); await sleep(30);

  /* ---------- спин ---------- */
  click($('[data-game="spin"]')); await sleep(60);
  const SPd = window.MONEYFORUP_DEBUG.SP;
  const pay = SPd.pay, w = SPd.w;
  check($$('.lg').length === 8 && pay.length === 8, 'в спине 8 слотов: ' + pay.join(', '));
  check(!$$('.lg').map(e => e.textContent).join(' ').includes('%'), 'в спине нет процентов');
  check([5, 3, 2, 1, 0.75, 0.5, 0.25, 0].every(v => pay.includes(v)), 'состав слотов: ' + pay.join(', '));
  const W = v => w[pay.indexOf(v)];
  check(W(0) > W(1) && W(0) > W(3), 'шанс ×0 (' + W(0) + ' %) выше, чем у ×1 (' + W(1) + ' %) и ×3 (' + W(3) + ' %)');
  check(Math.min(...w) === W(5), 'у ×5 самый маленький шанс: ' + W(5) + '% — минимум из всех');
  check(w.reduce((a, b) => a + b, 0) === 100, 'шансы складываются в 100 %');
  const rtpSpin = pay.reduce((a, v, i) => a + v * w[i] / 100, 0);
  check(rtpSpin > 0.85 && rtpSpin < 0.95, 'отдача круга ' + (rtpSpin * 100).toFixed(1) + '% — часть остаётся сервису');
  const bg = $('#sw').style.background;
  const spans = bg.split(',').map(part => { const m = part.match(/([\d.]+)deg ([\d.]+)deg/); return m ? { a0: parseFloat(m[1]), a1: parseFloat(m[2]), span: parseFloat(m[2]) - parseFloat(m[1]) } : null; }).filter(Boolean);
  check(spans.length === 8, 'в колесе 8 секторов: ' + spans.length);
  check(Math.abs(spans[0].span - W(5) * 3.6) < 0.01 && Math.abs(spans[1].span - W(3) * 3.6) < 0.01 && Math.abs(spans[3].span - W(0.5) * 3.6) < 0.01,
    'размер сектора равен шансу: ×5 — ' + spans[0].span.toFixed(1) + '°, ×3 — ' + spans[1].span.toFixed(1) + '°, ×0.5 — ' + spans[3].span.toFixed(1) + '°');
  check(spans[spans.length - 1].a1 === 360, 'сектора заполняют круг целиком (до 360°)');
  const dots = $$('.lg .dot').map(e => e.style.background);
  const labels2 = $$('.lg b').map(e => e.style.color);
  check(/255, 207, 107/.test(dots[0]) && /255, 115, 134/.test(dots[1]) && /92, 104, 133/.test(dots[2]) && /57, 65, 90/.test(dots[5]),
    'гамма: ×5 золотой, ×3 красный, низкие приглушённые: ' + dots.join(' '));
  check(/61, 220, 150/.test(labels2[7]) && /161, 117, 255/.test(labels2[6]) && /139, 148, 171/.test(labels2[3]),
    'подписи окрашены по гамме (×1 зелёный, ×2 фиолетовый, низкие серые): ' + labels2.join(' '));
  const lgText = $$('.lg').map(e => e.textContent).join(' ');
  check(/×0\.25/.test(lgText) && /×0\.5/.test(lgText) && /×0\.75/.test(lgText) && /×1/.test(lgText) && /×2/.test(lgText) && /×3/.test(lgText) && /×5/.test(lgText) && /×0/.test(lgText),
    'в легенде все восемь значений: ' + lgText.slice(0, 90));
  click($('#sgo')); await sleep(3700);
  check(/Сектор/.test($('#sr').textContent), 'спин крутится: ' + $('#sr').textContent.slice(0, 50));
  check($$('.lg.hit').length === 1, 'подсвечен один сектор');
  click($('#back')); await sleep(30);

  /* ---------- дроп ---------- */
  click($('[data-game="drop"]')); await sleep(60);
  check($$('.slot').length === 8, 'в дропе 8 лунок');
  const slotText = $$('.slot').map(e => e.textContent).join(' ');
  check(slotText === '×10.5 ×2 ×1.1 ×0.4 ×0.6 ×1.4 ×2 ×10.5', 'выдачи дропа: ' + slotText);
  const sc = $$('.slot').map(e => e.style.color);
  check(/255, 207, 107/.test(sc[0]) && /61, 220, 150/.test(sc[2]) && /139, 148, 171/.test(sc[3]), 'гамма лунок: ' + sc.join(' '));
  click($('#dgo')); await sleep(1600);
  check(/лунку/.test($('#dr').textContent), 'дроп сработал: ' + $('#dr').textContent.slice(0, 60));
  check(!/%|C\(|путей/.test($('#dr').textContent), 'в сообщении дропа нет математики');
  check($$('.slot.hit').length === 1, 'подсвечена одна лунка');
  click($('#back')); await sleep(30);

  /* ---------- стейкинг 1 %/сутки и рефералы 15 % ---------- */
  click($('[data-nav="profile"]')); await sleep(40);
  const dbg = window.MONEYFORUP_DEBUG;
  check(!!dbg && dbg.STAKE_RATE === 0.01, 'ставка стейкинга = 1 % в сутки');
  check(dbg.REF_PERCENT === 15, 'реферальная ставка = 15 %');
  // проценты за сутки считаются корректно
  dbg.state.stake = { amount: 10000, since: Date.now() - 86400000, accruedBase: 0 };
  const dayAcc = dbg.stakeAccrued();
  check(Math.abs(dayAcc - 100) < 0.5, '10000 ⬦ за сутки дают +' + dayAcc.toFixed(2) + ' ⬦ (ожидалось 100)');
  const halfAcc = dbg.stakeAccrued(dbg.state.stake, Date.now() - 43200000);
  check(Math.abs(halfAcc - 50) < 1, 'за 12 часов начисляется ~50 ⬦: ' + halfAcc.toFixed(2));
  dbg.state.stake = { amount: 0, since: 0, accruedBase: 0 };
  dbg.state.balance = 5000;
  const bStake = dbg.state.balance;
  const err = dbg.stakeAdd(2000);
  check(!err && dbg.state.stake.amount === 2000 && dbg.state.balance === bStake - 2000, 'вложение 2000 ⬦ в стейкинг: тело ' + dbg.state.stake.amount + ', баланс ' + dbg.state.balance);
  check(dbg.stakeAdd(999999) === 'Недостаточно токенов на балансе', 'нельзя вложить больше баланса');
  const claimed = dbg.stakeClaim();
  check(typeof claimed === 'string' && claimed === 'Пока нечего забирать', 'копейки пока не забрать: ' + claimed);
  const out = dbg.stakeOut();
  check(typeof out === 'number' && Math.abs(out - 2000) < 1 && dbg.state.stake.amount === 0, 'снятие всего стейкинга вернуло ' + (typeof out === 'number' ? out.toFixed(2) : out) + ' ⬦');
  check(/1 % в сутки/.test($('#profile').textContent), 'в профиле подписан стейкинг «1 % в сутки»');
  click($('[data-nav="ref"]')); await sleep(40);
  check(/15 % от каждого пополнения/i.test($('#ref').textContent), 'на экране рефералов написано про 15 %');
  check(!!$('#refInvited') && !!$('#refEarned'), 'реферальная статистика выводится');
  check(/15 %/.test($('#ref').textContent), 'ставка 15 % показана в статистике');
  // уникальный код и ссылка приглашения
  const codeText = $('#refCode').textContent.trim();
  check(/^MF[A-HJ-NP-Z2-9]{6}$/.test(codeText), 'уникальный код формата MF + 6 символов: ' + codeText);
  check(/^https:\/\/t\.me\/your_bot\?startapp=MF[A-HJ-NP-Z2-9]{6}$/.test($('#refLink').textContent.trim()), 'ссылка приглашения собрана из кода: ' + $('#refLink').textContent.trim());
  check(!!$('#copyLink'), 'есть кнопка «Скопировать ссылку»');
  const dbgRef = window.MONEYFORUP_DEBUG;
  check(typeof dbgRef.genRefCode === 'function' && dbgRef.ensureRefCode() === dbgRef.state.refCode, 'код сохраняется в состоянии и не меняется (ensureRefCode идемпотентен)');
  const many = new Set(Array.from({ length: 40 }, () => dbgRef.genRefCode()));
  check(many.size >= 38, 'генератор даёт разные коды: ' + many.size + ' уникальных из 40');
  check(dbgRef.refLinkFor('MFTEST23') === 'https://t.me/your_bot?startapp=MFTEST23', 'refLinkFor собирает ссылку по коду: ' + dbgRef.refLinkFor('MFTEST23'));

  /* ---------- профиль ---------- */
  click($('[data-nav="profile"]')); await sleep(30);
  check(!$('#pc') && !$('#lvl') && !$('#pnet') && !$('#lvlp'), 'в профиле нет блока статистики (Игры/Уровень/Итог)');
  check(!/Прогресс/.test($('#profile').textContent), 'нет блока «Прогресс» (тоже статистика)');
  check($('#payMethods') && $('#payAmounts') && $('#payRub') && $('#payGo'), 'в профиле есть способы пополнения');
  check(!!$('#termsChk') && !!$('#termsOpen'), 'в блоке пополнения есть галочка соглашения');
  check($('#payGo').disabled === true, 'без галочки кнопка пополнения заблокирована');
  check(!/18/.test($('#termsChk').parentElement.textContent), 'в галочке соглашения нет требования 18+: ' + $('#termsChk').parentElement.textContent.trim());
  check(/Сначала примите соглашение/.test($('#payGo').textContent), 'подсказка про соглашение: ' + $('#payGo').textContent);
  // соглашение принимается галочкой и открывается ссылкой
  click($('#termsOpen')); await sleep(30);
  check($$('.screen').find(x => x.classList.contains('active')).id === 'terms', 'ссылка открывает экран соглашения');
  click($('#termsAccept')); await sleep(30);
  check($$('.screen').find(x => x.classList.contains('active')).id === 'profile', 'после принятия возвращаемся в профиль');
  check($('#payGo').disabled === false, 'после принятия соглашения кнопка активна');
  check($$('#payMethods .chip').map(c => c.textContent.trim()).join('|') === '💳 Карта / СБП|⭐ Telegram Stars|₿ CryptoBot|🪙 Heleket|🎟 Промокод', 'методы оплаты: ' + $$('#payMethods .chip').map(c => c.textContent.trim()).join(', '));
  check($$('#payMethods .chip').length === 5, '5 способов оплаты: ' + $$('#payMethods .chip').map(c => c.textContent.trim()).join(', '));
  check(!/виртуал/i.test($('#profile').textContent), 'в блоке пополнения нет слова «виртуальные»');
  check(/10 ⬦ = 1 ₽/.test($('#profile').textContent), 'в профиле указан курс');
  check(nbsp($('#payPreview').textContent).includes('К зачислению: 3 000 ⬦') && nbsp($('#payPreview').textContent).includes('≈ 300,00 ₽'), 'предпросчёт: ' + $('#payPreview').textContent);
  check(/Пополнить на 3\s000 ⬦/.test($('#payGo').textContent), 'кнопка пополнения: ' + $('#payGo').textContent);
  // способ оплаты + сумма + зачисление
  click($$('#payMethods .chip')[0]); await sleep(20);
  check($$('#payMethods .chip')[0].classList.contains('on'), 'способ «Карта / СБП» выбран');
  click($$('#payMethods .chip')[2]); await sleep(20);
  check($$('#payMethods .chip')[2].classList.contains('on') && /CryptoBot/.test(nbsp($('#payPreview').textContent)), 'способ CryptoBot выбирается: ' + nbsp($('#payPreview').textContent));
  click($$('#payMethods .chip')[3]); await sleep(20);
  check($$('#payMethods .chip')[3].classList.contains('on') && /Heleket/.test(nbsp($('#payPreview').textContent)) && /USDT/.test($('#payPreview').innerHTML), 'способ Heleket выбирается: ' + nbsp($('#payPreview').textContent));
  click($$('#payMethods .chip')[4]); await sleep(20);
  check($$('#payMethods .chip')[4].classList.contains('on') && /Промокод/.test(nbsp($('#payPreview').textContent)), 'способ «Промокод» выбирается');
  click($$('#payMethods .chip')[1]); await sleep(20);
  check($$('#payMethods .chip')[1].classList.contains('on'), 'способ «Telegram Stars» выбран');
  click($$('#payAmounts .chip')[2]); await sleep(20);
  check($('#payRub').value === '500' && nbsp($('#payPreview').textContent).includes('5 000 ⬦'), 'выбор суммы 500 ₽ → 5 000 ⬦');
  const bPay = bal();
  click($('#payGo')); await sleep(60);
  check(bal() === bPay + 5000, 'пополнение зачислило 500 ₽ = 5 000 ⬦ (' + bPay + ' → ' + bal() + ')');
  check(nbsp($('#payMsg').textContent).includes('Зачислено 5 000 ⬦ ≈ 500,00 ₽'), 'сообщение о зачислении: ' + $('#payMsg').textContent);
  check(/Пополнение · Telegram Stars/.test($('#pactiv').textContent), 'пополнение попало в активность');
  type($('#payRub'), '77'); await sleep(20);
  check(/770 ⬦/.test($('#payPreview').innerHTML), 'своя сумма 77 ₽ → 770 ⬦');

  console.log('\n=== ПРОШЛО (' + ok.length + ') ===');
  ok.forEach(m => console.log('  ✓ ' + m));
  if (bad.length) { console.log('\n=== ПРОВАЛЫ (' + bad.length + ') ==='); bad.forEach(m => console.log('  ✗ ' + m)); }
  if (errors.length) { console.log('\n=== ОШИБКИ JS (' + errors.length + ') ==='); errors.slice(0, 10).forEach(e => console.log('  ! ' + e)); }
  else console.log('\n=== JS-ошибок нет ===');
  process.exit(bad.length || errors.length ? 1 : 0);
})().catch(e => { console.log('ТЕСТ УПАЛ:', e.stack); process.exit(2); });
