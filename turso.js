/**
 * Модуль облачной синхронизации MoneyForUp с Turso (LibSQL).
 *
 * Обеспечивает персистентность данных при деплоях на Render/Fly (эфемерный диск):
 * 1. При старте сервера: подтягивает всех пользователей, заказы, ledger и инвентарь из Turso в локальный SQLite.
 * 2. При операциях записи: немедленно выполняет запись в локальный SQLite (быстро, без лагов),
 *    и асинхронно отправляет операцию в Turso.
 * 3. При выключении сервера (SIGTERM/SIGINT): завершает отправку очереди в Turso.
 */
let createClient = null;
try {
  createClient = require('@libsql/client').createClient;
} catch (e) {
  try {
    const path = require('path');
    createClient = require(path.join(process.cwd(), 'node_modules/@libsql/client')).createClient;
  } catch (e2) {
    // @libsql/client not found in current path or cwd
  }
}

const { EXTRA_COLUMNS } = require('./schema');

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

let client = null;
if (TURSO_URL && createClient) {
  try {
    client = createClient({
      url: TURSO_URL,
      authToken: TURSO_TOKEN
    });
  } catch (e) {
    console.error('[Turso] Ошибка инициализации клиента:', e.message);
  }
}

function tursoOn() {
  return !!(client && TURSO_URL);
}

// Очередь асинхронных операций в Turso.
// Элемент очереди — группа стейтментов, которая обязана долететь ЦЕЛИКОМ
// (например, UPDATE баланса + INSERT в ledger одним изменением баланса).
// Все стейтменты в очереди идемпотентны (UPDATE / INSERT OR IGNORE / upsert),
// поэтому повторная отправка после сетевого сбоя безопасна.
const queue = [];
let isFlushing = false;
let retryTimer = null;
let retryDelay = 2000;

function queueQuery(sql, args = []) {
  queueBatch([{ sql, args }]);
}

/* Поставить в очередь группу стейтментов одного логического изменения. */
function queueBatch(stmts) {
  if (!tursoOn() || !Array.isArray(stmts) || stmts.length === 0) return;
  queue.push({ stmts });
  flushQueue();
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, 30000);
    flushQueue();
  }, retryDelay);
  if (retryTimer.unref) retryTimer.unref();
}

async function flushQueue() {
  if (isFlushing || queue.length === 0 || !client) return;
  isFlushing = true;

  while (queue.length > 0) {
    // Собираем до 50 стейтментов, не разрывая группы: client.batch — это
    // транзакция, группа долетит либо целиком, либо никак.
    const batch = [];
    const items = [];
    while (queue.length > 0 && batch.length < 50) {
      const item = queue.shift();
      items.push(item);
      batch.push(...item.stmts);
    }
    try {
      if (batch.length === 1) {
        await client.execute(batch[0]);
      } else {
        await client.batch(batch, 'write');
      }
      retryDelay = 2000;
    } catch (e) {
      console.error('[Turso] Ошибка записи в облако:', e.message);
      // Возвращаем группы в начало очереди и повторяем по таймеру, а не
      // только при следующей записи: иначе хвост теряется на SIGTERM.
      queue.unshift(...items);
      scheduleRetry();
      break;
    }
  }

  isFlushing = false;
}

/**
 * Восстановление локальной БД из Turso при старте сервиса на Render
 */
async function pullFromTurso(dbSync) {
  if (!tursoOn()) return { ok: false, reason: 'Turso не настроен' };
  console.log('[Turso] ⏳ Восстановление данных из облака Turso...');

  try {
    // Таблица персональных бустов появилась позже остальных. Создаём её здесь,
    // иначе первая же запись встанет в очередь и будет вечно ретраиться.
    try {
      await client.execute(`CREATE TABLE IF NOT EXISTS player_boosts (
        user_id INTEGER PRIMARY KEY,
        luck INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`);
    } catch (e) {
      console.warn('[Turso] player_boosts не создана:', e.message);
    }

    // Догоняющие колонки: без них запись заказа со сроком действия
    // (orders.expires_at и id сообщения в чате) вечно ретраилась бы в очереди.
    for (const [table, cols] of Object.entries(EXTRA_COLUMNS)) {
      try {
        const info = await client.execute(`PRAGMA table_info(${table})`);
        const have = new Set(info.rows.map(r => r.name));
        for (const [name, type] of cols) {
          if (!have.has(name)) {
            await client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
            console.log(`[Turso] + колонка ${table}.${name}`);
          }
        }
      } catch (e) {
        console.warn(`[Turso] миграция ${table}:`, e.message);
      }
    }

    // 1. Users
    const uRes = await client.execute('SELECT * FROM users');
    if (uRes.rows.length > 0) {
      const insUser = dbSync.prepare(`
        INSERT INTO users (id, num_id, name, username, tokens, staked, stake_since, accrued_base, ref_id, ref_earned, ref_invited, terms_at, total_deposited_rub, last_deposit_rub, last_deposit_id, last_cashback_at, cashback_claimed_dep_id, easycash_claimed, code, created_at, rakeback, free_cases, free_case_5ref_claimed, first_deposit_bonus_claimed, last_hot_drop, last_wheel_spin, last_streak_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, username=excluded.username, tokens=excluded.tokens, staked=excluded.staked,
          stake_since=excluded.stake_since, accrued_base=excluded.accrued_base, ref_earned=excluded.ref_earned,
          ref_invited=excluded.ref_invited, terms_at=excluded.terms_at, total_deposited_rub=excluded.total_deposited_rub,
          last_deposit_rub=excluded.last_deposit_rub, last_deposit_id=excluded.last_deposit_id,
          ref_id=excluded.ref_id, last_cashback_at=excluded.last_cashback_at, cashback_claimed_dep_id=excluded.cashback_claimed_dep_id,
          easycash_claimed=excluded.easycash_claimed, code=excluded.code,
          rakeback=excluded.rakeback, free_cases=excluded.free_cases, free_case_5ref_claimed=excluded.free_case_5ref_claimed,
          first_deposit_bonus_claimed=excluded.first_deposit_bonus_claimed,
          last_hot_drop=excluded.last_hot_drop, last_wheel_spin=excluded.last_wheel_spin, last_streak_at=excluded.last_streak_at
      `);
      for (const r of uRes.rows) {
        insUser.run(
          r.id, r.num_id, r.name, r.username, r.tokens, r.staked, r.stake_since, r.accrued_base,
          r.ref_id, r.ref_earned, r.ref_invited, r.terms_at, r.total_deposited_rub,
          r.last_deposit_rub, r.last_deposit_id, r.last_cashback_at, r.cashback_claimed_dep_id,
          r.easycash_claimed, r.code, r.created_at,
          Number(r.rakeback || 0), Number(r.free_cases || 0), Number(r.free_case_5ref_claimed || 0),
          Number(r.first_deposit_bonus_claimed || 0),
          Number(r.last_hot_drop || 0), Number(r.last_wheel_spin || 0), Number(r.last_streak_at || 0)
        );
      }
    }

    // 2. Orders
    const oRes = await client.execute('SELECT * FROM orders');
    if (oRes.rows.length > 0) {
      const insOrder = dbSync.prepare(`
        INSERT INTO orders (id, type, user_id, tokens, rub, bank, card, sender, method, details, status, source, tx, created_at, updated_at, bonus, expires_at, admin_msg_id, admin_chat_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at,
          expires_at=excluded.expires_at, admin_msg_id=excluded.admin_msg_id,
          admin_chat_id=excluded.admin_chat_id
      `);
      for (const r of oRes.rows) {
        insOrder.run(
          r.id, r.type, r.user_id, r.tokens, r.rub, r.bank, r.card, r.sender,
          r.method, r.details, r.status, r.source, r.tx, r.created_at, r.updated_at,
          r.bonus ?? '', r.expires_at ?? 0, r.admin_msg_id ?? 0, r.admin_chat_id ?? 0
        );
      }
    }

    // 3. Transactions Ledger
    const lRes = await client.execute('SELECT * FROM transactions_ledger ORDER BY id ASC');
    if (lRes.rows.length > 0) {
      const insLedger = dbSync.prepare(`
        INSERT OR IGNORE INTO transactions_ledger (id, user_id, amount, type, reason, reference_id, balance_before, balance_after, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of lRes.rows) {
        insLedger.run(r.id, r.user_id, r.amount, r.type, r.reason, r.reference_id, r.balance_before, r.balance_after, r.created_at);
      }
    }

    // 3b. Promo Codes (определения; без них кастомные промокоды теряются)
    try {
      const pcRes = await client.execute('SELECT * FROM promo_codes');
      if (pcRes.rows.length > 0) {
        const insPc = dbSync.prepare(`
          INSERT INTO promo_codes (code, tokens, max_uses, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(code) DO UPDATE SET tokens=excluded.tokens, max_uses=excluded.max_uses
        `);
        for (const r of pcRes.rows) insPc.run(r.code, r.tokens, r.max_uses, r.created_at);
      }
    } catch (e) { console.warn('[Turso] promo_codes не восстановлены (таблицы нет?):', e.message); }

    // 4. Promo Activations
    const paRes = await client.execute('SELECT * FROM promo_activations');
    if (paRes.rows.length > 0) {
      const insPa = dbSync.prepare('INSERT OR IGNORE INTO promo_activations (promo_code, user_id, activated_at) VALUES (?, ?, ?)');
      for (const r of paRes.rows) {
        insPa.run(r.promo_code, r.user_id, r.activated_at);
      }
    }

    // 5. User Inventory
    const invRes = await client.execute('SELECT * FROM user_inventory ORDER BY id ASC');
    if (invRes.rows.length > 0) {
      const insInv = dbSync.prepare(`
        INSERT OR IGNORE INTO user_inventory (id, user_id, item_code, name, icon, price, tier, case_id, case_name, round_id, acquired_at, sold_at, sold_for, upgrade_only)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of invRes.rows) {
        insInv.run(
          r.id, r.user_id, r.item_code, r.name, r.icon, r.price, r.tier,
          r.case_id, r.case_name, r.round_id, r.acquired_at, r.sold_at, r.sold_for,
          Number(r.upgrade_only || 0)
        );
      }
    }

    // 6. Game Rounds
    const grRes = await client.execute('SELECT * FROM game_rounds ORDER BY created_at DESC LIMIT 500');
    if (grRes.rows.length > 0) {
      const insGr = dbSync.prepare(`
        INSERT OR IGNORE INTO game_rounds (round_id, user_id, game, bet_tokens, mult, win_tokens, status, created_at, settled_at, item_code, item_price, seed, params)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of grRes.rows) {
        // seed/params появились позже: в старых строках Turso их нет — пишем null.
        insGr.run(
          r.round_id, r.user_id, r.game, r.bet_tokens, r.mult, r.win_tokens,
          r.status, r.created_at, r.settled_at, r.item_code, r.item_price,
          r.seed ?? null, r.params ?? null
        );
      }
    }

    // 7. Новые режимы: история кейсов, апгрейды и серверные сессии «Лесенки».
    // Без этого после рестарта Render сессии терялись бы, хотя сервер обещает
    // их сохранность.
    try {
      const coRes = await client.execute('SELECT * FROM case_opens');
      if (coRes.rows.length > 0) {
        const insCo = dbSync.prepare(`INSERT OR IGNORE INTO case_opens
          (request_id, user_id, mode_id, price, item_code, item_name, item_icon, item_price, item_tier, inventory_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of coRes.rows) insCo.run(r.request_id, r.user_id, r.mode_id, r.price, r.item_code,
          r.item_name, r.item_icon, r.item_price, r.item_tier, r.inventory_id, r.created_at);
      }
      try {
        const cwRes = await client.execute('SELECT * FROM case_warmups');
        if (cwRes.rows.length > 0) {
          const insCw = dbSync.prepare(`INSERT INTO case_warmups
            (user_id, case_id, points, last_roll_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, case_id) DO UPDATE SET points = excluded.points, last_roll_at = excluded.last_roll_at`);
          for (const r of cwRes.rows) insCw.run(r.user_id, r.case_id, r.points, r.last_roll_at);
        }
      } catch (e) { /* таблица появляется миграцией schema.js */ }
      const urRes = await client.execute('SELECT * FROM upgrade_runs');
      if (urRes.rows.length > 0) {
        const insUr = dbSync.prepare(`INSERT OR IGNORE INTO upgrade_runs
          (request_id, user_id, mode, source_type, source_value, source_item_id, targets_json, won,
           target_code, target_name, target_icon, target_value, target_tier, chance, aggregate_chance, inventory_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of urRes.rows) insUr.run(r.request_id, r.user_id, r.mode, r.source_type, r.source_value,
          r.source_item_id, r.targets_json, r.won, r.target_code, r.target_name, r.target_icon,
          r.target_value, r.target_tier, r.chance, r.aggregate_chance, r.inventory_id, r.created_at);
      }
      const usRes = await client.execute('SELECT * FROM upgrade_sessions');
      if (usRes.rows.length > 0) {
        const insUs = dbSync.prepare(`INSERT OR IGNORE INTO upgrade_sessions
          (id, request_id, user_id, mode, steps_total, step_index, source_value, current_value,
           source_type, source_item_id, status, ladder_json, created_at, updated_at, settled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of usRes.rows) insUs.run(r.id, r.request_id, r.user_id, r.mode, r.steps_total,
          r.step_index, r.source_value, r.current_value, r.source_type, r.source_item_id,
          r.status, r.ladder_json, r.created_at, r.updated_at, r.settled_at);
      }
      const uaRes = await client.execute('SELECT * FROM upgrade_actions');
      if (uaRes.rows.length > 0) {
        const insUa = dbSync.prepare(`INSERT OR IGNORE INTO upgrade_actions
          (request_id, session_id, user_id, step_index, action, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const r of uaRes.rows) insUa.run(r.request_id, r.session_id, r.user_id, r.step_index,
          r.action, r.result_json, r.created_at);
      }
      const irRes = await client.execute('SELECT * FROM idempotent_results');
      if (irRes.rows.length > 0) {
        const insIr = dbSync.prepare(`INSERT OR IGNORE INTO idempotent_results
          (request_id, user_id, kind, result_json, created_at) VALUES (?, ?, ?, ?, ?)`);
        for (const r of irRes.rows) insIr.run(r.request_id, r.user_id, r.kind, r.result_json, r.created_at);
      }
    } catch (e) {
      console.warn('[Turso] новые таблицы не восстановлены (миграция не применена?):', e.message);
    }

    // 7b. Персональные бусты дропа.
    try {
      const pbRes = await client.execute('SELECT * FROM player_boosts');
      if (pbRes.rows.length > 0) {
        const insPb = dbSync.prepare(`
          INSERT INTO player_boosts (user_id, luck, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET luck = excluded.luck, updated_at = excluded.updated_at
        `);
        for (const r of pbRes.rows) insPb.run(r.user_id, Number(r.luck || 0), Number(r.updated_at || 0));
      }
    } catch (e) {
      console.warn('[Turso] player_boosts не восстановлены:', e.message);
    }

    console.log(
      `[Turso] ✅ База синхронизирована: ${uRes.rows.length} пользователей, ` +
      `${oRes.rows.length} заказов, ${lRes.rows.length} транзакций ledger, ${invRes.rows.length} предметов инвентаря.`
    );
    return { ok: true, usersCount: uRes.rows.length };
  } catch (e) {
    console.error('[Turso] Ошибка при pullFromTurso:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Ожидание завершения всех записей в очереди перед остановкой процесса
 */
async function waitForFlush(timeoutMs = 5000) {
  const start = Date.now();
  flushQueue();   // не ждём пассивно: очередь могла стоять после сетевого сбоя
  // Ждём и опустошения очереди, и завершения уже летящего батча: раньше
  // функция возвращалась при пустой очереди, хотя запрос ещё был в сети,
  // и process.exit() обрывал его.
  while ((queue.length > 0 || isFlushing) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return queue.length === 0 && !isFlushing;
}

module.exports = {
  tursoOn,
  queueQuery,
  queueBatch,
  pullFromTurso,
  waitForFlush,
  // для тестов: состояние очереди без сети
  _queueLength: () => queue.length,
  _isFlushing: () => isFlushing
};
