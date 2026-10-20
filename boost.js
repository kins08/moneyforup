'use strict';
/**
 * MoneyForUp — персональный буст дропа.
 *
 * luck 0..100 задаётся владельцем в админке. Это вероятность, что сервер
 * улучшит исход конкретного раунда в пользу игрока. Чистые функции без
 * обращения к БД: вызывающая сторона сама решает, как применить результат.
 */

function normalizeLuck(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Сработал ли буст в этом раунде. random01 — [0,1) от серверного CSPRNG. */
function triggers(luck, random01) {
  const l = normalizeLuck(luck);
  if (l <= 0) return false;
  return Number(random01) * 100 < l;
}

/**
 * Бросок предмета кейса. При срабатывании буста делает ещё два броска и
 * оставляет самый дорогой предмет. Без буста — ровно один бросок.
 */
function boostDrop(luck, random01, rollFn) {
  let best = rollFn();
  if (!triggers(luck, random01)) return best;
  for (let i = 0; i < 2; i++) {
    const candidate = rollFn();
    if (candidate && (!best || Number(candidate.price) > Number(best.price))) best = candidate;
  }
  return best;
}

/**
 * Ищет seed Pulse Market, при котором исход совпадёт с направлением игрока.
 * Используется только при срабатывании буста; 64 попытки дают практически
 * нулевой шанс промаха даже для направления с вероятностью 1/3.
 */
function pickPulseSeed(makeSeed, isWin, attempts = 64) {
  let seed = makeSeed();
  for (let i = 0; i < attempts; i++) {
    if (isWin(seed)) return seed;
    seed = makeSeed();
  }
  return seed;
}

/** Бонус к кэшауту Ракетки: при срабатывании буста выплата +50%. */
function cashoutBonus(win, luck, random01) {
  const base = Math.max(0, Math.floor(Number(win) || 0));
  if (!triggers(luck, random01)) return { win: base, boosted: false };
  return { win: Math.floor(base * 1.5), boosted: true };
}

module.exports = { normalizeLuck, triggers, boostDrop, pickPulseSeed, cashoutBonus };
