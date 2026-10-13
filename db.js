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
  created_at INTEGER
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
  updated_at INTEGER
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
  sold_for INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inv_user_unsold ON user_inventory(user_id, sold_at);
`);

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
__ensureColumns('game_rounds', [['item_code', 'TEXT'], ['item_price', 'INTEGER']]);

// Подготовленные SQL-запросы для быстрого выполнения
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByCode: db.prepare('SELECT * FROM users WHERE code = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (id, num_id, name, username, tokens, staked, stake_since, accrued_base, ref_id, ref_earned, ref_invited, terms_at, total_deposited_rub, last_deposit_rub, last_deposit_id, last_cashback_at, cashback_claimed_dep_id, easycash_claimed, code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateUser: db.prepare(`
    UPDATE users SET
      num_id = ?, name = ?, username = ?, staked = ?, stake_since = ?, accrued_base = ?,
      ref_id = ?, ref_earned = ?, ref_invited = ?, terms_at = ?, total_deposited_rub = ?,
      last_deposit_rub = ?, last_deposit_id = ?, last_cashback_at = ?, cashback_claimed_dep_id = ?,
      easycash_claimed = ?, code = ?
    WHERE id = ?
  `),
  countInvited: db.prepare('SELECT COUNT(*) AS count FROM users WHERE ref_id = ?'),
  insertLedger: db.prepare(`
    INSERT INTO transactions_ledger (user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
  insertOrder: db.prepare(`
    INSERT INTO orders (id, type, user_id, tokens, rub, bank, card, sender, method, details, status, source, tx, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      (user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
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
    code: row.code
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
      u.id
    );
    turso.queueQuery(`
      UPDATE users SET
        num_id=?, name=?, username=?, staked=?, stake_since=?, accrued_base=?,
        ref_id=?, ref_earned=?, ref_invited=?, terms_at=?, total_deposited_rub=?,
        last_deposit_rub=?, last_deposit_id=?, last_cashback_at=?, cashback_claimed_dep_id=?,
        easycash_claimed=?, code=?
      WHERE id=?
    `, [
      u.numId || 0, u.name || '', u.username || '', u.staked || 0, u.stakeSince || 0, u.accruedBase || 0,
      u.ref || 0, u.refEarned || 0, u.refInvited || 0, u.termsAt || 0, u.totalDepositedRub || 0,
      u.lastDeposit || 0, u.lastDepositId || 0, u.lastCashbackAt || 0, u.cashbackClaimedDepositId || 0,
      u.easycashClaimed ? 1 : 0, u.code || null, u.id
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
      Date.now()
    );
    turso.queueQuery(`
      INSERT INTO users (id, num_id, name, username, tokens, staked, stake_since, accrued_base, ref_id, ref_earned, ref_invited, terms_at, total_deposited_rub, last_deposit_rub, last_deposit_id, last_cashback_at, cashback_claimed_dep_id, easycash_claimed, code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, username=excluded.username, staked=excluded.staked
    `, [
      u.id, u.numId || 0, u.name || '', u.username || '', Math.floor(u.tokens || 50),
      u.staked || 0, u.stakeSince || 0, u.accruedBase || 0, u.ref || 0, u.refEarned || 0, u.refInvited || 0,
      u.termsAt || 0, u.totalDepositedRub || 0, u.lastDeposit || 0, u.lastDepositId || 0,
      u.lastCashbackAt || 0, u.cashbackClaimedDepositId || 0, u.easycashClaimed ? 1 : 0, u.code || null, Date.now()
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

module.exports = {
  db,
  DB_PATH,
  getUser,
  saveUser,
  atomicBalanceChange,
  atomicApplyPromo,
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
      Date.now()
    );
    turso.queueQuery(`
      INSERT INTO orders (id, type, user_id, tokens, rub, bank, card, sender, method, details, status, source, tx, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
    `, [
      ord.id, ord.type || 'deposit', ord.userId, ord.tokens, ord.rub, ord.bank || null,
      ord.card || null, ord.sender || null, ord.method || null, ord.details || null,
      ord.status || 'pending', ord.source || null, ord.tx || null, ord.createdAt || Date.now(), Date.now()
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
      acAt
    );
    const newId = Number(res.lastInsertRowid);
    turso.queueQuery(`
      INSERT OR IGNORE INTO user_inventory (id, user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `, [
      newId, r.userId, String(r.itemCode), String(r.name || ''), String(r.icon || ''),
      Math.floor(r.price || 0), String(r.tier || ''), String(r.caseId || ''),
      String(r.caseName || ''), String(r.roundId || ''), acAt
    ]);
    return { ok: true, id: newId };
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
  pullFromTurso: () => turso.pullFromTurso(db),
  waitForTurso: (timeoutMs) => turso.waitForFlush(timeoutMs),
  tursoOn: turso.tursoOn
};
