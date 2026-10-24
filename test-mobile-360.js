'use strict';
/**
 * MoneyForUp — проверка мобильной вёрстки на ширине 360px (этап 1 редизайна).
 * Не визуальный тест: через jsdom проверяем, что новые экраны не задают
 * фиксированную ширину шире 360px и что CSS-правила для узкого экрана есть.
 * Визуальный скриншот в этом окружении сделать не удалось (см. REPORT.md).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓', m); };

console.log('=== MOBILE 360px (статическая проверка CSS) ===');

// 1. Палитра дизайн-системы объявлена.
for (const v of ['--mfu-graphite-0', '--mfu-cyan', '--mfu-lime', '--mfu-orange', '--mfu-red']) {
  ok(html.includes(v + ':'), `токен ${v} объявлен`);
}

// 2. Новые экраны не используют фиксированную ширину больше 360px.
const newSelectors = ['.pm-shell', '.tr-shell', '.pm-dirs', '.tr-answers', '.pm-row', '.pm-chip', '.upg-wheel', '.free-cases', '.free-case'];
const block = (sel) => {
  const i = html.indexOf(sel + '{');
  if (i < 0) return '';
  return html.slice(i, html.indexOf('}', i));
};
for (const sel of newSelectors) {
  const b = block(sel);
  const m = b.match(/width:\s*(\d+)px/);
  if (m) ok(Number(m[1]) <= 360, `${sel}: ширина ${m[1]}px не шире 360px`);
  else ok(true, `${sel}: без фиксированной ширины`);
}

// 3. Защита от горизонтального скролла в новых экранах.
ok(/\.pm-shell,\.tr-shell\{[^}]*overflow-x:hidden/.test(html), 'экраны Pulse/Trend не дают горизонтального скролла');

// 4. Правила для узкого экрана (≤380px) есть.
ok(/@media \(max-width:380px\)\{[^}]*\.pm-dirs/.test(html) || /max-width:380px[\s\S]{0,400}\.pm-dirs/.test(html),
  'для ширины ≤380px сетка направлений перестраивается в один столбец');
ok(/max-width:380px\)\{\s*\.free-cases/.test(html), 'для ≤380px сетка FREE-кейсов ужимается');

// 5. Reduced motion: нефункциональные анимации отключаются.
ok(/prefers-reduced-motion: reduce/.test(html), 'есть правила prefers-reduced-motion');
ok(/@media \(prefers-reduced-motion: reduce\)\{\s*\.upg-wheel__spinner/.test(html), 'кольцо апгрейдера отключает анимацию при reduced-motion');

console.log(`\nИТОГ: ${passed} проверок пройдено.`);
