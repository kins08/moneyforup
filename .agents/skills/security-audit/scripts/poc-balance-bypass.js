#!/usr/bin/env node
/**
 * PoC: клиент управляет результатом игры и балансом — MoneyForUp.
 *
 * ДВА раздела:
 *   1) ЖИВОЙ СЕРВЕР — те же атаки уходят в реальный bot.js (изолированная копия).
 *      Именно этот раздел определяет exit-код. Если тут появится эксплойт —
 *      значит защита сломана заново.
 *   2) ИСТОРИЧЕСКИЙ СЛЕПОК — что делал код на b8b56f5. Нужен для разбора
 *      инцидента и оценки ущерба. На exit-код не влияет.
 *
 * Запуск: node .agents/skills/security-audit/scripts/poc-balance-bypass.js
 *   exit 0 — все векторы закрыты
 *   exit 1 — есть работающий эксплойт
 *
 * ВАЖНО: раньше этот файл был ТОЛЬКО симуляцией старого кода и всегда печатал
 * «ЭКСПЛОЙТ», даже после фикса. Такой PoC опаснее отсутствующего: он приучает
 * игнорировать красный вывод. Теперь вердикт выносит живой сервер.
 */

'use strict';

const path = require('path');
const { startServer, C } = require(path.join(__dirname, 'lib', 'server-harness'));

const PORT = 34520;          // отличается от e2e-game-authority-test.js (34519)
const DEPOSITOR = 777001;
const UNDEPOSITED = 777002;
const START = 3000;          // 300 ₽ на счету (10 ⬦ = 1 ₽), депозит уже был
const RUB_DEPOSIT = 300;
const NON_DEPOSITOR_CAP = 400;

let exploited = 0;
const line = pwned => pwned ? C.red('❌ ЭКСПЛОЙТ') : C.grn('✅ защищено');

(async () => {
  console.log('\n' + '═'.repeat(72));
  console.log(C.b('РАЗДЕЛ 1. ЖИВОЙ СЕРВЕР — текущий код'));
  console.log('═'.repeat(72) + '\n');

  const srv = await startServer({
    port: PORT,
    users: [
      { id: DEPOSITOR,    tokens: START, depositedRub: RUB_DEPOSIT },
      { id: UNDEPOSITED,  tokens: 50,    depositedRub: 0 }
    ]
  });
  console.log(C.dim(`изолированная копия: ${srv.tmp}`));
  console.log(C.dim(`исходный баланс ${START} ⬦ (${START / 10} ₽), депозит ${RUB_DEPOSIT} ₽\n`));

  const { post, bal } = srv;

  /** Один вектор: запрос → изменение баланса → вердикт.
   *  maxGain — наибольший ЧЕСТНЫЙ прирост баланса. Для чисто атакующих векторов
   *  это 0: баланс не должен вырасти ни на токен. Для векторов, где легально
   *  ставится ставка и возможен настоящий выигрыш, порог считается из математики
   *  игры (ставка × (множитель − 1)) — иначе честный выигрыш выглядел бы эксплойтом. */
  async function vector(id, title, userId, p, body, maxGain, extraCheck) {
    const before = bal(userId);
    const r = await post(p, body, userId);
    const after = bal(userId);
    const delta = after - before;
    let pwned = delta > maxGain;
    let extraMsg = '';
    if (extraCheck) {
      const res = extraCheck(r, delta);
      if (res) { pwned = true; extraMsg = res; }
    }
    if (pwned) exploited++;
    console.log(`[${id}] ${title}`);
    console.log(`     ${p} → ${r.status} ${C.dim(JSON.stringify(r.body).slice(0, 90))}`);
    console.log(`     ${before} ⬦ → ${after} ⬦ (${delta >= 0 ? '+' : ''}${delta} ⬦; честный максимум +${maxGain})   ${line(pwned)}`);
    if (extraMsg) console.log(C.red(`     вывод: ${extraMsg}`));
    else if (pwned) console.log(C.red(`     вывод: начислено ${delta - maxGain} ⬦ сверх честного максимума`));
    console.log('');
    return { r, delta, pwned };
  }

  // ── A. Главный вектор из находки P0-1 ────────────────────────────────────
  await vector('A', 'record-bet: клиентский winTokens (депозит есть — потолок не спасает)',
    DEPOSITOR, '/api/record-bet', { betTokens: 0, winTokens: 999_999, game: 'dice' }, 0);

  // ── B. Установка баланса напрямую ────────────────────────────────────────
  await vector('B', 'sync-balance: попытка установить баланс',
    DEPOSITOR, '/api/sync-balance', { tokens: 10_000_000, game: 'dice' }, 0);

  // ── C. Бездепозитный игрок ───────────────────────────────────────────────
  await vector('C', `record-bet: клиентский winTokens БЕЗ депозита (потолок ${NON_DEPOSITOR_CAP} ⬦)`,
    UNDEPOSITED, '/api/record-bet', { betTokens: 0, winTokens: 999_999, game: 'dice' }, 0);

  // ── D. Ставка больше баланса ─────────────────────────────────────────────
  await vector('D', 'record-bet: ставка выше баланса (контрольный — защита обязана работать)',
    DEPOSITOR, '/api/record-bet', { betTokens: 999_999, winTokens: 999_999, game: 'dice' }, 0);

  // ── E. Старое поле tokens ────────────────────────────────────────────────
  await vector('E', 'record-bet: поле tokens (старый вектор — больше не читается)',
    DEPOSITOR, '/api/record-bet', { betTokens: 0, winTokens: 0, tokens: 9_000_000, game: 'cases' }, 0);

  // ── F. Новый контракт: клиент не может прислать выигрыш ──────────────────
  await vector('F', 'play: клиент присылает win/verdict в новом контракте',
    DEPOSITOR, '/api/play', { game: 'dice', bet: 100, mult: 2, win: 999_999, verdict: 'win' }, 100,
    r => (r.body && r.body.win > 200) ? `сервер выплатил ${r.body.win} ⬦ при ставке 100 и ×2` : null);

  // ── G. Множитель сверх максимума игры ────────────────────────────────────
  await vector('G', 'play: множитель ×100000 (потолок игры dice = 20)',
    DEPOSITOR, '/api/play', { game: 'dice', bet: 100, mult: 100_000 }, 1900,
    r => (r.body && r.body.mult > 20) ? `сервер принял множитель ×${r.body.mult}` : null);

  await srv.stop();

  const verdictLive = exploited === 0;
  console.log('─'.repeat(72));
  if (verdictLive) {
    console.log(C.grn('РАЗДЕЛ 1 — ИТОГ: все векторы закрыты. Баланс не поднялся ни разу.'));
  } else {
    console.log(C.red(`РАЗДЕЛ 1 — ИТОГ: ${exploited} работающих эксплойт(ов). Это P0, чинить немедленно.`));
  }

  // ── Исторический слепок: НЕ влияет на exit-код ───────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(C.b('РАЗДЕЛ 2. ИСТОРИЧЕСКИЙ СЛЕПОК — код на b8b56f5 (для разбора инцидента)'));
  console.log('═'.repeat(72) + '\n');
  console.log(C.dim('Это НЕ проверка текущего состояния, а модель того, что делал старый код.\n'));

  const newUser = () => ({ tokens: START, totalDepositedRub: RUB_DEPOSIT });

  /** /api/record-bet — bot.js:1301–1355 на b8b56f5 */
  function oldRecordBet(u, body) {
    const userDep = u.totalDepositedRub || 0;                                // 1303
    let betTk = Math.max(0, Math.floor(Number(body.betTokens) || 0));        // 1304
    let winTk = Math.max(0, Math.floor(Number(body.winTokens) || 0));        // 1305  ← из клиента
    const maxAllowedBet = Math.max(500, Math.floor(u.tokens || 0) + 200);    // 1309
    if (betTk > maxAllowedBet) { betTk = Math.min(betTk, u.tokens); winTk = 0; }
    let nextTk = Math.max(0, Math.floor(u.tokens - betTk + winTk));          // 1323
    if (userDep <= 0 && nextTk > NON_DEPOSITOR_CAP) nextTk = 350;            // 1325
    u.tokens = nextTk;
    return u.tokens;
  }

  const hist = [
    ['A', 'winTokens=999999 при депозите 300 ₽', oldRecordBet(newUser(), { betTokens: 0, winTokens: 999_999 })],
    ['C', 'winTokens без депозита (потолок 400 ⬦)', oldRecordBet({ tokens: 50, totalDepositedRub: 0 }, { betTokens: 0, winTokens: 999_999 })],
    ['D', 'ставка выше баланса', oldRecordBet(newUser(), { betTokens: 999_999, winTokens: 999_999 })]
  ];
  for (const [id, title, got] of hist) {
    const pwned = got > START;
    console.log(`[${id}] ${title}`);
    console.log(`     ${START} ⬦ → ${got} ⬦ (${(got / 10).toFixed(0)} ₽)   ${pwned ? C.red('❌ ЭКСПЛОЙТ БЫЛ') : C.grn('✅ отбито')}`);
    if (pwned) console.log(C.dim(`     ущерб до ${((got - START) / 10).toFixed(0)} ₽ за один запрос`));
  }
  console.log(C.dim('\nСлой БД удваивал результат — см. poc-db-double-write.js.'));

  console.log('\n' + '─'.repeat(72));
  if (!verdictLive) {
    console.log(C.red('ИТОГ: защита P0-1 сломана — см. РАЗДЕЛ 1.'));
    process.exit(1);
  }
  console.log(C.grn('ИТОГ: живой сервер не даёт клиенту влиять на деньги. История — для оценки ущерба.'));
  console.log(C.dim('Проверь, что честная игра, депозит и вывод по-прежнему работают (e2e-game-authority-test.js).\n'));
  process.exit(0);
})().catch(e => { console.error('Ошибка PoC:', e.message || e); process.exit(2); });
