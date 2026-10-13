#!/usr/bin/env node
/**
 * E2E-тест: исход игры решает СЕРВЕР, клиент не может влиять на деньги (P0-1).
 *
 * Поднимает реальный bot.js в изолированном temp-каталоге, генерирует валидный
 * initData и проверяет, что любые клиентские поля результата игнорируются,
 * а баланс, ledger и раунды сходятся.
 *
 * Запуск: node .agents/skills/security-audit/scripts/e2e-game-authority-test.js
 *   exit 0 — сервер авторитетен
 *   exit 1 — регрессия (клиент снова влияет на деньги)
 */

'use strict';

const path = require('path');
const { startServer, C } = require(path.join(__dirname, 'lib', 'server-harness'));

const PORT = 34519;
const UID = 515151;
const ADMIN_ID = 999999999;
const START_TOKENS = 50;      // столько начисляет регистрация, минуя ledger

let failures = 0;
const ok = m => console.log(`   ${C.grn('✅')} ${m}`);
const bad = m => { failures++; console.log(`   ${C.red('❌')} ${m}`); };

(async () => {
  console.log('\nE2E: сервер авторитетен в игре — MoneyForUp');

  const srv = await startServer({
    port: PORT, adminId: ADMIN_ID,
    users: [
      { id: UID,     tokens: 500000, depositedRub: 300 },   // депозит есть — потолок бездепозитных не мешает
      { id: UID + 1, tokens: START_TOKENS, depositedRub: 0 } // бездепозитный — для проверки потолка
    ]
  });
  console.log(C.dim('изолированная копия: ' + srv.tmp + '\n'));

  const { post, bal, ledgerSum, db } = srv;
  const initData = srv.initData(UID);
  console.log(C.grn('✅ Сервер поднялся\n'));

  // ── 1. Клиентские поля результата игнорируются ────────────────────────────
  console.log('1) Клиент присылает выигрыш сам — сервер обязан его проигнорировать');
  const b1 = bal(UID);
  const r1 = await post('/api/play', { game: 'dice', bet: 100, mult: 2,
    winTokens: 999999, tokens: 999999, win: 999999, verdict: 'win' });
  const gained1 = bal(UID) - b1;
  console.log(`   ответ: ${r1.status} ${C.dim(JSON.stringify(r1.body).slice(0, 130))}`);
  const maxLegit = Math.floor(100 * 20);        // bet × maxMult(dice)=20
  if (gained1 <= maxLegit) ok(`начислено ${gained1} ⬦ — в пределах математики игры (макс ${maxLegit})`);
  else bad(`начислено ${gained1} ⬦ — клиент повлиял на сумму!`);
  if (gained1 !== 999999) ok('присланный winTokens=999999 проигнорирован');
  else bad('сервер принял winTokens от клиента');

  // ── 2. Множитель сверх границ обрезается ──────────────────────────────────
  console.log('\n2) Множитель выше максимума игры (dice maxMult=20)');
  const b2 = bal(UID);
  const r2 = await post('/api/play', { game: 'dice', bet: 100, mult: 100000 });
  const gained2 = bal(UID) - b2;
  console.log(`   ответ: mult=${r2.body.mult}, начислено ${gained2} ⬦`);
  if ((r2.body.mult || 0) <= 20) ok(`множитель обрезан до ×${r2.body.mult} (максимум игры)`);
  else bad(`сервер принял множитель ×${r2.body.mult}`);
  if (gained2 <= 2000) ok('выплата не превысила bet × maxMult');
  else bad(`выплата ${gained2} ⬦ превышает допустимую`);

  // ── 3. Ставка больше баланса отклоняется ──────────────────────────────────
  console.log('\n3) Ставка больше баланса');
  const r3 = await post('/api/play', { game: 'dice', bet: 10_000_000, mult: 2 });
  if (r3.status === 400) ok('отклонено с 400: ' + (r3.body.error || ''));
  else bad(`принято со статусом ${r3.status} — ставка больше баланса`);

  // ── 4. Идемпотентность раунда ─────────────────────────────────────────────
  console.log('\n4) Повтор одного roundId не создаёт второй раунд');
  const rid = 'TESTROUND' + Date.now().toString(36);
  const r4a = await post('/api/play', { game: 'dice', bet: 50, mult: 2, roundId: rid });
  const after4a = bal(UID);
  const r4b = await post('/api/play', { game: 'dice', bet: 50, mult: 2, roundId: rid });
  const after4b = bal(UID);
  console.log(`   первый: ${r4a.status}, повтор: ${r4b.status} ${C.dim(JSON.stringify(r4b.body).slice(0, 70))}`);
  if (after4a === after4b) ok('повтор отклонён, баланс не изменился');
  else bad(`повтор изменил баланс на ${after4b - after4a} ⬦`);
  if (r4b.status === 400) ok('повтор получил 400 «Раунд уже проведён»');

  // ── 5. Неизвестная игра не ломает сервис ──────────────────────────────────
  console.log('\n5) Неизвестная игра');
  const b5 = bal(UID);
  const r5 = await post('/api/play', { game: 'Хакерская игра 3000', bet: 100, mult: 2 });
  const gained5 = bal(UID) - b5;
  if (r5.status === 200) ok(`принято с консервативным профилем, начислено ${gained5} ⬦ (≤ 2× ставки)`);
  else console.log(`   ${C.yel('⚠️')} ответ ${r5.status}: ${JSON.stringify(r5.body).slice(0, 80)}`);
  if (gained5 <= 200) ok('выплата в пределах консервативного профиля');
  else bad(`выплата ${gained5} ⬦ вне консервативного профиля`);

  // ── 6. Потолок бездепозитного игрока применяется на сервере ───────────────
  console.log('\n6) Бездепозитный игрок: потолок 400 ⬦');
  for (let i = 0; i < 40; i++) {
    await post('/api/play', { game: 'dice', bet: 10, mult: 20 }, UID + 1);
  }
  const ndBal = bal(UID + 1);
  console.log(`   баланс бездепозитного: ${ndBal} ⬦`);
  if (ndBal <= 400) ok('выше потолка не поднялся');
  else bad(`бездепозитный поднялся до ${ndBal} ⬦`);

  // ── 7. Матожидание соответствует заявленной комиссии ──────────────────────
  console.log('\n7) RTP: 1200 раундов (bet 10, mult 2, edge 3 %)');
  const ROUNDS = 1200;
  const wins = [];
  for (let i = 0; i < ROUNDS; i++) {
    const before = bal(UID);
    const r = await post('/api/play', { game: 'dice', bet: 10, mult: 2 });
    if (r.status !== 200) { bad('раунд не прошёл: ' + JSON.stringify(r.body)); break; }
    wins.push(bal(UID) - before + 10);          // выигрыш за раунд
  }
  const wagered = ROUNDS * 10;
  const won = wins.reduce((a, b) => a + b, 0);
  const rtp = won / wagered;
  console.log(`   поставлено ${wagered} ⬦, выплачено ${won} ⬦, RTP = ${rtp.toFixed(4)} (ожидалось ≈ 0.97)`);
  if (Math.abs(rtp - 0.97) < 0.09) ok('RTP в пределах статистической погрешности — жребий серверный');
  else bad(`RTP ${rtp.toFixed(4)} вне ожиданий — проверьте генератор`);

  // ── 8. Инвариант: стартовый баланс + журнал == текущий баланс ─────────────
  // ВАЖНО: регистрация начисляет START_TOKENS (50 ⬦) БЕЗ записи в ledger.
  // Поэтому корректная формула: opening + SUM(ledger) == users.tokens.
  // Сверка, которая сравнивает SUM(ledger) с балансом напрямую, даст ложные
  // расхождения по каждому игроку — это надо учесть в tools/reconcile-ledger.js.
  console.log('\n8) Инвариант ledger: opening + SUM(ledger.amount) == users.tokens');
  for (const [uid, opening] of [[UID, 500000], [UID + 1, START_TOKENS]]) {
    const b = bal(uid), l = ledgerSum(uid);
    if (opening + l === b) ok(`игрок ${uid}: ${opening} + (${l}) == ${b} ⬦`);
    else bad(`игрок ${uid}: ${opening} + (${l}) != ${b} ⬦ (расхождение ${b - opening - l})`);
  }

  // ── 8b. Обратная совместимость со старым клиентом ─────────────────────────
  console.log('\n8b) Старый клиент: POST /api/record-bet { betTokens }');
  const b8 = bal(UID);
  const r8 = await post('/api/record-bet', { game: 'Dice', betTokens: 100 });
  const gained8 = bal(UID) - b8;
  console.log(`   ответ: ${r8.status} ${C.dim(JSON.stringify(r8.body).slice(0, 110))}`);
  if (r8.status === 200 && typeof r8.body.verdict === 'string') ok('старый путь работает и получает вердикт сервера');
  else bad('обратная совместимость сломана');
  if (gained8 >= -100 && gained8 <= 1900) ok(`ставка списана один раз, начисление ${gained8} ⬦ в пределах игры`);
  else bad(`некорректное начисление: ${gained8} ⬦`);

  // ── 9. Двойной записи нет ─────────────────────────────────────────────────
  console.log('\n9) Детектор рассинхрона за весь тест');
  const drifts = (srv.log.match(/\[Ledger\] Рассинхрон/g) || []).length;
  if (drifts === 0) ok('ни одного случая рассинхрона');
  else bad(`${drifts} случаев рассинхрона — есть путь в обход ledger`);

  // ── 10. Раунды записаны ───────────────────────────────────────────────────
  console.log('\n10) Журнал раундов game_rounds');
  const rn = db.db.prepare(
    'SELECT COUNT(*) AS c, COALESCE(SUM(bet_tokens),0) AS b, COALESCE(SUM(win_tokens),0) AS w FROM game_rounds WHERE user_id = ?'
  ).get(UID);
  console.log(`   раундов: ${rn.c}, ставок: ${rn.b} ⬦, выигрышей: ${rn.w} ⬦`);
  if (rn.c >= ROUNDS) ok('раунды пишутся в БД — есть чем расследовать инцидент');
  else bad(`в журнале только ${rn.c} раундов из ${ROUNDS}`);

  console.log('\n' + '─'.repeat(64));
  await srv.stop();
  console.log(C.dim('временный каталог удалён\n'));

  if (failures) {
    console.log(C.red(`ИТОГ: ${failures} провал(ов) — клиент снова влияет на исход.`));
    process.exit(1);
  }
  console.log(C.grn('ИТОГ: исход решает сервер, деньги и журнал сходятся.'));
  console.log('Клиент может влиять только на СВОЙ ВЫБОР (игра, ставка, множитель в границах).\n');
  process.exit(0);
})().catch(e => { console.error('Ошибка теста:', e.message || e); process.exit(2); });
