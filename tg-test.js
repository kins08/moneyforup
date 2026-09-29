/* Тест Telegram-режима: подсовываем мок window.Telegram и проверяем
   инициализацию, BackButton, вибрации, профиль, реферальную ссылку и оплату через openInvoice.
   Запуск:  NODE_PATH=/tmp/node_modules node tg-test.js                                  */
const fs = require('fs');
const path = require('path');
const HTML = process.env.MONEYFORUP_TG || process.env.MATHPLAY_TG || path.join(__dirname, '..', 'moneyforup-tg.html');
const { JSDOM, VirtualConsole } = require('jsdom');

const errors = [], calls = { ready: 0, expand: 0, backShow: 0, backHide: 0, haptic: [], invoices: [], opened: [], fetches: [], backCb: null, serverBalance: 1000 };
const balanceFor = { platega: 5100, heleket: 9100 };
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail ? e.detail.detail || e.detail : e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const TG_MOCK = {
  initData: 'query_id=AAHd&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22%D0%98%D0%B2%D0%B0%D0%BD%22%7D&auth_date=1&hash=abc',
  initDataUnsafe: { user: { id: 42, first_name: 'Иван', last_name: 'Петров', username: 'ivan_petrov' }, start_param: 'MATH-4827' },
  platform: 'android', version: '7.0', colorScheme: 'dark',
  themeParams: { bg_color: '#161b28' },
  viewportStableHeight: 800, isExpanded: true,
  contentSafeAreaInset: { top: 0, bottom: 24 },
  ready() { calls.ready++; },
  expand() { calls.expand++; },
  disableVerticalSwipes() {},
  setHeaderColor() {}, setBackgroundColor() {},
  BackButton: { show() { calls.backShow++; }, hide() { calls.backHide++; }, onClick(fn) { calls.backCb = fn; } },
  HapticFeedback: {
    impactOccurred(t) { calls.haptic.push(t); },
    notificationOccurred(t) { calls.haptic.push(t); }
  },
  openInvoice(url, cb) { calls.invoices.push(url); setTimeout(() => cb && cb('paid'), 10); },
  openTelegramLink(url) { calls.opened.push(url); },
  openLink(url) { calls.opened.push(url); }
};

const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.tg/',
  beforeParse(window) {
    window.MONEYFORUP_API = 'https://api.test';
    window.Telegram = { WebApp: TG_MOCK };
    window.fetch = async (url) => {
      const u = String(url);
      calls.fetches.push(u);
      if (u.includes('/api/invoice')) { calls.serverBalance = 4300; return { json: async () => ({ invoice_link: 'https://t.me/invoice/777', tokens: 3000 }) }; }
      if (u.includes('/api/crypto-invoice')) { calls.serverBalance = 7300; return { json: async () => ({ pay_url: 'https://t.me/CryptoBot?start=IV555', invoice_id: 555, tokens: 3000 }) }; }
      if (u.includes('/api/platega-invoice')) { return { json: async () => ({ pay_url: 'https://pay.platega.io/?id=PL1', invoice_id: 'tx-1', tokens: 3000 }) }; }
      if (u.includes('/api/check-platega')) { calls.serverBalance = balanceFor.platega; return { json: async () => ({ paid: true, tokens: 3000 }) }; }
      if (u.includes('/api/heleket-invoice')) { return { json: async () => ({ pay_url: 'https://pay.heleket.com/hl-1', invoice_id: 'hl-uuid-1', tokens: 3000 }) }; }
      if (u.includes('/api/check-heleket')) { calls.serverBalance = balanceFor.heleket; return { json: async () => ({ paid: true, tokens: 3000 }) }; }
      if (u.includes('/api/check-crypto')) return { json: async () => ({ paid: true, tokens: 3000 }) };
      if (u.includes('/api/order-sbp')) return { json: async () => ({ order_id: 'SBP-77', tokens: 3000 }) };
      if (u.includes('/api/balance')) return { json: async () => ({ tokens: calls.serverBalance, refCode: 'MFTEST23' }) };
      if (u.includes('/api/register')) return { json: async () => ({ refCode: 'MFTEST23' }) };
      return { json: async () => ({}) };
    };
  }
});

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
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const nbsp = t => t.split(String.fromCharCode(160)).join(' ');
const codeOnScreen2 = () => $('#refCode').textContent.trim();

(async () => {
  await sleep(150);

  /* инициализация */
  check(calls.ready > 0 && calls.expand > 0, 'Telegram.WebApp.ready() и expand() вызваны');
  check(doc.documentElement.style.getPropertyValue('--tgSafe') === '24px', 'учтена безопасная зона Telegram: ' + doc.documentElement.style.getPropertyValue('--tgSafe'));
  check(typeof calls.backCb === 'function', 'BackButton.onClick зарегистрирован');
  check(calls.backHide > 0, 'BackButton скрыт на главном экране Telegram');
  check($('#pname').textContent === '@ivan_petrov', 'в профиле юзернейм из Telegram: ' + $('#pname').textContent);
  check($('#psub').textContent === 'Иван Петров', 'под юзернеймом полное имя: ' + $('#psub').textContent);
  check($('#pavatar').textContent === 'ИП', 'инициалы в аватаре: ' + $('#pavatar').textContent);
  check($('.logo').textContent.trim() === 'MUP', 'логотип MUP есть и в Telegram-сборке: ' + $('.logo').textContent.trim());
  check(!/лаборатор/i.test($('#app').textContent), 'в Telegram-сборке нет подписи «лаборатория»');
  check(/Вас пригласил пользователь MATH-4827/.test($('#tgRefInfo').textContent), 'start_param показан: ' + $('#tgRefInfo').textContent);
  check(/15 %/.test($('#tgRefInfo').textContent), 'в реферальном блоке видна ставка 15 %');
  check(/MoneyForUp/.test(doc.title) && !/MathPlay/.test($('#app').innerHTML), 'название в Telegram-сборке — MoneyForUp');
  await sleep(150);
  check(/^MF[A-HJ-NP-Z2-9]{6}$/.test(codeOnScreen2()), 'уникальный код приглашения создан: ' + codeOnScreen2());
  check(/startapp=MFTEST23/.test($('#refLink').textContent), 'канонический код с сервера попал в ссылку: ' + $('#refLink').textContent);
  check(/t\.me\/\S+\?startapp=MFTEST23/.test($('#refLink').textContent), 'ссылка ведёт на бота с кодом приглашения');
  check(!!$('#copyLink'), 'есть кнопка «Скопировать ссылку»');
  check($$('#payMethods .chip').length === 5, 'в Telegram-сборке 5 способов оплаты');

  /* реферальная кнопка */
  click($('#tgShare')); await sleep(20);
  check(calls.opened.length === 1, 'кнопка «Поделиться» открывает Telegram-ссылку');
  const shareUrl = decodeURIComponent(calls.opened[0]);
  const codeOnScreen = codeOnScreen2();
  check(new RegExp('startapp=' + codeOnScreen).test(shareUrl) || /startapp=MFTEST23/.test(shareUrl),
        'ссылка-приглашение содержит уникальный код (' + codeOnScreen + '): ' + shareUrl.slice(0, 100));
  check(/MoneyForUp/.test(decodeURIComponent(calls.opened[0])), 'текст приглашения с новым названием');

  /* BackButton на экране игры */
  click($('[data-game="racket"]')); await sleep(60);
  check(!/ЖДЁМ/.test($('#rgo').textContent), 'порога вывода нет — забрать можно сразу: ' + $('#rgo').textContent.trim());
  check(calls.backShow > 0, 'BackButton показан на экране игры');
  const before = calls.backHide;
  calls.backCb(); await sleep(40);
  check($$('.screen').find(s => s.classList.contains('active')).id === 'games', 'BackButton возвращает на экран игр');
  check(calls.backHide > before, 'BackButton скрылся при возврате');

  /* вибрации */
  click($('[data-game="racket"]')); await sleep(40);
  const h0 = calls.haptic.length;
  click($$('#betchips .chip').find(c => c.dataset.bet === '10')); await sleep(20);
  click($('#rgo')); await sleep(300);
  check(calls.haptic.includes('light'), 'вибрация при ставке: ' + JSON.stringify(calls.haptic.slice(h0)));
  let cashed = false;
  for (let i = 0; i < 20; i++) {                     // вывод доступен с ×1.01 — почти сразу
    if (/ЗАБРАТЬ/.test($('#rgo').textContent)) { click($('#rgo')); cashed = true; break; }
    if (/СНОВА/.test($('#rgo').textContent)) break;
    await sleep(120);
  }
  if (cashed) check(calls.haptic.includes('success'), 'вибрация при выводе (success)');
  else check(calls.haptic.includes('error'), 'вибрация при остановке ракеты (error)');
  if (cashed) {
    check($('#rgo').disabled === true && /ЗАБРАНО/.test($('#rgo').textContent), 'после вывода ракета ещё летит, кнопка заблокирована: ' + $('#rgo').textContent.trim());
    let fin = false;
    for (let i = 0; i < 110 && !fin; i++) { if (/Итог раунда/.test($('#rr').textContent)) fin = true; else await sleep(120); }
    check(fin, 'итог раунда показан в момент остановки ракеты: ' + $('#rr').textContent.slice(0, 60));
    check(/ваш вывод был на/.test($('#rr').textContent), 'в итоге указан коэффициент вывода: ' + $('#rr').textContent.slice(-60));
    check(!calls.haptic.slice(h0).includes('error'), 'после успешного вывода вибрации «проигрыш» нет: ' + JSON.stringify(calls.haptic.slice(h0)));
  }
  click($('#back')); await sleep(30);

  /* оплата: без соглашения кнопка заблокирована */
  click($('[data-nav="profile"]')); await sleep(40);
  const balBefore = +$$('.js-bal')[0].textContent.replace(/\s/g, '');
  check($('#payGo').disabled === true, 'в Telegram-режиме без соглашения пополнение заблокировано');
  click($('#payGo')); await sleep(80);
  check(!calls.fetches.some(u => u.includes('/api/invoice')), 'без соглашения счёт у бэкенда не запрашивается');
  click($('#termsOpen')); await sleep(40);
  click($('#termsAccept')); await sleep(60);
  check($$('.screen').find(x => x.classList.contains('active')).id === 'profile', 'соглашение принято, вернулись в профиль');
  check(calls.fetches.some(u => u.includes('/api/terms')), 'сервер получил отметку о принятии соглашения');
  check($('#payGo').disabled === false, 'после соглашения пополнение доступно');

  /* Telegram Stars: /api/invoice → openInvoice → перезагрузка баланса */
  click($$('#payMethods .chip')[1]); await sleep(30);
  click($('#payGo')); await sleep(250);
  check(calls.invoices.length === 1 && calls.invoices[0] === 'https://t.me/invoice/777', 'вызван openInvoice с ссылкой от сервера: ' + calls.invoices[0]);
  check(calls.fetches.some(u => u.includes('/api/invoice')), 'счёт Stars запрошен у бэкенда');
  check(/зачислено 3\s?000 ⬦/i.test(nbsp($('#payMsg').textContent)), 'сообщение об оплате: ' + $('#payMsg').textContent);
  check(+$$('.js-bal')[0].textContent.replace(/[\s\u00A0]/g, '') === 4300, 'баланс взят с сервера: ' + $$('.js-bal')[0].textContent);
  check(balBefore !== 4300, 'серверный баланс перезаписал локальный (' + balBefore + ' → 4300)');

  /* CryptoBot: ссылка на счёт + опрос статуса */
  click($$('#payMethods .chip')[2]); await sleep(30);
  const opBefore = calls.opened.length;
  click($('#payGo')); await sleep(200);
  check(calls.fetches.some(u => u.includes('/api/crypto-invoice')), 'CryptoBot: счёт запрошен у бэкенда');
  check(calls.opened.length > opBefore && /CryptoBot/.test(calls.opened[calls.opened.length - 1]), 'CryptoBot: открыта платёжная ссылка ' + calls.opened[calls.opened.length - 1]);
  check(/CryptoBot|Ждём подтверждения|Оплачено криптой/i.test($('#payMsg').textContent), 'CryptoBot: статус в сообщении: ' + $('#payMsg').textContent.slice(0, 70));
  await sleep(3400);
  check(calls.fetches.some(u => u.includes('/api/check-crypto')), 'CryptoBot: статус платежа опрашивается');
  check(/Оплачено криптой/.test($('#payMsg').textContent) && +$$('.js-bal')[0].textContent.replace(/[\s\u00A0]/g, '') === 7300, 'CryptoBot: после подтверждения зачислено на баланс: ' + $('#payMsg').textContent.slice(0, 60) + ' | ' + $$('.js-bal')[0].textContent);

  /* Platega: карта/СБП — ссылка на оплату + опрос статуса */
  click($$('#payMethods .chip')[0]); await sleep(30);
  const opPl = calls.opened.length;
  click($('#payGo')); await sleep(200);
  check(calls.fetches.some(u => u.includes('/api/platega-invoice')), 'Platega: счёт запрошен у бэкенда');
  check(calls.opened.length > opPl && /platega/.test(calls.opened[calls.opened.length - 1] || ''), 'Platega: открыта платёжная ссылка ' + (calls.opened[calls.opened.length - 1] || ''));
  await sleep(3400);
  check(calls.fetches.some(u => u.includes('/api/check-platega')), 'Platega: статус платежа опрашивается');
  check(/Оплачено/.test($('#payMsg').textContent) && +$$('.js-bal')[0].textContent.replace(/[\s\u00A0]/g, '') === balanceFor.platega,
        'Platega: после подтверждения зачислено (' + $('#payMsg').textContent.slice(0, 50) + ' | ' + $$('.js-bal')[0].textContent + ')');

  /* Heleket: крипта */
  click($$('#payMethods .chip')[3]); await sleep(30);
  const opHl = calls.opened.length;
  click($('#payGo')); await sleep(200);
  check(calls.fetches.some(u => u.includes('/api/heleket-invoice')), 'Heleket: счёт запрошен у бэкенда');
  check(calls.opened.length > opHl && /heleket/.test(calls.opened[calls.opened.length - 1] || ''), 'Heleket: открыта платёжная ссылка ' + (calls.opened[calls.opened.length - 1] || ''));
  await sleep(3400);
  check(calls.fetches.some(u => u.includes('/api/check-heleket')), 'Heleket: статус платежа опрашивается');
  check(/Оплачено криптой/.test($('#payMsg').textContent) && +$$('.js-bal')[0].textContent.replace(/[\s\u00A0]/g, '') === balanceFor.heleket,
        'Heleket: после подтверждения зачислено криптой');

  /* ручная заявка по СБП остаётся фолбэком, если Platega не ответила */
  const fetchReal = window.fetch;
  window.fetch = async (u, o) => (String(u).includes('/api/platega-invoice') ? { json: async () => ({ error: 'Platega не настроена' }) } : fetchReal(u, o));
  click($$('#payMethods .chip')[0]); await sleep(30);
  click($('#payGo')); await sleep(150);
  check(calls.fetches.some(u => u.includes('/api/order-sbp')), 'фолбэк: при недоступной Platega создаётся ручная заявка');
  check(/Заявка №SBP-77/.test(nbsp($('#payMsg').textContent)), 'фолбэк: номер заявки показан: ' + $('#payMsg').textContent.slice(0, 80));
  window.fetch = fetchReal;

  /* отмена оплаты */
  click($$('#payMethods .chip')[1]); await sleep(30);
  TG_MOCK.openInvoice = (url, cb) => { setTimeout(() => cb('cancelled'), 10); };
  click($('#payGo')); await sleep(120);
  check(/Оплата отменена/.test($('#payMsg').textContent), 'отмена оплаты обрабатывается: ' + $('#payMsg').textContent);

  console.log('\n=== PROSHLO (' + ok.length + ') ===');
  ok.forEach(m => console.log('  ✓ ' + m));
  if (bad.length) { console.log('\n=== ПРОВАЛЫ (' + bad.length + ') ==='); bad.forEach(m => console.log('  ✗ ' + m)); }
  if (errors.length) { console.log('\n=== ОШИБКИ JS (' + errors.length + ') ==='); errors.slice(0, 8).forEach(e => console.log('  ! ' + e)); }
  else console.log('\n=== JS-ошибок нет ===');
  process.exit(bad.length || errors.length ? 1 : 0);
})().catch(e => { console.log('ТЕСТ УПАЛ:', e.stack); process.exit(2); });
