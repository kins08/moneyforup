'use strict';
/**
 * Харнесс для аудиторских скриптов MoneyForUp.
 *
 * Поднимает РЕАЛЬНЫЙ bot.js в изолированном temp-каталоге: копирует проект,
 * линкует node_modules, создаёт тестовых игроков и ждёт готовности сервера.
 * Продовая база не трогается — работа идёт в /tmp, который удаляется в stop().
 *
 * Зачем общий модуль: PoC и e2e-тесты должны бить по ОДНОМУ и тому же
 * способу запуска. Если харнесс один, то и расхождение «в тесте работает,
 * а в PoC нет» невозможно.
 *
 * Использование:
 *   const { startServer, C } = require('./lib/server-harness');
 *   const srv = await startServer({ users: [{ id: 1, tokens: 3000, depositedRub: 300 }] });
 *   const r = await srv.post('/api/play', { game: 'dice', bet: 10, mult: 2 });
 *   ...
 *   await srv.stop();
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../../../../..');
const DEFAULT_BOT_TOKEN = '123456789:AAaaBBccDDeeFFggHHiiJJkkLLmmNNooPPP';

const C = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  grn: s => `\x1b[32m${s}\x1b[0m`,
  yel: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Занят ли порт. Проверяем ПЕРЕД запуском: если на порту уже висит сервер
 * от прошлого прогона (такое бывает после падения теста), новый bot.js не
 * сможет забиндиться, а тест начнёт общаться с ЧУЖИМ сервером и его БД —
 * и покажет расхождение, которого нет. Лучше найти свободный порт.
 */
function portBusy(port) {
  return new Promise(resolve => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Валидный initData для Telegram WebApp — HMAC-SHA256 от BOT_TOKEN, как в проде. */
function makeInitData(botToken, userId) {
  const p = new URLSearchParams();
  p.set('user', JSON.stringify({ id: userId, first_name: 'Аудит', username: 'audit_' + userId }));
  p.set('auth_date', String(Math.floor(Date.now() / 1000)));
  p.set('query_id', 'AAAaudit' + userId);
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

/**
 * @param {object} opts
 * @param {number} [opts.port=34519]      порт тестового сервера (меняй, чтобы гонять параллельно)
 * @param {Array}  [opts.users]           [{ id, tokens, depositedRub, name }]
 * @param {string} [opts.botToken]
 * @param {number} [opts.adminId]
 * @param {object} [opts.env]             доп. переменные окружения для bot.js
 */
async function startServer(opts = {}) {
  let port = opts.port || 34519;
  // Ищем свободный порт, начиная с запрошенного
  if (await portBusy(port)) {
    const asked = port;
    for (let p = port + 1; p < port + 20; p++) {
      if (!(await portBusy(p))) { port = p; break; }
    }
    console.warn(`[harness] порт ${asked} занят (остался сервер от прошлого запуска?) — беру ${port}`);
  }
  const botToken = opts.botToken || DEFAULT_BOT_TOKEN;
  const adminId = opts.adminId || 999999999;
  const users = opts.users || [];
  const defaultUser = users.length ? users[0].id : 1;

  // ── Изолированная копия проекта ──────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfu-audit-'));
  for (const f of ['bot.js', 'db.js', 'bets_monitor.js', 'items.js']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
  }
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) {
    try {
      fs.symlinkSync(nm, path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (_) {}
  }

  // ── Тестовые игроки (пишем напрямую в копию базы) ────────────────────────
  const db = require(path.join(tmp, 'db.js'));
  for (const u of users) {
    db.saveUser({
      id: u.id, numId: u.id % 100000, name: u.name || 'Тест', username: 'audit_' + u.id,
      tokens: u.tokens || 0, staked: 0, stakeSince: 0, accruedBase: 0,
      ref: 0, refEarned: 0, refInvited: 0, termsAt: Date.now(),
      totalDepositedRub: u.depositedRub || 0,
      lastDeposit: u.depositedRub || 0, lastDepositId: u.depositedRub ? 1 : 0,
      lastCashbackAt: 0, cashbackClaimedDepositId: 0, easycashClaimed: false,
      code: 'AUD' + u.id
    });
  }

  // ── Запуск bot.js ────────────────────────────────────────────────────────
  let log = '';
  const child = spawn(process.execPath, ['bot.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      NODE_PATH: path.join(ROOT, 'node_modules'),
      BOT_TOKEN: botToken,
      BOT_DRY_RUN: '1',                 // не ходим в Telegram API
      API_PORT: String(port),
      APP_URL: 'https://example.com/app',
      ADMIN_ID: String(adminId),
      PAYMENT_WEBHOOK_SECRET: 'audit-secret',
      ...(opts.env || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => log += d.toString());
  child.stderr.on('data', d => log += d.toString());

  const initDataCache = new Map();
  const initData = userId => {
    if (!initDataCache.has(userId)) initDataCache.set(userId, makeInitData(botToken, userId));
    return initDataCache.get(userId);
  };

  const post = (p, body = {}, userId) =>
    new Promise((resolve, reject) => {
      const payload = { ...body };
      if (!payload.initData) payload.initData = initData(userId || defaultUser);
      const data = JSON.stringify(payload);
      const req = http.request({
        host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 15000
      }, res => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
          catch { resolve({ status: res.statusCode, body: out }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(data);
      req.end();
    });

  const get = p => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 10000 }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }).on('error', reject);
  });

  // ── Ждём готовности ──────────────────────────────────────────────────────
  let up = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try { await post('/api/balance', {}, defaultUser); up = true; break; }
    catch { await sleep(250); }
  }
  if (!up) {
    await finish();
    throw new Error('bot.js не поднялся за 20 с. Лог:\n' + log.slice(-2000));
  }

  const bal = id => db.getUser(id).tokens;
  const ledgerSum = id => db.db
    .prepare('SELECT COALESCE(SUM(amount),0) AS s FROM transactions_ledger WHERE user_id = ?')
    .get(id).s;
  const stop = () => finish();

  async function finish() {
    try { child.kill('SIGTERM'); } catch (_) {}
    await sleep(250);
    try { child.kill('SIGKILL'); } catch (_) {}
    try { db.db.close(); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  return {
    port, botToken, adminId, users, defaultUser,
    post, get, initData, bal, ledgerSum, stop,
    get log() { return log; },
    tmp, db
  };
}

module.exports = { startServer, makeInitData, C, sleep, ROOT, DEFAULT_BOT_TOKEN };
