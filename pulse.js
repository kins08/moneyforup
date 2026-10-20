'use strict';
/**
 * MoneyForUp — Pulse Market (микрораунды крипто-рынка).
 *
 * Игрок ставит токены из баланса на направление движения цены за
 * выбранное время. Исход определяет СЕРВЕР по серверному seed.
 * Клиент никогда не видит seed до окончания раунда.
 *
 * Модель (DECISIONS.md, D5):
 *   - Исходы: UP / DOWN / RANGE (боковик). Для каждого направления
 *     вероятность 1/3 при плече ×1.
 *   - Плечо ×2: только UP / DOWN (вероятность 1/2), выплата ×2 от базы.
 *   - Выплата = ставка × M, M = N × (1 − edge), N — число исходов.
 *     RTP = P(win) × M = (1 − edge) при любом плече.
 *   - Всё, что касается исхода, живёт здесь. Никаких скрытых коэффициентов.
 *
 * Исход считается из HMAC(serverSecret, roundId): детерминирован для
 * тестов (фиксированный секрет) и непредсказуем для клиента.
 */

const crypto = require('crypto');

const PULSE = {
  id: 'pulse',
  label: 'PULSE MARKET',
  edge: 0.08,                 // комиссия кассы: RTP 92%
  durations: [5, 10, 20],     // секунды раунда
  leverages: [1, 2],          // ×1 — три исхода, ×2 — два исхода (без RANGE)
  minBet: 10,
  maxBet: 5000,
  // Порог «боковика»: |move| < 1/3 даёт RANGE. При равномерном move на [-1, 1]
  // три исхода получают равные вероятности 1/3 (проверено test-pulse.js).
  rangeThreshold: 1 / 3
};

const OUTCOMES = ['up', 'down', 'range'];

/** Множитель выплаты для плеча: N исходов × (1 − edge). */
function payoutMultiplier(leverage) {
  const n = leverage === 2 ? 2 : 3;
  return Math.round(n * (1 - PULSE.edge) * 10000) / 10000;
}

/** Вероятность выигрыша одного направления. */
function winProbability(leverage) {
  return leverage === 2 ? 1 / 2 : 1 / 3;
}

/**
 * Детерминированный пересчёт ценового пути из seed.
 * Возвращает отклонение цены в условных единицах и итоговый исход.
 * @param {string} seedHex  серверный seed раунда (hex)
 * @param {string} roundId  идентификатор раунда (вход HMAC)
 */
function outcomeFromSeed(seedHex, roundId, leverage) {
  const mac = crypto.createHmac('sha256', String(seedHex)).update(String(roundId)).digest();
  // 4 байта → [0,1). Берём 32-битное значение, чтобы не терять точность.
  const r = mac.readUInt32BE(0) / 0x100000000;
  // Отклонение цены: симметричное, в диапазоне [-1, 1].
  const move = r * 2 - 1;
  let outcome;
  if (leverage === 2) {
    // Плечо ×2 исключает боковик: только направление.
    outcome = move >= 0 ? 'up' : 'down';
  } else if (Math.abs(move) < PULSE.rangeThreshold) {
    outcome = 'range';
  } else {
    outcome = move > 0 ? 'up' : 'down';
  }
  return { move: Math.round(move * 10000) / 10000, outcome };
}

/** Проверка параметров ставки (вызывается сервером до списания). */
function validateBet({ direction, leverage, duration, bet }) {
  if (!OUTCOMES.includes(direction)) return { ok: false, error: 'Неизвестное направление' };
  if (!PULSE.leverages.includes(Number(leverage))) return { ok: false, error: 'Плечо: только ×1 или ×2' };
  if (!PULSE.durations.includes(Number(duration))) return { ok: false, error: 'Длительность: 5, 10 или 20 с' };
  if (Number(leverage) === 2 && direction === 'range') {
    return { ok: false, error: 'На боковик плечо ×2 недоступно' };
  }
  const b = Math.floor(Number(bet));
  if (!Number.isFinite(b) || b < PULSE.minBet || b > PULSE.maxBet) {
    return { ok: false, error: `Ставка от ${PULSE.minBet} до ${PULSE.maxBet} ⬦` };
  }
  return { ok: true, bet: b, leverage: Number(leverage), duration: Number(duration) };
}

/**
 * Результат раунда. Выигрыш: направление совпало с исходом.
 * Выплата = floor(bet × payoutMultiplier(leverage)); при проигрыше 0.
 */
function settle({ seedHex, roundId, direction, leverage, bet }) {
  const { move, outcome } = outcomeFromSeed(seedHex, roundId, leverage);
  const won = direction === outcome;
  const mult = payoutMultiplier(leverage);
  const payout = won ? Math.floor(bet * mult) : 0;
  return { move, outcome, won, mult, payout };
}

/** Публичная информация о правилах (без seed и без исхода). */
function publicConfig() {
  return {
    id: PULSE.id,
    label: PULSE.label,
    edge: PULSE.edge,
    durations: PULSE.durations.slice(),
    leverages: PULSE.leverages.map(l => ({
      leverage: l,
      outcomes: l === 2 ? ['up', 'down'] : ['up', 'down', 'range'],
      multiplier: payoutMultiplier(l),
      winChance: winProbability(l)
    })),
    minBet: PULSE.minBet,
    maxBet: PULSE.maxBet
  };
}

module.exports = {
  PULSE,
  OUTCOMES,
  payoutMultiplier,
  winProbability,
  outcomeFromSeed,
  validateBet,
  settle,
  publicConfig
};
