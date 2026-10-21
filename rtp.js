'use strict';
/**
 * Единый источник RTP (возврат игроку) для всех игровых режимов.
 *
 * RTP = 1 − edge. Сервер, симулятор и интерфейс читают значения отсюда,
 * поэтому математика и публичные правила не расходятся.
 *
 * Режимы НЕ уравниваются: у каждого свой прежний уровень, сниженный
 * на RTP_DELTA (3 п.п.). Там, где возврат задаётся распределением
 * (кейсы, Crash), это учитывается отдельными коэффициентами.
 */
const RTP_DELTA = 0.03;

const BASE_RTP = {
  wheel: 0.95,
  dice: 0.945,
  upgrader: 0.94,
  auction: 0.94,
  jumper: 0.94,
  spin: 0.94,
  drop: 0.94,
  skuf: 0.94,
  avito: 0.94,
  scratch: 0.935,
  revolver: 0.94,
  safe: 0.95,
  cases: 0.94,
  racket: 0.94,
  hotdrop: 0.94,
  challenge: 0.94,

  pulse: 0.82,
  trend: 0.92,
  case_items: 0.8335,
  racket_crash: 0.8069
};

/* Точка взрыва Ракетки масштабируется, чтобы фактический RTP Crash
   снизился примерно на тот же 3 п.п. Коэффициент проверяется симуляцией. */
const CRASH_POINT_SCALE = 0.977;

function rtpOf(game) {
  const base = BASE_RTP[game];
  if (typeof base !== 'number') return 1 - RTP_DELTA;
  return Math.max(0.5, base - RTP_DELTA);
}

function edgeOf(game) {
  return Number((1 - rtpOf(game)).toFixed(4));
}

module.exports = {
  RTP_DELTA, BASE_RTP, CRASH_POINT_SCALE,
  rtpOf, edgeOf
};
