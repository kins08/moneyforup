'use strict';
const db = require('../db').db;
const q = s => '"' + String(s).replace(/"/g,'""') + '"';
for (const [table, cols] of Object.entries({
  users: [['last_hot_drop','INTEGER DEFAULT 0'],['last_wheel_spin','INTEGER DEFAULT 0'],['last_streak_at','INTEGER DEFAULT 0'],['rakeback','REAL DEFAULT 0'],['free_cases','INTEGER DEFAULT 0'],['free_case_5ref_claimed','INTEGER DEFAULT 0'],['first_deposit_bonus_claimed','INTEGER DEFAULT 0']],
  orders: [['bonus',"TEXT DEFAULT ''"]],
  user_inventory: [['upgrade_only','INTEGER DEFAULT 0']]
})) {
  const have = new Set(db.prepare(`PRAGMA table_info(${q(table)})`).all().map(x => x.name));
  for (const [n,t] of cols) if (!have.has(n)) db.exec(`ALTER TABLE ${q(table)} ADD COLUMN ${q(n)} ${t}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS processed_payments(provider TEXT NOT NULL, external_id TEXT NOT NULL, processed_at INTEGER NOT NULL, PRIMARY KEY(provider,external_id)); CREATE TABLE IF NOT EXISTS referral_payouts(deposit_id TEXT NOT NULL, referrer_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(deposit_id,referrer_id)); CREATE TABLE IF NOT EXISTS challenge_claims(user_id INTEGER NOT NULL, quest_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,quest_id));`);
console.log('MoneyForUp schema migration completed');
