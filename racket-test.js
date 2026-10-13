/* Быстрый тест клиента «Ракетки»: интерфейс обязан следовать за сервером.
   Мок-сервер повторяет контракт /api/racket/* (см. bot.js), причём намеренно
   РАСХОДИТСЯ с тем, что клиент мог бы посчитать сам:
     • кэшаут возвращает ×1.11 и выплату +111 (клиент в этот момент рисует ×1.00),
     • крах раунда раскрывается только после финиша.
   Так тест ловит возврат старого поведения: «экран обещал bet×кэшаут, а платил
   сервер другое» (R3) и «тикер склеивал цифры подписи» (R4).
   Полноценная проверка серверной авторитетности — в e2e-racket-crash-test.js.

   Запуск:  node racket-test.js                                            */
const fs = require('fs');
const path = require('path');
const HTML = process.env.MONEYFORUP || process.env.MATHPLAY || path.join(__dirname, 'index.html');
const { JSDOM, VirtualConsole } = require('jsdom');

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const unhandled = [];
process.on('unhandledRejection', e => unhandled.push((e && e.message) || String(e)));

/* ── мок-движок: фазу задаёт сам тест ─────────────────────────────────────── */
const CYCLE = 30000, BETTING = 15000;
const srv = {
  tokens: 300, phase: 'betting', roundId: 'RKTmock1', startedAt: Date.now(),
  crash: 1.4, bets: {}, calls: [], cashoutX: 1.85, nextId: 'RKTmock2'
};
const round = () => ({ id: srv.roundId, startedAt: srv.startedAt, bettingEndsAt: srv.startedAt + BETTING, endsAt: srv.startedAt + CYCLE, seedHash: 'mockhash', nextId: srv.nextId });
const me = () => Object.entries(srv.bets).map(([slot, b]) => ({ slot: Number(slot), bet: b.bet, status: b.status, autoX: b.autoX, cashedX: b.cashedX ?? null, win: b.win ?? null, roundId: srv.roundId }));
const history = () => srv.phase === 'done'
  ? [{ roundId: srv.roundId, crash: srv.crash, seedHash: 'mockhash', endedAt: 1, live: false }, { roundId: srv.nextId, crash: null, seedHash: 'nexthash', endedAt: null, live: true }]
  : [{ roundId: srv.roundId, crash: null, seedHash: 'mockhash', endedAt: null, live: true }];

const ok_ = obj => ({ ok: true, status: 200, json: async () => obj });
const err_ = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

async function api(pathname, body) {
  srv.calls.push(pathname);
  if (pathname === '/api/racket/status') {
    const now = Date.now();
    // фаза 'done' объявлена тестом: держим её, пока тест сам не вернёт 'betting'
    return ok_({ ok: true, now, engine: { cycleMs: CYCLE, bettingMs: BETTING, graceMs: 2500, minBet: 10, maxBet: 100000, maxCashX: 30, k: 0.18, speed: 0.58, rtp: 0.96 }, round: round(), me: me(), history: history(), stats: { bets: 0, wagered: 0, won: 0 }, tokens: srv.tokens });
  }
  if (pathname === '/api/racket/bet') {
    const slot = Number(body.slot) || 1, bet = Math.floor(Number(body.bet) || 0);
    if (srv.bets[slot] && srv.bets[slot].status === 'active') return err_(400, `Ставка #${slot} в этом раунде уже сделана`);
    if (bet > srv.tokens) return err_(400, 'Недостаточно токенов');
    srv.tokens -= bet;
    srv.bets[slot] = { bet, status: 'active', autoX: body.autoX ?? null };
    return ok_({ ok: true, phase: srv.phase, roundId: srv.roundId, round: round(), slot, bet, autoX: body.autoX ?? null, tokens: srv.tokens });
  }
  if (pathname === '/api/racket/cancel') {
    const slot = Number(body.slot) || 1, b = srv.bets[slot];
    if (!b || b.status !== 'active') return err_(400, 'Ставка уже закрыта');
    srv.tokens += b.bet; b.status = 'cancelled';
    return ok_({ ok: true, cancelled: true, slot, refund: b.bet, tokens: srv.tokens });
  }
  if (pathname === '/api/racket/cashout') {
    const slot = Number(body.slot) || 1, b = srv.bets[slot];
    if (!b) return err_(404, `Ставка #${slot} не найдена`);
    if (b.status === 'cashed') return ok_({ ok: true, repeat: true, verdict: 'win', x: b.cashedX, win: b.win, crash: null, tokens: srv.tokens });
    if (b.status !== 'active') return ok_({ ok: true, verdict: 'lose', x: null, win: 0, crash: null, tokens: srv.tokens });
    b.status = 'cashed'; b.cashedX = srv.cashoutX; b.win = Math.floor(b.bet * srv.cashoutX);
    srv.tokens += b.win;
    return ok_({ ok: true, verdict: 'win', x: b.cashedX, win: b.win, crash: srv.phase === 'done' ? srv.crash : null, tokens: srv.tokens });
  }
  if (pathname === '/api/balance') return ok_({ tokens: srv.tokens, totalDeposited: 1000, refCode: 'RKTEST01' });
  if (pathname === '/api/register') return ok_({ refCode: 'RKTEST01', tokens: srv.tokens, totalDeposited: 1000 });
  if (pathname === '/api/requisites') return ok_({ ok: true, configured: {}, sbp: { phone: '', holder: '' }, cards: {} });
  if (pathname === '/api/inventory') return ok_({ ok: true, items: [], count: 0, value: 0, tokens: srv.tokens });
  return ok_({ ok: true });
}

const PAGE_API = 'https://moneyforup.onrender.com';
function makePage({ telegram = true } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail ? e.detail.detail || e.detail : e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', (...a) => errors.push('console.warn: ' + a.join(' ')));
  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.tg/',
    beforeParse(window) {
      if (telegram) {
        window.Telegram = { WebApp: {
          initData: 'query_id=AAHd&user=%7B%22id%22%3A42%7D&auth_date=1&hash=abc',
          initDataUnsafe: { user: { id: 42, first_name: 'Иван', username: 'ivan_petrov' } },
          platform: 'android', version: '7.0', colorScheme: 'dark', viewportStableHeight: 800, isExpanded: true,
          contentSafeAreaInset: { top: 0, bottom: 24 },
          ready() {}, expand() {}, disableVerticalSwipes() {}, setHeaderColor() {}, setBackgroundColor() {},
          BackButton: { show() {}, hide() {}, onClick() {} },
          HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
          openInvoice() {}, openTelegramLink() {}, openLink() {}
        } };
      }
      // jsdom считает вкладку скрытой — тогда клиент не опрашивает сервер.
      // Симулируем открытую вкладку: страница должна жить в реальном ритме.
      try{ Object.defineProperty(window.Document.prototype, 'hidden', { get: () => false, configurable: true }); }catch(_){}
      try{ Object.defineProperty(window.Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true }); }catch(_){}
      window.fetch = (url, opts = {}) => {
        const u = String(url);
        const p = u.slice(PAGE_API.length);
        const o = { ...opts };
        delete o.signal;
        return api(p, o.body ? JSON.parse(o.body) : {});
      };
    }
  });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, { get: (t, p) => p in t ? t[p]
      : (p === 'createLinearGradient' || p === 'createRadialGradient') ? () => ({ addColorStop() {} })
      : (p === 'measureText') ? () => ({ width: 10 }) : () => {}, set: (t, p, v) => { t[p] = v; return true; } });
  };
  return { dom, w, errors };
}

(async () => {
  /* ── Telegram-режим: интерфейс следует за сервером ─────────────────────── */
  const { dom, w, errors } = makePage();
  const doc = w.document, $ = s => doc.querySelector(s);
  const click = el => { if (!el) throw new Error('нет элемента'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
  const shownBal = () => +doc.querySelector('.js-bal').textContent.replace(/\s/g, '');
  /* Ждём нужное состояние кнопки: интерфейс обновляется после ответа сервера,
     и кликать «наугад» между запросами нельзя. */
  const waitBtn = async (re, ms = 2500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (re.test($('#b1Btn').textContent)) return true; await sleep(50); }
    return false;
  };

  await sleep(120);
  click($('[data-game="racket"]'));
  await sleep(120);
  check(!!$('#b1Btn'), 'экран Ракетки открыт');
  const inp = $('#b1Inp'); inp.value = '60'; inp.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(30);
  check(/ПОСТАВИТЬ 60/.test($('#b1Btn').textContent), 'в приёме ставок кнопка предлагает поставить: ' + $('#b1Btn').textContent);
  click($('#b1Btn'));
  check(await waitBtn(/ОТМЕНИТЬ/), 'сервер подтвердил ставку, интерфейс это отразил');
  check(srv.calls.includes('/api/racket/bet'), 'клик уходит на сервер ставкой, а не в локальную симуляцию');
  check(srv.tokens === 240, 'ставка списана сервером один раз: ' + srv.tokens + ' ⬦ (300 − 60)');
  check($('#b1Btn').textContent.includes('ОТМЕНИТЬ'), 'после подтверждения кнопка предлагает отмену: ' + $('#b1Btn').textContent);
  check(shownBal() === 240, 'на экране серверный баланс: ' + shownBal());

  click($('#b1Btn'));                                   // отмена
  check(await waitBtn(/ПОСТАВИТЬ/), 'после отмены кнопка снова предлагает поставить');
  check(srv.calls.includes('/api/racket/cancel'), 'отмена уходит на сервер (раньше токены «возвращались» только на экране)');
  check(srv.tokens === 300, 'отмена вернула ровно ставку: ' + srv.tokens + ' ⬦');
  check(/вернулись на баланс/.test($('#rr').textContent), 'игроку сказано о возврате: ' + $('#rr').textContent.slice(0, 60));

  /* полёт: экран обязан показать выплату СЕРВЕРА, а не bet×кэшаут */
  click($('#b1Btn'));                                   // ставим снова
  check(await waitBtn(/ОТМЕНИТЬ/), 'повторная ставка в тот же слот принята (после отмены)');
  srv.startedAt = Date.now() - BETTING - 1500;          // раунд ушёл в полёт
  srv.phase = 'flight';
  check(await waitBtn(/ЗАБРАТЬ ×/), 'в полёте кнопка предлагает забрать: ' + $('#b1Btn').textContent.slice(0, 34));

  const tk = [];
  const origPush = w.pushLiveTickerWin;
  w.pushLiveTickerWin = (name, game, amt, mult) => { tk.push({ name, game, amt, mult, note: '' }); if (origPush) origPush(name, game, amt, mult); };
  const localEstimate = Math.floor(60 * 1.0);           // что нарисовал бы старый «bet × кэшаут» в этот момент
  click($('#b1Btn'));                                   // кэшаут
  await sleep(250);
  const rr = $('#rr').textContent;
  check(srv.calls.includes('/api/racket/cashout'), 'кэшаут уходит на сервер');
  check(/\+111/.test(rr), 'показана выплата СЕРВЕРА (+111 ⬦): ' + rr.slice(0, 90));
  check(!/\+66|\+60/.test(rr), 'нет локального обещания (' + localEstimate + ' ⬦), которое сервер не платил');
  check(/×1\.85/.test(rr), 'на экране серверный множитель ×1.85: ' + rr.slice(0, 90));
  check(tk.length > 0 && tk[0].mult === 1.85, 'тикер получил ×1.85, а не склейку цифр 11.85: ' + JSON.stringify(tk[0] || null));
  check(tk.length > 0 && tk[0].amt === 111, 'тикер показывает фактическую сумму 111 ⬦: ' + (tk[0] && tk[0].amt));
  check(srv.tokens === 351, 'баланс на сервере сошёлся: ' + srv.tokens + ' ⬦ (300 − 60 + 111)');
  check(shownBal() === 351, 'на экране ровно серверный баланс: ' + shownBal());
  check(unhandled.length === 0, 'нет необработанных отказов промисов: ' + JSON.stringify(unhandled));

  dom.window.close();

  /* ── Демо-режим: без Telegram ставки не имитируются ────────────────────── */
  const demo = makePage({ telegram: false });
  await sleep(120);
  const dclick = el => el.dispatchEvent(new demo.w.MouseEvent('click', { bubbles: true }));
  dclick(demo.dom.window.document.querySelector('[data-game="racket"]'));
  await sleep(120);
  const demoDoc = demo.dom.window.document;
  check(/Только в Telegram/.test(demoDoc.querySelector('#b1Status').textContent), 'демо-режим: ставка недоступна, а не «играем локально»: ' + demoDoc.querySelector('#b1Status').textContent);
  check(demoDoc.querySelector('#b1Btn').disabled === true, 'демо-режим: кнопка ставки отключена');
  check(errors.length === 0 && demo.errors.length === 0, 'страница без ошибок: ' + JSON.stringify([...errors, ...demo.errors].slice(0, 2)));
  demo.dom.window.close();

  const line = '─'.repeat(64);
  console.log('\n' + line);
  ok.forEach(m => console.log('  ✅ ' + m));
  if (bad.length) { console.log(''); bad.forEach(m => console.log('  ❌ ' + m)); }
  console.log(line);
  console.log(bad.length ? `ПРОВАЛЕНО: ${bad.length} из ${ok.length + bad.length}` : 'ИТОГ: интерфейс Ракетки следует за сервером, демо-режим не имитирует ставки.');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ТЕСТ УПАЛ:', e && e.stack || e); process.exit(1); });
