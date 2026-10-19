#!/usr/bin/env node
'use strict';
/**
 * Синхронизация двух копий фронта (P2-5).
 *
 * В прод (Cloudflare, wrangler.jsonc -> assets.directory: "public") уходит
 * ТОЛЬКО public/, а корневые index.html и assets/case-modes.js — источники
 * правды. Правка только одной из копий = фикс не доехал до прода (или наоборот).
 *
 *   node tools/sync-frontend.js           # скопировать источник -> public/
 *   node tools/sync-frontend.js --check   # только проверить (exit 1, если нет)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAIRS = [
  ['index.html', path.join('public', 'index.html')],
  [path.join('assets', 'case-modes.js'), path.join('public', 'assets', 'case-modes.js')]
];
const checkOnly = process.argv.includes('--check');
let failed = false;

for (const [srcRel, dstRel] of PAIRS) {
  const srcPath = path.join(ROOT, srcRel);
  const dstPath = path.join(ROOT, dstRel);
  if (!fs.existsSync(srcPath)) {
    console.error(`✗ Нет источника: ${srcRel}`);
    failed = true;
    continue;
  }
  const src = fs.readFileSync(srcPath);
  const dst = fs.existsSync(dstPath) ? fs.readFileSync(dstPath) : null;
  if (dst && src.equals(dst)) {
    console.log(`✓ ${srcRel} и ${dstRel} идентичны`);
    continue;
  }
  if (checkOnly) {
    console.error(`✗ Копии фронта разошлись: ${srcRel} != ${dstRel}`);
    failed = true;
    continue;
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, src);
  console.log(`✓ ${dstRel} обновлён из ${srcRel} (${src.length} байт)`);
}

if (failed) {
  console.error('  Запустите: node tools/sync-frontend.js  (или npm run sync:frontend)');
  process.exit(1);
}
process.exit(0);
