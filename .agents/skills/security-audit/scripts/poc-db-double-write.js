#!/usr/bin/env node
/**
 * РЕГРЕССИОННЫЙ ТЕСТ: единый источник истины для баланса.
 *
 * Тестирует НАСТОЯЩИЙ код, а не его пересказ:
 *   • берёт реальный ./db.js (копия в temp-каталоге — боевая база не затрагивается)
 *   • извлекает реальную функцию applyBalance() из ./bot.js по исходному тексту
 *     и исполняет её с этим db
 *   • статически проверяет bot.js: не вернулись ли опасные конструкции
 *
 * Запуск: node .agents/skills/security-audit/scripts/poc-db-double-write.js
 *   exit 0 — фикс на месте
 *   exit 1 — регрессия (баланс снова применяется дважды или правки в обход ledger)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const DB_SRC = path.join(ROOT, 'db.js');
const BOT_SRC = path.join(ROOT, 'bot.js');
const TURSO_SRC = path.join(ROOT, 'turso.js');

for (const f of [DB_SRC, BOT_SRC]) {
  if (!fs.existsSync(f)) { console.error('Не найден ' + f); process.exit(2); }
}

// ── Изолированная копия db.js: создаст свою ./data рядом с собой, в temp ─────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-test-'));
fs.copyFileSync(DB_SRC, path.join(TMP, 'db.js'));
if (fs.existsSync(TURSO_SRC)) {
  fs.copyFileSync(TURSO_SRC, path.join(TMP, 'turso.js'));
}
const db = require(path.join(TMP, 'db.js'));

// ── Извлекаем РЕАЛЬНУЮ applyBalance() из bot.js и исполняем её ──────────────
const botSrc = fs.readFileSync(BOT_SRC, 'utf8');
const fnMatch = botSrc.match(/function applyBalance\(u, delta, type, reason, refId = ''\) \{[\s\S]*?\n\}/);
if (!fnMatch) {
  console.error('❌ Не найдена функция applyBalance() в bot.js — структура изменилась, обнови тест');
  process.exit(2);
}
// eslint-disable-next-line no-new-func
const applyBalance = new Function('db', 'console', `return (${fnMatch[0]});`)(db, console);

const C = { red: s => `\x1b[31m${s}\x1b[0m`, grn: s => `\x1b[32m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

const UID = 777;
const mkUser = tokens => ({
  id: UID, numId: 1, name: 'Тест', username: 'test',
  tokens, staked: 0, stakeSince: 0, accruedBase: 0,
  ref: 0, refEarned: 0, refInvited: 0, termsAt: 0,
  totalDepositedRub: 300, lastDeposit: 300, lastDepositId: 1,
  lastCashbackAt: 0, cashbackClaimedDepositId: 0, easycashClaimed: false,
  code: 'TESTCODE'
});
const dbBalance = () => db.getUser(UID).tokens;

/* Сид для теста. Показательно: задать баланс через saveUser БОЛЬШЕ НЕЛЬЗЯ —
   insert пишет tokens только при создании игрока, дальше только через ledger. */
function seed(tokens) {
  const existing = db.getUser(UID);
  if (!existing) { db.saveUser(mkUser(tokens)); return; }
  const r = applyBalance(existing, tokens - existing.tokens, 'test_seed', 'Подготовка теста');
  if (!r.ok) throw new Error('seed: ' + r.error);
}

let failures = 0;
const ok = msg => console.log(`  ${C.grn('✅')} ${msg}`);
const bad = msg => { failures++; console.log(`  ${C.red('❌')} ${msg}`); };

console.log('\nТест: единый источник истины для баланса — MoneyForUp');
console.log(C.dim('реальный db.js: ' + TMP));
console.log(C.dim('реальная applyBalance() извлечена из bot.js\n'));

// ── 1. Инвариант: saveUser НЕ МОЖЕТ менять баланс ───────────────────────────
console.log('1) saveUser не должен менять баланс');
seed(1000);
const u1 = db.getUser(UID);
u1.tokens = 999999;                 // имитируем старый баг: правка памяти перед saveUser
db.saveUser(u1);
if (dbBalance() === 1000) ok('saveUser проигнорировал tokens — двойное применение невозможно по конструкции');
else bad(`saveUser записал баланс: в БД ${dbBalance()} ⬦ вместо 1000 ⬦`);
if (u1.tokens === 1000) ok('память синхронизирована из БД (устаревшее значение отброшено)');
else bad(`память осталась ${u1.tokens} ⬦ — рассинхрон не вылечен`);

// ── 2. Честный раунд ────────────────────────────────────────────────────────
console.log('\n2) Честный раунд: 1000 ⬦, ставка 100, выигрыш 200');
seed(1000);
let u = db.getUser(UID);
const delta = (1000 - 100 + 200) - u.tokens;
const r2 = applyBalance(u, delta, 'game_bet', 'Игра: dice (ставка: 100, выигрыш: 200)');
if (!r2.ok) bad('applyBalance вернул ошибку: ' + r2.error);
else {
  if (dbBalance() === 1100) ok(`в БД ровно 1100 ⬦ (было бы 1200 при двойном применении)`);
  else bad(`в БД ${dbBalance()} ⬦ вместо 1100 ⬦`);
  if (u.tokens === dbBalance()) ok('память == БД (' + u.tokens + ' ⬦)');
  else bad(`память ${u.tokens} ⬦ != БД ${dbBalance()} ⬦`);
}

// ── 3. 20 раундов подряд ────────────────────────────────────────────────────
console.log('\n3) 20 раундов подряд, каждый +50 ⬦');
seed(1000);
for (let i = 0; i < 20; i++) {
  const cu = db.getUser(UID);
  applyBalance(cu, 50, 'game_bet', 'Игра: dice');
}
if (dbBalance() === 2000) ok('итог 2000 ⬦ — накопления ошибки нет');
else bad(`итог ${dbBalance()} ⬦ вместо 2000 ⬦`);

// ── 4. Вывод: списание ровно один раз ───────────────────────────────────────
console.log('\n4) Вывод 300 ₽ (3000 ⬦) с баланса 10 000 ⬦');
seed(10_000);
u = db.getUser(UID);
applyBalance(u, -3000, 'withdraw', 'Заявка на вывод 300 ₽');
if (dbBalance() === 7000) ok('списано ровно 3000 ⬦ (раньше списывалось 6000 ⬦)');
else bad(`на балансе ${dbBalance()} ⬦ вместо 7000 ⬦`);

// ── 5. Сброс баланса (античит) через setBalanceTo-семантику ─────────────────
console.log('\n5) Сброс накрученного баланса до 50 ⬦');
seed(999_999);
u = db.getUser(UID);
const r5 = applyBalance(u, 50 - u.tokens, 'anticheat_reset', 'Сброс накрутки');
if (r5.ok && dbBalance() === 50) ok('сброс проведён через ledger, баланс 50 ⬦');
else bad(`сброс не сработал: ${dbBalance()} ⬦`);

// ── 6. Ошибка записи не оставляет след в памяти ─────────────────────────────
console.log('\n6) Сбой записи в ledger не зачисляет в память');
seed(100);
const u6 = { id: 888888, tokens: 100 };          // игрока нет в БД -> atomicBalanceChange бросит
const r6 = applyBalance(u6, 500, 'deposit', 'Тест сбоя');
if (!r6.ok && u6.tokens === 100) ok('ошибка возвращена, память не изменена — депозит не «потерялся» в памяти');
else bad(`при сбое память всё равно изменилась: ${u6.tokens} ⬦`);

// ── 7. Статика: опасные конструкции не вернулись ────────────────────────────
console.log('\n7) Статическая проверка bot.js');
const lines = botSrc.split('\n');
let pairs = 0;
for (let i = 0; i < lines.length; i++) {
  if (!/db\.saveUser\(/.test(lines[i])) continue;
  for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
    if (/db\.atomicBalanceChange\(/.test(lines[j])) {
      bad(`bot.js:${i + 1} — saveUser затем atomicBalanceChange (двойное применение вернулось)`);
      pairs++;
      break;
    }
    if (/db\.saveUser\(/.test(lines[j])) break;
  }
}
if (!pairs) ok('пар «saveUser → atomicBalanceChange» нет');

let direct = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/\.tokens\s*(\+=|-=|=)/);
  if (!m) continue;
  const ctx = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
  if (/applyBalance|setBalanceTo/.test(ctx)) continue;      // правка внутри хелпера — это и есть ledger
  if (/\/\/\s*ledger-ok\b/.test(lines[i])) continue;        // явная метка: значение уже записано в БД транзакцией
  if (/setRef|stakeAccrued/.test(lines[i])) continue;
  bad(`bot.js:${i + 1} — правка баланса в обход ledger: ${lines[i].trim().slice(0, 60)}`);
  direct++;
}
const marked = lines.filter(l => /\/\/\s*ledger-ok\b/.test(l)).length;
if (!direct) ok(`прямых правок баланса в обход applyBalance нет (помечено ledger-ok: ${marked})`);

// ── Итог ────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(64));
if (failures) {
  console.log(C.red(`ИТОГ: ${failures} провал(ов) — регрессия.`));
  console.log('Баланс обязан меняться ТОЛЬКО через applyBalance()/setBalanceTo(), а saveUser не трогать tokens.\n');
  process.exit(1);
}
console.log(C.grn('ИТОГ: все проверки пройдены — баланс применяется ровно один раз.'));
console.log('Осталось сверить уже испорченные балансы: tools/reconcile-ledger.js\n');
process.exit(0);
