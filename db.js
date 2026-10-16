/**
 * MoneyForUp — модуль постоянной базы данных и финансового журнала (Ledger)
 * Использует встроенный node:sqlite. Без внешних компилируемых зависимостей.
 *
 * ТРЕБОВАНИЯ К RUNTIME: node:sqlite доступен БЕЗ ФЛАГОВ только с Node 22.13 / 23.4.
 * (модуль появился в 22.5, но до 22.13 и в 23.0–23.3 он спрятан за --experimental-sqlite;
 *  в 22.13.0 и 23.4.0 флаг сняли). На Node 20 и на 22.5–22.12 без флага этот require
 * падает с ERR_UNKNOWN_BUILTIN_MODULE — процесс не стартует вообще.
 *
 * ПУТЬ К БАЗЕ: по умолчанию ./data/moneyforup.db рядом с проектом. На хостингах
 * с эфемерной файловой системой (Render, Fly, Heroku) этот каталог СТИРАЕТСЯ
 * при каждом деплое и рестарте — вместе с балансами, журналом и заявками.
 * Обязательно смонтируйте постоянный диск и укажите путь в DB_PATH.
 */
const fs = require('fs');
const path = require('path');
const turso = require('./turso');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error(
    'Не удалось загрузить node:sqlite. Нужен Node.js 22.13+ (в 22.5–22.12 модуль за флагом ' +
    '--experimental-sqlite, в 23.0–23.3 тоже за флагом, на 20 и ниже его нет). ' +
    'Текущая версия: ' + process.version + '. Установите Node 22.13+ или 23.4+.'
  );
}

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'moneyforup.db');
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Включаем WAL-режим для высокой производительности и надежности
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Инициализация структуры таблиц
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  num_id INTEGER,
  name TEXT,
  username TEXT,
  tokens INTEGER DEFAULT 50,
  staked REAL DEFAULT 0,
  stake_since INTEGER DEFAULT 0,
  accrued_base REAL DEFAULT 0,
  ref_id INTEGER DEFAULT 0,
  ref_earned INTEGER DEFAULT 0,
  ref_invited INTEGER DEFAULT 0,
  terms_at INTEGER DEFAULT 0,
  total_deposited_rub INTEGER DEFAULT 0,
  last_deposit_rub INTEGER DEFAULT 0,
  last_deposit_id INTEGER DEFAULT 0,
  last_cashback_at INTEGER DEFAULT 0,
  cashback_claimed_dep_id INTEGER DEFAULT 0,
  easycash_claimed INTEGER DEFAULT 0,
  code TEXT UNIQUE,
  created_at INTEGER,
  rakeback REAL DEFAULT 0,
  free_cases INTEGER DEFAULT 0,
  free_case_5ref_claimed INTEGER DEFAULT 0,
  first_deposit_bonus_claimed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  type TEXT,
  user_id INTEGER,
  tokens INTEGER,
  rub INTEGER,
  bank TEXT,
  card TEXT,
  sender TEXT,
  method TEXT,
  details TEXT,
  status TEXT,
  source TEXT,
  tx TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  bonus TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS transactions_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount INTEGER,
  type TEXT,
  reason TEXT,
  reference_id TEXT,
  balance_before INTEGER,
  balance_after INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  tokens INTEGER,
  max_uses INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS promo_activations (
  promo_code TEXT,
  user_id INTEGER,
  activated_at INTEGER,
  PRIMARY KEY (promo_code, user_id)
);

CREATE TABLE IF NOT EXISTS game_rounds (
  round_id TEXT PRIMARY KEY,
  user_id INTEGER,
  game TEXT,
  bet_tokens INTEGER,
  mult REAL,
  win_tokens INTEGER,
  status TEXT,
  created_at INTEGER,
  settled_at INTEGER,
  -- выпавший предмет (кейсы): код и его цена на момент раунда
  item_code TEXT,
  item_price INTEGER
);

/* Инвентарь игрока — СЕРВЕРНЫЙ. Раньше предметы жили только в браузере
   (localStorage), и сервер не знал ни что у игрока есть, ни сколько это стоит.
   Значит продажу нельзя было ни проверить, ни начислить честно.
   sold_at = NULL — предмет ещё у игрока; иначе продан и повторно не продаётся. */
CREATE TABLE IF NOT EXISTS user_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_code TEXT NOT NULL,
  name TEXT,
  icon TEXT,
  price INTEGER NOT NULL,
  tier TEXT,
  case_id TEXT,
  case_name TEXT,
  round_id TEXT,
  acquired_at INTEGER,
  sold_at INTEGER,
  sold_for INTEGER,
  upgrade_only INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inv_user_unsold ON user_inventory(user_id, sold_at);

CREATE TABLE IF NOT EXISTS vault_safe (
  id INTEGER PRIMARY KEY,
  jackpot_tokens INTEGER DEFAULT 25000,
  secret_code TEXT DEFAULT '7429',
  guesses_count INTEGER DEFAULT 0,
  last_won_at INTEGER DEFAULT 0,
  last_winner_id INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS safe_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  bulls INTEGER NOT NULL,
  cows INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safe_attempts_user ON safe_attempts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pvp_duels (
  id TEXT PRIMARY KEY,
  creator_id INTEGER NOT NULL,
  opponent_id INTEGER,
  bet_tokens INTEGER NOT NULL,
  winner_id INTEGER,
  status TEXT DEFAULT 'open',
  roll_creator INTEGER,
  roll_opponent INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pvp_duels_status ON pvp_duels(status, created_at DESC);
`);

// Инициализируем сейф по умолчанию, если ещё не создан
try {
  const safeInit = db.prepare('SELECT id FROM vault_safe WHERE id = 1').get();
  if (!safeInit) {
    const initCode = String(Math.floor(1000 + Math.random() * 9000));
    db.prepare('INSERT INTO vault_safe (id, jackpot_tokens, secret_code, guesses_count) VALUES (1, 25000, ?, 0)').run(initCode);
  }
} catch (e) {
  console.warn('[DB] vault_safe init warning:', e.message);
}

/* Мягкая миграция: CREATE TABLE IF NOT EXISTS не добавит колонки в уже
   существующую таблицу, а база в проде живёт давно. Добавляем недостающие. */
function __ensureColumns(table, cols) {
  try {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [name, type] of cols) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        console.log(`[DB] Миграция: ${table}.${name} добавлена`);
      }
    }
  } catch (e) {
    console.error(`[DB] Миграция ${table}: ${e.message}`);
  }
}
__ensureColumns('users', [
  ['rakeback', 'REAL DEFAULT 0'],
  ['free_cases', 'INTEGER DEFAULT 0'],
  ['free_case_5ref_claimed', 'INTEGER DEFAULT 0'],
  ['first_deposit_bonus_claimed', 'INTEGER DEFAULT 0']
]);
__ensureColumns('orders', [
  ['bonus', "TEXT DEFAULT ''"]
]);
__ensureColumns('game_rounds', [['item_code', 'TEXT'], ['item_price', 'INTEGER']]);
__ensureColumns('user_inventory', [['upgrade_only', 'INTEGER DEFAULT 0']]);

// Подготовленные SQL-запросы для быстрого выполнения
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByCode: db.prepare('SELECT * FROM users WHERE code = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (id, num_id, name, username, tokens, staked, stake_since, accrued_base, ref_id, ref_earned, ref_invited, terms_at, total_deposited_rub, last_deposit_rub, last_deposit_id, last_cashback_at, cashback_claimed_dep_id, easycash_claimed, code, created_at, rakeback, free_cases, free_case_5ref_claimed, first_deposit_bonus_claimed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateUser: db.prepare(`
    UPDATE users SET
      num_id = ?, name = ?, username = ?, staked = ?, stake_since = ?, accrued_base = ?,
      ref_id = ?, ref_earned = ?, ref_invited = ?, terms_at = ?, total_deposited_rub = ?,
      last_deposit_rub = ?, last_deposit_id = ?, last_cashback_at = ?, cashback_claimed_dep_id = ?,
      easycash_claimed = ?, code = ?, rakeback = ?, free_cases = ?, free_case_5ref_claimed = ?,
      first_deposit_bonus_claimed = ?
    WHERE id = ?
  `),
  countInvited: db.prepare('SELECT COUNT(*) AS count FROM users WHERE ref_id = ?'),
  insertLedger: db.prepare(`
    INSERT INTO transactions_ledger (user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
  insertOrder: db.prepare(`
    INSERT INTO orders (id, type, user_id, tokens, rub, bank, card, sender, method, details, status, source, tx, created_at, updated_at, bonus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateOrderStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
  getAllOrders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100'),
  getPromo: db.prepare('SELECT * FROM promo_codes WHERE code = ?'),
  getPromoActivationsCount: db.prepare('SELECT COUNT(*) AS count FROM promo_activations WHERE promo_code = ?'),
  checkUserPromo: db.prepare('SELECT 1 FROM promo_activations WHERE promo_code = ? AND user_id = ?'),
  insertPromoActivation: db.prepare('INSERT INTO promo_activations (promo_code, user_id, activated_at) VALUES (?, ?, ?)'),
  upsertPromo: db.prepare(`
    INSERT INTO promo_codes (code, tokens, max_uses, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET tokens = excluded.tokens, max_uses = excluded.max_uses
  `),
  insertRound: db.prepare(`
    INSERT INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getRound: db.prepare('SELECT * FROM game_rounds WHERE round_id = ?'),
  userRoundsSince: db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(bet_tokens), 0) AS wagered, COALESCE(SUM(win_tokens), 0) AS won
    FROM game_rounds WHERE user_id = ? AND created_at >= ?
  `),
  insertInventoryItem: db.prepare(`
    INSERT INTO user_inventory
      (user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for, upgrade_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `),
  listInventory: db.prepare(`
    SELECT * FROM user_inventory WHERE user_id = ? AND sold_at IS NULL
    ORDER BY acquired_at DESC, id DESC LIMIT 200
  `),
  getInventoryItem: db.prepare('SELECT * FROM user_inventory WHERE id = ?'),
  markInventorySold: db.prepare(
    'UPDATE user_inventory SET sold_at = ?, sold_for = ? WHERE id = ? AND user_id = ? AND sold_at IS NULL'
  ),
  inventoryTotals: db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value
    FROM user_inventory WHERE user_id = ? AND sold_at IS NULL
  `)
};

// Предустановленные промокоды
stmts.upsertPromo.run('MONEYUP', 500, 100, Date.now());
stmts.upsertPromo.run('START', 250, 50, Date.now());
stmts.upsertPromo.run('SKUF', 300, 30, Date.now());
for (const [c, t, m] of [['MONEYUP', 500, 100], ['START', 250, 50], ['SKUF', 300, 30]]) {
  turso.queueQuery(
    'INSERT INTO promo_codes (code, tokens, max_uses, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET tokens=excluded.tokens, max_uses=excluded.max_uses',
    [c, t, m, Date.now()]
  );
}

function getUser(id) {
  const row = stmts.getUser.get(id);
  if (!row) return null;
  return {
    id: row.id,
    numId: row.num_id,
    name: row.name,
    username: row.username,
    tokens: row.tokens,
    staked: row.staked,
    stakeSince: row.stake_since,
    accruedBase: row.accrued_base,
    ref: row.ref_id,
    refEarned: row.ref_earned,
    refInvited: row.ref_invited,
    termsAt: row.terms_at,
    totalDepositedRub: row.total_deposited_rub,
    lastDeposit: row.last_deposit_rub,
    lastDepositId: row.last_deposit_id,
    lastCashbackAt: row.last_cashback_at,
    cashbackClaimedDepositId: row.cashback_claimed_dep_id,
    easycashClaimed: Boolean(row.easycash_claimed),
    code: row.code,
    rakeback: Number(row.rakeback || 0),
    freeCases: Number(row.free_cases || 0),
    freeCase5RefClaimed: Number(row.free_case_5ref_claimed || 0),
    firstDepositBonusClaimed: Number(row.first_deposit_bonus_claimed || 0)
  };
}

/* Баланс — единый источник истины в БД.
   Предупреждаем о рассинхроне один раз на игрока, чтобы не заспамить лог. */
const driftWarned = new Set();
function warnBalanceDrift(userId, memTokens, dbTokens) {
  if (driftWarned.has(userId)) return;
  driftWarned.add(userId);
  console.warn(
    `[Ledger] Рассинхрон баланса игрока ${userId}: в памяти ${memTokens} ⬦, в БД ${dbTokens} ⬦. ` +
    `Взят баланс из БД. Меняйте баланс только через atomicBalanceChange().`
  );
}

function saveUser(u) {
  const existing = stmts.getUser.get(u.id);
  if (existing) {
    // ЗАЩИТА ОТ ДВОЙНОГО ПРИМЕНЕНИЯ БАЛАНСА.
    // saveUser НЕ пишет tokens (этой колонки нет в UPDATE). Если память и БД разошлись —
    // это пропущенный вызов atomicBalanceChange(): берём баланс из БД и предупреждаем.
    if (Number(u.tokens) !== Number(existing.tokens)) {
      warnBalanceDrift(u.id, u.tokens, existing.tokens);
      u.tokens = existing.tokens;
    }
    stmts.updateUser.run(
      u.numId || 0,
      u.name || '',
      u.username || '',
      u.staked || 0,
      u.stakeSince || 0,
      u.accruedBase || 0,
      u.ref || 0,
      u.refEarned || 0,
      u.refInvited || 0,
      u.termsAt || 0,
      u.totalDepositedRub || 0,
      u.lastDeposit || 0,
      u.lastDepositId || 0,
      u.lastCashbackAt || 0,
      u.cashbackClaimedDepositId || 0,
      u.easycashClaimed ? 1 : 0,
      u.code || null,
      Number(u.rakeback || 0),
      Number(u.freeCases || 0),
      Number(u.freeCase5RefClaimed || 0),
      Number(u.firstDepositBonusClaimed || 0),
      u.id
    );
    turso.queueQuery(`
      UPDATE users SET
        num_id=?, name=?, username=?, staked=?, stake_since=?, accrued_base=?,
        ref_id=?, ref_earned=?, ref_invited=?, terms_at=?, total_deposited_rub=?,
        last_deposit_rub=?, last_deposit_id=?, last_cashback_at=?, cashback_claimed_dep_id=?,
        easycash_claimed=?, code=?, rakeback=?, free_cases=?, free_case_5ref_claimed=?,
        first_deposit_bonus_claimed=?
      WHERE id=?
    `, [
      u.numId || 0, u.name || '', u.username || '', u.staked || 0, u.stakeSince || 0, u.accruedBase || 0,
      u.ref || 0, u.refEarned || 0, u.refInvited || 0, u.termsAt || 0, u.totalDepositedRub || 0,
      u.lastDeposit || 0, u.lastDepositId || 0, u.lastCashbackAt || 0, u.cashbackClaimedDepositId || 0,
      u.easycashClaimed ? 1 : 0, u.code || null, Number(u.rakeback || 0), Number(u.freeCases || 0),
      Number(u.freeCase5RefClaimed || 0), Number(u.firstDepositBonusClaimed || 0), u.id
    ]);
  } else {
    stmts.insertUser.run(
      u.id,
      u.numId || 0,
      u.name || '',
      u.username || '',
      Math.floor(u.tokens || 50),
      u.staked || 0,
      u.stakeSince || 0,
      u.accruedBase || 0,
      u.ref || 0,
      u.refEarned || 0,
      u.refInvited || 0,
      u.termsAt || 0,
      u.totalDepositedRub || 0,
      u.lastDeposit || 0,
      u.lastDepositId || 0,
      u.lastCashbackAt || 0,
      u.cashbackClaimedDepositId || 0,
      u.easycashClaimed ? 1 : 0,
      u.code || null,
      Date.now(),
      Number(u.rakeback || 0),
      Number(u.freeCases || 0),
      Number(u.freeCase5RefClaimed || 0),
      Number(u.firstDepositBonusClaimed || 0)
    );
    turso.queueQuery(`
      INSERT INTO users (id, num_id, name, username, tokens, staked, stake_since, accrued_base, ref_id, ref_earned, ref_invited, terms_at, total_deposited_rub, last_deposit_rub, last_deposit_id, last_cashback_at, cashback_claimed_dep_id, easycash_claimed, code, created_at, rakeback, free_cases, free_case_5ref_claimed, first_deposit_bonus_claimed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, username=excluded.username, staked=excluded.staked
    `, [
      u.id, u.numId || 0, u.name || '', u.username || '', Math.floor(u.tokens || 50),
      u.staked || 0, u.stakeSince || 0, u.accruedBase || 0, u.ref || 0, u.refEarned || 0, u.refInvited || 0,
      u.termsAt || 0, u.totalDepositedRub || 0, u.lastDeposit || 0, u.lastDepositId || 0,
      u.lastCashbackAt || 0, u.cashbackClaimedDepositId || 0, u.easycashClaimed ? 1 : 0, u.code || null, Date.now(),
      Number(u.rakeback || 0), Number(u.freeCases || 0), Number(u.freeCase5RefClaimed || 0), Number(u.firstDepositBonusClaimed || 0)
    ]);
  }
}

/**
 * Атомарное изменение баланса с обязательной записью в Transactions Ledger
 */
function atomicBalanceChange(userId, deltaTokens, type, reason, referenceId = '') {
  db.exec('BEGIN TRANSACTION');
  try {
    const row = stmts.getUser.get(userId);
    if (!row) throw new Error('Пользователь не найден');

    const balanceBefore = row.tokens;
    const balanceAfter = balanceBefore + deltaTokens;

    if (balanceAfter < 0) {
      throw new Error(`Недостаточно средств: баланс ${balanceBefore} ⬦, списание ${Math.abs(deltaTokens)} ⬦`);
    }

    db.prepare('UPDATE users SET tokens = ? WHERE id = ?').run(balanceAfter, userId);
    const ledAt = Date.now();
    const ledRes = stmts.insertLedger.run(
      userId,
      deltaTokens,
      type,
      reason,
      String(referenceId),
      balanceBefore,
      balanceAfter,
      ledAt
    );

    db.exec('COMMIT');
    // В Turso — одной группой и с ЛОКАЛЬНЫМ id записи: повторная отправка и
    // обратный pull не плодят дубли ledger (раньше Turso присваивал свой id,
    // и INSERT OR IGNORE при pull не узнавал собственные записи).
    turso.queueBatch([
      { sql: 'UPDATE users SET tokens = ? WHERE id = ?', args: [balanceAfter, userId] },
      { sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [Number(ledRes.lastInsertRowid), userId, deltaTokens, type, reason, String(referenceId), balanceBefore, balanceAfter, ledAt] }
    ]);
    return { ok: true, balanceBefore, balanceAfter };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Атомарная активация промокода
 */
function atomicApplyPromo(userId, code) {
  const normCode = String(code || '').trim().toUpperCase();
  db.exec('BEGIN TRANSACTION');
  try {
    const promo = stmts.getPromo.get(normCode);
    if (!promo) {
      db.exec('ROLLBACK');
      return { ok: false, error: `Промокод «${normCode}» не существует` };
    }

    const alreadyUsed = stmts.checkUserPromo.get(normCode, userId);
    if (alreadyUsed) {
      db.exec('ROLLBACK');
      return { ok: false, error: `Вы уже активировали промокод «${normCode}»` };
    }

    const countRow = stmts.getPromoActivationsCount.get(normCode);
    const uses = countRow ? countRow.count : 0;
    if (uses >= promo.max_uses) {
      db.exec('ROLLBACK');
      return { ok: false, error: `Лимит активаций промокода «${normCode}» исчерпан (${promo.max_uses}/${promo.max_uses})` };
    }

    // Фиксируем активацию
    stmts.insertPromoActivation.run(normCode, userId, Date.now());

    // Начисляем баланс в ledger
    const row = stmts.getUser.get(userId);
    const balBefore = row ? row.tokens : 0;
    const balAfter = balBefore + promo.tokens;

    db.prepare('UPDATE users SET tokens = ? WHERE id = ?').run(balAfter, userId);
    const pNow = Date.now();
    const ledRes = stmts.insertLedger.run(
      userId,
      promo.tokens,
      'promo',
      `Промокод ${normCode}`,
      normCode,
      balBefore,
      balAfter,
      pNow
    );

    db.exec('COMMIT');
    turso.queueBatch([
      { sql: 'INSERT OR IGNORE INTO promo_activations (promo_code, user_id, activated_at) VALUES (?, ?, ?)', args: [normCode, userId, pNow] },
      { sql: 'UPDATE users SET tokens = ? WHERE id = ?', args: [balAfter, userId] },
      { sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [Number(ledRes.lastInsertRowid), userId, promo.tokens, 'promo', `Промокод ${normCode}`, normCode, balBefore, balAfter, pNow] }
    ]);
    return {
      ok: true,
      tokens: promo.tokens,
      newBalance: balAfter,
      code: normCode,
      remainingUses: promo.max_uses - (uses + 1),
      maxUses: promo.max_uses
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* Атомарное начисление бонуса за подписку: единожды на пользователя.
   Проверка флага, установка флага, изменение баланса и запись в ledger —
   одна транзакция. Память процесса (u.easycashClaimed) источником истины
   не является: она устаревает при рестартах, втором устройстве и pull из Turso. */
function atomicClaimChannel(userId, bonus) {
  const amt = Math.floor(Number(bonus) || 0);
  db.exec('BEGIN TRANSACTION');
  try {
    const row = stmts.getUser.get(userId);
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'Пользователь не найден' }; }
    if (row.easycash_claimed) { db.exec('ROLLBACK'); return { ok: false, already: true }; }
    const balBefore = row.tokens;
    const balAfter = balBefore + amt;
    const now = Date.now();
    db.prepare('UPDATE users SET easycash_claimed = 1, tokens = ? WHERE id = ?').run(balAfter, userId);
    const led = stmts.insertLedger.run(userId, amt, 'bonus_channel', 'Подписка на канал @moneyforup', '', balBefore, balAfter, now);
    db.exec('COMMIT');
    turso.queueBatch([
      { sql: 'UPDATE users SET tokens = ?, easycash_claimed = 1 WHERE id = ?', args: [balAfter, userId] },
      { sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [Number(led.lastInsertRowid), userId, amt, 'bonus_channel', 'Подписка на канал @moneyforup', '', balBefore, balAfter, now] }
    ]);
    return { ok: true, bonus: amt, newBalance: balAfter };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = {
  db,
  DB_PATH,
  getUser,
  saveUser,
  atomicBalanceChange,
  atomicApplyPromo,
  atomicClaimChannel,
  countInvited: (refId) => {
    const r = stmts.countInvited.get(refId);
    return r ? r.count : 0;
  },
  getUserByCode: (code) => stmts.getUserByCode.get(code),
  saveOrder: (ord) => {
    stmts.insertOrder.run(
      ord.id,
      ord.type || 'deposit',
      ord.userId,
      ord.tokens,
      ord.rub,
      ord.bank || null,
      ord.card || null,
      ord.sender || null,
      ord.method || null,
      ord.details || null,
      ord.status || 'pending',
      ord.source || null,
      ord.tx || null,
      ord.createdAt || Date.now(),
      Date.now(),
      ord.bonus || ''
    );
    turso.queueQuery(`
      INSERT INTO orders (id, type, user_id, tokens, rub, bank, card, sender, method, details, status, source, tx, created_at, updated_at, bonus)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
    `, [
      ord.id, ord.type || 'deposit', ord.userId, ord.tokens, ord.rub, ord.bank || null,
      ord.card || null, ord.sender || null, ord.method || null, ord.details || null,
      ord.status || 'pending', ord.source || null, ord.tx || null, ord.createdAt || Date.now(), Date.now(),
      ord.bonus || ''
    ]);
  },
  getOrder: (id) => stmts.getOrder.get(id),
  updateOrderStatus: (id, status) => {
    const now = Date.now();
    const res = stmts.updateOrderStatus.run(status, now, id);
    turso.queueQuery('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
    return res;
  },
  getAllOrders: () => stmts.getAllOrders.all(),

  /* ── Раунды игры ──────────────────────────────────────────────────────────
     Раунд пишется один раз, уже в финальном статусе: деньги меняет только
     atomicBalanceChange (в bot.js — внутри applyBalance), здесь только журнал.
     PRIMARY KEY round_id защищает от повторного применения одного раунда. */
  saveRound: (r) => {
    const cAt = r.createdAt || Date.now();
    const sAt = r.settledAt || Date.now();
    stmts.insertRound.run(
      String(r.roundId),
      r.userId,
      String(r.game),
      Math.floor(r.bet || 0),
      Number(r.mult || 1),
      Math.floor(r.win || 0),
      r.status || 'settled',
      cAt,
      sAt,
      r.itemCode || null,
      r.itemPrice != null ? Math.floor(r.itemPrice) : null
    );
    turso.queueQuery(`
      INSERT OR IGNORE INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      String(r.roundId), r.userId, String(r.game), Math.floor(r.bet || 0),
      Number(r.mult || 1), Math.floor(r.win || 0), r.status || 'settled', cAt, sAt,
      r.itemCode || null, r.itemPrice != null ? Math.floor(r.itemPrice) : null
    ]);
    return { ok: true, roundId: String(r.roundId) };
  },
  getRound: (roundId) => stmts.getRound.get(String(roundId)),

  /* ── Инвентарь ──────────────────────────────────────────────────────────
     Цена и название берутся из СЕРВЕРНОГО каталога items.js, а не из запроса
     клиента: иначе игрок пришлёт price: 999999 и продаст вентилятор за миллион. */
  addInventoryItem: (r) => {
    const acAt = r.acquiredAt || Date.now();
    const upgOnly = (r.upgradeOnly || r.upgrade_only) ? 1 : 0;
    const res = stmts.insertInventoryItem.run(
      r.userId,
      String(r.itemCode),
      String(r.name || ''),
      String(r.icon || ''),
      Math.floor(r.price || 0),
      String(r.tier || ''),
      String(r.caseId || ''),
      String(r.caseName || ''),
      String(r.roundId || ''),
      acAt,
      upgOnly
    );
    const newId = Number(res.lastInsertRowid);
    turso.queueQuery(`
      INSERT OR IGNORE INTO user_inventory (id, user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for, upgrade_only)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `, [
      newId, r.userId, String(r.itemCode), String(r.name || ''), String(r.icon || ''),
      Math.floor(r.price || 0), String(r.tier || ''), String(r.caseId || ''),
      String(r.caseName || ''), String(r.roundId || ''), acAt, upgOnly
    ]);
    return { ok: true, id: newId };
  },
  getQualifiedFriendsCount: (userId) => {
    try {
      const row = db.prepare(`
        SELECT COUNT(DISTINCT u.id) AS count
        FROM users u
        WHERE u.ref_id = ?
          AND (
            (SELECT COUNT(*) FROM game_rounds gr WHERE gr.user_id = u.id) >= 1
            OR u.total_deposited_rub > 0
            OR (SELECT COUNT(*) FROM user_inventory inv WHERE inv.user_id = u.id) >= 1
            OR u.free_cases > 0
          )
      `).get(Number(userId));
      return row ? Number(row.count || 0) : 0;
    } catch (e) {
      console.error('[DB] getQualifiedFriendsCount error:', e.message);
      return 0;
    }
  },
  listInventory: (userId) => stmts.listInventory.all(userId),
  getInventoryItem: (id) => stmts.getInventoryItem.get(id),
  /** Помечает предмет проданным. false — уже был продан или не его (защита от гонки). */
  markInventorySold: (id, userId, tokens, at) => {
    const soldAt = at || Date.now();
    const soldTokens = Math.floor(tokens || 0);
    const res = stmts.markInventorySold.run(soldAt, soldTokens, id, userId);
    if (res.changes === 1) {
      turso.queueQuery(
        'UPDATE user_inventory SET sold_at = ?, sold_for = ? WHERE id = ? AND user_id = ? AND sold_at IS NULL',
        [soldAt, soldTokens, id, userId]
      );
      return true;
    }
    return false;
  },
  inventoryTotals: (userId) => {
    const r = stmts.inventoryTotals.get(userId);
    return r || { count: 0, value: 0 };
  },
  /** Ставки и выигрыши игрока за период — для лимитов и детекта аномалий */
  userRoundsSince: (userId, sinceMs) => {
    const r = stmts.userRoundsSince.get(userId, sinceMs);
    return r || { count: 0, wagered: 0, won: 0 };
  },
  upsertPromo: (code, tokens, maxUses) => {
    const r = stmts.upsertPromo.run(String(code).toUpperCase(), Math.floor(tokens || 0), Math.floor(maxUses || 0), Date.now());
    turso.queueQuery(
      'INSERT INTO promo_codes (code, tokens, max_uses, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET tokens=excluded.tokens, max_uses=excluded.max_uses',
      [String(code).toUpperCase(), Math.floor(tokens || 0), Math.floor(maxUses || 0), Date.now()]
    );
    return r;
  },
  /** Полная аналитика по раундам конкретного пользователя */
  getUserRoundStats: (userId) => {
    try {
      const summary = db.prepare(`
        SELECT COUNT(*) AS totalRounds,
               COALESCE(SUM(CASE WHEN win_tokens > bet_tokens THEN 1 ELSE 0 END), 0) AS wonRounds,
               COALESCE(SUM(CASE WHEN win_tokens <= bet_tokens THEN 1 ELSE 0 END), 0) AS lostRounds,
               COALESCE(SUM(bet_tokens), 0) AS totalWageredTk,
               COALESCE(SUM(win_tokens), 0) AS totalPayoutTk,
               COALESCE(MAX(win_tokens), 0) AS maxWinTk
        FROM game_rounds WHERE user_id = ?
      `).get(userId);

      const byGame = db.prepare(`
        SELECT game,
               COUNT(*) AS rounds,
               COALESCE(SUM(CASE WHEN win_tokens > bet_tokens THEN 1 ELSE 0 END), 0) AS won,
               COALESCE(SUM(bet_tokens), 0) AS wageredTk,
               COALESCE(SUM(win_tokens), 0) AS payoutTk,
               COALESCE(MAX(win_tokens), 0) AS maxWin
        FROM game_rounds WHERE user_id = ? GROUP BY game ORDER BY rounds DESC
      `).all(userId);

      return { summary: summary || {}, byGame: byGame || [] };
    } catch (e) {
      return { summary: {}, byGame: [] };
    }
  },
  /** Расширенная админ-аналитика по реальным данным проекта */
  getAdminMetrics: (period = 'all') => {
    let since = 0;
    const now = Date.now();
    if (period === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      since = d.getTime();
    } else if (period === '7d') {
      since = now - 7 * 86400 * 1000;
    } else if (period === '30d') {
      since = now - 30 * 86400 * 1000;
    }

    try {
      // 1. Депозиты (подтвержденные)
      const depStats = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(rub), 0) AS totalRub,
               COALESCE(SUM(tokens), 0) AS totalTokens
        FROM orders
        WHERE type = 'deposit' AND status = 'paid' AND created_at >= ?
      `).get(since) || { count: 0, totalRub: 0, totalTokens: 0 };

      // 1.1 Бонус +25% на первый депозит
      const bonus25Orders = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(CASE WHEN tokens > (rub * 10) THEN (tokens - (rub * 10)) ELSE (rub * 2.5) END), 0) AS bonusTokens,
               COALESCE(SUM(rub), 0) AS bonusRub
        FROM orders
        WHERE type = 'deposit' AND status = 'paid' AND bonus = '25' AND created_at >= ?
      `).get(since) || { count: 0, bonusTokens: 0, bonusRub: 0 };

      // 2. Выводы (подтвержденные и ожидающие)
      const wdPaid = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(rub), 0) AS totalRub,
               COALESCE(SUM(tokens), 0) AS totalTokens
        FROM orders
        WHERE type = 'withdraw' AND status = 'paid' AND created_at >= ?
      `).get(since) || { count: 0, totalRub: 0, totalTokens: 0 };

      const wdPending = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(rub), 0) AS totalRub,
               COALESCE(SUM(tokens), 0) AS totalTokens
        FROM orders
        WHERE type = 'withdraw' AND status = 'pending'
      `).get() || { count: 0, totalRub: 0, totalTokens: 0 };

      // 3. Пользователи и конверсия
      const newUsersCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE created_at >= ?
      `).get(since) || {}).count || 0;

      const totalUsersCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM users
      `).get() || {}).count || 0;

      const payingUsersCount = (db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS count
        FROM orders
        WHERE type = 'deposit' AND status = 'paid' AND created_at >= ?
      `).get(since) || {}).count || 0;

      const totalPayingUsersCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE total_deposited_rub > 0
      `).get() || {}).count || 0;

      const firstBonusUsersCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE first_deposit_bonus_claimed = 1
      `).get() || {}).count || 0;

      // 4. Игровые раунды (RTP, GGR, оборот)
      const roundsSummary = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(bet_tokens), 0) AS wagered,
               COALESCE(SUM(win_tokens), 0) AS payouts
        FROM game_rounds
        WHERE created_at >= ?
      `).get(since) || { count: 0, wagered: 0, payouts: 0 };

      const wagered = Number(roundsSummary.wagered || 0);
      const payouts = Number(roundsSummary.payouts || 0);
      const grossGamingRevenueTk = wagered - payouts;
      const grossGamingRevenueRub = grossGamingRevenueTk / 10;
      const rtpPct = wagered > 0 ? Number(((payouts / wagered) * 100).toFixed(1)) : 0;

      // 5. По режимам игры
      const byGame = db.prepare(`
        SELECT game,
               COUNT(*) AS rounds,
               COALESCE(SUM(bet_tokens), 0) AS wageredTk,
               COALESCE(SUM(win_tokens), 0) AS payoutTk,
               COALESCE(SUM(CASE WHEN win_tokens > bet_tokens THEN 1 ELSE 0 END), 0) AS wins,
               COALESCE(SUM(CASE WHEN win_tokens <= bet_tokens THEN 1 ELSE 0 END), 0) AS losses
        FROM game_rounds
        WHERE created_at >= ?
        GROUP BY game
        ORDER BY wageredTk DESC
      `).all(since).map(g => {
        const wag = Number(g.wageredTk || 0);
        const pay = Number(g.payoutTk || 0);
        const netTk = wag - pay;
        return {
          game: g.game,
          rounds: g.rounds,
          wageredTk: wag,
          payoutTk: pay,
          netTk,
          netRub: netTk / 10,
          rtpPct: wag > 0 ? Number(((pay / wag) * 100).toFixed(1)) : 0,
          wins: g.wins,
          losses: g.losses
        };
      });

      // 6. Последние 25 операций ledger
      const recentLedger = db.prepare(`
        SELECT l.id, l.user_id, l.amount, l.type, l.reason, l.balance_before, l.balance_after, l.created_at,
               u.username, u.name
        FROM transactions_ledger l
        LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.id DESC
        LIMIT 25
      `).all().map(row => ({
        id: row.id,
        userId: row.user_id,
        userLabel: row.username ? '@' + row.username : (row.name || 'ID ' + row.user_id),
        amount: row.amount,
        type: row.type,
        reason: row.reason,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
        createdAt: row.created_at
      }));

      // 7. По провайдерам пополнений
      const byProvider = db.prepare(`
        SELECT COALESCE(source, bank, method, 'СБП') AS provider,
               COUNT(*) AS count,
               COALESCE(SUM(rub), 0) AS totalRub
        FROM orders
        WHERE type = 'deposit' AND status = 'paid' AND created_at >= ?
        GROUP BY provider
        ORDER BY totalRub DESC
      `).all(since);

      return {
        ok: true,
        period,
        since,
        summary: {
          totalUsers: totalUsersCount,
          newUsers: newUsersCount,
          totalDepositors: totalPayingUsersCount,
          periodDepositors: payingUsersCount,
          depositsCount: depStats.count,
          depositsRub: depStats.totalRub,
          depositsTokens: depStats.totalTokens,
          firstBonusClaimedUsers: firstBonusUsersCount,
          firstBonusOrdersCount: bonus25Orders.count,
          firstBonusTokens: bonus25Orders.bonusTokens,
          firstBonusRubVolume: bonus25Orders.bonusRub,
          withdrawalsPaidCount: wdPaid.count,
          withdrawalsPaidRub: wdPaid.totalRub,
          withdrawalsPendingCount: wdPending.count,
          withdrawalsPendingRub: wdPending.totalRub,
          roundsCount: roundsSummary.count,
          wageredTk: wagered,
          payoutsTk: payouts,
          ggrTk: grossGamingRevenueTk,
          ggrRub: grossGamingRevenueRub,
          rtpPct,
          cashflowNetRub: depStats.totalRub - wdPaid.totalRub
        },
        byGame,
        byProvider,
        recentLedger
      };
    } catch (e) {
      console.error('[DB] getAdminMetrics error:', e.message);
      return { ok: false, error: e.message };
    }
  },
  // ── Взлом Сейфа (Crack the Safe) ──
  getSafeData: (userId) => {
    try {
      const safe = db.prepare('SELECT jackpot_tokens, guesses_count, last_won_at, last_winner_id FROM vault_safe WHERE id = 1').get() || {
        jackpot_tokens: 25000, guesses_count: 0
      };
      const recentAttempts = db.prepare(`
        SELECT code, bulls, cows, created_at
        FROM safe_attempts
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 6
      `).all(userId);
      return {
        jackpot: safe.jackpot_tokens,
        guessesCount: safe.guesses_count,
        recentAttempts
      };
    } catch (e) {
      console.error('[DB] getSafeData error:', e.message);
      return { jackpot: 25000, guessesCount: 0, recentAttempts: [] };
    }
  },

  attemptSafeGuess: (userId, guessCode) => {
    try {
      const safe = db.prepare('SELECT secret_code, jackpot_tokens, guesses_count FROM vault_safe WHERE id = 1').get();
      if (!safe) return { ok: false, error: 'Сейф недоступен' };
      const secret = String(safe.secret_code);
      const guess = String(guessCode);

      let bulls = 0; // точное совпадение
      let cows = 0;  // есть в числе, но на другой позиции
      const secretUsed = [false, false, false, false];
      const guessUsed = [false, false, false, false];

      for (let i = 0; i < 4; i++) {
        if (guess[i] === secret[i]) {
          bulls++;
          secretUsed[i] = true;
          guessUsed[i] = true;
        }
      }
      for (let i = 0; i < 4; i++) {
        if (!guessUsed[i]) {
          for (let j = 0; j < 4; j++) {
            if (!secretUsed[j] && guess[i] === secret[j]) {
              cows++;
              secretUsed[j] = true;
              break;
            }
          }
        }
      }

      const won = (bulls === 4);
      const now = Date.now();
      db.prepare(`
        INSERT INTO safe_attempts (user_id, code, bulls, cows, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, guess, bulls, cows, now);

      let winTokens = 0;
      if (won) {
        winTokens = safe.jackpot_tokens;
        const newCode = String(Math.floor(1000 + Math.random() * 9000));
        db.prepare(`
          UPDATE vault_safe
          SET jackpot_tokens = 10000, secret_code = ?, guesses_count = 0, last_won_at = ?, last_winner_id = ?
          WHERE id = 1
        `).run(newCode, now, userId);
      } else {
        db.prepare(`
          UPDATE vault_safe
          SET jackpot_tokens = jackpot_tokens + 15, guesses_count = guesses_count + 1
          WHERE id = 1
        `).run();
      }

      const updatedSafe = db.prepare('SELECT jackpot_tokens, guesses_count FROM vault_safe WHERE id = 1').get();
      return {
        ok: true,
        won,
        bulls,
        cows,
        winTokens,
        jackpot: updatedSafe.jackpot_tokens,
        guessesCount: updatedSafe.guesses_count
      };
    } catch (e) {
      console.error('[DB] attemptSafeGuess error:', e.message);
      return { ok: false, error: e.message };
    }
  },

  // ── PvP Дуэли (Skin & Coin Flip 1v1) ──
  getActiveDuels: () => {
    try {
      return db.prepare(`
        SELECT d.id, d.creator_id, d.bet_tokens, d.created_at, u.name as creator_name, u.username as creator_username
        FROM pvp_duels d
        LEFT JOIN users u ON u.id = d.creator_id
        WHERE d.status = 'open'
        ORDER BY d.created_at DESC
        LIMIT 15
      `).all();
    } catch (e) {
      console.error('[DB] getActiveDuels error:', e.message);
      return [];
    }
  },

  createDuel: (duelId, creatorId, betTokens) => {
    try {
      db.prepare(`
        INSERT INTO pvp_duels (id, creator_id, bet_tokens, status, created_at)
        VALUES (?, ?, ?, 'open', ?)
      `).run(duelId, creatorId, betTokens, Date.now());
      return { ok: true };
    } catch (e) {
      console.error('[DB] createDuel error:', e.message);
      return { ok: false, error: e.message };
    }
  },

  getDuel: (duelId) => {
    try {
      return db.prepare(`
        SELECT d.*, u.name as creator_name, u.username as creator_username
        FROM pvp_duels d
        LEFT JOIN users u ON u.id = d.creator_id
        WHERE d.id = ?
      `).get(duelId);
    } catch (e) {
      return null;
    }
  },

  settleDuel: (duelId, opponentId, winnerId, rollCreator, rollOpponent) => {
    try {
      db.prepare(`
        UPDATE pvp_duels
        SET opponent_id = ?, winner_id = ?, status = 'settled',
            roll_creator = ?, roll_opponent = ?, settled_at = ?
        WHERE id = ? AND status = 'open'
      `).run(opponentId, winnerId, rollCreator, rollOpponent, Date.now(), duelId);
      return { ok: true };
    } catch (e) {
      console.error('[DB] settleDuel error:', e.message);
      return { ok: false, error: e.message };
    }
  },

  cancelDuel: (duelId, creatorId) => {
    try {
      const res = db.prepare(`
        UPDATE pvp_duels
        SET status = 'canceled', settled_at = ?
        WHERE id = ? AND creator_id = ? AND status = 'open'
      `).run(Date.now(), duelId, creatorId);
      return { ok: res.changes > 0 };
    } catch (e) {
      console.error('[DB] cancelDuel error:', e.message);
      return { ok: false, error: e.message };
    }
  },
  pullFromTurso: () => turso.pullFromTurso(db),
  waitForTurso: (timeoutMs) => turso.waitForFlush(timeoutMs),
  tursoOn: turso.tursoOn
};
