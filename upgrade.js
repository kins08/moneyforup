'use strict';
/**
 * MoneyForUp — серверная модель Апгрейдера.
 *
 * Здесь живут ВСЕ параметры режимов риска, каталог целей и формулы шанса.
 * Клиент присылает только выбор (режим, источник, коды целей), но никогда —
 * вероятность, цену предмета или результат раунда.
 *
 * Формула одна для всех режимов:
 *   chance = clamp((1 − edge) × sourceValue / targetValue, 0, chanceCap)
 *   EV     = chance × targetValue − sourceValue = −edge × sourceValue
 * Верхний cap только уменьшает выплату в пользу кассы, нижнего пола нет:
 * иначе при дорогих целях EV становился бы положительным (печатный станок).
 */

const items = require('./items');

/* Единственный режим апгрейдера (DECISIONS.md, D4): режимы риска убраны из UI.
   Потолок шанса 70% для любой цели. Комиссия 6% — EV всегда −6% от источника. */
const MODES = {
  standard: {
    id: 'standard',
    label: 'АПГРЕЙД',
    title: 'Апгрейд',
    desc: 'Выберите цель дороже источника. Шанс до 70%, результат определяет сервер.',
    edge: 0.06,
    chanceCap: 0.70,
    maxMult: 100,
    minTargetRatio: 1.05,
    color: '#ffcf6b'
  }
};

/* Старые id режимов (до упрощения) принимаются и маппятся в `standard`,
   чтобы закэшированные клиенты и незавершённые лесенки не ломались. */
const LEGACY_MODE_IDS = { safe: 'standard', balanced: 'standard', extreme: 'standard', stable: 'standard', experimental: 'standard' };

const MAX_TARGETS = 5;

/** Один и тот же предмет не должен встречаться в каталоге целей дважды. */
function buildTargets() {
  const buckets = { cheap: [], low: [], profit: [], high: [], jackpot: [], secret: [] };
  const seen = new Set();
  for (const c of Object.values(items.CASES)) {
    for (const it of c.items) {
      if (!it || !it.code || seen.has(it.code)) continue;
      if (!Number.isFinite(it.price) || it.price < 10) continue;
      seen.add(it.code);
      const bucket = buckets[it.tier] || buckets.low;
      bucket.push({
        code: it.code,
        name: it.name,
        icon: it.icon || '📦',
        value: Math.floor(it.price),
        tier: it.tier || 'low',
        caseName: c.name
      });
    }
  }
  for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => a.value - b.value);
  // Пропорциональная выборка: каталог целей должен покрывать все ценовые
  // диапазоны, но не превращаться в список из 255 позиций в мобильном UI.
  const take = (arr, n) => {
    if (arr.length <= n) return arr.slice();
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(arr[Math.round(i * (arr.length - 1) / (n - 1))]);
    }
    return out;
  };
  const list = [
    ...take(buckets.cheap, 4),
    ...take(buckets.low, 6),
    ...take(buckets.profit, 8),
    ...take(buckets.high, 5),
    ...take(buckets.jackpot, 4),
    ...take(buckets.secret, 1)
  ];
  return list.sort((a, b) => a.value - b.value);
}

const TARGETS = buildTargets();
const TARGET_BY_CODE = new Map(TARGETS.map(t => [t.code, t]));

function getMode(raw) {
  const key = String(raw || '').trim().toLowerCase();
  const resolved = LEGACY_MODE_IDS[key] || key;
  return MODES[resolved] || null;
}

function getTarget(code) {
  return TARGET_BY_CODE.get(String(code || '')) || null;
}

function minChance(mode) {
  return 1 / Math.max(1, mode.maxMult);
}

/**
 * Проверка целей на сервере. Возвращает либо ошибку, либо нормализованный
 * список целей с уже посчитанными шансами.
 */
function validateTargets(mode, sourceValue, rawCodes) {
  if (!mode) return { ok: false, error: 'Неизвестный режим апгрейда' };
  if (!Number.isFinite(sourceValue) || sourceValue < 10) {
    return { ok: false, error: 'Минимальная стоимость источника — 10 ⬦' };
  }
  const codes = Array.isArray(rawCodes) ? rawCodes : [];
  if (!codes.length) return { ok: false, error: 'Выберите хотя бы одну цель' };
  if (codes.length > MAX_TARGETS) return { ok: false, error: `Можно выбрать не больше ${MAX_TARGETS} целей` };

  const uniq = [];
  const seen = new Set();
  for (const raw of codes) {
    const t = getTarget(raw);
    if (!t) return { ok: false, error: 'Цель не найдена в каталоге' };
    if (seen.has(t.code)) return { ok: false, error: 'Одна и та же цель выбрана дважды' };
    seen.add(t.code);
    if (t.value <= sourceValue * mode.minTargetRatio) {
      return { ok: false, error: `Цель «${t.name}» должна быть дороже источника минимум на 5%` };
    }
    if (t.value > sourceValue * mode.maxMult) {
      return { ok: false, error: `Цель «${t.name}» превышает потолок ${mode.maxMult}× для режима ${mode.label}` };
    }
    const chance = Math.min(mode.chanceCap, (1 - mode.edge) * sourceValue / t.value);
    if (!(chance > 0)) return { ok: false, error: 'Некорректная вероятность цели' };
    uniq.push({ ...t, price: t.value, chance, aggregateChance: chance / codes.length });
  }
  // Дубликаты уже отбиты выше — код ниже оставлен как страховка от
  // случайного повторного учёта одной цели в будущих правках.
  const sum = uniq.reduce((s, t) => s + t.aggregateChance, 0);
  return {
    ok: true,
    targets: uniq,
    aggregateChance: Math.min(1, sum),
    distribution: uniq.map(t => ({ code: t.code, chance: t.aggregateChance }))
  };
}

/**
 * Бросок мульти-апгрейда. Сначала равновероятно выбирается цель, затем
 * бросается её индивидуальный шанс. Итоговая вероятность = среднее шансов,
 * поэтому вероятности НЕ учитываются дважды.
 */
function rollUpgrade(mode, sourceValue, targets, randomTarget01, randomRoll01) {
  if (!targets.length) return { ok: false, error: 'Нет целей' };
  const idx = Math.min(targets.length - 1, Math.floor(randomTarget01 * targets.length));
  const target = targets[idx];
  const won = randomRoll01 < target.chance;
  const aggregateChance = targets.reduce((s, t) => s + t.chance, 0) / targets.length;
  return {
    ok: true,
    index: idx,
    target,
    won,
    chance: target.chance,
    aggregateChance,
    distribution: targets.map(t => ({ code: t.code, chance: t.chance / targets.length }))
  };
}

/* ── Лесенка ───────────────────────────────────────────────────────────────
   Множители подобраны так, чтобы каждый шаг оставался в пределах cap режима:
   SAFE — маленькие шаги; EXTREME — крупные, иначе cap 0.40 превращал бы
   экстремальный режим в самый невыгодный. */
const LADDER_MULTS = {
  standard: {
    3: [2.0, 1.7, 1.45],
    5: [1.8, 1.6, 1.45, 1.35, 1.25],
    10: [1.6, 1.5, 1.4, 1.35, 1.3, 1.25, 1.2, 1.18, 1.15, 1.12]
  }
};

function ladderSteps(raw, mode) {
  const n = Math.floor(Number(raw) || 0);
  if (![3, 5, 10].includes(n)) return null;
  const table = LADDER_MULTS[mode.id];
  return table ? table[n] : null;
}

function ladderChance(mode, mult) {
  return Math.min(mode.chanceCap, (1 - mode.edge) / mult);
}

/**
 * Полная конфигурация лесенки для клиента: шаги, множители и шансы.
 * Сервер всё равно пересчитывает их при каждом шаге — это только превью.
 */
function ladderPreview(mode, steps, sourceValue) {
  const mults = ladderSteps(steps, mode);
  if (!mults) return null;
  let value = Math.floor(sourceValue);
  return {
    steps,
    stepsTotal: steps,
    sourceValue: value,
    stepsData: mults.map((mult, i) => {
      const chance = ladderChance(mode, mult);
      value = Math.floor(value * mult);
      return { step: i + 1, mult, chance, valueAfter: value };
    }),
    finalValue: value
  };
}

module.exports = {
  MODES,
  TARGETS,
  MAX_TARGETS,
  LADDER_MULTS,
  getMode,
  getTarget,
  validateTargets,
  rollUpgrade,
  ladderSteps,
  ladderChance,
  ladderPreview,
  minChance
};
