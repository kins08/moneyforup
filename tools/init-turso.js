const { createClient } = require('@libsql/client');

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (_) {}
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error('Ошибка: не заданы TURSO_DATABASE_URL или TURSO_AUTH_TOKEN');
    process.exit(1);
  }

  const schema = [
    `CREATE TABLE IF NOT EXISTS users (
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
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
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
    )`,
    `CREATE TABLE IF NOT EXISTS transactions_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount INTEGER,
      type TEXT,
      reason TEXT,
      reference_id TEXT,
      balance_before INTEGER,
      balance_after INTEGER,
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      tokens INTEGER,
      max_uses INTEGER,
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS promo_activations (
      promo_code TEXT,
      user_id INTEGER,
      activated_at INTEGER,
      PRIMARY KEY (promo_code, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS game_rounds (
      round_id TEXT PRIMARY KEY,
      user_id INTEGER,
      game TEXT,
      bet_tokens INTEGER,
      mult REAL,
      win_tokens INTEGER,
      status TEXT,
      created_at INTEGER,
      settled_at INTEGER,
      item_code TEXT,
      item_price INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS user_inventory (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_inv_user_unsold ON user_inventory(user_id, sold_at)`
  ];

  for (const s of schema) {
    await client.execute(s);
  }

  const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
  console.log('✅ Успешно инициализирована структура в Turso Cloud:');
  console.log(res.rows.map(r => r.name).join(', '));
}

main().catch(console.error);
