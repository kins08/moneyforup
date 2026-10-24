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
const crypto = require('crypto');
const turso = require('./turso');

const TOKENS_PER_RUB = 10;
const rub = tk => (Number(tk) / TOKENS_PER_RUB)
  .toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';

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

// Инициализация структуры таблиц. Схема лежит в schema.js и общая с Turso.
const { SCHEMA_SQL, EXTRA_COLUMNS } = require('./schema');
db.exec(SCHEMA_SQL);

// Инициализируем сейф по умолчанию, если ещё не создан
try {
  const safeInit = db.prepare('SELECT id FROM vault_safe WHERE id = 1').get();
  if (!safeInit) {
    const initCode = String(1000 + crypto.randomInt(0, 9000));
    db.prepare('INSERT INTO vault_safe (id, jackpot_tokens, secret_code, guesses_count) VALUES (1, 0, ?, 0)').run(initCode);
  }
} catch (e) {
  console.warn('[DB] vault_safe init warning:', e.message);
}

/* Обнуляем «бесплатный» сид джекпота сейфа (был 25 000 при создании / 10 000 после
   выигрыша). Он не заработан игроками, а скрипт-солвер вскрывает код за ~8 попыток
   (bulls/cows) и забирает весь пул. Теперь пул — честный прогрессивный: растёт только
   с промахов (+15 за попытку) и обнуляется при выигрыше. */
try {
  db.prepare('UPDATE vault_safe SET jackpot_tokens = 0 WHERE id = 1 AND jackpot_tokens IN (25000, 10000)').run();
} catch (e) {
  console.warn('[DB] vault_safe seed reset warning:', e.message);
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
__ensureColumns('users', EXTRA_COLUMNS.users);
__ensureColumns('orders', EXTRA_COLUMNS.orders);
__ensureColumns('game_rounds', EXTRA_COLUMNS.game_rounds);
__ensureColumns('user_inventory', EXTRA_COLUMNS.user_inventory);

// Подготовленные SQL-запросы для быстрого выполнения
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByCode: db.prepare('SELECT * FROM users WHERE code = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (id, num_id, name, username, tokens, staked, stake_since, accrued_base, ref_id, ref_earned, ref_invited, terms_at, total_deposited_rub, last_deposit_rub, last_deposit_id, last_cashback_at, cashback_claimed_dep_id, easycash_claimed, code, created_at, rakeback, free_cases, free_case_5ref_claimed, first_deposit_bonus_claimed, last_hot_drop, last_wheel_spin, last_streak_at, free_daily_at, free_case_3ref_claimed, free_notified_at, free_notify_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateUser: db.prepare(`
    UPDATE users SET
      num_id = ?, name = ?, username = ?, staked = ?, stake_since = ?, accrued_base = ?,
      ref_id = ?, ref_earned = ?, ref_invited = ?, terms_at = ?, total_deposited_rub = ?,
      last_deposit_rub = ?, last_deposit_id = ?, last_cashback_at = ?, cashback_claimed_dep_id = ?,
      easycash_claimed = ?, code = ?, rakeback = ?, free_cases = ?, free_case_5ref_claimed = ?,
      first_deposit_bonus_claimed = ?, last_hot_drop = ?, last_wheel_spin = ?, last_streak_at = ?,
      free_daily_at = ?, free_case_3ref_claimed = ?, free_notified_at = ?, free_notify_day = ?
    WHERE id = ?
  `),
  countInvited: db.prepare('SELECT COUNT(*) AS count FROM users WHERE ref_id = ?'),
  insertLedger: db.prepare(`
    INSERT INTO transactions_ledger (user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
  insertOrder: db.prepare(`
    INSERT INTO orders (id, type, user_id, tokens, rub, bank, card, sender, method, details, status, source, tx, created_at, updated_at, bonus, expires_at, admin_msg_id, admin_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, updated_at = excluded.updated_at,
      expires_at = excluded.expires_at, admin_msg_id = excluded.admin_msg_id,
      admin_chat_id = excluded.admin_chat_id
  `),
  updateOrderStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
  setOrderMessage: db.prepare('UPDATE orders SET admin_msg_id = ?, admin_chat_id = ?, updated_at = ? WHERE id = ?'),
  listUserOrders: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
  listPendingManualDeposits: db.prepare(`
    SELECT * FROM orders
    WHERE type = 'deposit' AND status = 'pending'
      AND (source = 'СБП / Карта' OR COALESCE(expires_at, 0) > 0)
  `),
  getAllOrders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500'),
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
      (user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for, upgrade_only, collectible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
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
  `),
  insertChallengeClaim: db.prepare(
    'INSERT OR IGNORE INTO challenge_claims (user_id, quest_id, claim_date, created_at) VALUES (?, ?, ?, ?)'
  ),
  bumpDepositCount: db.prepare('UPDATE users SET deposit_count = deposit_count + 1 WHERE id = ?'),
  setDepositCount: db.prepare('UPDATE users SET deposit_count = ? WHERE id = ?'),
  touchUserSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
  setReactivationAt: db.prepare('UPDATE users SET last_reactivation_at = ? WHERE id = ?'),
  getPlayerBoost: db.prepare('SELECT luck FROM player_boosts WHERE user_id = ?'),
  setPlayerBoost: db.prepare(`
    INSERT INTO player_boosts (user_id, luck, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET luck = excluded.luck, updated_at = excluded.updated_at
  `),
  deletePlayerBoost: db.prepare('DELETE FROM player_boosts WHERE user_id = ?'),
  listPlayerBoosts: db.prepare(`
    SELECT b.user_id, b.luck, b.updated_at, u.num_id, u.name, u.username, u.tokens
    FROM player_boosts b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.luck > 0
    ORDER BY b.updated_at DESC
    LIMIT ?
  `),
  searchUsersForAdmin: db.prepare(`
    SELECT id, num_id, name, username, tokens
    FROM users
    WHERE CAST(id AS TEXT) = ? OR CAST(num_id AS TEXT) = ? OR lower(username) = lower(?)
       OR lower(name) LIKE lower(?) ESCAPE '\\'
    ORDER BY id DESC
    LIMIT ?
  `),
  listRecentLedger: db.prepare(`
    SELECT l.id, l.user_id, l.amount, l.type, l.reason, l.balance_after, l.created_at,
           u.num_id, u.name, u.username
    FROM transactions_ledger l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.id DESC
    LIMIT ?
  `),
  listRecentRounds: db.prepare(`
    SELECT r.round_id, r.user_id, r.game, r.bet_tokens, r.mult, r.win_tokens,
           r.status, r.created_at, r.settled_at,
           u.num_id, u.name, u.username
    FROM game_rounds r
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY r.created_at DESC
    LIMIT ?
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
    firstDepositBonusClaimed: Number(row.first_deposit_bonus_claimed || 0),
    depositCount: Number(row.deposit_count || 0),
    lastSeenAt: Number(row.last_seen_at || 0),
    lastReactivationAt: Number(row.last_reactivation_at || 0),
    lastHotDrop: Number(row.last_hot_drop || 0),
    lastWheelSpin: Number(row.last_wheel_spin || 0),
    lastStreakAt: Number(row.last_streak_at || 0),
    freeDailyAt: Number(row.free_daily_at || 0),
    freeCase3RefClaimed: Number(row.free_case_3ref_claimed || 0),
    freeNotifiedAt: Number(row.free_notified_at || 0),
    freeNotifyDay: row.free_notify_day || ''
  };
}

/* Баланс — единый источник истины в БД.
   Предупреждаем о рассинхроне один раз на игрока, чтобы не заспамить лог. */
const driftWarned = new Set();
function warnBalanceDrift(userId, memTokens, dbTokens) {
  if (driftWarned.has(userId)) return;
  driftWarned.add(userId);
  console.warn(
    `[Ledger] Рассинхрон баланса игрока ${userId}: в памяти ${rub(memTokens)}, в БД ${rub(dbTokens)}. ` +
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
      Number(u.lastHotDrop || 0),
      Number(u.lastWheelSpin || 0),
      Number(u.lastStreakAt || 0),
      Number(u.freeDailyAt || 0),
      Number(u.freeCase3RefClaimed || 0),
      Number(u.freeNotifiedAt || 0),
      String(u.freeNotifyDay || ''),
      u.id
    );
    turso.queueQuery(`
      UPDATE users SET
        num_id=?, name=?, username=?, staked=?, stake_since=?, accrued_base=?,
        ref_id=?, ref_earned=?, ref_invited=?, terms_at=?, total_deposited_rub=?,
        last_deposit_rub=?, last_deposit_id=?, last_cashback_at=?, cashback_claimed_dep_id=?,
        easycash_claimed=?, code=?, rakeback=?, free_cases=?, free_case_5ref_claimed=?,
        first_deposit_bonus_claimed=?, last_hot_drop=?, last_wheel_spin=?, last_streak_at=?,
        free_daily_at=?, free_case_3ref_claimed=?, free_notified_at=?, free_notify_day=?
      WHERE id=?
    `, [
      u.numId || 0, u.name || '', u.username || '', u.staked || 0, u.stakeSince || 0, u.accruedBase || 0,
      u.ref || 0, u.refEarned || 0, u.refInvited || 0, u.termsAt || 0, u.totalDepositedRub || 0,
      u.lastDeposit || 0, u.lastDepositId || 0, u.lastCashbackAt || 0, u.cashbackClaimedDepositId || 0,
      u.easycashClaimed ? 1 : 0, u.code || null, Number(u.rakeback || 0), Number(u.freeCases || 0),
      Number(u.freeCase5RefClaimed || 0), Number(u.firstDepositBonusClaimed || 0),
      Number(u.lastHotDrop || 0), Number(u.lastWheelSpin || 0), Number(u.lastStreakAt || 0),
      Number(u.freeDailyAt || 0), Number(u.freeCase3RefClaimed || 0), Number(u.freeNotifiedAt || 0),
      String(u.freeNotifyDay || ''), u.id
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
      Number(u.firstDepositBonusClaimed || 0),
      Number(u.lastHotDrop || 0),
      Number(u.lastWheelSpin || 0),
      Number(u.lastStreakAt || 0),
      Number(u.freeDailyAt || 0),
      Number(u.freeCase3RefClaimed || 0),
      Number(u.freeNotifiedAt || 0),
      String(u.freeNotifyDay || '')
    );
    turso.queueQuery(`
      INSERT INTO users (id, num_id, name, username, tokens, staked, stake_since, accrued_base, ref_id, ref_earned, ref_invited, terms_at, total_deposited_rub, last_deposit_rub, last_deposit_id, last_cashback_at, cashback_claimed_dep_id, easycash_claimed, code, created_at, rakeback, free_cases, free_case_5ref_claimed, first_deposit_bonus_claimed, last_hot_drop, last_wheel_spin, last_streak_at, free_daily_at, free_case_3ref_claimed, free_notified_at, free_notify_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, username=excluded.username, staked=excluded.staked
    `, [
      u.id, u.numId || 0, u.name || '', u.username || '', Math.floor(u.tokens || 50),
      u.staked || 0, u.stakeSince || 0, u.accruedBase || 0, u.ref || 0, u.refEarned || 0, u.refInvited || 0,
      u.termsAt || 0, u.totalDepositedRub || 0, u.lastDeposit || 0, u.lastDepositId || 0,
      u.lastCashbackAt || 0, u.cashbackClaimedDepositId || 0, u.easycashClaimed ? 1 : 0, u.code || null, Date.now(),
      Number(u.rakeback || 0), Number(u.freeCases || 0), Number(u.freeCase5RefClaimed || 0), Number(u.firstDepositBonusClaimed || 0),
      Number(u.lastHotDrop || 0), Number(u.lastWheelSpin || 0), Number(u.lastStreakAt || 0),
      Number(u.freeDailyAt || 0), Number(u.freeCase3RefClaimed || 0), Number(u.freeNotifiedAt || 0), String(u.freeNotifyDay || '')
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
      throw new Error(`Недостаточно средств: баланс ${rub(balanceBefore)}, списание ${rub(Math.abs(deltaTokens))}`);
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

/* ══════════════════════════════════════════════════════════════════════════
   НОВЫЕ РЕЖИМЫ: атомарные операции с балансом и инвентарём.

   Все функции ниже выполняют проверку, списание, выдачу предмета и запись
   журнала В ОДНОЙ транзакции BEGIN IMMEDIATE. Клиент не может ни задать
   цену, ни повторно применить операцию: request_id — PRIMARY KEY, а баланс
   читается внутри той же транзакции, что и UPDATE.
   ══════════════════════════════════════════════════════════════════════════ */

const __q = (sql) => db.prepare(sql);

function __ledger(userId, amount, type, reason, refId, before, after, at) {
  return stmts.insertLedger.run(userId, amount, type, reason, String(refId || ''), before, after, at);
}
function __round(roundId, userId, game, bet, mult, win, status, at, itemCode, itemPrice) {
  __q(`INSERT OR IGNORE INTO game_rounds
      (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(roundId), userId, String(game), Math.floor(bet || 0), Number(mult || 1),
      Math.floor(win || 0), status, at, status === 'active' ? null : at, itemCode || null,
      itemPrice != null ? Math.floor(itemPrice) : null);
}
function __queueBalance(userId, balanceAfter, ledId, amount, type, reason, refId, before, after, at) {
  turso.queueBatch([
    { sql: 'UPDATE users SET tokens = ? WHERE id = ?', args: [balanceAfter, userId] },
    { sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [Number(ledId), userId, amount, type, reason, String(refId || ''), before, after, at] }
  ]);
}
function __mapCaseOpen(row) {
  if (!row) return null;
  return {
    requestId: row.request_id, userId: row.user_id, modeId: row.mode_id, price: row.price,
    item: { code: row.item_code, name: row.item_name, icon: row.item_icon,
      price: row.item_price, tier: row.item_tier, id: row.inventory_id },
    inventoryId: row.inventory_id, createdAt: row.created_at
  };
}
function __mapUpgradeRow(row) {
  if (!row) return null;
  return {
    requestId: row.request_id, userId: row.user_id, mode: row.mode,
    sourceType: row.source_type, sourceValue: row.source_value, sourceItemId: row.source_item_id,
    targets: JSON.parse(row.targets_json || '[]'), won: Boolean(row.won),
    target: row.target_code ? { code: row.target_code, name: row.target_name, icon: row.target_icon,
      price: row.target_value, tier: row.target_tier } : null,
    chance: row.chance, aggregateChance: row.aggregate_chance,
    inventoryId: row.inventory_id, createdAt: row.created_at
  };
}
function __mapSession(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, mode: row.mode, stepsTotal: row.steps_total,
    stepIndex: row.step_index, sourceValue: row.source_value, currentValue: row.current_value,
    sourceType: row.source_type, sourceItemId: row.source_item_id, status: row.status,
    ladder: JSON.parse(row.ladder_json || '[]'), createdAt: row.created_at,
    updatedAt: row.updated_at, settledAt: row.settled_at
  };
}

/**
 * Открытие кейса нового режима. price и item приходят ТОЛЬКО из серверного
 * каталога (case-modes.js) — не из тела запроса.
 */
function atomicOpenCase(args) {
  const { requestId, userId, modeId, modeName, price, item, roundId } = args;
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) return { ok: false, error: 'Некорректная цена кейса' };
  if (!item || !item.code || !Number.isFinite(Number(item.price)) || Number(item.price) < 0) {
    return { ok: false, error: 'Некорректный предмет кейса' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = __q('SELECT * FROM case_opens WHERE request_id = ?').get(String(requestId));
    if (prev) {
      const bal = stmts.getUser.get(userId);
      db.exec('ROLLBACK');
      return { ok: true, duplicate: true, open: __mapCaseOpen(prev), balanceAfter: bal ? bal.tokens : 0 };
    }
    const row = stmts.getUser.get(userId);
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'Пользователь не найден' }; }
    if (Number(row.tokens) < Number(price)) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'Недостаточно средств' };
    }
    const at = Date.now();
    const chosen = item;
    const balBefore = Number(row.tokens);
    const balAfter = balBefore - Number(price);
    __q('UPDATE users SET tokens = ? WHERE id = ?').run(balAfter, userId);
    const led = __ledger(userId, -price, 'case_open', `Кейс «${modeName}» · ${chosen.name}`, roundId, balBefore, balAfter, at);
    __round(roundId, userId, 'Кейс: ' + modeName, price, 1, 0, 'settled', at, chosen.code, chosen.price);
    const inv = stmts.insertInventoryItem.run(
      userId, String(chosen.code), String(chosen.name), String(chosen.icon || ''),
      Math.floor(chosen.price), String(chosen.tier || ''), String(modeId), String(modeName),
      String(roundId), at, 0
    );
    const inventoryId = Number(inv.lastInsertRowid);
    __q(`INSERT INTO case_opens
        (request_id, user_id, mode_id, price, item_code, item_name, item_icon, item_price, item_tier, inventory_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(String(requestId), userId, String(modeId), Math.floor(price), String(chosen.code),
        String(chosen.name), String(chosen.icon || ''), Math.floor(chosen.price), String(chosen.tier || ''),
        inventoryId, at);
    db.exec('COMMIT');

    __queueBalance(userId, balAfter, led.lastInsertRowid, -price, 'case_open',
      `Кейс «${modeName}» · ${chosen.name}`, roundId, balBefore, balAfter, at);
    const queue = [
      { sql: 'INSERT OR IGNORE INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [String(roundId), userId, 'Кейс: ' + modeName, Math.floor(price), 1, 0, 'settled', at, at, String(chosen.code), Math.floor(chosen.price)] },
      { sql: 'INSERT OR IGNORE INTO user_inventory (id, user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for, upgrade_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [inventoryId, userId, String(chosen.code), String(chosen.name), String(chosen.icon || ''), Math.floor(chosen.price), String(chosen.tier || ''), String(modeId), String(modeName), String(roundId), at, null, null, 0] },
      { sql: `INSERT OR IGNORE INTO case_opens (request_id, user_id, mode_id, price, item_code, item_name, item_icon, item_price, item_tier, inventory_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [String(requestId), userId, String(modeId), Math.floor(price), String(chosen.code), String(chosen.name), String(chosen.icon || ''), Math.floor(chosen.price), String(chosen.tier || ''), inventoryId, at] }
    ];
    turso.queueBatch(queue);
    return {
      ok: true, duplicate: false, balanceAfter: balAfter, inventoryId,
      open: { requestId, userId, modeId, price, item: { ...chosen, id: inventoryId }, inventoryId, createdAt: at }
    };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/**
 * Одиночный/мульти-апгрейд. Источник — токены или предмет инвентаря.
 * won и target выбирает сервер до вызова; клиент их не присылает.
 */
function atomicUpgradeRun(args) {
  const { requestId, userId, mode, sourceType, sourceAmount, sourceItemId,
    target, won, chance, aggregateChance, targets } = args;
  if (won && (!target || !target.code || !Number.isFinite(Number(target.price)))) {
    return { ok: false, error: 'Некорректная цель апгрейда' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = __q('SELECT * FROM upgrade_runs WHERE request_id = ?').get(String(requestId));
    if (prev) {
      const bal = stmts.getUser.get(userId);
      db.exec('ROLLBACK');
      return { ok: true, duplicate: true, run: __mapUpgradeRow(prev), balanceAfter: bal ? bal.tokens : 0 };
    }
    const row = stmts.getUser.get(userId);
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'Пользователь не найден' }; }

    let sourceValue = 0;
    let balBefore = Number(row.tokens);
    let balAfter = balBefore;
    let consumedItem = null;
    let at = Date.now();
    let led = null;

    if (sourceType === 'tokens') {
      const amount = Math.floor(Number(sourceAmount) || 0);
      if (!Number.isFinite(amount) || amount < 10) {
        db.exec('ROLLBACK'); return { ok: false, error: `Минимальная сумма апгрейда — ${rub(10)}` };
      }
      if (amount > 100000) {
        db.exec('ROLLBACK'); return { ok: false, error: `Максимальная сумма апгрейда — ${rub(100000)}` };
      }
      if (balBefore < amount) {
        db.exec('ROLLBACK'); return { ok: false, error: 'Недостаточно средств' };
      }
      sourceValue = amount;
      balAfter = balBefore - amount;
      __q('UPDATE users SET tokens = ? WHERE id = ?').run(balAfter, userId);
      led = __ledger(userId, -amount, 'upgrade_stake', `Апгрейд (${mode}) · ставка ${rub(amount)}`, requestId, balBefore, balAfter, at);
    } else {
      const it = __q('SELECT * FROM user_inventory WHERE id = ? AND user_id = ? AND sold_at IS NULL')
        .get(Math.floor(Number(sourceItemId) || 0), userId);
      if (!it) { db.exec('ROLLBACK'); return { ok: false, error: 'Предмет не найден в вашем инвентаре' }; }
      sourceValue = Number(it.price);
      consumedItem = it;
      const sold = __q('UPDATE user_inventory SET sold_at = ?, sold_for = 0 WHERE id = ? AND user_id = ? AND sold_at IS NULL')
        .run(at, it.id, userId);
      if (!sold.changes) { db.exec('ROLLBACK'); return { ok: false, error: 'Предмет уже использован' }; }
    }

    let inventoryId = null;
    if (won) {
      const inv = stmts.insertInventoryItem.run(
        userId, String(target.code), String(target.name), String(target.icon || ''),
        Math.floor(target.price), String(target.tier || ''), 'upgrade', 'Апгрейд',
        String(requestId), at, 0
      );
      inventoryId = Number(inv.lastInsertRowid);
    }

    __q(`INSERT INTO upgrade_runs
        (request_id, user_id, mode, source_type, source_value, source_item_id, targets_json,
         won, target_code, target_name, target_icon, target_value, target_tier, chance,
         aggregate_chance, inventory_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(String(requestId), userId, String(mode), String(sourceType), Math.floor(sourceValue),
        sourceType === 'item' ? Math.floor(sourceItemId) : null,
        JSON.stringify(targets || []), won ? 1 : 0,
        won ? String(target.code) : null, won ? String(target.name) : null,
        won ? String(target.icon || '') : null, won ? Math.floor(target.price) : null,
        won ? String(target.tier || '') : null, Number(chance || 0), Number(aggregateChance || 0),
        inventoryId, at);
    __round(requestId, userId, 'Апгрейд · ' + mode, sourceValue, won ? (target.price / sourceValue) : 0,
      won ? target.price : 0, 'settled', at, won ? target.code : (consumedItem ? consumedItem.item_code : null),
      won ? target.price : null);

    db.exec('COMMIT');

    if (led) {
      __queueBalance(userId, balAfter, led.lastInsertRowid, -Math.floor(sourceValue), 'upgrade_stake',
        `Апгрейд (${mode}) · ставка ${rub(sourceValue)}`, requestId, balBefore, balAfter, at);
    }
    const queue = [
      { sql: `INSERT OR IGNORE INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [String(requestId), userId, 'Апгрейд · ' + mode, Math.floor(sourceValue),
          won ? Number(target.price / sourceValue) : 0, won ? Math.floor(target.price) : 0, 'settled', at, at,
          won ? String(target.code) : (consumedItem ? consumedItem.item_code : null),
          won ? Math.floor(target.price) : null] },
      { sql: `INSERT OR IGNORE INTO upgrade_runs
              (request_id, user_id, mode, source_type, source_value, source_item_id, targets_json, won,
               target_code, target_name, target_icon, target_value, target_tier, chance, aggregate_chance, inventory_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [String(requestId), userId, String(mode), String(sourceType), Math.floor(sourceValue),
          sourceType === 'item' ? Math.floor(sourceItemId) : null, JSON.stringify(targets || []), won ? 1 : 0,
          won ? String(target.code) : null, won ? String(target.name) : null, won ? String(target.icon || '') : null,
          won ? Math.floor(target.price) : null, won ? String(target.tier || '') : null,
          Number(chance || 0), Number(aggregateChance || 0), inventoryId, at] }
    ];
    if (sourceType === 'item') {
      queue.push({ sql: 'UPDATE user_inventory SET sold_at = ?, sold_for = 0 WHERE id = ? AND user_id = ?', args: [at, Math.floor(sourceItemId), userId] });
    }
    if (won) {
      queue.push({ sql: 'INSERT OR IGNORE INTO user_inventory (id, user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for, upgrade_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [inventoryId, userId, String(target.code), String(target.name), String(target.icon || ''), Math.floor(target.price), String(target.tier || ''), 'upgrade', 'Апгрейд', String(requestId), at, null, null, 0] });
    }
    turso.queueBatch(queue);

    return {
      ok: true, duplicate: false, balanceAfter: balAfter, inventoryId,
      run: {
        requestId, userId, mode, sourceType, sourceValue,
        sourceItemId: sourceType === 'item' ? sourceItemId : null,
        targets: targets || [], won: Boolean(won), target: won ? { ...target, id: inventoryId } : null,
        chance, aggregateChance, createdAt: at
      }
    };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/** Старт «Лесенки»: списание источника и создание серверной сессии. */
function atomicLadderStart(args) {
  const { sessionId, requestId, userId, mode, stepsTotal, sourceType, sourceAmount, sourceItemId, ladder } = args;
  if (![3, 5, 10].includes(Number(stepsTotal))) return { ok: false, error: 'Лесенка бывает на 3, 5 или 10 шагов' };
  if (sourceType !== 'tokens' && sourceType !== 'item') return { ok: false, error: 'Некорректный источник' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = __q('SELECT * FROM upgrade_sessions WHERE request_id = ?').get(String(requestId));
    if (prev) {
      const bal = stmts.getUser.get(userId);
      db.exec('ROLLBACK');
      return { ok: true, duplicate: true, session: __mapSession(prev), balanceAfter: bal ? bal.tokens : 0 };
    }
    // Одна активная лесенка на игрока: иначе можно запутаться в нескольких
    // сессиях и случайно списать источник дважды.
    const active = __q(`SELECT id FROM upgrade_sessions WHERE user_id = ? AND status = 'active' LIMIT 1`).get(userId);
    if (active) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'У вас уже есть активная лесенка. Завершите её или заберите выигрыш.' };
    }
    const row = stmts.getUser.get(userId);
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'Пользователь не найден' }; }
    let sourceValue = 0;
    let balBefore = Number(row.tokens);
    let balAfter = balBefore;
    let led = null;
    const at = Date.now();
    if (sourceType === 'tokens') {
      const amount = Math.floor(Number(sourceAmount) || 0);
      if (!Number.isFinite(amount) || amount < 10) { db.exec('ROLLBACK'); return { ok: false, error: `Минимальная сумма — ${rub(10)}` }; }
      if (amount > 100000) { db.exec('ROLLBACK'); return { ok: false, error: `Максимальная сумма — ${rub(100000)}` }; }
      if (balBefore < amount) { db.exec('ROLLBACK'); return { ok: false, error: 'Недостаточно средств' }; }
      sourceValue = amount;
      balAfter = balBefore - amount;
      __q('UPDATE users SET tokens = ? WHERE id = ?').run(balAfter, userId);
      led = __ledger(userId, -amount, 'ladder_stake', `Лесенка ${stepsTotal} шагов · ставка ${rub(amount)}`, sessionId, balBefore, balAfter, at);
    } else {
      const it = __q('SELECT * FROM user_inventory WHERE id = ? AND user_id = ? AND sold_at IS NULL')
        .get(Math.floor(Number(sourceItemId) || 0), userId);
      if (!it) { db.exec('ROLLBACK'); return { ok: false, error: 'Предмет не найден в вашем инвентаре' }; }
      sourceValue = Number(it.price);
      const sold = __q('UPDATE user_inventory SET sold_at = ?, sold_for = 0 WHERE id = ? AND user_id = ? AND sold_at IS NULL')
        .run(at, it.id, userId);
      if (!sold.changes) { db.exec('ROLLBACK'); return { ok: false, error: 'Предмет уже использован' }; }
    }
    __q(`INSERT INTO upgrade_sessions
        (id, request_id, user_id, mode, steps_total, step_index, source_value, current_value,
         source_type, source_item_id, status, ladder_json, created_at, updated_at, settled_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`)
      .run(String(sessionId), String(requestId), userId, String(mode), Math.floor(stepsTotal),
        Math.floor(sourceValue), Math.floor(sourceValue), String(sourceType),
        sourceType === 'item' ? Math.floor(sourceItemId) : null,
        JSON.stringify(ladder || []), at, at);
    __round(sessionId, userId, `Апгрейд · Лесенка ${stepsTotal}`, sourceValue, 1, 0, 'active', at, null, null);
    db.exec('COMMIT');

    if (led) {
      __queueBalance(userId, balAfter, led.lastInsertRowid, -Math.floor(sourceValue), 'ladder_stake',
        `Лесенка ${stepsTotal} шагов · ставка ${rub(sourceValue)}`, sessionId, balBefore, balAfter, at);
    }
    const queue = [
      { sql: `INSERT OR IGNORE INTO upgrade_sessions
              (id, request_id, user_id, mode, steps_total, step_index, source_value, current_value, source_type, source_item_id, status, ladder_json, created_at, updated_at, settled_at)
              VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
        args: [String(sessionId), String(requestId), userId, String(mode), Math.floor(stepsTotal),
          Math.floor(sourceValue), Math.floor(sourceValue), String(sourceType),
          sourceType === 'item' ? Math.floor(sourceItemId) : null, JSON.stringify(ladder || []), at, at] },
      { sql: `INSERT OR IGNORE INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [String(sessionId), userId, `Апгрейд · Лесенка ${stepsTotal}`, Math.floor(sourceValue), 1, 0, 'active', at, null, null, null] }
    ];
    if (sourceType === 'item') {
      queue.push({ sql: 'UPDATE user_inventory SET sold_at = ?, sold_for = 0 WHERE id = ? AND user_id = ?', args: [at, Math.floor(sourceItemId), userId] });
    }
    turso.queueBatch(queue);
    const session = __mapSession(__q('SELECT * FROM upgrade_sessions WHERE id = ?').get(String(sessionId)));
    return { ok: true, duplicate: false, session, balanceAfter: balAfter };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/**
 * Шаг «Лесенки». Порядок шага проверяется внутри транзакции: уже завершённый
 * шаг нельзя выполнить повторно даже двумя параллельными запросами.
 */
function atomicLadderStep(args) {
  const { requestId, sessionId, userId, expectedStep, won, mult } = args;
  if (!Number.isFinite(Number(mult)) || Number(mult) <= 1) {
    return { ok: false, error: 'Некорректный множитель шага' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const prevAct = __q('SELECT * FROM upgrade_actions WHERE request_id = ?').get(String(requestId));
    if (prevAct) {
      const bal = stmts.getUser.get(userId);
      db.exec('ROLLBACK');
      const result = JSON.parse(prevAct.result_json || '{}');
      return { ok: true, duplicate: true, result, balanceAfter: bal ? bal.tokens : result.balanceAfter };
    }
    const s = __q('SELECT * FROM upgrade_sessions WHERE id = ? AND user_id = ?').get(String(sessionId), userId);
    if (!s) { db.exec('ROLLBACK'); return { ok: false, error: 'Сессия не найдена' }; }
    if (s.status !== 'active') { db.exec('ROLLBACK'); return { ok: false, error: 'Сессия уже завершена' }; }
    const nextStep = Number(s.step_index) + 1;
    if (nextStep !== Number(expectedStep)) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'Этот шаг уже выполнен или пропущен' };
    }
    const at = Date.now();
    const cur = Number(s.current_value);
    const nextValue = Math.floor(cur * Number(mult));
    let status = s.status;
    let currentValue = cur;
    let balanceAfter = Number(stmts.getUser.get(userId).tokens);
    let led = null;

    if (!won) {
      status = 'lost';
      currentValue = 0;
    } else if (nextStep >= Number(s.steps_total)) {
      status = 'completed';
      currentValue = nextValue;
      const balBefore = balanceAfter;
      balanceAfter = balBefore + nextValue;
      __q('UPDATE users SET tokens = ? WHERE id = ?').run(balanceAfter, userId);
      led = __ledger(userId, nextValue, 'ladder_win', `Лесенка пройдена: ${s.steps_total} шагов (+${rub(nextValue)})`, sessionId, balBefore, balanceAfter, at);
    } else {
      currentValue = nextValue;
    }

    __q(`UPDATE upgrade_sessions
        SET step_index = ?, current_value = ?, status = ?, updated_at = ?, settled_at = ?
        WHERE id = ? AND user_id = ?`)
      .run(nextStep, Math.floor(currentValue), status, at, status === 'active' ? null : at, String(sessionId), userId);
    __q(`UPDATE game_rounds SET win_tokens = ?, mult = ?, status = ?, settled_at = ?
        WHERE round_id = ? AND user_id = ?`)
      .run(Math.floor(currentValue), cur > 0 ? Number(mult) : 0, status === 'active' ? 'active' : status,
        status === 'active' ? null : at, String(sessionId), userId);

    const result = {
      sessionId: String(sessionId), step: nextStep, stepsTotal: Number(s.steps_total),
      won: Boolean(won), mult: Number(mult), value: Math.floor(currentValue),
      status, balanceAfter, finished: status !== 'active', paid: status === 'completed' ? nextValue : 0
    };
    __q(`INSERT INTO upgrade_actions (request_id, session_id, user_id, step_index, action, result_json, created_at)
        VALUES (?, ?, ?, ?, 'step', ?, ?)`)
      .run(String(requestId), String(sessionId), userId, nextStep, JSON.stringify(result), at);
    db.exec('COMMIT');

    if (led) {
      __queueBalance(userId, balanceAfter, led.lastInsertRowid, nextValue, 'ladder_win',
        `Лесенка пройдена: ${s.steps_total} шагов (+${rub(nextValue)})`, sessionId, balanceAfter - nextValue, balanceAfter, at);
    }
    turso.queueBatch([
      { sql: `UPDATE upgrade_sessions SET step_index = ?, current_value = ?, status = ?, updated_at = ?, settled_at = ? WHERE id = ? AND user_id = ?`,
        args: [nextStep, Math.floor(currentValue), status, at, status === 'active' ? null : at, String(sessionId), userId] },
      { sql: `INSERT OR IGNORE INTO upgrade_actions (request_id, session_id, user_id, step_index, action, result_json, created_at) VALUES (?, ?, ?, ?, 'step', ?, ?)`,
        args: [String(requestId), String(sessionId), userId, nextStep, JSON.stringify(result), at] },
      { sql: `UPDATE game_rounds SET win_tokens = ?, mult = ?, status = ?, settled_at = ? WHERE round_id = ? AND user_id = ?`,
        args: [Math.floor(currentValue), cur > 0 ? Number(mult) : 0, status === 'active' ? 'active' : status,
          status === 'active' ? null : at, String(sessionId), userId] }
    ]);
    return { ok: true, duplicate: false, result, balanceAfter };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/** Кэшаут «Лесенки»: забирает текущую стоимость и закрывает сессию. */
function atomicLadderCashout(args) {
  const { requestId, sessionId, userId } = args;
  db.exec('BEGIN IMMEDIATE');
  try {
    const prevAct = __q('SELECT * FROM upgrade_actions WHERE request_id = ?').get(String(requestId));
    if (prevAct) {
      const bal = stmts.getUser.get(userId);
      db.exec('ROLLBACK');
      const result = JSON.parse(prevAct.result_json || '{}');
      return { ok: true, duplicate: true, result, balanceAfter: bal ? bal.tokens : result.balanceAfter };
    }
    const s = __q('SELECT * FROM upgrade_sessions WHERE id = ? AND user_id = ?').get(String(sessionId), userId);
    if (!s) { db.exec('ROLLBACK'); return { ok: false, error: 'Сессия не найдена' }; }
    if (s.status !== 'active') { db.exec('ROLLBACK'); return { ok: false, error: 'Сессия уже завершена' }; }
    if (Number(s.step_index) < 1) { db.exec('ROLLBACK'); return { ok: false, error: 'Сначала пройдите хотя бы один шаг' }; }
    const at = Date.now();
    const win = Math.floor(Number(s.current_value));
    const row = stmts.getUser.get(userId);
    const balBefore = Number(row.tokens);
    const balAfter = balBefore + win;
    __q('UPDATE users SET tokens = ? WHERE id = ?').run(balAfter, userId);
    const led = __ledger(userId, win, 'ladder_cashout', `Лесенка: кэшаут на шаге ${s.step_index} (+${rub(win)})`, sessionId, balBefore, balAfter, at);
    __q(`UPDATE upgrade_sessions SET status = 'cashed', updated_at = ?, settled_at = ? WHERE id = ? AND user_id = ?`)
      .run(at, at, String(sessionId), userId);
    __q(`UPDATE game_rounds SET win_tokens = ?, mult = ?, status = 'settled', settled_at = ? WHERE round_id = ? AND user_id = ?`)
      .run(win, Number(s.step_index), at, String(sessionId), userId);
    const result = {
      sessionId: String(sessionId), step: Number(s.step_index), stepsTotal: Number(s.steps_total),
      won: true, value: win, status: 'cashed', balanceAfter: balAfter, finished: true, paid: win
    };
    __q(`INSERT INTO upgrade_actions (request_id, session_id, user_id, step_index, action, result_json, created_at)
        VALUES (?, ?, ?, ?, 'cashout', ?, ?)`)
      .run(String(requestId), String(sessionId), userId, Number(s.step_index), JSON.stringify(result), at);
    db.exec('COMMIT');

    __queueBalance(userId, balAfter, led.lastInsertRowid, win, 'ladder_cashout',
      `Лесенка: кэшаут на шаге ${s.step_index} (+${rub(win)})`, sessionId, balBefore, balAfter, at);
    turso.queueBatch([
      { sql: `UPDATE upgrade_sessions SET status = 'cashed', updated_at = ?, settled_at = ? WHERE id = ? AND user_id = ?`,
        args: [at, at, String(sessionId), userId] },
      { sql: `INSERT OR IGNORE INTO upgrade_actions (request_id, session_id, user_id, step_index, action, result_json, created_at) VALUES (?, ?, ?, ?, 'cashout', ?, ?)`,
        args: [String(requestId), String(sessionId), userId, Number(s.step_index), JSON.stringify(result), at] },
      { sql: `UPDATE game_rounds SET win_tokens = ?, mult = ?, status = 'settled', settled_at = ? WHERE round_id = ? AND user_id = ?`,
        args: [win, Number(s.step_index), at, String(sessionId), userId] }
    ]);
    return { ok: true, duplicate: false, result, balanceAfter: balAfter };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/** Чтение сохранённого результата идемпотентной операции. */
function getIdempotentResult(requestId, userId) {
  try {
    const row = db.prepare('SELECT * FROM idempotent_results WHERE request_id = ? AND user_id = ?')
      .get(String(requestId), userId);
    if (!row) return null;
    return JSON.parse(row.result_json || 'null');
  } catch (_) { return null; }
}

/**
 * Скретч-карта: списание билета, выигрыш и страховка — одной транзакцией.
 * Раньше списание и начисление шли двумя отдельными вызовами applyBalance,
 * поэтому сбой между ними оставлял игрока без билета или без выигрыша.
 */
function atomicScratchPlay(args) {
  const { requestId, userId, roundId, bet, cost, winTokens, winMult, insuredReturn, grid, won, winSymbol } = args;
  if (!Number.isFinite(Number(cost)) || Number(cost) <= 0 ||
      !Number.isFinite(Number(winTokens)) || Number(winTokens) < 0 ||
      !Number.isFinite(Number(insuredReturn)) || Number(insuredReturn) < 0) {
    return { ok: false, error: 'Некорректные параметры розыгрыша' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = __q('SELECT * FROM idempotent_results WHERE request_id = ? AND user_id = ?')
      .get(String(requestId), userId);
    if (prev) {
      const bal = stmts.getUser.get(userId);
      db.exec('ROLLBACK');
      return { ok: true, duplicate: true, result: JSON.parse(prev.result_json || '{}'), balanceAfter: bal ? bal.tokens : 0 };
    }
    const row = stmts.getUser.get(userId);
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'Пользователь не найден' }; }
    const at = Date.now();
    const balBefore = Number(row.tokens);
    if (balBefore < Number(cost)) { db.exec('ROLLBACK'); return { ok: false, error: 'Недостаточно средств' }; }
    const afterDebit = balBefore - Number(cost);
    __q('UPDATE users SET tokens = ? WHERE id = ?').run(afterDebit, userId);
    const led1 = __ledger(userId, -Number(cost), 'scratch_buy',
      `Скретч-билет (${rub(bet)}${cost > bet ? ' + страховка 15%' : ''})`, roundId, balBefore, afterDebit, at);

    let balanceAfter = afterDebit;
    let led2 = null;
    if (winTokens > 0) {
      const before = balanceAfter;
      balanceAfter += Math.floor(winTokens);
      __q('UPDATE users SET tokens = ? WHERE id = ?').run(balanceAfter, userId);
      led2 = __ledger(userId, Math.floor(winTokens), 'scratch_win',
        `Скретч-карты: 3x ${winSymbol || ''} (+${rub(winTokens)})`, roundId, before, balanceAfter, at);
    }
    let led3 = null;
    if (insuredReturn > 0) {
      const before = balanceAfter;
      balanceAfter += Math.floor(insuredReturn);
      __q('UPDATE users SET tokens = ? WHERE id = ?').run(balanceAfter, userId);
      led3 = __ledger(userId, Math.floor(insuredReturn), 'insurance_refund',
        `🛡️ Страховка ставки: возврат 20% (+${rub(insuredReturn)})`, roundId, before, balanceAfter, at);
    }
    __round(roundId, userId, 'Скретч-карты', bet, winMult || 0, winTokens || 0, 'settled', at, null, null);
    const result = {
      ok: true, grid, won: Boolean(won), winSymbol: winSymbol || null,
      winMult: Number(winMult || 0), winTokens: Math.floor(winTokens || 0),
      insuredReturn: Math.floor(insuredReturn || 0), tokens: balanceAfter
    };
    __q(`INSERT INTO idempotent_results (request_id, user_id, kind, result_json, created_at)
        VALUES (?, ?, 'scratch', ?, ?)`)
      .run(String(requestId), userId, JSON.stringify(result), at);
    db.exec('COMMIT');

    const queue = [
      { sql: 'UPDATE users SET tokens = ? WHERE id = ?', args: [balanceAfter, userId] },
      { sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [Number(led1.lastInsertRowid), userId, -Number(cost), 'scratch_buy',
          `Скретч-билет (${rub(bet)}${cost > bet ? ' + страховка 15%' : ''})`, String(roundId), balBefore, afterDebit, at] }
    ];
    if (led2) queue.push({ sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [Number(led2.lastInsertRowid), userId, Math.floor(winTokens), 'scratch_win',
        `Скретч-карты: 3x ${winSymbol || ''} (+${rub(winTokens)})`, String(roundId), afterDebit, afterDebit + Math.floor(winTokens), at] });
    if (led3) queue.push({ sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [Number(led3.lastInsertRowid), userId, Math.floor(insuredReturn), 'insurance_refund',
        `🛡️ Страховка ставки: возврат 20% (+${rub(insuredReturn)})`, String(roundId), balanceAfter - Math.floor(insuredReturn), balanceAfter, at] });
    queue.push({ sql: `INSERT OR IGNORE INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [String(roundId), userId, 'Скретч-карты', Math.floor(bet), Number(winMult || 0), Math.floor(winTokens || 0), 'settled', at, at, null, null] });
    queue.push({ sql: `INSERT OR IGNORE INTO idempotent_results (request_id, user_id, kind, result_json, created_at) VALUES (?, ?, 'scratch', ?, ?)`,
      args: [String(requestId), userId, JSON.stringify(result), at] });
    turso.queueBatch(queue);
    return { ok: true, duplicate: false, result, balanceAfter };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/**
 * Взлом сейфа: списание попытки, запись истории, обновление пула и выплата
 * джекпота — одной транзакцией. Раньше джекпот обнулялся до начисления,
 * и сбой applyBalance мог «съесть» выигрыш.
 */
function atomicSafeGuess(userId, code, cost, requestId) {
  if (!/^\d{4}$/.test(String(code)) || !Number.isFinite(Number(cost)) || Number(cost) <= 0) {
    return { ok: false, error: 'Некорректные параметры попытки' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = requestId
      ? __q('SELECT * FROM idempotent_results WHERE request_id = ? AND user_id = ?').get(String(requestId), userId)
      : null;
    if (prev) {
      const bal = stmts.getUser.get(userId);
      db.exec('ROLLBACK');
      return { ok: true, duplicate: true, result: JSON.parse(prev.result_json || '{}'), balanceAfter: bal ? bal.tokens : 0 };
    }
    const safe = __q('SELECT secret_code, jackpot_tokens, guesses_count FROM vault_safe WHERE id = 1').get();
    if (!safe) { db.exec('ROLLBACK'); return { ok: false, error: 'Сейф недоступен' }; }
    const row = stmts.getUser.get(userId);
    if (!row) { db.exec('ROLLBACK'); return { ok: false, error: 'Пользователь не найден' }; }
    const balBefore = Number(row.tokens);
    if (balBefore < Number(cost)) { db.exec('ROLLBACK'); return { ok: false, error: `Для попытки требуется ${rub(25)}` }; }

    const secret = String(safe.secret_code);
    const guess = String(code);
    let bulls = 0, cows = 0;
    const secretUsed = [false, false, false, false];
    const guessUsed = [false, false, false, false];
    for (let i = 0; i < 4; i++) {
      if (guess[i] === secret[i]) { bulls++; secretUsed[i] = true; guessUsed[i] = true; }
    }
    for (let i = 0; i < 4; i++) {
      if (!guessUsed[i]) {
        for (let j = 0; j < 4; j++) {
          if (!secretUsed[j] && guess[i] === secret[j]) { cows++; secretUsed[j] = true; break; }
        }
      }
    }
    const won = bulls === 4;
    const at = Date.now();
    const afterDebit = balBefore - Number(cost);
    __q('UPDATE users SET tokens = ? WHERE id = ?').run(afterDebit, userId);
    const led1 = __ledger(userId, -Number(cost), 'safe_guess', `Попытка взлома сейфа [${guess}]`, 'safe' + at, balBefore, afterDebit, at);
    __q('INSERT INTO safe_attempts (user_id, code, bulls, cows, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, guess, bulls, cows, at);

    let winTokens = 0;
    let balanceAfter = afterDebit;
    let led2 = null;
    if (won) {
      winTokens = Number(safe.jackpot_tokens || 0);
      const newCode = String(1000 + crypto.randomInt(0, 9000));
      __q(`UPDATE vault_safe SET jackpot_tokens = 0, secret_code = ?, guesses_count = 0, last_won_at = ?, last_winner_id = ? WHERE id = 1`)
        .run(newCode, at, userId);
      if (winTokens > 0) {
        balanceAfter = afterDebit + winTokens;
        __q('UPDATE users SET tokens = ? WHERE id = ?').run(balanceAfter, userId);
        led2 = __ledger(userId, winTokens, 'safe_jackpot', `🎉 ВЗЛОМ СЕЙФА: ДЖЕКПОТ +${rub(winTokens)}!`, 'safe' + at, afterDebit, balanceAfter, at);
      }
    } else {
      __q('UPDATE vault_safe SET jackpot_tokens = jackpot_tokens + 15, guesses_count = guesses_count + 1 WHERE id = 1').run();
    }
    const updatedSafe = __q('SELECT jackpot_tokens, guesses_count FROM vault_safe WHERE id = 1').get();
    const result = {
      ok: true, code: guess, won, bulls, cows, winTokens,
      jackpot: updatedSafe ? updatedSafe.jackpot_tokens : 0,
      guessesCount: updatedSafe ? updatedSafe.guesses_count : 0,
      balance: balanceAfter
    };
    if (requestId) {
      __q(`INSERT INTO idempotent_results (request_id, user_id, kind, result_json, created_at)
          VALUES (?, ?, 'safe', ?, ?)`)
        .run(String(requestId), userId, JSON.stringify(result), at);
    }
    const safeRoundId = requestId || ('SAFE_' + at + '_' + userId);
    __round(safeRoundId, userId, 'Взлом Сейфа',
      cost, won ? winTokens / cost : 0, winTokens, 'settled', at, null, null);
    db.exec('COMMIT');

    const queue = [
      { sql: 'UPDATE users SET tokens = ? WHERE id = ?', args: [balanceAfter, userId] },
      { sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [Number(led1.lastInsertRowid), userId, -Number(cost), 'safe_guess', `Попытка взлома сейфа [${guess}]`, 'safe' + at, balBefore, afterDebit, at] }
    ];
    if (led2) queue.push({ sql: 'INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [Number(led2.lastInsertRowid), userId, winTokens, 'safe_jackpot', `🎉 ВЗЛОМ СЕЙФА: ДЖЕКПОТ +${rub(winTokens)}!`, 'safe' + at, afterDebit, balanceAfter, at] });
    queue.push({ sql: `INSERT OR IGNORE INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [String(safeRoundId), userId, 'Взлом Сейфа', Math.floor(cost), won ? winTokens / cost : 0,
        Math.floor(winTokens), 'settled', at, at, null, null] });
    if (requestId) queue.push({ sql: `INSERT OR IGNORE INTO idempotent_results (request_id, user_id, kind, result_json, created_at) VALUES (?, ?, 'safe', ?, ?)`,
      args: [String(requestId), userId, JSON.stringify(result), at] });
    turso.queueBatch(queue);
    return { ok: true, duplicate: false, result, balanceAfter };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

module.exports = {
  db,
  DB_PATH,
  SCHEMA_SQL,
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

  /* Персональный буст дропа: 0..100. Ошибка чтения не должна ронять игру —
     возвращаем 0 (без буста), а проблема остаётся в логе. */
  bumpDepositCount: (userId) => {
    try {
      const uid = Math.floor(Number(userId));
      const row = stmts.getUser.get(uid);
      const next = Number(row && row.deposit_count || 0) + 1;
      stmts.bumpDepositCount.run(uid);
      turso.queueQuery('UPDATE users SET deposit_count = deposit_count + 1 WHERE id = ?', [uid]);
      return next;
    } catch (e) { console.error('[DB] bumpDepositCount error:', e.message); return 0; }
  },
  setDepositCount: (userId, value) => {
    try {
      const uid = Math.floor(Number(userId));
      const n = Math.max(0, Math.floor(Number(value) || 0));
      stmts.setDepositCount.run(n, uid);
      turso.queueQuery('UPDATE users SET deposit_count = ? WHERE id = ?', [n, uid]);
      return true;
    } catch (e) { console.error('[DB] setDepositCount error:', e.message); return false; }
  },
  touchUserSeen: (userId, at) => {
    try {
      const uid = Math.floor(Number(userId));
      const ts = Math.floor(Number(at) || Date.now());
      stmts.touchUserSeen.run(ts, uid);
      turso.queueQuery('UPDATE users SET last_seen_at = ? WHERE id = ?', [ts, uid]);
      return true;
    } catch (e) { return false; }
  },
  setReactivationAt: (userId, at) => {
    try {
      const uid = Math.floor(Number(userId));
      const ts = Math.floor(Number(at) || Date.now());
      stmts.setReactivationAt.run(ts, uid);
      turso.queueQuery('UPDATE users SET last_reactivation_at = ? WHERE id = ?', [ts, uid]);
      return true;
    } catch (e) { return false; }
  },
  getPlayerBoost: (userId) => {
    try {
      const row = stmts.getPlayerBoost.get(userId);
      if (!row) return 0;
      return Math.max(0, Math.min(100, Math.round(Number(row.luck) || 0)));
    } catch (e) {
      console.error('[DB] getPlayerBoost error:', e.message);
      return 0;
    }
  },
  /* luck = 0 удаляет запись: в списке остаются только реально бустнутые игроки. */
  setPlayerBoost: (userId, luck) => {
    const uid = Math.floor(Number(userId));
    const value = Math.max(0, Math.min(100, Math.round(Number(luck) || 0)));
    if (!Number.isFinite(uid) || uid <= 0) return { ok: false, error: 'Некорректный ID игрока' };
    try {
      if (value <= 0) {
        stmts.deletePlayerBoost.run(uid);
        turso.queueQuery('DELETE FROM player_boosts WHERE user_id = ?', [uid]);
      } else {
        const now = Date.now();
        stmts.setPlayerBoost.run(uid, value, now);
        turso.queueQuery(
          'INSERT INTO player_boosts (user_id, luck, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET luck=excluded.luck, updated_at=excluded.updated_at',
          [uid, value, now]
        );
      }
      return { ok: true, luck: value };
    } catch (e) {
      console.error('[DB] setPlayerBoost error:', e.message);
      return { ok: false, error: 'Не удалось сохранить буст' };
    }
  },
  listPlayerBoosts: (limit = 50) => {
    try {
      const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      return stmts.listPlayerBoosts.all(n).map(r => ({
        userId: Number(r.user_id),
        luck: Math.max(0, Math.min(100, Math.round(Number(r.luck) || 0))),
        updatedAt: Number(r.updated_at || 0),
        numId: Number(r.num_id || 0),
        name: r.name || '',
        username: r.username || '',
        tokens: Number(r.tokens || 0)
      }));
    } catch (e) {
      console.error('[DB] listPlayerBoosts error:', e.message);
      return [];
    }
  },
  searchUsersForAdmin: (query, limit = 10) => {
    const raw = String(query || '').trim().replace(/^@/, '');
    if (!raw) return [];
    const n = Math.max(1, Math.min(30, Math.floor(Number(limit) || 10)));
    // LIKE-шаблон экранируем: % и _ не должны превращать поиск в «все игроки».
    const like = '%' + raw.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
    try {
      return stmts.searchUsersForAdmin.all(raw, raw, raw, like, n).map(r => ({
        id: Number(r.id),
        numId: Number(r.num_id || 0),
        name: r.name || '',
        username: r.username || '',
        tokens: Number(r.tokens || 0)
      }));
    } catch (e) {
      console.error('[DB] searchUsersForAdmin error:', e.message);
      return [];
    }
  },

  /* Кандидаты на мягкую реактивацию: давно не открывали приложение,
     есть реальный повод вернуться (подарочный кейс или рейкбек), и мы
     не писали им последние 3 дня. */
  listReactivationCandidates: (inactiveBefore, cooldownBefore, limit = 50) => {
    try {
      const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      return db.prepare(`
        SELECT id, username, name, tokens, free_cases, rakeback, last_seen_at
        FROM users
        WHERE last_seen_at > 0
          AND last_seen_at < ?
          AND (last_reactivation_at = 0 OR last_reactivation_at < ?)
          AND (COALESCE(free_cases, 0) > 0 OR COALESCE(rakeback, 0) >= 30)
        ORDER BY last_seen_at ASC
        LIMIT ?
      `).all(Math.floor(Number(inactiveBefore) || 0), Math.floor(Number(cooldownBefore) || 0), n)
        .map(r => ({
          id: Number(r.id),
          username: r.username || '',
          name: r.name || '',
          tokens: Number(r.tokens || 0),
          freeCases: Number(r.free_cases || 0),
          rakeback: Number(r.rakeback || 0),
          lastSeenAt: Number(r.last_seen_at || 0)
        }));
    } catch (e) {
      console.error('[DB] listReactivationCandidates error:', e.message);
      return [];
    }
  },
  /* Полные логи для админки: последние движения баланса и раунды. */
  listRecentWins: (limit = 30, since = 0) => {
    try {
      const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 30)));
      const from = Math.floor(Number(since) || 0);
      return db.prepare(`
        SELECT r.round_id, r.game, r.win_tokens, r.bet_tokens, r.mult, r.created_at,
               u.username, u.name
        FROM game_rounds r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.win_tokens > r.bet_tokens AND r.created_at >= ?
        ORDER BY r.created_at DESC
        LIMIT ?
      `).all(from, n).map(r => ({
        id: String(r.round_id),
        name: r.username ? '@' + r.username : (r.name || 'Игрок'),
        game: r.game || '',
        win: Number(r.win_tokens || 0),
        bet: Number(r.bet_tokens || 0),
        mult: Number(r.mult || 0),
        at: Number(r.created_at || 0)
      }));
    } catch (e) {
      console.error('[DB] listRecentWins error:', e.message);
      return [];
    }
  },
  listRecentLedger: (limit = 200) => {
    try {
      const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
      return stmts.listRecentLedger.all(n).map(r => ({
        id: Number(r.id),
        userId: Number(r.user_id),
        amount: Number(r.amount),
        type: r.type || '',
        reason: r.reason || '',
        balanceAfter: Number(r.balance_after),
        createdAt: Number(r.created_at),
        numId: Number(r.num_id || 0),
        name: r.name || '',
        username: r.username || ''
      }));
    } catch (e) {
      console.error('[DB] listRecentLedger error:', e.message);
      return [];
    }
  },
  listRecentRounds: (limit = 200) => {
    try {
      const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
      return stmts.listRecentRounds.all(n).map(r => ({
        roundId: r.round_id,
        userId: Number(r.user_id),
        game: r.game || '',
        bet: Number(r.bet_tokens || 0),
        mult: Number(r.mult || 0),
        win: Number(r.win_tokens || 0),
        status: r.status || '',
        createdAt: Number(r.created_at || 0),
        settledAt: Number(r.settled_at || 0),
        numId: Number(r.num_id || 0),
        name: r.name || '',
        username: r.username || ''
      }));
    } catch (e) {
      console.error('[DB] listRecentRounds error:', e.message);
      return [];
    }
  },

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
      ord.bonus || '',
      ord.expiresAt || ord.expires_at || 0,
      ord.adminMsgId || ord.admin_msg_id || 0,
      ord.adminChatId || ord.admin_chat_id || 0
    );
    turso.queueQuery(`
      INSERT INTO orders (id, type, user_id, tokens, rub, bank, card, sender, method, details, status, source, tx, created_at, updated_at, bonus, expires_at, admin_msg_id, admin_chat_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at,
        expires_at=excluded.expires_at, admin_msg_id=excluded.admin_msg_id, admin_chat_id=excluded.admin_chat_id
    `, [
      ord.id, ord.type || 'deposit', ord.userId, ord.tokens, ord.rub, ord.bank || null,
      ord.card || null, ord.sender || null, ord.method || null, ord.details || null,
      ord.status || 'pending', ord.source || null, ord.tx || null, ord.createdAt || Date.now(), Date.now(),
      ord.bonus || '', ord.expiresAt || ord.expires_at || 0,
      ord.adminMsgId || ord.admin_msg_id || 0, ord.adminChatId || ord.admin_chat_id || 0
    ]);
  },
  getOrder: (id) => stmts.getOrder.get(id),
  updateOrderStatus: (id, status) => {
    const now = Date.now();
    const res = stmts.updateOrderStatus.run(status, now, id);
    turso.queueQuery('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
    return res;
  },
  setOrderMessage: (id, msgId, chatId) => {
    const now = Date.now();
    const res = stmts.setOrderMessage.run(msgId, chatId, now, id);
    turso.queueQuery('UPDATE orders SET admin_msg_id = ?, admin_chat_id = ?, updated_at = ? WHERE id = ?',
      [msgId, chatId, now, id]);
    return res;
  },
  listUserOrders: (userId, limit = 10) => {
    const safe = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
    return stmts.listUserOrders.all(userId, safe);
  },
  listPendingManualDeposits: () => stmts.listPendingManualDeposits.all(),
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

  /* Раунды игрока для прогрессии (DECISIONS D7): только чтение game_rounds,
     без новых таблиц. Ограничение по количеству — защита от раздувания ответа. */
  getUserRounds: (userId, limit = 500) => {
    try {
      return db.prepare(`SELECT round_id, game, status, bet_tokens, mult, win_tokens, created_at
        FROM game_rounds WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(userId, Math.max(1, Math.min(2000, Number(limit) || 500)));
    } catch (e) { console.error('[DB] getUserRounds:', e.message); return []; }
  },

  /* Pulse/Trend (DECISIONS D5/D6): серверный seed и параметры раунда хранятся
     в той же строке game_rounds, чтобы раунд переживал перезапуск сервера.
     Игроки видят seed после расчёта; этим решением пользователь подтвердил открытое хранение. */
  setRoundParams: (roundId, userId, seed, params) => {
    try {
      const json = JSON.stringify(params || {});
      if (seed == null) {
        // Ракетке seed не нужен: сохраняем только серверные параметры раунда.
        db.prepare('UPDATE game_rounds SET params = ? WHERE round_id = ? AND user_id = ?')
          .run(json, String(roundId), userId);
        turso.queueQuery('UPDATE game_rounds SET params = ? WHERE round_id = ? AND user_id = ?',
          [json, String(roundId), userId]);
      } else {
        db.prepare('UPDATE game_rounds SET seed = ?, params = ? WHERE round_id = ? AND user_id = ?')
          .run(String(seed), json, String(roundId), userId);
        turso.queueQuery('UPDATE game_rounds SET seed = ?, params = ? WHERE round_id = ? AND user_id = ?',
          [String(seed), json, String(roundId), userId]);
      }
      return true;
    } catch (e) { console.error('[DB] setRoundParams:', e.message); return false; }
  },
  getRoundParams: (roundId, userId) => {
    try {
      const row = db.prepare('SELECT * FROM game_rounds WHERE round_id = ? AND user_id = ?').get(String(roundId), userId);
      if (!row) return null;
      let params = {};
      try { params = row.params ? JSON.parse(row.params) : {}; } catch (_) {}
      return { ...row, params, seed: row.seed || null };
    } catch (e) { console.error('[DB] getRoundParams:', e.message); return null; }
  },
  /* Зависшие раунды Pulse/Trend: статус pending с сохранённым seed. Нужны для восстановления после перезапуска. */
  listPendingGameRounds: (games) => {
    try {
      const list = Array.isArray(games) ? games : [games];
      const marks = list.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM game_rounds WHERE status = 'pending' AND seed IS NOT NULL AND game IN (${marks})`)
        .all(...list).map(row => {
          let params = {};
          try { params = row.params ? JSON.parse(row.params) : {}; } catch (_) {}
          return { ...row, params };
        });
    } catch (e) { console.error('[DB] listPendingGameRounds:', e.message); return []; }
  },

  /* Открытые раунды конкретного игрока: нужны для восстановления после
     закрытия приложения (Ракетка) и после перезапуска сервера. */
  listUserOpenRounds: (userId, game, statuses = ['pending', 'active'], since = 0, limit = 20) => {
    try {
      const list = Array.isArray(statuses) ? statuses : [statuses];
      const marks = list.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM game_rounds
        WHERE user_id = ? AND game = ? AND status IN (${marks}) AND created_at >= ?
        ORDER BY created_at DESC LIMIT ?`)
        .all(userId, String(game), ...list, since, Math.max(1, Math.min(100, Number(limit) || 20)))
        .map(row => {
          let params = {};
          try { params = row.params ? JSON.parse(row.params) : {}; } catch (_) {}
          return { ...row, params };
        });
    } catch (e) { console.error('[DB] listUserOpenRounds:', e.message); return []; }
  },

  /* Все незакрытые раунды указанных игр: свип при старте сервера. */
  listUnsettledGameRounds: (games, statuses = ['pending', 'active'], since = 0, limit = 200) => {
    try {
      const g = Array.isArray(games) ? games : [games];
      const st = Array.isArray(statuses) ? statuses : [statuses];
      const gm = g.map(() => '?').join(',');
      const sm = st.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM game_rounds
        WHERE game IN (${gm}) AND status IN (${sm}) AND created_at >= ?
        ORDER BY created_at DESC LIMIT ?`)
        .all(...g, ...st, since, Math.max(1, Math.min(1000, Number(limit) || 200)))
        .map(row => {
          let params = {};
          try { params = row.params ? JSON.parse(row.params) : {}; } catch (_) {}
          return { ...row, params };
        });
    } catch (e) { console.error('[DB] listUnsettledGameRounds:', e.message); return []; }
  },

  /* Раунды, закрытые после указанного момента (для показа результата,
     который игрок не увидел из-за закрытого приложения). */
  listUserRoundsSince: (userId, game, since, limit = 50) => {
    try {
      return db.prepare(`SELECT * FROM game_rounds
        WHERE user_id = ? AND game = ? AND settled_at >= ?
        ORDER BY settled_at DESC LIMIT ?`)
        .all(userId, String(game), since, Math.max(1, Math.min(200, Number(limit) || 50)))
        .map(row => {
          let params = {};
          try { params = row.params ? JSON.parse(row.params) : {}; } catch (_) {}
          return { ...row, params };
        });
    } catch (e) { console.error('[DB] listUserRoundsSince:', e.message); return []; }
  },

  /* Атомарный claim раунда: INSERT OR IGNORE по PRIMARY KEY round_id.
     Возвращает true только победителю гонки; второй параллельный запрос
     с тем же roundId получит false и не спишет деньги. */
  claimRound: (r) => {
    const res = db.prepare(`
      INSERT OR IGNORE INTO game_rounds
      (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price)
      VALUES (?, ?, ?, ?, 1, 0, ?, ?, NULL, NULL, NULL)
    `).run(String(r.roundId), r.userId, String(r.game), Math.floor(r.bet || 0),
      String(r.status || 'pending'), r.createdAt || Date.now());
    return res.changes > 0;
  },
  releaseRoundClaim: (roundId, userId) => {
    try { db.prepare(`DELETE FROM game_rounds WHERE round_id = ? AND user_id = ? AND status IN ('pending','active')`).run(String(roundId), userId); } catch (_) {}
  },
  settleRound: (r) => {
    // Множитель 0 (проигрыш) должен сохраняться как 0; undefined/null — по-прежнему 1.
    const multOf = v => (v === undefined || v === null) ? 1 : Number(v);
    const at = r.settledAt || Date.now();
    db.prepare(`
      UPDATE game_rounds
      SET game = ?, bet_tokens = ?, mult = ?, win_tokens = ?, status = ?, settled_at = ?,
          item_code = ?, item_price = ?
      WHERE round_id = ? AND user_id = ?
    `).run(String(r.game), Math.floor(r.bet || 0), multOf(r.mult), Math.floor(r.win || 0),
      r.status || 'settled', at, r.itemCode || null,
      r.itemPrice != null ? Math.floor(r.itemPrice) : null, String(r.roundId), r.userId);
    turso.queueQuery(`
      UPDATE game_rounds SET game = ?, bet_tokens = ?, mult = ?, win_tokens = ?, status = ?, settled_at = ?, item_code = ?, item_price = ?
      WHERE round_id = ? AND user_id = ?
    `, [String(r.game), Math.floor(r.bet || 0), multOf(r.mult), Math.floor(r.win || 0),
      r.status || 'settled', at, r.itemCode || null,
      r.itemPrice != null ? Math.floor(r.itemPrice) : null, String(r.roundId), r.userId]);
    return { ok: true, roundId: String(r.roundId) };
  },

  /* Закрыть раунд только если он ещё открыт. Нужно для автоматического
     проигрыша Ракетки и свипа Pulse: не перезаписывает уже рассчитанный раунд
     и не даёт закрыть его дважды после перезапуска. */
  settleRoundOnce: (r) => {
    const multOf = v => (v === undefined || v === null) ? 1 : Number(v);
    const at = r.settledAt || Date.now();
    const res = db.prepare(`
      UPDATE game_rounds
      SET game = ?, bet_tokens = ?, mult = ?, win_tokens = ?, status = ?, settled_at = ?,
          item_code = ?, item_price = ?
      WHERE round_id = ? AND user_id = ? AND status IN ('pending', 'active')
    `).run(String(r.game), Math.floor(r.bet || 0), multOf(r.mult), Math.floor(r.win || 0),
      r.status || 'settled', at, r.itemCode || null,
      r.itemPrice != null ? Math.floor(r.itemPrice) : null, String(r.roundId), r.userId);
    turso.queueQuery(`
      UPDATE game_rounds SET game = ?, bet_tokens = ?, mult = ?, win_tokens = ?, status = ?, settled_at = ?, item_code = ?, item_price = ?
      WHERE round_id = ? AND user_id = ? AND status IN ('pending', 'active')
    `, [String(r.game), Math.floor(r.bet || 0), multOf(r.mult), Math.floor(r.win || 0),
      r.status || 'settled', at, r.itemCode || null,
      r.itemPrice != null ? Math.floor(r.itemPrice) : null, String(r.roundId), r.userId]);
    return res.changes > 0;
  },

  /* ── Новые кейсы / апгрейдер ─────────────────────────────────────────── */
  atomicOpenCase,
  atomicUpgradeRun,
  atomicLadderStart,
  atomicLadderStep,
  atomicLadderCashout,
  atomicScratchPlay,
  atomicSafeGuess,
  getIdempotentResult,
  getCaseHistory: (userId, limit = 20) => {
    try {
      return db.prepare(`SELECT * FROM case_opens WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(userId, Math.max(1, Math.min(50, Number(limit) || 20))).map(__mapCaseOpen);
    } catch (e) { console.error('[DB] getCaseHistory:', e.message); return []; }
  },
  getUpgradeRun: (requestId, userId) => {
    try {
      const row = db.prepare('SELECT * FROM upgrade_runs WHERE request_id = ? AND user_id = ?')
        .get(String(requestId), userId);
      return __mapUpgradeRow(row);
    } catch (e) { console.error('[DB] getUpgradeRun:', e.message); return null; }
  },
  getLadderByRequest: (requestId, userId) => {
    try {
      const row = db.prepare('SELECT * FROM upgrade_sessions WHERE request_id = ? AND user_id = ?')
        .get(String(requestId), userId);
      return __mapSession(row);
    } catch (e) { console.error('[DB] getLadderByRequest:', e.message); return null; }
  },
  getUpgradeHistory: (userId, limit = 20) => {
    try {
      return db.prepare(`SELECT * FROM upgrade_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(userId, Math.max(1, Math.min(50, Number(limit) || 20))).map(__mapUpgradeRow);
    } catch (e) { console.error('[DB] getUpgradeHistory:', e.message); return []; }
  },
  getLadderSession: (sessionId, userId) => {
    try {
      const row = db.prepare('SELECT * FROM upgrade_sessions WHERE id = ? AND user_id = ?').get(String(sessionId), userId);
      return __mapSession(row);
    } catch (e) { console.error('[DB] getLadderSession:', e.message); return null; }
  },
  getUpgradeAction: (requestId, userId) => {
    try {
      const row = db.prepare('SELECT * FROM upgrade_actions WHERE request_id = ? AND user_id = ?')
        .get(String(requestId), userId);
      return row ? { action: row.action, stepIndex: row.step_index, result: JSON.parse(row.result_json || '{}') } : null;
    } catch (e) { console.error('[DB] getUpgradeAction:', e.message); return null; }
  },
  getActiveLadder: (userId) => {
    try {
      const row = db.prepare(`SELECT * FROM upgrade_sessions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(userId);
      return __mapSession(row);
    } catch (e) { console.error('[DB] getActiveLadder:', e.message); return null; }
  },

  /* Атомарный захват права на +25% к первому депозиту. Флаг ставится
     условным UPDATE ... WHERE first_deposit_bonus_claimed = 0: два
     параллельных первых депозита не могут получить бонус дважды. */
  /* Атомарное списание бесплатного кейса: два параллельных запроса не могут
     оба увидеть free_cases=1 и получить два предмета. */
  claimFreeCase: (userId) => {
    const res = db.prepare('UPDATE users SET free_cases = free_cases - 1 WHERE id = ? AND COALESCE(free_cases, 0) > 0').run(userId);
    if (res.changes > 0) {
      turso.queueQuery('UPDATE users SET free_cases = free_cases - 1 WHERE id = ? AND COALESCE(free_cases, 0) > 0', [userId]);
      return true;
    }
    return false;
  },
  refundFreeCase: (userId) => {
    try {
      db.prepare('UPDATE users SET free_cases = COALESCE(free_cases, 0) + 1 WHERE id = ?').run(userId);
      turso.queueQuery('UPDATE users SET free_cases = COALESCE(free_cases, 0) + 1 WHERE id = ?', [userId]);
    } catch (_) {}
  },
  claim5RefCase: (userId) => {
    const res = db.prepare('UPDATE users SET free_case_5ref_claimed = 1 WHERE id = ? AND COALESCE(free_case_5ref_claimed, 0) = 0').run(userId);
    if (res.changes > 0) {
      turso.queueQuery('UPDATE users SET free_case_5ref_claimed = 1 WHERE id = ?', [userId]);
      return true;
    }
    return false;
  },
  /* ── Бесплатные кейсы и уведомления о кулдаунах ──────────────────────── */
  claimDailyFreeCase: (userId, at, cutoff) => {
    const res = db.prepare('UPDATE users SET free_daily_at = ? WHERE id = ? AND COALESCE(free_daily_at, 0) <= ?')
      .run(Number(at), Number(userId), Number(cutoff));
    if (res.changes > 0) {
      turso.queueQuery('UPDATE users SET free_daily_at = ? WHERE id = ? AND COALESCE(free_daily_at, 0) <= ?',
        [Number(at), Number(userId), Number(cutoff)]);
      return true;
    }
    return false;
  },
  releaseDailyFreeCase: (userId, prevAt) => {
    try {
      db.prepare('UPDATE users SET free_daily_at = ? WHERE id = ?').run(Number(prevAt || 0), Number(userId));
      turso.queueQuery('UPDATE users SET free_daily_at = ? WHERE id = ?', [Number(prevAt || 0), Number(userId)]);
    } catch (_) {}
  },
  claim3RefCase: (userId) => {
    const res = db.prepare('UPDATE users SET free_case_3ref_claimed = 1 WHERE id = ? AND COALESCE(free_case_3ref_claimed, 0) = 0')
      .run(Number(userId));
    if (res.changes > 0) {
      turso.queueQuery('UPDATE users SET free_case_3ref_claimed = 1 WHERE id = ?', [Number(userId)]);
      return true;
    }
    return false;
  },
  release3RefCase: (userId) => {
    try {
      db.prepare('UPDATE users SET free_case_3ref_claimed = 0 WHERE id = ?').run(Number(userId));
      turso.queueQuery('UPDATE users SET free_case_3ref_claimed = 0 WHERE id = ?', [Number(userId)]);
    } catch (_) {}
  },
  setFreeNotified: (userId, at, day) => {
    try {
      db.prepare('UPDATE users SET free_notified_at = ?, free_notify_day = ? WHERE id = ?')
        .run(Number(at), String(day || ''), Number(userId));
      turso.queueQuery('UPDATE users SET free_notified_at = ?, free_notify_day = ? WHERE id = ?',
        [Number(at), String(day || ''), Number(userId)]);
    } catch (_) {}
  },
  listCooldownNotifyCandidates: (now, day, limit = 60) => {
    try {
      const idleBefore = Number(now) - 30 * 60 * 1000;
      const activeSince = Number(now) - 14 * 86400000;
      return db.prepare(`
        SELECT u.id, u.name, u.username, u.last_seen_at,
               COALESCE(u.free_daily_at, 0) AS free_daily_at,
               COALESCE(u.last_wheel_spin, 0) AS last_wheel_spin,
               COALESCE(u.last_hot_drop, 0) AS last_hot_drop,
               COALESCE(u.free_notified_at, 0) AS free_notified_at,
               COALESCE(u.free_notify_day, '') AS free_notify_day
        FROM users u
        WHERE u.last_seen_at >= ?
          AND u.last_seen_at <= ?
          AND (
            (u.free_daily_at > 0 AND u.free_daily_at <= ? AND COALESCE(u.free_notified_at, 0) < u.free_daily_at + 86400000)
            OR (u.last_wheel_spin > 0 AND u.last_wheel_spin <= ? AND COALESCE(u.free_notified_at, 0) < u.last_wheel_spin + 43200000)
            OR (u.last_hot_drop > 0 AND u.last_hot_drop <= ? AND COALESCE(u.free_notified_at, 0) < u.last_hot_drop + 3600000)
            OR (COALESCE(u.free_notify_day, '') <> ? AND u.created_at <= ?)
          )
        ORDER BY u.last_seen_at DESC
        LIMIT ?
      `).all(
        activeSince, idleBefore,
        Number(now) - 86400000,
        Number(now) - 12 * 3600000,
        Number(now) - 3600000,
        String(day || ''), Number(now) - 86400000,
        Number(limit) || 60
      );
    } catch (e) {
      console.error('[DB] listCooldownNotifyCandidates:', e.message);
      return [];
    }
  },
  release5RefCase: (userId) => {
    try {
      db.prepare('UPDATE users SET free_case_5ref_claimed = 0 WHERE id = ?').run(userId);
      turso.queueQuery('UPDATE users SET free_case_5ref_claimed = 0 WHERE id = ?', [userId]);
    } catch (_) {}
  },

  claimFirstDepositBonus: (userId) => {
    const res = db.prepare('UPDATE users SET first_deposit_bonus_claimed = 1 WHERE id = ? AND COALESCE(first_deposit_bonus_claimed, 0) = 0').run(userId);
    if (res.changes > 0) {
      turso.queueQuery('UPDATE users SET first_deposit_bonus_claimed = 1 WHERE id = ?', [userId]);
      return true;
    }
    return false;
  },
  releaseFirstDepositBonusClaim: (userId) => {
    try {
      db.prepare('UPDATE users SET first_deposit_bonus_claimed = 0 WHERE id = ?').run(userId);
      turso.queueQuery('UPDATE users SET first_deposit_bonus_claimed = 0 WHERE id = ?', [userId]);
    } catch (_) {}
  },

  /* ── Инвентарь ──────────────────────────────────────────────────────────
     Цена и название берутся из СЕРВЕРНОГО каталога items.js, а не из запроса
     клиента: иначе игрок пришлёт price: 999999 и продаст вентилятор за миллион. */
  addInventoryItem: (r) => {
    const acAt = r.acquiredAt || Date.now();
    const upgOnly = (r.upgradeOnly || r.upgrade_only) ? 1 : 0;
    const collectible = (r.collectible || r.isCollectible) ? 1 : 0;
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
      upgOnly,
      collectible
    );
    const newId = Number(res.lastInsertRowid);
    turso.queueQuery(`
      INSERT OR IGNORE INTO user_inventory (id, user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for, upgrade_only, collectible)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `, [
      newId, r.userId, String(r.itemCode), String(r.name || ''), String(r.icon || ''),
      Math.floor(r.price || 0), String(r.tier || ''), String(r.caseId || ''),
      String(r.caseName || ''), String(r.roundId || ''), acAt, upgOnly, collectible
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
  listPromos: (limit = 100) => {
    try {
      const n = Math.max(1, Math.min(300, Math.floor(Number(limit) || 100)));
      return db.prepare(`
        SELECT p.code, p.tokens, p.max_uses, p.created_at,
               (SELECT COUNT(*) FROM promo_activations a WHERE a.promo_code = p.code) AS used
        FROM promo_codes p
        ORDER BY p.created_at DESC
        LIMIT ?
      `).all(n).map(r => ({
        code: r.code,
        tokens: Number(r.tokens || 0),
        maxUses: Number(r.max_uses || 0),
        used: Number(r.used || 0),
        createdAt: Number(r.created_at || 0)
      }));
    } catch (e) {
      console.error('[DB] listPromos error:', e.message);
      return [];
    }
  },
  deletePromo: (code) => {
    try {
      const norm = String(code || '').trim().toUpperCase();
      const r = db.prepare('DELETE FROM promo_codes WHERE code = ?').run(norm);
      if (Number(r && r.changes) > 0) {
        turso.queueQuery('DELETE FROM promo_codes WHERE code = ?', [norm]);
      }
      return { ok: Number(r && r.changes) > 0 };
    } catch (e) {
      console.error('[DB] deletePromo error:', e.message);
      return { ok: false, error: 'Не удалось удалить промокод' };
    }
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

      // 4. Игровые раунды (возврат игроку, GGR, оборот)
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

      const activePlayersCount = Number((db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS count FROM game_rounds WHERE created_at >= ?
      `).get(since) || {}).count || 0);

      const maxWinTk = Number((db.prepare(`
        SELECT COALESCE(MAX(win_tokens), 0) AS maxWin FROM game_rounds WHERE created_at >= ?
      `).get(since) || {}).maxWin || 0);

      const balanceLiabilityTk = Number((db.prepare(`
        SELECT COALESCE(SUM(tokens), 0) AS total FROM users
      `).get() || {}).total || 0);

      const depPending = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(rub), 0) AS totalRub
        FROM orders WHERE type = 'deposit' AND status = 'pending'
      `).get() || { count: 0, totalRub: 0 };

      // Заявки: сроки, просрочки и скорость обработки
      const DAY_MS = 86400000;
      const depPendingDetailed = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(rub), 0) AS totalRub, MIN(created_at) AS oldest
        FROM orders WHERE type = 'deposit' AND status = 'pending'
      `).get() || { count: 0, totalRub: 0, oldest: 0 };
      const depExpiringSoon = db.prepare(`
        SELECT COUNT(*) AS count FROM orders
        WHERE type = 'deposit' AND status = 'pending'
          AND expires_at > 0 AND expires_at <= ?
      `).get(now + 15 * 60000) || { count: 0 };
      const depExpired24h = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(rub), 0) AS totalRub
        FROM orders WHERE type = 'deposit' AND status = 'expired' AND updated_at >= ?
      `).get(now - DAY_MS) || { count: 0, totalRub: 0 };
      const depExpiredAll = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(rub), 0) AS totalRub
        FROM orders WHERE type = 'deposit' AND status = 'expired'
      `).get() || { count: 0, totalRub: 0 };
      const wdPendingDetailed = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(rub), 0) AS totalRub, MIN(created_at) AS oldest
        FROM orders WHERE type = 'withdraw' AND status = 'pending'
      `).get() || { count: 0, totalRub: 0, oldest: 0 };
      const wdOverHour = db.prepare(`
        SELECT COUNT(*) AS count FROM orders
        WHERE type = 'withdraw' AND status = 'pending' AND created_at <= ?
      `).get(now - 3600000) || { count: 0 };
      const depPaySpeed = db.prepare(`
        SELECT AVG(updated_at - created_at) AS avgMs FROM orders
        WHERE type = 'deposit' AND status = 'paid' AND created_at >= ?
      `).get(since) || { avgMs: 0 };
      const depStatusRows = db.prepare(`
        SELECT status, COUNT(*) AS count, COALESCE(SUM(rub), 0) AS totalRub
        FROM orders WHERE type = 'deposit' AND created_at >= ?
        GROUP BY status
      `).all(since);
      const depStatusCounts = {};
      depStatusRows.forEach(r => {
        depStatusCounts[r.status || 'unknown'] = { count: r.count, rub: Number(r.totalRub) || 0 };
      });

      // Аудитория и деньги
      const active24h = Number((db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS count FROM game_rounds WHERE created_at >= ?
      `).get(now - DAY_MS) || {}).count || 0);
      const active7d = Number((db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS count FROM game_rounds WHERE created_at >= ?
      `).get(now - 7 * DAY_MS) || {}).count || 0);
      const newUsers24h = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE created_at >= ?
      `).get(now - DAY_MS) || {}).count || 0);
      const newUsers7d = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE created_at >= ?
      `).get(now - 7 * DAY_MS) || {}).count || 0);
      const bonusesPaid = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total FROM transactions_ledger
        WHERE amount > 0 AND (type LIKE '%bonus%' OR type = 'rakeback') AND created_at >= ?
      `).get(since) || { total: 0 };
      const stakedTk = Number((db.prepare(`
        SELECT COALESCE(SUM(staked), 0) AS total FROM users
      `).get() || {}).total || 0);
      const refEarnedTk = Number((db.prepare(`
        SELECT COALESCE(SUM(ref_earned), 0) AS total FROM users
      `).get() || {}).total || 0);

      const topDepositors = db.prepare(`
        SELECT u.id, u.num_id, u.name, u.username,
               COUNT(*) AS depositsCount,
               COALESCE(SUM(o.rub), 0) AS totalRub
        FROM orders o
        JOIN users u ON u.id = o.user_id
        WHERE o.type = 'deposit' AND o.status = 'paid' AND o.created_at >= ?
        GROUP BY u.id
        ORDER BY totalRub DESC
        LIMIT 5
      `).all(since).map(x => ({
        id: x.id,
        numId: x.num_id,
        name: x.name,
        username: x.username,
        label: x.username ? '@' + x.username : (x.name || 'ID ' + x.id),
        depositsCount: x.depositsCount,
        totalRub: Number(x.totalRub) || 0
      }));

      const hourlyRows = db.prepare(`
        SELECT CAST((? - created_at) / 3600000 AS INTEGER) AS bucket,
               COUNT(*) AS rounds,
               COALESCE(SUM(bet_tokens), 0) AS wagered,
               COALESCE(SUM(win_tokens), 0) AS payouts
        FROM game_rounds
        WHERE created_at >= ?
        GROUP BY bucket
      `).all(now, now - DAY_MS);
      const hourlyMap = new Map(hourlyRows.map(r => [Number(r.bucket), r]));
      const hourly = Array.from({ length: 24 }, (_, idx) => {
        const bucket = 23 - idx;
        const row = hourlyMap.get(bucket);
        const wag = Number(row && row.wagered || 0);
        const pay = Number(row && row.payouts || 0);
        return {
          hoursAgo: bucket,
          rounds: Number(row && row.rounds || 0),
          wageredTk: wag,
          payoutTk: pay,
          ggrRub: (wag - pay) / 10
        };
      });

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
          cashflowNetRub: depStats.totalRub - wdPaid.totalRub,
          activePlayers: activePlayersCount,
          avgBetTk: roundsSummary.count > 0 ? Number((wagered / roundsSummary.count).toFixed(0)) : 0,
          betsPerPlayer: activePlayersCount > 0 ? Number((roundsSummary.count / activePlayersCount).toFixed(1)) : 0,
          winRatePct: roundsSummary.count > 0
            ? Number((byGame.reduce((s, g) => s + Number(g.wins || 0), 0) / roundsSummary.count * 100).toFixed(1))
            : 0,
          maxWinTk,
          balanceLiabilityTk,
          avgDepositRub: depStats.count > 0 ? Number((Number(depStats.totalRub) / depStats.count).toFixed(0)) : 0,
          arpuRub: totalUsersCount > 0 ? Number((Number(depStats.totalRub) / totalUsersCount).toFixed(0)) : 0,
          arppuRub: payingUsersCount > 0 ? Number((Number(depStats.totalRub) / payingUsersCount).toFixed(0)) : 0,
          payerSharePct: totalUsersCount > 0 ? Number((totalPayingUsersCount / totalUsersCount * 100).toFixed(1)) : 0,
          pendingDepositsCount: Number(depPending.count) || 0,
          pendingDepositsRub: Number(depPending.totalRub) || 0,
          pendingDepositsOldestAt: Number(depPendingDetailed.oldest) || 0,
          pendingDepositsExpiringSoon: Number(depExpiringSoon.count) || 0,
          expiredDeposits24h: Number(depExpired24h.count) || 0,
          expiredDepositsRub24h: Number(depExpired24h.totalRub) || 0,
          expiredDepositsTotal: Number(depExpiredAll.count) || 0,
          expiredDepositsRubTotal: Number(depExpiredAll.totalRub) || 0,
          withdrawalsPendingOldestAt: Number(wdPendingDetailed.oldest) || 0,
          withdrawalsPendingOverHour: Number(wdOverHour.count) || 0,
          avgDepositConfirmMin: depPaySpeed.avgMs
            ? Number((Number(depPaySpeed.avgMs) / 60000).toFixed(1))
            : 0,
          depositStatusCounts: depStatusCounts,
          activeUsers24h: active24h,
          activeUsers7d: active7d,
          newUsers24h,
          newUsers7d,
          bonusesPaidRub: Number(bonusesPaid.total) / 10,
          stakedRub: stakedTk / 10,
          referralPaidRub: refEarnedTk / 10
        },
        byGame,
        byProvider,
        topDepositors,
        hourly,
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
        jackpot_tokens: 0, guesses_count: 0
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
      return { jackpot: 0, guessesCount: 0, recentAttempts: [] };
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
        const newCode = String(1000 + crypto.randomInt(0, 9000));
        db.prepare(`
          UPDATE vault_safe
          SET jackpot_tokens = 0, secret_code = ?, guesses_count = 0, last_won_at = ?, last_winner_id = ?
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
  /* Идемпотентный клейм челленджа: одна выплата на (игрок, квест, дата).
     Возвращает true только если запись реально вставлена (первый клейм). */
  tryClaimChallenge: (userId, questId, claimDate) => {
    try {
      const res = stmts.insertChallengeClaim.run(userId, String(questId), String(claimDate), Date.now());
      if (!res || Number(res.changes) < 1) return false;
      turso.queueQuery(
        'INSERT OR IGNORE INTO challenge_claims (user_id, quest_id, claim_date, created_at) VALUES (?, ?, ?, ?)',
        [userId, String(questId), String(claimDate), Date.now()]
      );
      return true;
    } catch (e) {
      console.error('[DB] tryClaimChallenge error:', e.message);
      return false;
    }
  },
  pullFromTurso: () => turso.pullFromTurso(db),
  waitForTurso: (timeoutMs) => turso.waitForFlush(timeoutMs),
  tursoOn: turso.tursoOn
};
