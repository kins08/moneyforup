'use strict';

const { db } = require('../db');

const quoteIdent = value => '"' + String(value).replace(/"/g, '""') + '"';
const ensureColumns = (table, columns) => {
  const tableSql = quoteIdent(table);
  const present = new Set(db.prepare(`PRAGMA table_info(${tableSql})`).all().map(row => row.name));
  for (const [name, type] of columns) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${tableSql} ADD COLUMN ${quoteIdent(name)} ${type}`);
  }
};

ensureColumns('users', [
  ['last_hot_drop', 'INTEGER DEFAULT 0'],
  ['last_wheel_spin', 'INTEGER DEFAULT 0'],
  ['last_streak_at', 'INTEGER DEFAULT 0'],
  ['deposit_payment_hash', 'TEXT'],
  ['deposit_ip_hash', 'TEXT'],
  ['deposit_device_hash', 'TEXT'],
  ['self_ref_blocked', 'INTEGER DEFAULT 0']
]);
ensureColumns('orders', [
  ['bonus', "TEXT DEFAULT ''"],
  ['payment_hash', 'TEXT'],
  ['ip_hash', 'TEXT'],
  ['device_hash', 'TEXT']
]);

db.exec(`
CREATE TABLE IF NOT EXISTS processed_payments (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE TABLE IF NOT EXISTS referral_payouts (
  deposit_id TEXT NOT NULL,
  referrer_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (deposit_id, referrer_id)
);
CREATE TABLE IF NOT EXISTS challenge_claims (
  user_id INTEGER NOT NULL,
  quest_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, quest_id)
);
`);

console.log('MoneyForUp schema migration completed');
