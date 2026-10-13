#!/usr/bin/env node
'use strict';
/**
 * Синхронизация двух копий фронта (P2-5).
 *
 * В прод (Cloudflare, wrangler.jsonc -> assets.directory: "public") уходит
 * ТОЛЬКО public/index.html, а корень index.html — вторая копия того же файла.
 * Правка только одной из них = фикс не доехал до прода (или наоборот).
 *
 * Источник правды — корневой index.html.
 *   node tools/sync-frontend.js           # скопировать index.html -> public/index.html
 *   node tools/sync-frontend.js --check   # только проверить, что копии идентичны (exit 1, если нет)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const DST = path.join(ROOT, 'public', 'index.html');
const checkOnly = process.argv.includes('--check');

const src = fs.readFileSync(SRC);
const dst = fs.existsSync(DST) ? fs.readFileSync(DST) : null;

if (dst && src.equals(dst)) {
  console.log('✓ index.html и public/index.html идентичны');
  process.exit(0);
}
if (checkOnly) {
  console.error('✗ Копии фронта разошлись: index.html != public/index.html');
  console.error('  Запустите: node tools/sync-frontend.js  (или npm run sync:frontend)');
  process.exit(1);
}
fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, src);
console.log(`✓ public/index.html обновлён из index.html (${src.length} байт)`);
