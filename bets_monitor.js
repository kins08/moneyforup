/**
 * Мониторинг выигранных и проигранных ставок игроков + анализ итогового PnL проекта (+ или -).
 * Сохраняет историю и агрегаты в отдельный файл bets_stats.json и формирует сводки для Telegram.
 */
const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, 'bets_stats.json');
const TOKENS_PER_RUB = 10;

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

/**
 * Запись одиночной ставки игрока
 * @param {object} p - { userId, name, game, betTokens, winTokens }
 */
function recordBet({ userId, name, game, betTokens, winTokens }) {
  const bet = Math.max(0, Math.round(Number(betTokens) || 0));
  const win = Math.max(0, Math.round(Number(winTokens) || 0));
  if (bet <= 0 && win <= 0) return null;

  const isPlayerWin = win >= bet && win > 0;
  // Для проекта: сколько поставили минус сколько выплатили
  const netProject = bet - win;

  store.totalBetsCount += 1;
  if (isPlayerWin) store.wonBetsCount += 1;
  else store.lostBetsCount += 1;

  store.totalWageredTokens += bet;
  store.totalPayoutTokens += win;
  store.totalProjectNetTokens += netProject;

  const entry = {
    t: Date.now(),
    uid: userId || 0,
    name: String(name || 'Игрок').slice(0, 40),
    game: String(game || 'Игра').slice(0, 32),
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
 * Учёт подтверждённых пополнений и выводов в общей кассе проекта
 */
function recordCashflow(type, rubAmount) {
  const rub = Math.max(0, Number(rubAmount) || 0);
  if (type === 'deposit') {
    store.totalDepositsRub = (store.totalDepositsRub || 0) + rub;
  } else if (type === 'withdraw') {
    store.totalWithdrawalsRub = (store.totalWithdrawalsRub || 0) + rub;
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
    if (item.win >= item.bet && item.win > 0) wonCount++;
    else lostCount++;
    wageredTk += item.bet;
    payoutTk += item.win;
    projectNetTk += item.netProject;
    if (item.uid) playersSet.add(item.uid);

    const g = item.game || 'Другое';
    if (!byGame[g]) byGame[g] = { count: 0, wagered: 0, payout: 0, netProject: 0 };
    byGame[g].count++;
    byGame[g].wagered += item.bet;
    byGame[g].payout += item.win;
    byGame[g].netProject += item.netProject;
  }

  // Если за всё время, берём глобальные счётчики
  if (hours <= 0) {
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

  return {
    hours,
    betsCount,
    wonCount,
    lostCount,
    activePlayers: playersSet.size,
    wageredTk,
    wageredRub,
    payoutTk,
    payoutRub,
    projectNetTk,
    projectNetRub,
    inPlus: projectNetTk >= 0,
    totalDepositsRub: store.totalDepositsRub || 0,
    totalWithdrawalsRub: store.totalWithdrawalsRub || 0,
    cashflowNetRub,
    byGame,
    recentBets: store.history.slice(-15).reverse()
  };
}

/**
 * Форматирование HTML-сводки для отправки в Telegram администратору
 */
function formatTelegramReport(hours = 12) {
  const periodStats = getAnalytics(hours);
  const allStats = getAnalytics(0);

  const periodLabel = hours === 12 ? 'за 12 часов (полдня)' : (hours === 24 ? 'за 24 часа (сутки)' : `за ${hours} ч.`);
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
      gameLines += `• <b>${gName}</b>: ${gData.count} ст. | Итог проекта: ${gIcon} <b>${gData.netProject >= 0 ? '+' : ''}${gNetRub} ₽</b>\n`;
    }
  }

  return (
    `📊 <b>ФИНАНСОВАЯ СВОДКА ПРОЕКТА (${periodLabel})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${statusEmoji} <b>Итог по ставкам: ${statusVerdict}</b>\n\n` +
    `📈 <b>Статистика ставок (${periodLabel}):</b>\n` +
    `├ Всего сыграно: <b>${periodStats.betsCount}</b> ставок (игроков: ${periodStats.activePlayers})\n` +
    `├ Выиграно игроками: <b>${periodStats.wonCount}</b> шт. на <b>${periodStats.payoutRub} ₽</b> (${periodStats.payoutTk} ⬦)\n` +
    `├ Проиграно игроками: <b>${periodStats.lostCount}</b> шт.\n` +
    `├ Общий оборот ставок: <b>${periodStats.wageredRub} ₽</b> (${periodStats.wageredTk} ⬦)\n` +
    `└ Чистый результат по играм: <b>${signRub(periodStats.projectNetRub)}</b> (${sign(periodStats.projectNetTk)} ⬦)\n` +
    gameLines +
    `\n🏦 <b>Общий баланс проекта за всё время:</b>\n` +
    `├ По играм (всего ${allStats.betsCount} ст.): ${allStatusEmoji} <b>${signRub(allStats.projectNetRub)}</b> (${sign(allStats.projectNetTk)} ⬦)\n` +
    `├ Всего пополнений: <b>+${allStats.totalDepositsRub.toFixed(2)} ₽</b>\n` +
    `├ Всего выплачено выводов: <b>-${allStats.totalWithdrawalsRub.toFixed(2)} ₽</b>\n` +
    `└ Чистая касса (Депозиты − Выводы): ${cashStatusEmoji} <b>${signRub(allStats.cashflowNetRub)}</b>`
  );
}

module.exports = {
  STATS_FILE,
  recordBet,
  recordCashflow,
  getAnalytics,
  formatTelegramReport
};
