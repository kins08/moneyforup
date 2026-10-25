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
  [path.join('assets', 'case-modes.js'), path.join('public', 'assets', 'case-modes.js')],
  [path.join('assets', 'rubup-catalog.css'), path.join('public', 'assets', 'rubup-catalog.css')]
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

/* Картинки: assets/*.{jpg,png} и assets/cases/*.{jpg,png} -> public/assets/…
   Раньше синхронизировались только обложки кейсов, из-за чего новые обложки
   игр (game_pulse.jpg, game_trend.jpg) не попадали в public/ и в проде
   карточки были с битой картинкой. */
for (const sub of ['', 'cases', 'items']) {
  const srcDir = path.join(ROOT, 'assets', sub);
  const dstDir = path.join(ROOT, 'public', 'assets', sub);
  if (!fs.existsSync(srcDir)) continue;
  const label = sub ? `обложки кейсов` : 'картинки assets/';
  const files = fs.readdirSync(srcDir).filter(f => /\.jpe?g|\.png$/i.test(f)).sort();
  let bad = 0;
  for (const f of files) {
    const srcPath = path.join(srcDir, f);
    const dstPath = path.join(dstDir, f);
    const src = fs.readFileSync(srcPath);
    const dst = fs.existsSync(dstPath) ? fs.readFileSync(dstPath) : null;
    if (dst && src.equals(dst)) continue;
    if (checkOnly) {
      console.error(`✗ Картинка разошлась: assets/${sub ? sub + '/' : ''}${f} != public/assets/${sub ? sub + '/' : ''}${f}`);
      failed = true;
      bad++;
      continue;
    }
    fs.mkdirSync(dstDir, { recursive: true });
    fs.writeFileSync(dstPath, src);
    bad++;
  }
  if (checkOnly) {
    if (!bad) console.log(`✓ ${label} синхронизированы (${files.length} шт.)`);
  } else {
    console.log(`✓ ${label}: ${files.length} шт., обновлено ${bad}`);
  }
}

if (failed) {
  console.error('  Запустите: node tools/sync-frontend.js  (или npm run sync:frontend)');
  process.exit(1);
}
process.exit(0);
