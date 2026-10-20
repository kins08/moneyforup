'use strict';
/**
 * Единая схема БД MoneyForUp.
 *
 * Используется и локальным слоем (db.js — node:sqlite), и инициализатором
 * облачной Turso (tools/init-turso.js). Одна схема на оба окружения — значит
 * локальная и облачная базы больше не расходятся (иначе после рестарта на
 * Render pull из Turso теряет колонки/таблицы).
 */

const SCHEMA_SQL = `
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
  first_deposit_bonus_claimed INTEGER DEFAULT 0,
  last_hot_drop INTEGER DEFAULT 0,
  last_wheel_spin INTEGER DEFAULT 0,
  last_streak_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS challenge_claims (
  user_id INTEGER NOT NULL,
  quest_id TEXT NOT NULL,
  claim_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, quest_id, claim_date)
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
  jackpot_tokens INTEGER DEFAULT 0,
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

-- ── Новые режимы кейсов (Case Hub) ──────────────────────────────────────
-- request_id — идемпотентность открытия: повторный запрос отдаёт сохранённый
-- результат и НЕ списывает цену кейса второй раз.
CREATE TABLE IF NOT EXISTS case_opens (
  request_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  mode_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  item_code TEXT,
  item_name TEXT,
  item_icon TEXT,
  item_price INTEGER,
  item_tier TEXT,
  inventory_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_opens_user ON case_opens(user_id, created_at DESC);

-- Бесплатный тест-прокрут: предмет не выдаётся, но даёт один реальный
-- «прогрев» следующего платного открытия этого кейса (лучший из двух дропов).
CREATE TABLE IF NOT EXISTS case_warmups (
  user_id INTEGER NOT NULL,
  case_id TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  last_roll_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, case_id)
);

-- ── Апгрейдер: журнал одиночных/мульти-апгрейдов ─────────────────────────
CREATE TABLE IF NOT EXISTS upgrade_runs (
  request_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_value INTEGER NOT NULL,
  source_item_id INTEGER,
  targets_json TEXT NOT NULL,
  won INTEGER NOT NULL,
  target_code TEXT,
  target_name TEXT,
  target_icon TEXT,
  target_value INTEGER,
  target_tier TEXT,
  chance REAL,
  aggregate_chance REAL,
  inventory_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upgrade_runs_user ON upgrade_runs(user_id, created_at DESC);

-- ── Апгрейдер: серверные сессии «Лесенки» ────────────────────────────────
-- Состояние переживает перезапуск приложения и сервера: раунд нельзя
-- «переиграть» после обновления страницы.
CREATE TABLE IF NOT EXISTS upgrade_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  steps_total INTEGER NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  source_value INTEGER NOT NULL,
  current_value INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_item_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',   -- active | completed | lost | cashed
  ladder_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_upgrade_sessions_user ON upgrade_sessions(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS upgrade_actions (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  action TEXT NOT NULL,                    -- step | cashout
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upgrade_action_step
  ON upgrade_actions(session_id, step_index, action);

-- Идемпотентные результаты быстрых игр (скретч, сейф): повтор запроса с тем
-- же requestId возвращает уже посчитанный результат, а не списывает второй раз.
CREATE TABLE IF NOT EXISTS idempotent_results (
  request_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/* Колонки, которые добавляются к уже существующим (старым) таблицам.
   CREATE TABLE IF NOT EXISTS их не добавит — нужен явный ALTER TABLE. */
const EXTRA_COLUMNS = {
  users: [
    ['rakeback', 'REAL DEFAULT 0'],
    ['free_cases', 'INTEGER DEFAULT 0'],
    ['free_case_5ref_claimed', 'INTEGER DEFAULT 0'],
    ['first_deposit_bonus_claimed', 'INTEGER DEFAULT 0'],
    ['last_hot_drop', 'INTEGER DEFAULT 0'],
    ['last_wheel_spin', 'INTEGER DEFAULT 0'],
    ['last_streak_at', 'INTEGER DEFAULT 0']
  ],
  orders: [['bonus', "TEXT DEFAULT ''"]],
  game_rounds: [['item_code', 'TEXT'], ['item_price', 'INTEGER'], ['seed', 'TEXT'], ['params', 'TEXT']],
  user_inventory: [['upgrade_only', 'INTEGER DEFAULT 0']]
};

module.exports = { SCHEMA_SQL, EXTRA_COLUMNS };
