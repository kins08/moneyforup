/**
 * Мониторинг выигранных и проигранных ставок игроков, детальная аналитика по играм и игрокам,
 * античит-аудит и анализ итогового PnL проекта (+ или -).
 * Сохраняет историю, профили игроков и агрегаты в отдельный файл bets_stats.json и формирует сводки для Telegram.
 */
const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, 'bets_stats.json');
const TOKENS_PER_RUB = 10;
/* Отчёты уходят админу с parse_mode:'HTML': имена игроков, названия игр и
   детали античита задаёт клиент, поэтому без экранирования это HTML-инъекция
   в админский чат (поддельная заявка, кликабельная ссылка от имени бота). */
const escHtml = v => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let store = {
  updatedAt: Date.now(),
  totalBetsCount: 0,
  wonBetsCount: 0,
  lostBetsCount: 0,
  totalWageredTokens: 0,
  totalPayoutTokens: 0,
  totalProjectNetTokens: 0, // Положительное = проект в плюсе (игроки проиграли больше, чем выиграли)
  totalDepositsRub: 0,
  totalWithdrawalsRub: 0,
  players: {}, // uid -> { uid, name, betsCount, wonCount, lostCount, wageredTk, payoutTk, netPlayerTk, depositsRub, withdrawalsRub, currentBalanceTk, maxSingleWinTk, maxSingleWinGame, games: {}, suspiciousFlags: [], lastActiveAt }
  suspiciousEvents: [], // последние 200 античит-событий
  history: [] // последние 5000 записей: { t, uid, name, game, bet, win, netProject }
};

function loadStore() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        store = Object.assign(store, data);
        if (!Array.isArray(store.history)) store.history = [];
        if (!Array.isArray(store.suspiciousEvents)) store.suspiciousEvents = [];
        if (!store.players || typeof store.players !== 'object') store.players = {};
      }
    }
  } catch (e) {
    console.error('[BetsMonitor] Ошибка чтения файла статистики:', e.message);
  }
}

let saveTimer = null;
function saveStore() {
  store.updatedAt = Date.now();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
      console.error('[BetsMonitor] Ошибка записи файла статистики:', e.message);
    }
  }, 1000);
}

loadStore();

function ensurePlayer(uid, name) {
  const key = String(uid || 0);
  if (!store.players[key]) {
    store.players[key] = {
      uid: Number(uid) || 0,
      name: String(name || 'Игрок').slice(0, 40),
      betsCount: 0,
      wonCount: 0,
      lostCount: 0,
      wageredTk: 0,
      payoutTk: 0,
      netPlayerTk: 0,
      depositsRub: 0,
      withdrawalsRub: 0,
      currentBalanceTk: 50,
      maxSingleWinTk: 0,
      maxSingleWinGame: '',
      games: {},
      suspiciousFlags: [],
      lastActiveAt: Date.now()
    };
  }
  const p = store.players[key];
  if (name && name !== 'Игрок') p.name = String(name).slice(0, 40);
  p.lastActiveAt = Date.now();
  if (!p.games) p.games = {};
  if (!Array.isArray(p.suspiciousFlags)) p.suspiciousFlags = [];
  return p;
}

/**
 * Фиксация подозрительной активности / срабатывания античита
 */
function flagSuspicious({ userId, name, reason, details }) {
  const p = ensurePlayer(userId, name);
  const flagStr = `${reason}${details ? ' (' + details + ')' : ''}`;
  if (!p.suspiciousFlags.includes(flagStr)) {
    p.suspiciousFlags.push(flagStr);
    if (p.suspiciousFlags.length > 15) p.suspiciousFlags = p.suspiciousFlags.slice(-15);
  }
  store.suspiciousEvents.push({
    t: Date.now(),
    uid: Number(userId) || 0,
    name: p.name,
    reason,
    details: details || ''
  });
  if (store.suspiciousEvents.length > 200) {
    store.suspiciousEvents = store.suspiciousEvents.slice(-200);
  }
  saveStore();
}

/**
 * Запись одиночной ставки игрока
 * @param {object} p - { userId, name, game, betTokens, winTokens, balanceAfter, totalDepositedRub }
 */
function recordBet({ userId, name, game, betTokens, winTokens, balanceAfter, totalDepositedRub }) {
  const bet = Math.max(0, Math.round(Number(betTokens) || 0));
  const win = Math.max(0, Math.round(Number(winTokens) || 0));
  if (bet <= 0 && win <= 0) return null;

  const isPlayerWin = win > bet && win > 0;
  // Для проекта: сколько поставили минус сколько выплатили
  const netProject = bet - win;
  const netPlayer = win - bet;
  const gameClean = String(game || 'Игра').slice(0, 32);

  store.totalBetsCount += 1;
  if (isPlayerWin) store.wonBetsCount += 1;
  else store.lostBetsCount += 1;

  store.totalWageredTokens += bet;
  store.totalPayoutTokens += win;
  store.totalProjectNetTokens += netProject;

  // Обновляем детальный профиль игрока
  if (userId) {
    const p = ensurePlayer(userId, name);
    p.betsCount += 1;
    if (isPlayerWin) p.wonCount += 1;
    else p.lostCount += 1;
    p.wageredTk += bet;
    p.payoutTk += win;
    p.netPlayerTk += netPlayer;
    if (typeof balanceAfter === 'number') p.currentBalanceTk = Math.round(balanceAfter);
    if (typeof totalDepositedRub === 'number' && totalDepositedRub > p.depositsRub) {
      p.depositsRub = totalDepositedRub;
    }
    if (win > p.maxSingleWinTk) {
      p.maxSingleWinTk = win;
      p.maxSingleWinGame = gameClean;
    }
    if (!p.games[gameClean]) {
      p.games[gameClean] = { count: 0, won: 0, lost: 0, wageredTk: 0, payoutTk: 0, netPlayerTk: 0 };
    }
    const pg = p.games[gameClean];
    pg.count += 1;
    if (isPlayerWin) pg.won += 1;
    else pg.lost += 1;
    pg.wageredTk += bet;
    pg.payoutTk += win;
    pg.netPlayerTk += netPlayer;

    // Проверка на аномалии
    if ((p.depositsRub || 0) <= 0 && p.netPlayerTk > 500) {
      flagSuspicious({
        userId,
        name: p.name,
        reason: 'Высокий профит без депозита',
        details: `+${(p.netPlayerTk / TOKENS_PER_RUB).toFixed(2)} ₽ в ${gameClean}`
      });
    }
  }

  const entry = {
    t: Date.now(),
    uid: userId || 0,
    name: String(name || 'Игрок').slice(0, 40),
    game: gameClean,
    bet,
    win,
    netProject
  };

  store.history.push(entry);
  if (store.history.length > 5000) {
    store.history = store.history.slice(-5000);
  }

  saveStore();
  return entry;
}

/**
 * Учёт подтверждённых пополнений и выводов в общей кассе проекта и профиле игрока
 */
function recordCashflow(type, rubAmount, userId, userName) {
  const rub = Math.max(0, Number(rubAmount) || 0);
  if (type === 'deposit') {
    store.totalDepositsRub = (store.totalDepositsRub || 0) + rub;
    if (userId) {
      const p = ensurePlayer(userId, userName);
      p.depositsRub = (p.depositsRub || 0) + rub;
    }
  } else if (type === 'withdraw') {
    store.totalWithdrawalsRub = (store.totalWithdrawalsRub || 0) + rub;
    if (userId) {
      const p = ensurePlayer(userId, userName);
      p.withdrawalsRub = (p.withdrawalsRub || 0) + rub;
    }
  }
  saveStore();
}

/**
 * Аналитика за указанный период (в часах, например 12ч = полдня, 24ч = день, 0 = за всё время)
 */
function getAnalytics(hours = 12) {
  const now = Date.now();
  const cutoff = hours > 0 ? now - hours * 3600 * 1000 : 0;
  const list = hours > 0 ? store.history.filter(x => x.t >= cutoff) : store.history;

  let betsCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let wageredTk = 0;
  let payoutTk = 0;
  let projectNetTk = 0;
  const playersSet = new Set();
  const byGame = {};

  for (const item of list) {
    betsCount++;
    const isWin = item.win > item.bet && item.win > 0;
    if (isWin) wonCount++;
    else lostCount++;
    wageredTk += item.bet;
    payoutTk += item.win;
    projectNetTk += item.netProject;
    if (item.uid) playersSet.add(item.uid);

    const g = item.game || 'Другое';
    if (!byGame[g]) {
      byGame[g] = {
        count: 0,
        wonCount: 0,
        lostCount: 0,
        wagered: 0,
        payout: 0,
        netProject: 0,
        rtpPct: 0,
        winRatePct: 0,
        maxWinTk: 0,
        maxWinUser: ''
      };
    }
    const bg = byGame[g];
    bg.count++;
    if (isWin) bg.wonCount++;
    else bg.lostCount++;
    bg.wagered += item.bet;
    bg.payout += item.win;
    bg.netProject += item.netProject;
    if (item.win > bg.maxWinTk) {
      bg.maxWinTk = item.win;
      bg.maxWinUser = item.name || String(item.uid);
    }
  }

  for (const gKey of Object.keys(byGame)) {
    const bg = byGame[gKey];
    bg.rtpPct = bg.wagered > 0 ? +((bg.payout / bg.wagered) * 100).toFixed(1) : 0;
    bg.winRatePct = bg.count > 0 ? +((bg.wonCount / bg.count) * 100).toFixed(1) : 0;
  }

  // Если за всё время и в истории меньше записей, чем в глобальных счётчиках
  if (hours <= 0 && store.totalBetsCount > betsCount) {
    betsCount = store.totalBetsCount;
    wonCount = store.wonBetsCount;
    lostCount = store.lostBetsCount;
    wageredTk = store.totalWageredTokens;
    payoutTk = store.totalPayoutTokens;
    projectNetTk = store.totalProjectNetTokens;
  }

  const wageredRub = +(wageredTk / TOKENS_PER_RUB).toFixed(2);
  const payoutRub = +(payoutTk / TOKENS_PER_RUB).toFixed(2);
  const projectNetRub = +(projectNetTk / TOKENS_PER_RUB).toFixed(2);
  const cashflowNetRub = +((store.totalDepositsRub || 0) - (store.totalWithdrawalsRub || 0)).toFixed(2);
  const rtpOverallPct = wageredTk > 0 ? +((payoutTk / wageredTk) * 100).toFixed(1) : 0;

  // Топ игроков по активности / профиту
  const playersList = Object.values(store.players || {})
    .sort((a, b) => Math.abs(b.netPlayerTk) - Math.abs(a.netPlayerTk))
    .slice(0, 30);

  const winRateOverallPct = betsCount > 0 ? +((wonCount / betsCount) * 100).toFixed(1) : 0;
  const avgBetTk = betsCount > 0 ? +(wageredTk / betsCount).toFixed(1) : 0;
  const avgBetRub = betsCount > 0 ? +(wageredRub / betsCount).toFixed(2) : 0;
  const houseEdgePct = rtpOverallPct > 0 ? +(100 - rtpOverallPct).toFixed(1) : (betsCount > 0 ? 5.8 : 0);
  const totalTrackedPlayers = Object.keys(store.players || {}).length;

  return {
    hours,
    betsCount,
    wonCount,
    lostCount,
    winRateOverallPct,
    avgBetTk,
    avgBetRub,
    houseEdgePct,
    totalTrackedPlayers,
    activePlayers: playersSet.size || totalTrackedPlayers,
    wageredTk,
    wageredRub,
    payoutTk,
    payoutRub,
    projectNetTk,
    projectNetRub,
    rtpOverallPct,
    inPlus: projectNetTk >= 0,
    totalDepositsRub: store.totalDepositsRub || 0,
    totalWithdrawalsRub: store.totalWithdrawalsRub || 0,
    cashflowNetRub,
    byGame,
    playersList,
    suspiciousEvents: (store.suspiciousEvents || []).slice(-20).reverse(),
    recentBets: store.history.slice(-30).reverse()
  };
}

/**
 * Досье конкретного игрока (для прикрепления к заявкам на вывод и проверки на эксплойты)
 */
function getPlayerDossier(userId, serverUserObj) {
  const p = store.players[String(userId)] || null;
  const depRub = Math.max(
    (p && p.depositsRub) || 0,
    (serverUserObj && serverUserObj.totalDepositedRub) || 0,
    (serverUserObj && serverUserObj.lastDeposit) || 0
  );
  const wdRub = (p && p.withdrawalsRub) || 0;
  const betsCount = (p && p.betsCount) || 0;
  const wonCount = (p && p.wonCount) || 0;
  const lostCount = (p && p.lostCount) || 0;
  const netPlayerRub = p ? (p.netPlayerTk / TOKENS_PER_RUB).toFixed(1) : '0.0';

  let topGamesStr = 'нет записанных ставок';
  if (p && p.games && Object.keys(p.games).length > 0) {
    topGamesStr = Object.entries(p.games)
      .sort((a, b) => b[1].netPlayerTk - a[1].netPlayerTk)
      .slice(0, 3)
      .map(([g, d]) => `${g}: ${d.count} ст. (${d.netPlayerTk >= 0 ? '+' : ''}${(d.netPlayerTk / TOKENS_PER_RUB).toFixed(0)}₽)`)
      .join(', ');
  }

  const flags = (p && p.suspiciousFlags && p.suspiciousFlags.length)
    ? `🚨 <b>Флаги античита:</b> ${escHtml(p.suspiciousFlags.join('; '))}\n`
    : '';

  const verdict = depRub <= 0
    ? `🚨 <b>ВНИМАНИЕ: 0 ₽ ПОПОЛНЕНИЙ! (Не платил ни разу)</b>`
    : `✅ <b>Пополнял: ${depRub} ₽</b> (Выводил ранее: ${wdRub} ₽)`;

  return (
    `🔎 <b>АУДИТ ИГРОКА:</b>\n` +
    `├ Статус: ${verdict}\n` +
    `├ Ставок: <b>${betsCount}</b> (побед: ${wonCount} / сливов: ${lostCount})\n` +
    `├ Профит в играх: <b>${Number(netPlayerRub) >= 0 ? '+' : ''}${netPlayerRub} ₽</b>\n` +
    `├ Где поднял: <i>${escHtml(topGamesStr)}</i>\n` +
    flags
  );
}

/**
 * Подробная игровая аналитика пользователя (для профиля и миниаппа)
 */
function getPlayerStats(userId, fallbackDbStats) {
  const p = store.players[String(userId)] || null;
  const dbSummary = (fallbackDbStats && fallbackDbStats.summary) || {};
  const dbGames = (fallbackDbStats && fallbackDbStats.byGame) || [];

  const betsCount = Math.max((p && p.betsCount) || 0, Number(dbSummary.totalRounds) || 0);
  const wonCount = Math.max((p && p.wonCount) || 0, Number(dbSummary.wonRounds) || 0);
  const lostCount = (p && p.lostCount != null) ? p.lostCount : Math.max(0, betsCount - wonCount);
  const winRatePct = betsCount > 0 ? +((wonCount / betsCount) * 100).toFixed(1) : 0;

  const wageredTk = Math.max((p && p.wageredTk) || 0, Number(dbSummary.totalWageredTk) || 0);
  const payoutTk = Math.max((p && p.payoutTk) || 0, Number(dbSummary.totalPayoutTk) || 0);
  const netPlayerTk = (p && p.netPlayerTk != null) ? p.netPlayerTk : (payoutTk - wageredTk);
  const maxSingleWinTk = Math.max((p && p.maxSingleWinTk) || 0, Number(dbSummary.maxWinTk) || 0);

  let favoriteGame = (p && p.maxSingleWinGame) || '';
  let maxGameCount = 0;
  const gamesMap = {};

  if (p && p.games && Object.keys(p.games).length > 0) {
    for (const [gName, g] of Object.entries(p.games)) {
      if (g.count > maxGameCount) {
        maxGameCount = g.count;
        favoriteGame = gName;
      }
      gamesMap[gName] = {
        name: gName,
        count: g.count,
        won: g.won || 0,
        lost: g.lost || 0,
        winRatePct: g.count > 0 ? +(((g.won || 0) / g.count) * 100).toFixed(1) : 0,
        wageredTk: g.wageredTk || 0,
        wageredRub: +((g.wageredTk || 0) / TOKENS_PER_RUB).toFixed(2),
        payoutTk: g.payoutTk || 0,
        netPlayerTk: g.netPlayerTk || 0,
        netPlayerRub: +((g.netPlayerTk || 0) / TOKENS_PER_RUB).toFixed(2)
      };
    }
  } else if (dbGames.length > 0) {
    for (const dg of dbGames) {
      if (dg.rounds > maxGameCount) {
        maxGameCount = dg.rounds;
        favoriteGame = dg.game;
      }
      const net = (dg.payoutTk || 0) - (dg.wageredTk || 0);
      gamesMap[dg.game] = {
        name: dg.game,
        count: dg.rounds,
        won: dg.won || 0,
        lost: Math.max(0, dg.rounds - (dg.won || 0)),
        winRatePct: dg.rounds > 0 ? +(((dg.won || 0) / dg.rounds) * 100).toFixed(1) : 0,
        wageredTk: dg.wageredTk || 0,
        wageredRub: +((dg.wageredTk || 0) / TOKENS_PER_RUB).toFixed(2),
        payoutTk: dg.payoutTk || 0,
        netPlayerTk: net,
        netPlayerRub: +(net / TOKENS_PER_RUB).toFixed(2)
      };
    }
  }

  // Ранг игрока по опыту
  let gamerRank = 'Новичок';
  if (wageredTk >= 100000 || betsCount >= 500) gamerRank = '👑 Легенда MUP';
  else if (wageredTk >= 30000 || betsCount >= 200) gamerRank = '💎 Хайроллер';
  else if (wageredTk >= 10000 || betsCount >= 80) gamerRank = '⚡️ Мастер Иксов';
  else if (wageredTk >= 2000 || betsCount >= 20) gamerRank = '🎯 Опытный игрок';
  else if (betsCount >= 5) gamerRank = '🎲 Любитель';

  return {
    betsCount,
    wonCount,
    lostCount,
    winRatePct,
    wageredTk,
    wageredRub: +(wageredTk / TOKENS_PER_RUB).toFixed(2),
    payoutTk,
    payoutRub: +(payoutTk / TOKENS_PER_RUB).toFixed(2),
    netPlayerTk,
    netPlayerRub: +(netPlayerTk / TOKENS_PER_RUB).toFixed(2),
    maxSingleWinTk,
    maxSingleWinGame: (p && p.maxSingleWinGame) || favoriteGame || '—',
    favoriteGame: favoriteGame || '—',
    gamerRank,
    games: gamesMap
  };
}

/**
 * Форматирование основной HTML-сводки для отправки в Telegram администратору
 */
function formatTelegramReport(hours = 12) {
  const periodStats = getAnalytics(hours);
  const allStats = getAnalytics(0);

  const periodLabel = hours === 12 ? 'за 12 часов (полдня)' : (hours === 24 ? 'за 24 часа (сутки)' : (hours === 0 ? 'за всё время' : `за ${hours} ч.`));
  const sign = n => (n > 0 ? '+' : '') + n.toLocaleString('ru-RU');
  const signRub = n => (n > 0 ? '+' : '') + n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';

  const statusEmoji = periodStats.projectNetTk >= 0 ? '🟢' : '🔴';
  const statusVerdict = periodStats.projectNetTk >= 0
    ? `ПРОЕКТ В ПЛЮСЕ (${signRub(periodStats.projectNetRub)})`
    : `ПРОЕКТ В МИНУСЕ (${signRub(periodStats.projectNetRub)})`;

  const allStatusEmoji = allStats.projectNetTk >= 0 ? '🟢' : '🔴';
  const cashStatusEmoji = allStats.cashflowNetRub >= 0 ? '🟢' : '🔴';

  let gameLines = '';
  const gamesEntries = Object.entries(periodStats.byGame).sort((a, b) => b[1].wagered - a[1].wagered);
  if (gamesEntries.length > 0) {
    gameLines = '\n🎮 <b>Разбивка по играм (' + periodLabel + '):</b>\n';
    for (const [gName, gData] of gamesEntries) {
      const gNetRub = (gData.netProject / TOKENS_PER_RUB).toFixed(1);
      const gIcon = gData.netProject >= 0 ? '🟢' : '🔴';
      gameLines += `• <b>${escHtml(gName)}</b>: ${gData.count} ст. (выплаты ${gData.rtpPct}% от оборота) | Итог: ${gIcon} <b>${gData.netProject >= 0 ? '+' : ''}${gNetRub} ₽</b>\n`;
    }
  } else {
    gameLines = '\n🎮 <i>За выбранный период ставок ещё не было.</i>\n';
  }

  return (
    `📊 <b>ФИНАНСОВАЯ СВОДКА ПРОЕКТА (${periodLabel})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${statusEmoji} <b>Итог по ставкам: ${statusVerdict}</b>\n\n` +
    `📈 <b>Статистика ставок (${periodLabel}):</b>\n` +
    `├ Всего сыграно: <b>${periodStats.betsCount}</b> ставок (игроков: ${periodStats.activePlayers})\n` +
    `├ Побед игроков: <b>${periodStats.wonCount}</b> шт. | Сливов: <b>${periodStats.lostCount}</b> шт.\n` +
    `├ Оборот ставок: <b>${periodStats.wageredRub} ₽</b>\n` +
    `├ Выплачено выигрышей: <b>${periodStats.payoutRub} ₽</b> (доля выплат: <b>${periodStats.rtpOverallPct}%</b> от оборота)\n` +
    `└ Чистый доход казино по играм: <b>${signRub(periodStats.projectNetRub)}</b>\n` +
    gameLines +
    `\n🏦 <b>Общая касса проекта за всё время:</b>\n` +
    `├ По играм (всего ${allStats.betsCount} ст.): ${allStatusEmoji} <b>${signRub(allStats.projectNetRub)}</b>\n` +
    `├ Всего пополнений: <b>+${allStats.totalDepositsRub.toFixed(2)} ₽</b>\n` +
    `├ Всего выплачено выводов: <b>-${allStats.totalWithdrawalsRub.toFixed(2)} ₽</b>\n` +
    `└ Чистая касса (Депозиты − Выводы): ${cashStatusEmoji} <b>${signRub(allStats.cashflowNetRub)}</b>`
  );
}

/**
 * Детальный отчёт по каждой игре (обороты, выплаты, профит казино, макс выигрыши)
 */
function formatGamesReport(hours = 0) {
  const st = getAnalytics(hours);
  const label = hours > 0 ? `за ${hours} ч.` : 'за всё время';
  const entries = Object.entries(st.byGame).sort((a, b) => b[1].wagered - a[1].wagered);

  if (entries.length === 0) {
    return `🎮 <b>ДЕТАЛЬНЫЙ ОТЧЁТ ПО ИГРАМ (${label})</b>\n\nЗаписей о ставках пока нет.`;
  }

  let out = `🎮 <b>ДЕТАЛЬНЫЙ ОТЧЁТ ПО ИГРАМ (${label})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const [gName, g] of entries) {
    const netRub = (g.netProject / TOKENS_PER_RUB).toFixed(1);
    const wagRub = (g.wagered / TOKENS_PER_RUB).toFixed(1);
    const payRub = (g.payout / TOKENS_PER_RUB).toFixed(1);
    const maxRub = (g.maxWinTk / TOKENS_PER_RUB).toFixed(1);
    const icon = g.netProject >= 0 ? '🟢' : '🔴';
    out +=
      `\n<b>${icon} ${escHtml(gName)}</b>\n` +
      `├ Ставок: <b>${g.count}</b> (Побед: ${g.wonCount} / Сливов: ${g.lostCount} · WinRate: <b>${g.winRatePct}%</b>)\n` +
      `├ Оборот: <b>${wagRub} ₽</b> | Выплаты: <b>${payRub} ₽</b> (доля выплат: <b>${g.rtpPct}%</b>)\n` +
      `├ Макс. занос игрока: <b>${maxRub} ₽</b> — ${escHtml(g.maxWinUser || '—')}\n` +
      `└ Доход проекта: <b>${g.netProject >= 0 ? '+' : ''}${netRub} ₽</b>\n`;
  }
  return out;
}

/**
 * Детальный отчёт по игрокам (кто сколько пополнил, в каких играх поднял или слил)
 */
function formatPlayersReport(usersMap) {
  // Объединяем данные из bets_monitor и оперативной памяти bot.js
  const combined = new Map();
  for (const [uid, p] of Object.entries(store.players || {})) {
    combined.set(Number(uid), { ...p });
  }
  if (usersMap && typeof usersMap.entries === 'function') {
    for (const [uid, u] of usersMap.entries()) {
      const existing = combined.get(Number(uid)) || {
        uid: Number(uid),
        name: u.username ? '@' + u.username : (u.name || 'ID ' + uid),
        betsCount: 0,
        wonCount: 0,
        lostCount: 0,
        wageredTk: 0,
        payoutTk: 0,
        netPlayerTk: 0,
        depositsRub: u.totalDepositedRub || u.lastDeposit || 0,
        withdrawalsRub: 0,
        currentBalanceTk: u.tokens || 0,
        games: {},
        suspiciousFlags: []
      };
      existing.currentBalanceTk = Math.round(u.tokens || 0);
      if ((u.totalDepositedRub || u.lastDeposit || 0) > (existing.depositsRub || 0)) {
        existing.depositsRub = u.totalDepositedRub || u.lastDeposit || 0;
      }
      if (u.username) existing.name = '@' + u.username;
      combined.set(Number(uid), existing);
    }
  }

  const list = [...combined.values()].sort((a, b) => (b.currentBalanceTk + b.payoutTk) - (a.currentBalanceTk + a.payoutTk));
  if (list.length === 0) {
    return `👥 <b>ДЕТАЛЬНЫЙ ОТЧЁТ ПО ИГРОКАМ</b>\n\nДанных по игрокам пока нет.`;
  }

  let out = `👥 <b>ДЕТАЛЬНЫЙ ОТЧЁТ ПО ИГРОКАМ (ТОП-15)</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const p of list.slice(0, 15)) {
    const balRub = ((p.currentBalanceTk || 0) / TOKENS_PER_RUB).toFixed(1);
    const netRub = ((p.netPlayerTk || 0) / TOKENS_PER_RUB).toFixed(1);
    const depBadge = (p.depositsRub || 0) > 0 ? `💳 Деп: <b>${p.depositsRub} ₽</b>` : `⚠️ <b>БЕЗ ДЕПОЗИТА (0 ₽)</b>`;
    const topGames = p.games && Object.keys(p.games).length
      ? Object.entries(p.games)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 3)
          .map(([g, d]) => `${g} (${d.count}ст, ${d.netPlayerTk >= 0 ? '+' : ''}${Math.round(d.netPlayerTk / 10)}₽)`)
          .join(', ')
      : 'без ставок';
    const warn = (p.suspiciousFlags && p.suspiciousFlags.length) ? `\n├ 🚨 <b>Флаг:</b> ${escHtml(p.suspiciousFlags.slice(-2).join('; '))}` : '';

    out +=
      `\n👤 <b>${escHtml(p.name)}</b> (<code>${p.uid}</code>)\n` +
      `├ Баланс: <b>${balRub} ₽</b> | ${depBadge}\n` +
      `├ Ставок: <b>${p.betsCount}</b> (Вин: ${p.wonCount} / Слив: ${p.lostCount}) | Профит игрока: <b>${p.netPlayerTk >= 0 ? '+' : ''}${netRub} ₽</b>\n` +
      `└ Игры: <i>${escHtml(topGames)}</i>${warn}\n`;
  }
  return out;
}

/**
 * Античит-аудит: подозрительные игроки (высокий баланс при 0 депозитов и заблокированные попытки накрутки)
 */
function formatAuditReport(usersMap) {
  let out = `🛡 <b>АНТИЧИТ И АУДИТ БЕЗОПАСНОСТИ</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  out += `✅ <b>Активные защиты:</b>\n`;
  out += `• Лимит баланса без депозита: <b>макс. 40 ₽</b>\n`;
  out += `• Запрет вывода средств при <b>0 ₽ пополнений</b>\n`;
  out += `• Защита от смены ставки во время раунда (Ракетка, Скуф, Попрыгун, Авито)\n`;
  out += `• Защита от прикормки на больших кэфах (×20 Апгрейдер / ×95 Dice)\n\n`;

  const suspiciousUsers = [];
  if (usersMap && typeof usersMap.entries === 'function') {
    for (const [uid, u] of usersMap.entries()) {
      const dep = u.totalDepositedRub || u.lastDeposit || 0;
      if (dep <= 0 && u.tokens > 450) {
        suspiciousUsers.push({
          uid,
          name: u.username ? '@' + u.username : (u.name || 'ID ' + uid),
          tokens: u.tokens,
          dep
        });
      }
    }
  }

  if (suspiciousUsers.length > 0) {
    out += `🚨 <b>Обнаружены аккаунты с балансом > 45 ₽ без депозитов:</b>\n`;
    for (const su of suspiciousUsers) {
      out += `• <b>${escHtml(su.name)}</b> (<code>${su.uid}</code>): <b>${(su.tokens / TOKENS_PER_RUB).toFixed(1)} ₽</b> при 0 ₽ депозитов\n`;
    }
    out += `\n<i>Нажмите кнопку «🧹 Обнулить накрутчиков (0 деп)» ниже, чтобы сбросить им баланс до стартовых 5 ₽.</i>\n\n`;
  } else {
    out += `🟢 <b>Аномальных балансов без депозита сейчас нет.</b>\n\n`;
  }

  const events = (store.suspiciousEvents || []).slice(-10).reverse();
  if (events.length > 0) {
    out += `📋 <b>Последние срабатывания античита:</b>\n`;
    for (const ev of events) {
      const timeStr = new Date(ev.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      out += `• [${timeStr}] <b>${escHtml(ev.name)}</b> (<code>${ev.uid}</code>): ${escHtml(ev.reason)} ${ev.details ? '— ' + escHtml(ev.details) : ''}\n`;
    }
  } else {
    out += `📋 <i>Срабатываний античита за последнее время не зафиксировано.</i>`;
  }

  return out;
}

module.exports = {
  escHtml,
  STATS_FILE,
  recordBet,
  recordCashflow,
  flagSuspicious,
  getAnalytics,
  getPlayerDossier,
  getPlayerStats,
  formatTelegramReport,
  formatGamesReport,
  formatPlayersReport,
  formatAuditReport
};
