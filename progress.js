'use strict';
/**
 * MoneyForUp — прогрессия без токенов (DECISIONS.md D7, D8).
 *
 * Всё вычисляется из журнала раундов game_rounds — новых таблиц нет.
 * Награды ТОЛЬКО косметика и титулы: рамки, цвета темы, значки, титулы.
 * Токены здесь никогда не начисляются (игроки ставят то, что уже на балансе).
 *
 * Функции чистые: принимают массив раундов и возвращают прогресс.
 * Сервер подаёт им раунды пользователя за нужный период.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Игры прогрессии: Pulse Market. Остальные игры в миссиях не учитываются. */
const GAMES = { pulse: 'PULSE MARKET' };

/** Ежедневные миссии: условие и косметическая награда. Значения в коде, без токенов. */
const DAILY_MISSIONS = [
  { id: 'play_3',    title: 'Три раунда',              need: 3, metric: 'rounds',  reward: { type: 'frame', id: 'frame_steel' } },
  { id: 'win_2',     title: 'Два выигрыша',            need: 2, metric: 'wins',    reward: { type: 'color', id: 'theme_cyan' } }
];

/** Титулы по накопленной статистике (всё считается из game_rounds). */
const TITLES = [
  { id: 'rookie',   name: 'Новичок',         min: 0,   icon: '🔰' },
  { id: 'trader',   name: 'Трейдер',         min: 20,  icon: '📈' },
  { id: 'analyst',  name: 'Аналитик',        min: 60,  icon: '🔎' },
  { id: 'veteran',  name: 'Ветеран рынка',   min: 150, icon: '🏅' }
];

/** Вспомогательно: выбрать игровые раунды прогрессии. */
function gameRounds(rounds) {
  const labels = Object.values(GAMES);
  return (rounds || []).filter(r => labels.includes(r.game) && r.status === 'settled');
}

/** Статистика игрока: точность, лучший результат, любимая игра. */
function stats(rounds) {
  const list = gameRounds(rounds);
  const total = list.length;
  const wins = list.filter(r => Number(r.win_tokens) > 0).length;
  const accuracy = total ? Math.round((wins / total) * 10000) / 100 : 0;
  const best = list.reduce((m, r) => Math.max(m, Number(r.win_tokens) || 0), 0);
  const byGame = {};
  for (const r of list) byGame[r.game] = (byGame[r.game] || 0) + 1;
  const favorite = Object.entries(byGame).sort((a, b) => b[1] - a[1])[0];
  return {
    rounds: total,
    wins,
    accuracy,               // процент выигранных раундов (не точность прогноза рынка)
    bestWin: best,
    favorite: favorite ? favorite[0] : null
  };
}

/** Титул по числу сыгранных раундов. Чем больше раундов, тем выше титул. */
function titleFor(roundCount) {
  let cur = TITLES[0];
  for (const t of TITLES) if (roundCount >= t.min) cur = t;
  const idx = TITLES.indexOf(cur);
  const next = TITLES[idx + 1] || null;
  return { current: cur, next, leftToNext: next ? next.min - roundCount : 0 };
}

/**
 * Ежедневные миссии за указанные сутки (UTC-дата по startOfDay).
 * @param {Array} rounds   раунды игрока (поля game, status, win_tokens, created_at)
 * @param {number} now     текущее время (мс)
 */
function dailyMissions(rounds, now = Date.now()) {
  const start = startOfDay(now);
  const today = gameRounds(rounds).filter(r => Number(r.created_at) >= start && Number(r.created_at) < start + DAY_MS);
  const rounds_ = today.length;
  const wins = today.filter(r => Number(r.win_tokens) > 0).length;
  const metrics = { rounds: rounds_, wins };
  return DAILY_MISSIONS.map(m => {
    const have = Math.min(metrics[m.metric] || 0, m.need);
    return {
      id: m.id, title: m.title, progress: have, need: m.need,
      done: have >= m.need, reward: m.reward
    };
  });
}

/** Начало текущих суток (UTC). */
function startOfDay(ts) {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

/**
 * Market Replay: последние N раундов Pulse Market (исход раскрыт, так как раунд завершён).
 * Возвращает только завершённые раунды. Исход и seed на этом этапе не восстанавливаются.
 */
function replay(rounds, limit = 10) {
  const pulse = (rounds || []).filter(r => r.game === GAMES.pulse && r.status === 'settled');
  return pulse
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map(r => ({
      roundId: r.round_id, at: Number(r.created_at), bet: Number(r.bet_tokens) || 0,
      mult: Number(r.mult) || 0, payout: Number(r.win_tokens) || 0, won: Number(r.win_tokens) > 0
    }));
}

/**
 * Сезон: косметический прогресс по числу раундов за сезон.
 * Сезон — 30 суток. Награды: косметика (рамки, темы, значки) — без токенов.
 */
const SEASON = {
  id: 'season_1',
  name: 'Сезон 1 · Пульс',
  days: 30,
  tiers: [
    { at: 10,  reward: { type: 'frame', id: 'frame_season_bronze', name: 'Бронзовая рамка' } },
    { at: 40,  reward: { type: 'color', id: 'theme_season_lime',   name: 'Тема «Лайм»' } },
    { at: 100, reward: { type: 'badge', id: 'badge_season_gold',   name: 'Золотой значок' } }
  ]
};

function seasonProgress(rounds, seasonStart, now = Date.now()) {
  const end = seasonStart + SEASON.days * DAY_MS;
  const inSeason = gameRounds(rounds).filter(r => Number(r.created_at) >= seasonStart && Number(r.created_at) < Math.min(end, now + 1));
  const count = inSeason.length;
  const reached = SEASON.tiers.filter(t => count >= t.at);
  const next = SEASON.tiers.find(t => count < t.at) || null;
  return {
    season: SEASON.name,
    rounds: count,
    reached: reached.map(t => t.reward),
    next: next ? { at: next.at, left: next.at - count, reward: next.reward } : null,
    endsAt: end
  };
}

module.exports = {
  GAMES,
  DAILY_MISSIONS,
  TITLES,
  SEASON,
  stats,
  titleFor,
  dailyMissions,
  replay,
  seasonProgress,
  startOfDay
};
