'use strict';
/**
 * MoneyForUp — Trend Hunter (DECISIONS.md D6).
 *
 * Игрок видит график и определяет паттерн: РОСТ, ПАДЕНИЕ или БОКОВИК.
 * Сценарий (паттерн, сложность, правильный ответ) фиксируется на СЕРВЕРЕ
 * при генерации и не меняется после ответа игрока.
 *
 * Экономика:
 *   - Ставка из баланса, выплата = ставка × множитель сложности (фиксирован в коде).
 *   - Комбо за серию правильных ответов НЕ влияет на выплату — только отображение.
 *     Так скрытых бонусов в экономике нет.
 *   - Вероятность угадать при трёх равновероятных паттернах = 1/3.
 *     Множитель сложности = 3 × (1 − edge): RTP = 1 − edge при любой сложности.
 */

const crypto = require('crypto');

const TREND = {
  id: 'trend',
  label: 'TREND HUNTER',
  edge: 0.08,
  patterns: ['rise', 'fall', 'flat'],
  // Уровни сложности меняют ТОЛЬКО условия: длину ряда, шум и время на ответ.
  // Выплата одинакова на всех уровнях (3 паттерна → P = 1/3, множитель 3 × (1 − edge)),
  // поэтому RTP = 92% на любом уровне и сложность не даёт скрытой выгоды.
  levels: {
    1: { label: 'Лёгкий',   points: 12, noise: 0.10, seconds: 20, mult: 2.76 },
    2: { label: 'Средний',  points: 18, noise: 0.22, seconds: 15, mult: 2.76 },
    3: { label: 'Сложный',  points: 24, noise: 0.35, seconds: 10, mult: 2.76 }
  },
  minBet: 10,
  maxBet: 5000
};

/** Выплата для уровня: при уровне 3 множитель выше, но RTP одинаковый (см. ниже). */
function payoutMultiplier(level) {
  const L = TREND.levels[level];
  return L ? L.mult : null;
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
  const points = buildSeries(pattern, L, mac);
  return { pattern, points, level, seconds: L.seconds, mult: L.mult };
}

/** Построение ряда: тренд + детерминированный шум из HMAC-потока. */
function buildSeries(pattern, L, mac) {
  const n = L.points;
  const out = [];
  let v = 100;
  // Поток псевдослучайных значений из HMAC (расширяем по счётчику).
  const stream = (i) => {
    const h = crypto.createHmac('sha256', mac).update(String(i)).digest();
    return h.readUInt32BE(0) / 0x100000000;
  };
  const drift = pattern === 'rise' ? 1 : pattern === 'fall' ? -1 : 0;
  for (let i = 0; i < n; i++) {
    const noise = (stream(i) * 2 - 1) * L.noise;
    v = v * (1 + drift * 0.02 + noise * 0.05);
    out.push(Math.round(v * 100) / 100);
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
    levels: Object.entries(TREND.levels).map(([k, v]) => ({
      level: Number(k), label: v.label, points: v.points, seconds: v.seconds, multiplier: v.mult
    })),
    minBet: TREND.minBet,
    maxBet: TREND.maxBet
  };
}

module.exports = {
  TREND,
  payoutMultiplier,
  generateScenario,
  checkAnswer,
  nextCombo,
  publicConfig
};
