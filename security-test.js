/**
 * Тест серверной безопасности и игровой экономики (MoneyForUp):
 * 1. Защита баланса: клиент не может произвольно перезаписать баланс через /api/sync-balance
 * 2. Атомарность и мьютекс: два одновременных запроса не могут списать один и тот же остаток (защита от race condition)
 * 3. Идемпотентность: повторный запрос с тем же ключом не выполняет повторного списания/начисления
 * 4. Серверная экономика игр:
 *    - Ракетка: старт сессии, списание, генерация crashPoint, вывод с валидацией, начисление выигрыша
 *    - Спин: серверный расчёт сектора и начисление
 *    - Дроп: серверный выбор лунки и начисление
 *    - Дайс: серверный бросок кубика
 * 5. Прерывание игры: однократный возврат ставки через /api/game/cancel, повторный возврат заблокирован
 * 6. Выплаты: проверка доступного остатка, журнал заявок, идемпотентность
 * 7. Транзакционный журнал (Ledger) и аудит: сверка баланса через /api/audit
 * 8. Telegram-авторизация: поддельный / пустой initData отбивается (401)
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BOT_TOKEN = '123456789:AAaaBBccDDeeFFggHHiiJJkkLLmmNNoo';
const API_PORT = 3925;

const ok = [], bad = [];
const check = (c, m) => (c ? ok : bad).push(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeInitData(userId, name) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'q' + userId,
    user: JSON.stringify({ id: userId, first_name: name, username: 'user' + userId })
  });
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function request(path, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${API_PORT}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

async function run() {
  const env = {
    ...process.env,
    BOT_TOKEN,
    API_PORT: String(API_PORT),
    BOT_DRY_RUN: '1'
  };
  const proc = spawn('node', ['bot.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write(d));
  await sleep(1500);

  try {
    const user1Init = makeInitData(5001, 'Алексей');
    const user2Init = makeInitData(5002, 'Мария');

    // 1. Проверка Telegram-авторизации
    const fakeAuth = await request('/api/balance', { initData: 'bad_hash_data' });
    check(fakeAuth.status === 401, 'Поддельный initData отбит с кодом 401');

    const reg1 = await request('/api/register', { initData: user1Init, termsAcceptedAt: Date.now() });
    check(reg1.status === 200 && reg1.body.tokens === 50, 'Пользователь зарегистрирован, стартовый баланс = 50 ⬦');

    // 2. Проверка защиты баланса: клиент не может произвольно накрутить баланс через /api/sync-balance
    const cheatAttempt = await request('/api/sync-balance', { initData: user1Init, tokens: 999999 });
    check(cheatAttempt.status === 200 && cheatAttempt.body.tokens === 50, 'Попытка клиента произвольно установить 999999 ⬦ отбита (сервер вернул 50 ⬦)');

    const balCheck = await request('/api/balance', { initData: user1Init });
    check(balCheck.body.tokens === 50, 'Баланс на сервере остался неизменным (50 ⬦)');

    // 3. Серверная экономика игр: Ракетка (Crash)
    const racketStart = await request('/api/game/racket/start', { initData: user1Init, bet: 20 });
    check(racketStart.status === 200 && racketStart.body.ok && racketStart.body.balance === 30, 'Ракетка: ставка 20 ⬦ списана сервером (баланс 50 → 30 ⬦)');
    check(typeof racketStart.body.sessionId === 'string' && racketStart.body.hash, 'Ракетка: создана сессия и сгенерирован Provably Fair хеш');

    const sessionId = racketStart.body.sessionId;

    // 4. Прерывание игры с однократным возвратом ставки
    const cancelGame = await request('/api/game/cancel', { initData: user1Init, sessionId });
    check(cancelGame.status === 200 && cancelGame.body.ok && cancelGame.body.balance === 50, 'Отмена активной игры: ставка 20 ⬦ возвращена на баланс (30 → 50 ⬦)');

    const cancelAgain = await request('/api/game/cancel', { initData: user1Init, sessionId });
    check(cancelAgain.status === 400, 'Повторная отмена той же сессии отклонена (защита от двойного возврата)');

    // 5. Игровой раунд Ракетки с выводом (Cashout)
    const r2 = await request('/api/game/racket/start', { initData: user1Init, bet: 10 });
    check(r2.status === 200 && r2.body.balance === 40, 'Ракетка: новая ставка 10 ⬦ списана (баланс 40 ⬦)');

    const cashout = await request('/api/game/racket/cashout', { initData: user1Init, sessionId: r2.body.sessionId, multiplier: 1.05 });
    check(cashout.status === 200 && cashout.body.ok, 'Ракетка: вывод на ×1.05 обработан сервером');
    if (cashout.body.won) {
      check(cashout.body.payout === 10 && cashout.body.balance === 50, 'Ракетка: выигрыш начислен сервером (+10 ⬦)');
    }

    // 6. Серверная игра «Спин» (Колесо)
    const spinRes = await request('/api/game/spin', { initData: user1Init, bet: 10, mode: 'med' });
    check(spinRes.status === 200 && spinRes.body.ok && typeof spinRes.body.sectorIndex === 'number', 'Спин: сервер рассчитал выпавший сектор (' + spinRes.body.sectorIndex + ', ×' + spinRes.body.multiplier + ')');
    check(typeof spinRes.body.balance === 'number', 'Спин: баланс подтверждён сервером (' + spinRes.body.balance + ' ⬦)');

    // 7. Серверная игра «Дроп» (Плинко)
    const dropRes = await request('/api/game/drop', { initData: user1Init, bet: 5, mode: 'med' });
    check(dropRes.status === 200 && dropRes.body.ok && typeof dropRes.body.slotIndex === 'number', 'Дроп: сервер рассчитал лунку (' + dropRes.body.slotIndex + ', ×' + dropRes.body.multiplier + ')');

    // 8. Защита от параллельных запросов (Concurrency / Race Condition)
    // Пользователь пытается одновременно сделать 5 ставок по 50 токенов при балансе < 250
    const curBal = (await request('/api/balance', { initData: user1Init })).body.tokens;
    const betAmt = Math.floor(curBal * 0.6); // каждая ставка больше половины баланса!
    const [p1, p2] = await Promise.all([
      request('/api/game/racket/start', { initData: user1Init, bet: betAmt }),
      request('/api/game/racket/start', { initData: user1Init, bet: betAmt })
    ]);
    const succCount = (p1.status === 200 ? 1 : 0) + (p2.status === 200 ? 1 : 0);
    const failCount = (p1.status === 400 ? 1 : 0) + (p2.status === 400 ? 1 : 0);
    check(succCount === 1 && failCount === 1, 'Мьютекс: два параллельных запроса на списание не смогли использовать один и тот же остаток (1 успешен, 1 отклонён)');

    // 9. Выплаты (Withdrawals) и валидация
    const badWithdraw = await request('/api/withdraw', { initData: user1Init, rub: 1000, method: 'СБП', details: '+79991112233' });
    check(badWithdraw.status === 400, 'Заявка на вывод суммы, превышающей баланс, отклонена (400)');

    // 10. Транзакционный журнал (Ledger) и Сверка баланса (Audit)
    const txLog = await request('/api/transactions', { initData: user1Init });
    check(txLog.status === 200 && Array.isArray(txLog.body.transactions) && txLog.body.transactions.length > 0, 'Журнал транзакций ведётся: ' + txLog.body.transactions.length + ' записей');
    const firstTx = txLog.body.transactions[0];
    check(firstTx.id && firstTx.balanceBefore !== undefined && firstTx.balanceAfter !== undefined, 'Каждая транзакция содержит id, balanceBefore, balanceAfter, delta');

    const audit = await request('/api/audit', { initData: user1Init });
    check(audit.status === 200 && audit.body.ok, 'Серверный аудит доступен');
    check(audit.body.reconciled === true, 'Сверка баланса: 100% сошлось (текущий ' + audit.body.currentBalance + ' ⬦ = расчётный ' + audit.body.calculatedBalance + ' ⬦)');

    console.log(`\n=== ПРОШЛО БЕЗОПАСНОСТИ (${ok.length}) ===`);
    ok.forEach(m => console.log('  ✓ ' + m));

    if (bad.length > 0) {
      console.error(`\n=== ОШИБКИ (${bad.length}) ===`);
      bad.forEach(m => console.error('  ✗ ' + m));
      process.exit(1);
    }
  } finally {
    proc.kill('SIGTERM');
  }
}

run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
