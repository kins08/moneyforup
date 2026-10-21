'use strict';
/**
 * MoneyForUp — Trend Hunter (DECISIONS.md D6).
 *
 * Игрок видит график и определяет паттерн: РОСТ, ПАДЕНИЕ или БОКОВИК.
 * Сценарий (паттерн, сложность, правильный ответ) фиксируется на СЕРВЕРЕ
 * при генерации и не меняется после ответа игрока.
 *
 * Визуально сценарий намеренно неоднозначный: 128 базовых форм (8 профилей
 * × 4 режима волатильности × 4 фазы) и 25 оболочек (5 интервалов × 5 тонов).
 * Итоговое смещение всегда меньше внутридневных качелей, а против тренда
 * есть контр-движения — «по глазам» направление не считывается.
 *
 * Экономика:
 *   - Ставка из баланса, выплата = ставка × множитель сложности (фиксирован в коде).
 *   - Комбо за серию правильных ответов НЕ влияет на выплату — только отображение.
 *   - Вероятность угадать при трёх равновероятных паттернах = 1/3.
 *     Множитель сложности = 3 × (1 − edge): RTP = 1 − edge при любой сложности.
 */

const crypto = require('crypto');
const rtp = require('./rtp');

const TREND_EDGE = rtp.edgeOf('trend');
const TREND_MULT = Number((3 * (1 - TREND_EDGE)).toFixed(2));

const SHAPES = ['wave', 'steps', 'spike', 'channel', 'v', 'double', 'saw', 'drift'];
const VOL_REGIMES = [0.55, 1, 1.55, 2.2];
const PHASES = [0, 0.23, 0.48, 0.71];
const INTERVALS = ['1М', '5М', '15М', '1Ч', '4Ч'];
const TONES = ['mint', 'cyan', 'amber', 'violet', 'ice'];
const PRICE_BASES = [1260, 2470, 3890, 6150, 12400, 24800, 48700, 73400];

const TREND = {
  id: 'trend',
  label: 'TREND HUNTER',
  edge: TREND_EDGE,
  patterns: ['rise', 'fall', 'flat'],
  variants: SHAPES.length * VOL_REGIMES.length * PHASES.length,
  // Уровни сложности меняют ТОЛЬКО условия: длину ряда, шум и время на ответ.
  // Выплата одинакова на всех уровнях (3 паттерна → P = 1/3, множитель 3 × (1 − edge)),
  // поэтому RTP одинаковый на любом уровне и сложность не даёт скрытой выгоды.
  levels: {
    1: { label: 'Лёгкий',   points: 12, noise: 0.10, seconds: 20, mult: TREND_MULT },
    2: { label: 'Средний',  points: 18, noise: 0.22, seconds: 15, mult: TREND_MULT },
    3: { label: 'Сложный',  points: 24, noise: 0.35, seconds: 10, mult: TREND_MULT }
  },
  minBet: 10,
  maxBet: 5000
};

/** Выплата для уровня: при уровне 3 множитель выше, но RTP одинаковый (см. ниже). */
function payoutMultiplier(level) {
  const L = TREND.levels[level];
  return L ? L.mult : null;
}

/** Быстрый детерминированный поток из HMAC-дайджеста. */
function streamFrom(mac) {
  let t = (mac.readUInt32BE(4) ^ 0x9e3779b9) >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Форма графика в точке t ∈ [0..1]; не зависит от правильного ответа. */
function shapeAt(shape, t, phase) {
  switch (shape) {
    case 'wave':
      return Math.sin(2 * Math.PI * (t * 1.35 + phase)) * 0.78
        + Math.sin(2 * Math.PI * (t * 0.55 + phase * 0.5)) * 0.4;
    case 'steps': {
      const seq = [1, -0.6, 0.6, -1, 0.3, 0.8, -0.3];
      const x = t * 5 + phase * 5;
      const q = Math.floor(x);
      const f = x - q;
      const base = seq[((q % seq.length) + seq.length) % seq.length];
      return base * (0.55 + 0.45 * Math.sin(f * Math.PI));
    }
    case 'spike': {
      const c = 0.25 + phase * 0.5;
      const spike = Math.exp(-Math.pow((t - c) / 0.09, 2)) * 1.7;
      const dip = Math.exp(-Math.pow((t - (c + 0.28)) / 0.07, 2)) * 0.75;
      return spike - dip;
    }
    case 'channel': {
      const x = (t * 1.6 + phase) % 1;
      return (1 - 4 * Math.abs(x - 0.5)) * 0.9;
    }
    case 'v': {
      const c = 0.3 + phase * 0.4;
      return (Math.abs(t - c) - 0.28) * 2.2;
    }
    case 'double':
      return Math.sin(2 * Math.PI * (t * 1.9 + phase)) * 0.85
        + Math.sin(2 * Math.PI * (t * 0.4 + phase)) * 0.25;
    case 'saw': {
      const x = (t * 2.2 + phase) % 1;
      return (x * 2 - 1) * 0.95;
    }
    case 'drift':
    default:
      return Math.sin(2 * Math.PI * (t * 0.9 + phase)) * 0.6
        + Math.sin(2 * Math.PI * (t * 4.1 + phase * 2)) * 0.22;
  }
}

/**
 * Генерация сценария на сервере. Возвращает серверные данные (включая
 * правильный ответ). Клиенту отдаём только точки графика и параметры.
 */
function generateScenario({ seedHex, level, scenarioId }) {
  const L = TREND.levels[level];
  if (!L) throw new Error('Неизвестный уровень');
  const mac = crypto.createHmac('sha256', String(seedHex)).update(String(scenarioId)).digest();
  const pattern = TREND.patterns[mac.readUInt32BE(0) % TREND.patterns.length];
  const variant = mac.readUInt32BE(20) % TREND.variants;
  const style = {
    shape: SHAPES[variant % SHAPES.length],
    vol: VOL_REGIMES[Math.floor(variant / SHAPES.length) % VOL_REGIMES.length],
    phase: PHASES[Math.floor(variant / (SHAPES.length * VOL_REGIMES.length)) % PHASES.length]
  };
  const tone = TONES[mac.readUInt32BE(24) % TONES.length];
  const interval = INTERVALS[mac.readUInt32BE(28) % INTERVALS.length];
  const priceBase = PRICE_BASES[mac.readUInt32BE(16) % PRICE_BASES.length];
  const rnd = streamFrom(mac);
  const points = buildSeries(pattern, L, style, priceBase, rnd);
  const chart = {
    variant,
    interval,
    tone,
    start: points[0],
    toneIndex: TONES.indexOf(tone),
    intervalIndex: INTERVALS.indexOf(interval)
  };
  return { pattern, points, level, seconds: L.seconds, mult: L.mult, chart };
}

/**
 * Построение ряда: форма + случайное блуждание + контр-движение.
 * Итоговая точка мягко смещена в сторону паттерна (0.8–2.6%), но размах
 * внутри ряда в 2–4 раза больше — направление намеренно читается плохо.
 */
function buildSeries(pattern, L, style, priceBase, rnd) {
  const n = L.points;
  const direction = pattern === 'rise' ? 1 : pattern === 'fall' ? -1 : 0;
  const net = direction
    ? direction * (0.010 + rnd() * 0.016)
    : (rnd() * 2 - 1) * 0.006;
  const swing = (0.010 + L.noise * 0.032) * style.vol;
  const shapeSign = pattern === 'fall' ? -1 : 1;
  const start = priceBase * (0.99 + rnd() * 0.02);

  const raw = [];
  let walk = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    walk += (rnd() * 2 - 1) * swing * 0.35;
    const shape = shapeAt(style.shape, t, style.phase) * shapeSign;
    // Контр-движение в середине ряда: толпа видит «разворот» не в ту сторону.
    const counter = -direction * swing * 0.7 * Math.sin(Math.PI * t);
    raw.push(swing * shape + walk * 0.8 + counter);
  }

  // Первая точка — чистый старт, финальную задаёт только net; форму и шум
  // «подшиваем» мостиком, чтобы концы не выдавали направление раньше времени.
  raw[0] = 0;
  const endRaw = raw[n - 1];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const dev = raw[i] - endRaw * t;
    const v = start * (1 + net * t + dev);
    out.push(Math.max(0.01, Math.round(v * 100) / 100));
  }
  return out;
}

/**
 * Проверка ответа. Правильный ответ берётся из серверного сценария,
 * а не из запроса. Возвращает true, если ответ совпал.
 */
function checkAnswer(scenario, answer) {
  return scenario.pattern === answer;
}

/**
 * Комбо: счётчик серии правильных ответов. Только для отображения.
 * Сбрасывается при ошибке. Выплата от него НЕ зависит.
 */
function nextCombo(prevCombo, correct) {
  return correct ? prevCombo + 1 : 0;
}

/** Публичная конфигурация (без правильных ответов и без seed). */
function publicConfig() {
  return {
    id: TREND.id,
    label: TREND.label,
    edge: TREND.edge,
    patterns: ['rise', 'fall', 'flat'],
    variants: TREND.variants,
    levels: Object.entries(TREND.levels).map(([k, v]) => ({
      level: Number(k), label: v.label, points: v.points, seconds: v.seconds, multiplier: v.mult
    })),
    minBet: TREND.minBet,
    maxBet: TREND.maxBet
  };
}

module.exports = {
  TREND,
  SHAPES,
  INTERVALS,
  TONES,
  payoutMultiplier,
  generateScenario,
  checkAnswer,
  nextCombo,
  publicConfig
};
