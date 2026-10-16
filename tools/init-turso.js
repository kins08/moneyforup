#!/usr/bin/env node
'use strict';
/**
 * Инициализация схемы в ОБЛАКЕ Turso (LibSQL) — НЕ в локальной БД.
 *
 * Зачем: на Render/Fly локальный диск эфемерный, и при рестарте база
 * восстанавливается из Turso (turso.js -> pullFromTurso). Если в Turso нет
 * таблиц или колонок, синхронизация молча теряет данные. Важно: этот скрипт
 * обязан ходить именно в Turso по TURSO_DATABASE_URL.
 *
 * Источник схемы — schema.js (общий с локальным слоем db.js), поэтому локальная
 * и облачная схемы больше не расходятся.
 *
 * Запуск:
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node tools/init-turso.js
 */
const path = require('path');
const { SCHEMA_SQL, EXTRA_COLUMNS } = require('../schema');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL не задан — инициализировать нечего (это скрипт для облака Turso).');
  process.exit(1);
}

let createClient;
try {
  ({ createClient } = require('@libsql/client'));
} catch (e) {
  ({ createClient } = require(path.join(process.cwd(), 'node_modules/@libsql/client')));
}

const client = createClient({ url, authToken });

(async () => {
  // 1. Полная схема. client.execute выполняет один стейтмент, поэтому режем по ';'.
  const statements = SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean);
  for (const s of statements) {
    await client.execute(s);
  }

  // 2. Догоняющие колонки для давно живущей облачной базы.
  for (const [table, cols] of Object.entries(EXTRA_COLUMNS)) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    const have = new Set(info.rows.map(r => r.name));
    for (const [name, type] of cols) {
      if (!have.has(name)) {
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        console.log(`[Turso] + колонка ${table}.${name}`);
      }
    }
  }

  console.log('MoneyForUp: схема Turso инициализирована.');
  process.exit(0);
})().catch(e => {
  console.error('Ошибка инициализации Turso:', e.message);
  process.exit(1);
});
