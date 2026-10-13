#!/usr/bin/env node
/**
 * E2E: Ракетка — раунд, ставка и кэшаут решает СЕРВЕР (R3).
 *
 * Поднимает реальный bot.js (изолированная копия) и открывает в jsdom живую
 * страницу MoneyForUp, настроенную на этот сервер. Проверяет то, ради чего
 * движок переписывался:
 *   • клиент не может подделать множитель кэшаута (поле x/mult игнорируется);
 *   • точка остановки раунда не известна клиенту до финиша (только commit-хэш);
 *   • поздний кэшаут → 0, повторный → без второй выплаты;
 *   • отмена ставки возвращает ровно ставку и только до старта полёта;
 *   • авто-кэшаут платит по серверному краху;
 *   • брошенная ставка (раунд не доигран) возвращается;
 *   • деньги, ledger и состояние на экране сходятся.
 *
 * Запуск: node .agents/skills/security-audit/scripts/e2e-racket-crash-test.js
 *   exit 0 — сервер авторитетен, деньги сходятся
 *   exit 1 — регрессия
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../../..');
const { startServer, makeInitData, C, sleep } = require(path.join(__dirname, 'lib', 'server-harness'));

const PORT = 34610;
const UID = 585001;
const ADMIN_ID = 999999999;
const START_TOKENS = 5000;
const CYCLE = 4000, BETTING = 2500, GRACE = 400, EXPIRE = 1500;

let failures = 0;
const ok = m => console.log(`   ${C.grn('✅')} ${m}`);
const bad = m => { failures++; console.log(`   ${C.red('❌')} ${m}`); };
const check = (c, m) => (c ? ok : bad)(m);

(async () => {
  console.log('\nE2E: Ракетка — ставка, кэшаут и крах на сервере — MoneyForUp');

  const srv = await startServer({
    port: PORT, adminId: ADMIN_ID,
    users: [{ id: UID, tokens: START_TOKENS, depositedRub: 300 }],
    env: {
      RACKET_CYCLE_MS: String(CYCLE), RACKET_BETTING_MS: String(BETTING),
      RACKET_GRACE_MS: String(GRACE), RACKET_EXPIRE_MS: String(EXPIRE)
    }
  });
  console.log(C.dim('изолированная копия: ' + srv.tmp + '\n'));

  const initData = makeInitData(srv.botToken, UID);
  const api = `http://127.0.0.1:${srv.port}`;
  const rk = (p, b = {}) => srv.post('/api/racket/' + p, b);      // серверные проверки в обход страницы

  /* ── Живая страница, настроенная на этот сервер ──────────────────────────── */
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail ? e.detail.detail || e.detail : e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const TG_MOCK = {
    initData,
    initDataUnsafe: { user: { id: UID, first_name: 'Аудит', username: 'audit_' + UID } },
    platform: 'android', version: '7.0', colorScheme: 'dark', viewportStableHeight: 800, isExpanded: true,
    contentSafeAreaInset: { top: 0, bottom: 24 },
    ready() {}, expand() {}, disableVerticalSwipes() {}, setHeaderColor() {}, setBackgroundColor() {},
    BackButton: { show() {}, hide() {}, onClick() {} },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
    openInvoice() {}, openTelegramLink() {}, openLink() {}
  };

  /* Страница жёстко прописывает прод-URL бэкенда в <head>, поэтому подменить
     API_BASE снаружи нельзя — переписываем адрес в fetch-шиме: все запросы
     страницы идут на тестовый сервер. Побочный плюс: тест проверяет ровно тот
     код, что уходит в прод, без правок index.html. */
  const PAGE_API = 'https://moneyforup.onrender.com';
  const proxied = [];
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.tg/',
    beforeParse(window) {
      // jsdom считает вкладку скрытой — тогда клиент не опрашивает сервер.
      // Симулируем открытую вкладку: страница должна жить в реальном ритме.
      try{ Object.defineProperty(window.Document.prototype, 'hidden', { get: () => false, configurable: true }); }catch(_){}
      try{ Object.defineProperty(window.Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true }); }catch(_){}
      window.Telegram = { WebApp: TG_MOCK };
      window.fetch = (url, opts = {}) => {
        let u = String(url);
        if (u.startsWith(PAGE_API)) { proxied.push(u.slice(PAGE_API.length)); u = api + u.slice(PAGE_API.length); }
        const o = { ...opts };
        delete o.signal;                     // signal из jsdom не совместим с undici — тесту он не нужен
        return fetch(u, o);
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
  const click = el => { if (!el) throw new Error('нет элемента'); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
  const bal = () => srv.bal(UID);
  const st = () => rk('status', {});
  /* Ждём окно приёма ставок: сценарий должен попадать в него, иначе ставка
     честно уходит в следующий раунд (это тоже нормальный путь, но проверяем
     мы сейчас именно ставку текущего раунда). */
  const waitBetting = async (slack = 800) => {
    for (let i = 0; i < 100; i++) {
      const b = (await st()).body;
      if (b.now < b.round.bettingEndsAt - slack) return b;
      await sleep(150);
    }
    throw new Error('не дождался окна ставок');
  };
  const ledger = () => srv.ledgerSum(UID);

  await sleep(250);
  click($('[data-game="racket"]'));
  await sleep(700);                       // страница получает первый статус

  /* 1) Клиент показывает серверную механику и commit-хэш */
  check(proxied.some(u => u.startsWith('/api/racket/status')), 'страница сама запрашивает состояние раунда у сервера: ' + JSON.stringify(proxied.filter(u=>u.includes('racket')).slice(0,3)));
  const st1 = (await st()).body;
  check(!!st1.round && !!st1.round.seedHash, 'сервер отдаёт раунд с commit-хэшем: ' + (st1.round && st1.round.seedHash || '').slice(0, 12) + '…');
  check(st1.round.crash === undefined && st1.round.crashPoint === undefined, 'точка остановки живого раунда НЕ уходит клиенту');
  check(st1.engine && st1.engine.cycleMs === CYCLE, 'тайминги раунда приходят с сервера (cycle=' + st1.engine.cycleMs + 'мс)');
  check(/ОСТАНОВК|этап|раунд|ставк/i.test($('#rr').textContent), 'страница объясняет механику: ' + $('#rr').textContent.slice(0, 60));

  /* 2) Ставка через интерфейс: сервер принимает, UI показывает отменяемую ставку */
  await waitBetting();
  const betAmount = 60;
  let base = bal();
  const $b1 = $('#b1Inp'); $b1.value = String(betAmount); $b1.dispatchEvent(new window.Event('input', { bubbles: true }));
  click($('#b1Btn'));
  await sleep(1200);
  check(bal() === base - betAmount, `ставка списана один раз: ${base} → ${bal()} ⬦ (−${betAmount})`);
  check(ledger() === bal() - START_TOKENS, 'ledger сходится с балансом после ставки: ' + ledger());
  check(/ОТМЕНИТЬ/.test($('#b1Btn').textContent), 'кнопка предлагает отмену, пока раунд не полетел: ' + $('#b1Btn').textContent.slice(0, 40));

  /* 3) Отмена: возврат ровно ставки, повторная отмена — отказ */
  click($('#b1Btn'));
  await sleep(1200);
  check(bal() === base, `отмена вернула ровно ставку: ${bal()} ⬦ (было ${base})`);
  check(/отмен/i.test($('#rr').textContent), 'на экране сказано об отмене: ' + $('#rr').textContent.slice(0, 60));
  const cancelAgain = await rk('cancel', { slot: 1 });
  check(cancelAgain.status === 400 || cancelAgain.status === 404, 'повторная отмена отклонена (' + cancelAgain.status + ')');

  /* 4) Кэшаут считает сервер: подделка x в теле запроса игнорируется */
  await waitBetting();
  base = bal();
  const bet2 = await rk('bet', { slot: 1, bet: 100 });
  const stBet = (await st()).body;
  check(bet2.status === 200 && stBet.me.some(b => b.roundId === stBet.round.id && Number(b.slot) === 1 && b.status === 'active'),
        'ставка принята и видна в состоянии текущего раунда');
  await sleep(BETTING + 250);                                   // начался полёт
  const forged = await rk('cashout', { slot: 1, x: 30, mult: 30 });
  check(forged.status === 200, 'кэшаут выполнен: ' + JSON.stringify(forged.body).slice(0, 90));
  check(forged.body.x < 3, 'сервер вернул СВОЙ множитель (' + forged.body.x + '), а не навязанный клиентом ×30');
  const expWin = Math.floor(100 * forged.body.x);
  check(forged.body.win === expWin || forged.body.win === 0, `выплата = bet × серверный множитель: ${forged.body.win} ⬦ (ожидалось ${expWin})`);
  check(bal() === base - 100 + forged.body.win, `баланс сошёлся: ${bal()} ⬦ (было ${base})`);

  /* 5) Повторный кэшаут не платит второй раз */
  const repeat = await rk('cashout', { slot: 1 });
  check(repeat.body.repeat === true && repeat.body.win === forged.body.win, 'повторный кэшаут идемпотентен: ' + JSON.stringify(repeat.body).slice(0, 70));
  check(bal() === base - 100 + forged.body.win, 'второй выплаты не было: ' + bal() + ' ⬦');

  /* 6) Авто-кэшаут: платит по серверному краху, иначе ставка сгорает */
  await waitBetting();
  const balBeforeAuto = bal();
  await rk('bet', { slot: 2, bet: 100, autoX: 1.05 });
  await sleep(CYCLE + GRACE + 1200);
  const settled = (await st()).body.me.find(b => Number(b.slot) === 2) || null;
  check(!!settled && (settled.status === 'cashed' || settled.status === 'bust'), 'авто-ставка закрыта сервером: ' + (settled && settled.status));
  if (settled && settled.status === 'cashed') {
    check(settled.cashedX === 1.05 && settled.win === Math.floor(100 * 1.05), 'авто-кэшаут заплатил ×1.05: ' + settled.win + ' ⬦');
    check(bal() === balBeforeAuto - 100 + settled.win, 'баланс после авто-кэшаута: ' + bal() + ' ⬦');
  } else {
    check(bal() === balBeforeAuto - 100, 'авто-ставка сгорела: списано ровно 100 ⬦ (' + bal() + ')');
  }

  /* 7) Раскрытие раунда: крах в истории + проверка по seed */
  const st2 = (await st()).body;
  const fin = st2.history.find(h => h.crash != null);
  check(!!fin, 'завершённый раунд раскрыт в истории: ' + JSON.stringify(fin || {}).slice(0, 80));
  const vf = await rk('verify', { roundId: fin.roundId });
  const seed = vf.body.serverSeed;
  const hashOk = !!seed && crypto.createHash('sha256').update(fin.roundId + ':' + seed).digest('hex') === vf.body.seedHash;
  check(hashOk, 'commit-схема сходится: sha256(roundId + ":" + seed) == опубликованный хэш');
  check(vf.body.crash === fin.crash, 'крах из БД совпадает с раскрытым: ×' + vf.body.crash);
  const liveVerify = await rk('verify', { roundId: st2.round.id });
  check(liveVerify.body.serverSeed === null, 'seed живого раунда не раскрывается');

  /* 8) Отмена в полёте запрещена (это и был бы «откат проигрыша») */
  await waitBetting();
  await rk('bet', { slot: 1, bet: 50 });
  await sleep(BETTING + 250);
  const lateCancel = await rk('cancel', { slot: 1 });
  check(lateCancel.status === 400, 'отмена в полёте запрещена (' + lateCancel.status + '): ' + (lateCancel.body.error || ''));

  /* 9) Брошенная ставка возвращается ровно один раз */
  const balBeforeStale = bal();
  srv.db.racketBetCreate({
    roundId: 'RKTstale' + Date.now().toString(36), userId: UID, slot: 1, bet: 70, autoX: null,
    createdAt: Date.now() - EXPIRE - 5000
  });
  await sleep(6000);                                   // свип ходит раз в 5 секунд
  check(bal() === balBeforeStale + 70, `брошенная ставка возвращена: +70 ⬦ (${balBeforeStale} → ${bal()})`);
  await sleep(1500);
  check(bal() === balBeforeStale + 70, 'повторного возврата нет: ' + bal() + ' ⬦');

  /* 10) Деньги и страница сходятся */
  check(ledger() === bal() - START_TOKENS, `ledger == баланс − старт: ${ledger()} == ${bal() - START_TOKENS}`);
  check(errors.length === 0, 'страница без ошибок: ' + JSON.stringify(errors.slice(0, 2)));
  check(/ставк|забран|выигрыш|раунд/i.test($('#rr').textContent), 'на экране осмысленный итог: ' + $('#rr').textContent.slice(0, 70));

  dom.window.close();
  await srv.stop();

  console.log('\n' + '─'.repeat(66));
  console.log(failures
    ? C.red(`ПРОВАЛЕНО: ${failures} проверок — ставки Ракетки снова можно решать с клиента`)
    : C.grn('ИТОГ: раунд, крах и выплаты Ракетки решает сервер; клиент влияет только на момент кэшаута.'));
  process.exit(failures ? 1 : 0);
})().catch(async e => {
  console.error(C.red('E2E УПАЛ: ' + (e && e.stack || e)));
  process.exit(1);
});
