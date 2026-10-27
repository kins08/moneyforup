/* Тест денежного контура «Ракетки»: ставка живёт только тогда, когда её принял
   сервер. Ловит три дефекта, найденные на аудите свежих правок:
     1) фантомная ставка: сервер отказал (не хватает токенов), а интерфейс
        показывал «Принята / В игре» и обещал выигрыш, которого не будет;
     2) «отмена» ставки возвращала токены только на экране (сервер уже списал);
     3) кэшаут показывал bet×кэшаут, а сервер начислял свою сумму (и тикер
        получал множитель 12.31 из подписи «Ставка #1 кэшаут ×2.31»).

   Мок-сервер повторяет правила бэкенда: ставка списывается и раунд
   закрывается СРАЗУ, выплата = bet × 1.7 (defaultMult Ракетки) при verdict=win.

   Запуск:  node racket-test.js                                                      */
const fs = require('fs');
const path = require('path');
const HTML = process.env.MONEYFORUP || process.env.MATHPLAY || path.join(__dirname, 'index.html');
const { JSDOM, VirtualConsole } = require('jsdom');

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail ? e.detail.detail || e.detail : e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
const unhandled = [];
process.on('unhandledRejection', e => unhandled.push((e && e.message) || String(e)));

const BET_MS = 12000;
const FLIGHT_K = Math.log(200) / 40;
const RK_MULT = 1.7;                                  // defaultMult Ракетки на сервере
let FAKE_NOW = 0;                                     // управляемые часы для фаз раунда
let srvRound = null;                                  // текущий раунд мок-сервера

function makeSrvRound(startAt, idx, crash = 50) {
  const betEndsAt = startAt + BET_MS;
  const flightStartsAt = betEndsAt;
  const bustAt = flightStartsAt + Math.log(crash) / FLIGHT_K * 1000;
  return { idx, crash, bettingStartsAt: startAt, betEndsAt, flightStartsAt, bustAt, nextRoundAt: bustAt + 1200 };
}

/* ── мок-сервер: правила те же, что в bot.js playRound ─────────────────────── */
const srv = { tokens: 100, verdict: 'lose', attempts: 0, plays: [], balanceCalls: 0 };
const ok_ = obj => ({ ok: true, status: 200, json: async () => obj });
const err_ = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

async function apiHandle(url, opts) {
  const u = String(url);
  if (u.includes('/api/play')) {
    const body = JSON.parse(opts.body || '{}');
    const bet = Math.floor(Number(body.bet) || 0);
    srv.attempts++;
    if (bet < 10) return err_(400, 'Ставка от 1 ₽ до 10 000 ₽');
    if (bet > srv.tokens) return err_(400, 'Недостаточно средств');
    const win = srv.verdict === 'win' ? Math.floor(bet * RK_MULT) : 0;
    srv.tokens = srv.tokens - bet + win;
    srv.plays.push({ game: body.game, bet, verdict: srv.verdict, win, tokens: srv.tokens });
    return ok_({ ok: true, roundId: 'RT' + srv.plays.length, game: 'Ракетка', verdict: srv.verdict, win, mult: RK_MULT, tokens: srv.tokens });
  }
  /* Ракетка (текущий контракт бэкенда): ставка списывается в /api/racket/bet,
     выплата — в /api/racket/cashout; точку краха клиент узнаёт только из
     /api/racket/state (сервер раскрывает её по факту). Мок отдаёт «полёт без
     краха» (crashed:false), чтобы клиент мог забрать вручную. */
  if (u.includes('/api/racket/bet')) {
    const body = JSON.parse(opts.body || '{}');
    const bet = Math.floor(Number(body.bet) || 0);
    srv.attempts++;
    if (bet < 10) return err_(400, 'Ставка от 1 ₽ до 10 000 ₽');
    if (bet > srv.tokens) return err_(400, 'Недостаточно средств');
    srv.tokens -= bet;
    srv.lastBet = bet;
    srv.plays.push({ game: 'Ракетка', bet, roundId: body.roundId, tokens: srv.tokens });
    return ok_({ ok: true, roundId: body.roundId, bet, tokens: srv.tokens });
  }
  if (u.includes('/api/racket/cashout')) {
    const body = JSON.parse(opts.body || '{}');
    const bet = srv.lastBet || 0;
    const win = srv.verdict === 'win' ? Math.floor(bet * RK_MULT) : 0;
    srv.tokens += win;
    return ok_({ ok: true, verdict: srv.verdict, win, mult: RK_MULT, tokens: srv.tokens });
  }
  if (u.includes('/api/racket/state')) {
    srv.stateCalls = (srv.stateCalls || 0) + 1;
    if (!srvRound) srvRound = makeSrvRound(FAKE_NOW, 1, 50);
    const r = srvRound;
    const busted = FAKE_NOW >= r.bustAt;
    return ok_({
      ok: true, rIdx: r.idx,
      phase: FAKE_NOW < r.betEndsAt ? 'betting' : (busted ? 'done' : 'flight'),
      bettingStartsAt: r.bettingStartsAt, betEndsAt: r.betEndsAt, flightStartsAt: r.flightStartsAt,
      serverNow: FAKE_NOW, crashed: busted, crash: busted ? r.crash : null,
      nextRoundAt: busted ? r.nextRoundAt : null, maxWinTokens: 200000
    });
  }
  if (u.includes('/api/balance')) { srv.balanceCalls++; return ok_({ tokens: srv.tokens, totalDeposited: 1000, refCode: 'RKTEST01' }); }
  if (u.includes('/api/register')) return ok_({ refCode: 'RKTEST01', tokens: srv.tokens, totalDeposited: 1000 });
  if (u.includes('/api/requisites')) return ok_({ ok: true, configured: {}, sbp: { phone: '', holder: '' }, cards: {} });
  if (u.includes('/api/inventory')) return ok_({ ok: true, items: [], count: 0, value: 0, tokens: srv.tokens });
  return ok_({ ok: true });
}

const TG_MOCK = {
  initData: 'query_id=AAHd&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22%D0%98%D0%B2%D0%B0%D0%BD%22%7D&auth_date=1&hash=abc',
  initDataUnsafe: { user: { id: 42, first_name: 'Иван', username: 'ivan_petrov' } },
  platform: 'android', version: '7.0', colorScheme: 'dark',
  viewportStableHeight: 800, isExpanded: true,
  contentSafeAreaInset: { top: 0, bottom: 24 },
  ready() {}, expand() {}, disableVerticalSwipes() {}, setHeaderColor() {}, setBackgroundColor() {},
  BackButton: { show() {}, hide() {}, onClick() {} },
  HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
  openInvoice(url, cb) { setTimeout(() => cb && cb('paid'), 10); },
  openTelegramLink() {}, openLink() {}
};

const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.tg/',
  beforeParse(window) {
    window.MONEYFORUP_API = 'https://api.test';
    window.Telegram = { WebApp: TG_MOCK };
    window.Date.now = () => FAKE_NOW;                 // ускоряем 30-секундный цикл раундов
    window.fetch = (url, opts) => apiHandle(url, opts || {});
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
const click = el => { if (!el) throw new Error('нет элемента для клика: ' + el); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const showBal = () => Number((window.MONEYFORUP_DEBUG && window.MONEYFORUP_DEBUG.state || {}).balance);

/* ── сценарий ──────────────────────────────────────────────────────────────── */
(async () => {
  await sleep(80);
  const D = window.MONEYFORUP_DEBUG;
  const S = D.state;

  /* Три раунда с длинным полётом (краш > ×3) — чтобы кэшаут успел случиться.
     sampleCrash берём из исходника страницы: тест не разойдётся с игрой. */
  const src = fs.readFileSync(HTML, 'utf8');
  const sampleCrash = new Function(
    src.slice(src.indexOf('const RK_MAX_MULT'), src.indexOf('function gameRacket()')) + '\n; return sampleCrash;'
  )();
  const RIDXES = [];
  let maxCrash = 0, longTail = 0;
  for (let i = 1; i < 20000; i++) {
    const v = sampleCrash(i);
    if (v > maxCrash) maxCrash = v;
    if (v > 8.67) longTail++;
    if (v > 3 && RIDXES.length < 3) RIDXES.push(i);
  }
  check(RIDXES.length === 3, 'найдены 3 раунда с полётом > ×3: ' + RIDXES.join(', '));
  check(maxCrash <= 200 && maxCrash > 0, 'потолок раунда — ×200, максимум в выборке: ×' + maxCrash);
  check(longTail > 0, 'хвост до ×200 достижим: ' + longTail + ' раундов >×8.67 из 20 000');

  FAKE_NOW = 1000;
  srvRound = makeSrvRound(FAKE_NOW, 1, 50);
  click($('[data-game="racket"]'));
  await sleep(60);
  check($('#gameTitle').textContent === 'Ракетка', 'экран Ракетки открыт');
  {
    const mo = doc.querySelector('[data-mode-online="play"]');
    check(!!mo && !mo.classList.contains('off') && /онлайн/.test(mo.textContent),
      'в шапке режима виден зелёный индикатор «онлайн»: «' + (mo ? mo.textContent.trim() : 'нет') + '»');
  }
  check(showBal() === 100, 'стартовый баланс пришёл с сервера: ' + showBal() + ' ⬦');
  check(D.RKMAX === 200, 'клиент знает потолок ×200: ' + D.RKMAX);
  check($('#b1AutoX').getAttribute('max') === '200', 'авто-кэшаут ограничен ×200');
  await sleep(220);                                    // ждём первый /state с окном приёма
  check(/12\.0/.test($('#rrtVal').textContent), 'приём ставок длится 12 секунд: ' + $('#rrtVal').textContent);
  check(/20 000/.test($('#gameArea').textContent), 'игроку виден лимит 20 000 ₽ за раунд');
  type($('#b1Inp'), '6');
  const tgl = el => { if (el.checked) { el.checked = false; el.dispatchEvent(new window.Event('change', { bubbles: true })); } };
  tgl($('#b1AutoChk'));                                // авто-кэшаут не должен стрелять раньше нас
  // клик по кнопке ставит/снимает ставку в очереди; приводим состояние к нужному
  const setQueue = (btn, on) => { if (/ОТМЕНИТЬ/.test(btn.textContent) !== on) click(btn); };
  const b1Btn = $('#b1Btn');

  /* ── 1. ставка уходит на сервер не по клику, а на старте полёта ───────────── */
  setQueue(b1Btn, true);
  check(srv.plays.length === 0, 'после клика в окне приёма на сервер ещё ничего не ушло (очередь): plays=' + srv.plays.length);
  check(/будет сделана/.test($('#rr').textContent), 'игроку сказано, что ставка уйдёт на старте полёта: ' + $('#rr').textContent.slice(0, 60));

  /* ── 2. отмена в окне приёма — честная: токены не списывались ─────────────── */
  setQueue(b1Btn, false);
  check(srv.plays.length === 0 && srv.tokens === 100, 'после отмены сервер не тронут: plays=' + srv.plays.length + ', tokens=' + srv.tokens);
  check(!/Принята сервером|В игре/.test($('#b1Status').textContent), 'снятая ставка не выдаёт себя за принятую: «' + $('#b1Status').textContent + '»');

  /* ── 3. сервер отказал (у клиента устаревший баланс) — фантома быть не должно ─ */
  srv.verdict = 'lose';
  srv.tokens = 40; S.balance = 200;                    // клиент «помнит» 200, на сервере 40
  setQueue(b1Btn, true);
  const a0 = srv.attempts;
  FAKE_NOW = srvRound.flightStartsAt + 1000;           // старт полёта: ставка уходит на сервер
  await sleep(180);
  check(srv.attempts === a0 + 1, 'ставка дошла до сервера и была им рассмотрена');
  check(srv.tokens === 40, 'сервер отказал — баланс не тронут: ' + srv.tokens + ' ⬦');
  check(!/В игре|ПРИНЯТА/.test($('#b1Status').textContent), 'отклонённая ставка НЕ показана как принятая: «' + $('#b1Status').textContent + '»');
  check(/не принята/i.test($('#rr').textContent), 'игроку показан отказ сервера, а не успех: ' + $('#rr').textContent.slice(0, 90));
  check(unhandled.length === 0, 'нет необработанных отказов промисов (было Uncaught in promise): ' + JSON.stringify(unhandled));

  /* ── 4. одна ставка: пред-ставка уходит на сервер на старте следующего раунда ─ */
  srv.tokens = 100; S.balance = 200;                   // клиент снова «богаче» сервера
  setQueue(b1Btn, true);                               // в полёте это пред-ставка на след. раунд
  const a1 = srv.attempts;
  const start2 = FAKE_NOW + 1000;
  srvRound = makeSrvRound(start2, 2, 50);              // новый раунд мок-сервера
  FAKE_NOW = start2 + 1000;
  await sleep(220);
  check(srv.tokens === 40, 'пред-ставка на новый раунд списана один раз: ' + srv.tokens + ' ⬦ (100 − 60)');
  check(srv.attempts === a1 + 1, 'на сервер ушла ровно одна ставка: attempts=' + (srv.attempts - a1));
  check(/Принята сервером|ПРИНЯТА|В игре/.test($('#b1Status').textContent), 'ставка показана как принятая: «' + $('#b1Status').textContent + '»');

  /* ── 5. кэшаут показывает НАЧИСЛЕННОЕ сервером, а не bet×кэшаут ───────────── */
  const tk = [];
  const origPush = window.pushLiveTickerWin;
  window.pushLiveTickerWin = (name, game, amt, mult) => { tk.push({ name, game, amt, mult }); if (origPush) origPush(name, game, amt, mult); };

  srv.tokens = 300; srv.verdict = 'win';
  S.balance = 300;                                     // как после авто-refresh баланса
  const start3 = FAKE_NOW + 1000;
  srvRound = makeSrvRound(start3, 3, 50);              // новый чистый раунд
  FAKE_NOW = start3 + 1000;
  await sleep(220);
  check(!/ЗАБРАТЬ/.test(b1Btn.textContent), 'новый раунд начался с чистых ставок: ' + b1Btn.textContent.slice(0, 30));
  type($('#b1Inp'), '6');
  setQueue(b1Btn, true);
  const p2 = srv.plays.length;
  FAKE_NOW = srvRound.flightStartsAt + 1000;           // старт полёта: ставка уходит серверу и выигрывает 102 ⬦
  await sleep(180);
  check(srv.plays.length === p2 + 1, 'ставка #1 ушла на сервер ровно один раз');
  check(/ЗАБРАТЬ/.test(b1Btn.textContent), 'кнопка предлагает забрать: ' + b1Btn.textContent.slice(0, 40));
  check(/×1\.14/.test(b1Btn.textContent), 'за 1 с полёта множитель плавный ×1.14, а не ×1.36: ' + b1Btn.textContent.slice(0, 40));
  click(b1Btn);                                        // кэшаут на ×1.11
  await sleep(60);
  const rr = $('#rr').textContent;
  check(/\+10,2/.test(rr), 'показана выплата сервера (+10,2 ₽): ' + rr.slice(0, 90));
  check(!/\+6,6/.test(rr), 'нет обещания bet×кэшаут (+6,6 ₽), которого сервер не начислял');
  check(tk.length > 0 && tk[0].mult === RK_MULT, 'тикер получил множитель сервера ×' + RK_MULT + ', а не склейку цифр из подписи: ' + JSON.stringify(tk[0] || null));
  check(tk.length > 0 && tk[0].amt === 102, 'тикер показывает фактическую сумму 102 ⬦: ' + (tk[0] && tk[0].amt));
  check(srv.tokens === 342, 'баланс на сервере сошёлся: ' + srv.tokens + ' ⬦ (300 − 60 + 102)');
  check(showBal() === 342, 'и на экране ровно серверный баланс: ' + showBal() + ' ⬦');

  /* ── 5b. точка краха приходит от сервера (клиент её больше не вычисляет) ──── */
  check((srv.stateCalls || 0) > 0, 'клиент спрашивал точку краха у сервера (/api/racket/state): вызовов ' + (srv.stateCalls || 0));

  /* ── 6. никаких ошибок в консоли страницы ─────────────────────────────────── */
  check(errors.length === 0, 'страница без ошибок: ' + JSON.stringify(errors.slice(0, 3)));

  /* ── 7. демо-режим (без Telegram и без API): ставка и кэшаут не должны падать ── */
  {
    const demoErrors = [];
    const vc2 = new VirtualConsole();
    vc2.on('jsdomError', e => demoErrors.push('jsdomError: ' + (e.detail ? e.detail.detail || e.detail : e.message)));
    vc2.on('error', (...a) => demoErrors.push('console.error: ' + a.join(' ')));
    let DEMO_NOW = RIDXES[0] * 1000 + 1000;             // idx демо-раунда = floor(now/1000), краш > ×3
    const demo = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
      runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc2, url: 'http://localhost/',
      beforeParse(w) {
        w.Date.now = () => DEMO_NOW;                    // демо-режим: ни Telegram, ни API_BASE
        w.fetch = async () => { throw new Error('демо-режим: сеть дёргать нельзя'); };
      }
    });
    const dw = demo.window, ddoc = dw.document;
    const dq = s => ddoc.querySelector(s);
    const dclick = el => { if (!el) throw new Error('демо: нет элемента ' + s); el.dispatchEvent(new dw.MouseEvent('click', { bubbles: true })); };
    dw.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
    await sleep(80);
    dclick(dq('[data-game="racket"]'));
    await sleep(60);
    {
      const dmo = ddoc.querySelector('[data-mode-online="play"]');
      check(!!dmo && dmo.classList.contains('off') && /оффлайн/.test(dmo.textContent),
        'демо-режим: индикатор серый («оффлайн»), сервер не подключён: «' + (dmo ? dmo.textContent.trim() : 'нет') + '»');
    }
    dclick(dq('#b1Btn'));                               // ставка в очередь (локальный баланс)
    const demoStart = DEMO_NOW;
    DEMO_NOW = demoStart + BET_MS + 1000;               // старт полёта: демо-ставка списывается локально
    await sleep(150);
    check(/ЗАБРАТЬ/.test(dq('#b1Btn').textContent), 'демо-режим: кнопка предлагает забрать: ' + dq('#b1Btn').textContent.slice(0, 32));
    dclick(dq('#b1Btn'));                               // кэшаут
    await sleep(60);
    check(/начислено/i.test(dq('#rr').textContent), 'демо-режим: итог показан без сервера: ' + dq('#rr').textContent.slice(0, 80));
    check(demoErrors.length === 0, 'демо-режим без ошибок страницы: ' + JSON.stringify(demoErrors.slice(0, 3)));
    dw.close();
  }

  dom.window.close();
  const line = '─'.repeat(64);
  console.log('\n' + line);
  ok.forEach(m => console.log('  ✅ ' + m));
  if (bad.length) { console.log(''); bad.forEach(m => console.log('  ❌ ' + m)); }
  console.log(line);
  console.log((bad.length ? 'ПРОВАЛЕНО: ' + bad.length + ' из ' + (ok.length + bad.length) : 'ИТОГ: ставка, отмена и выплата совпадают с тем, что сделал сервер.'));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ТЕСТ УПАЛ:', e && e.stack || e); process.exit(1); });
