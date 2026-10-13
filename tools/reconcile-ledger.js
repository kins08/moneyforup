/**
 * MoneyForUp — Аудит и сверка целостности финансового журнала (Ledger Reconciliation)
 *
 * Скрипт ТОЛЬКО НА ЧТЕНИЕ. Открывает SQLite-базу через встроенный node:sqlite (Node.js 22+)
 * в режиме read-only. Не совершает никаких записей, модификаций или создания временных таблиц.
 *
 * Использование:
 *   node tools/reconcile-ledger.js [путь_к_файлу_бд]
 *   Пример: node tools/reconcile-ledger.js /tmp/check.db
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TOKENS_PER_RUB = 10; // 10 ⬦ = 1 ₽

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

function fmtRub(tk) {
  const rub = (Number(tk || 0) / TOKENS_PER_RUB).toFixed(2);
  return `${Number(rub).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function pad(str, len, align = 'left') {
  const s = String(str ?? '');
  if (s.length >= len) return s;
  const spaces = ' '.repeat(len - s.length);
  return align === 'right' ? spaces + s : s + spaces;
}

function main() {
  const dbArg = process.argv[2];
  const dbPath = dbArg ? path.resolve(dbArg) : path.join(__dirname, '..', 'data', 'moneyforup.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`[ОШИБКА] Файл базы данных не найден: ${dbPath}`);
    process.exit(1);
  }

  // Строго безопасное открытие БД только на чтение
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
  } catch (err) {
    console.error(`[ОШИБКА] Не удалось открыть базу данных в режиме чтения: ${err.message}`);
    process.exit(1);
  }

  console.log('='.repeat(92));
  console.log('🔎 СВЕРКА ФИНАНСОВОГО ЖУРНАЛА (LEDGER RECONCILIATION) — MONEYFORUP');
  console.log(`📁 Файл базы данных: ${dbPath}`);
  console.log(`⏱ Время проверки: ${new Date().toISOString()}`);
  console.log('🔒 Режим: STRICTLY READ-ONLY (query_only = ON)');
  console.log('='.repeat(92));
  console.log('');

  // Проверяем наличие необходимых таблиц
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  const hasUsers = tables.includes('users');
  const hasLedger = tables.includes('transactions_ledger');
  const hasOrders = tables.includes('orders');

  if (!hasUsers) {
    console.error('[ВНИМАНИЕ] Таблица users отсутствует в базе данных.');
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // 1. РАЗРЫВЫ В ЦЕПОЧКЕ LEDGER (ДЕТЕКТОР БАГА)
  // -------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------------------------------');
  console.log('1. РАЗРЫВЫ В ЦЕПОЧКЕ TRANSACTIONS_LEDGER');
  console.log('   (balance_after предыдущей записи == balance_before следующей)');
  console.log('--------------------------------------------------------------------------------------------');

  let gaps = [];
  let totalNetGapTokens = 0;
  let totalAbsGapTokens = 0;

  if (!hasLedger) {
    console.log('   [ИНФО] Таблица transactions_ledger отсутствует. Разрывы не обнаружены.');
  } else {
    const ledgerRows = db.prepare(`
      SELECT id, user_id, amount, type, reason, balance_before, balance_after, created_at
      FROM transactions_ledger
      ORDER BY user_id ASC, id ASC
    `).all();

    // Группируем по пользователям
    const userLedgerMap = new Map();
    for (const row of ledgerRows) {
      if (!userLedgerMap.has(row.user_id)) {
        userLedgerMap.set(row.user_id, []);
      }
      userLedgerMap.get(row.user_id).push(row);
    }

    for (const [userId, records] of userLedgerMap.entries()) {
      for (let i = 0; i < records.length - 1; i++) {
        const prev = records[i];
        const next = records[i + 1];

        if (prev.balance_after !== next.balance_before) {
          const diff = next.balance_before - prev.balance_after;
          gaps.push({
            userId,
            prevId: prev.id,
            nextId: next.id,
            prevBalAfter: prev.balance_after,
            nextBalBefore: next.balance_before,
            gapTokens: diff,
            prevType: prev.type,
            nextType: next.type,
            reason: next.reason || prev.reason || ''
          });
          totalNetGapTokens += diff;
          totalAbsGapTokens += Math.abs(diff);
        }
      }
    }

    if (gaps.length === 0) {
      console.log('   ✅ Разрывов в цепочке transactions_ledger не обнаружено!');
      console.log('      Все соседние записи строго согласованы (balance_after == next.balance_before).');
    } else {
      console.log(`   ⚠️ ОБНАРУЖЕНО РАЗРЫВОВ В ЦЕПОЧКЕ: ${gaps.length}`);
      console.log('');
      console.log(`   ${pad('User ID', 12)} | ${pad('Tx ID (до -> после)', 22)} | ${pad('Баланс (до -> после)', 24)} | ${pad('Разрыв (⬦)', 14)} | Причина/Контекст`);
      console.log('   ' + '-'.repeat(88));

      for (const g of gaps) {
        const userStr = pad(g.userId, 12);
        const txStr = pad(`#${g.prevId} -> #${g.nextId}`, 22);
        const balStr = pad(`${fmt(g.prevBalAfter)} -> ${fmt(g.nextBalBefore)} ⬦`, 24);
        const diffSign = g.gapTokens > 0 ? `+${fmt(g.gapTokens)}` : fmt(g.gapTokens);
        const diffStr = pad(diffSign, 14, 'right');
        const ctxStr = `${g.prevType} -> ${g.nextType} (${g.reason})`;

        console.log(`   ${userStr} | ${txStr} | ${balStr} | ${diffStr} | ${ctxStr}`);
      }
    }
  }

  console.log('');

  // -------------------------------------------------------------------------
  // 2. СВОДНАЯ ТАБЛИЦА ПО КАЖДОМУ ИГРОКУ
  // -------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------------------------------');
  console.log('2. СВОДНАЯ ТАБЛИЦА ПО КАЖДОМУ ИГРОКУ (СОРТИРОВКА ПО USERS.TOKENS УБЫВ.)');
  console.log('--------------------------------------------------------------------------------------------');

  let playerStats = [];
  try {
    const query = `
      SELECT 
        u.id AS user_id,
        u.name AS name,
        u.username AS username,
        u.tokens AS user_tokens,
        u.total_deposited_rub AS total_deposited_rub,
        ${hasLedger ? 'COALESCE(l.ledger_sum, 0)' : '0'} AS ledger_sum,
        ${hasLedger ? 'COALESCE(d.deposit_sum, 0)' : '0'} AS deposit_sum,
        ${hasOrders ? 'COALESCE(w.paid_withdrawals_count, 0)' : '0'} AS paid_withdrawals_count
      FROM users u
      ${hasLedger ? `
      LEFT JOIN (
        SELECT user_id, SUM(amount) AS ledger_sum
        FROM transactions_ledger
        GROUP BY user_id
      ) l ON l.user_id = u.id
      LEFT JOIN (
        SELECT user_id, SUM(amount) AS deposit_sum
        FROM transactions_ledger
        WHERE type = 'deposit'
        GROUP BY user_id
      ) d ON d.user_id = u.id
      ` : ''}
      ${hasOrders ? `
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS paid_withdrawals_count
        FROM orders
        WHERE type = 'withdraw' AND status = 'paid'
        GROUP BY user_id
      ) w ON w.user_id = u.id
      ` : ''}
      ORDER BY u.tokens DESC;
    `;
    playerStats = db.prepare(query).all();
  } catch (e) {
    // Резервный простой запрос
    playerStats = db.prepare('SELECT id AS user_id, name, username, tokens AS user_tokens, 0 AS ledger_sum, 0 AS deposit_sum, 0 AS paid_withdrawals_count FROM users ORDER BY tokens DESC').all();
  }

  console.log(`   ${pad('user_id', 12)} | ${pad('users.tokens', 14, 'right')} | ${pad('SUM(ledger)', 14, 'right')} | ${pad('SUM(deposit)', 14, 'right')} | ${pad('Выводов (paid)', 14, 'right')} | Имя/Username`);
  console.log('   ' + '-'.repeat(90));

  let totalUserTokens = 0;
  for (const p of playerStats) {
    totalUserTokens += Number(p.user_tokens || 0);
    const uId = pad(p.user_id, 12);
    const uTok = pad(fmt(p.user_tokens) + ' ⬦', 14, 'right');
    const lSum = pad(fmt(p.ledger_sum) + ' ⬦', 14, 'right');
    const dSum = pad(fmt(p.deposit_sum) + ' ⬦', 14, 'right');
    const wCount = pad(p.paid_withdrawals_count, 14, 'right');
    const uName = (p.username ? '@' + p.username : (p.name || '—'));
    console.log(`   ${uId} | ${uTok} | ${lSum} | ${dSum} | ${wCount} | ${uName}`);
  }

  if (playerStats.length === 0) {
    console.log('   (Пользователей в базе данных не найдено)');
  }

  console.log('');

  // -------------------------------------------------------------------------
  // 3. ЭВРИСТИКА: КАНДИДАТЫ НА НАКРУТКУ
  // -------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------------------------------');
  console.log('3. КАНДИДАТЫ НА НАКРУТКУ (ЭВРИСТИКА: tokens заметно больше депозитов)');
  console.log('   [Пометка: Это математическая эвристика, требующая ручной верификации]');
  console.log('--------------------------------------------------------------------------------------------');

  const suspiciousPlayers = [];

  for (const p of playerStats) {
    const tokens = Number(p.user_tokens || 0);
    const depRub = Number(p.total_deposited_rub || 0);
    const depLedger = Number(p.deposit_sum || 0);
    const effectiveDepTokens = Math.max(depLedger, depRub * TOKENS_PER_RUB);

    // Критерии подозрительности:
    // 1) Бездепозитный игрок с балансом > 400 ⬦ (стартовый баланс 50 ⬦)
    // 2) Игрок, у которого баланс более чем в 3 раза превышает сумму депозитов (и баланс >= 1000 ⬦)
    // 3) Резкий скачок баланса выше 5000 ⬦ при депозитах < 500 ⬦
    if (effectiveDepTokens === 0 && tokens > 400) {
      suspiciousPlayers.push({
        ...p,
        reason: `0 ₽ депозитов, а баланс ${fmt(tokens)} ⬦ (стартовый: 50 ⬦)`
      });
    } else if (effectiveDepTokens > 0 && tokens >= 1000 && tokens > effectiveDepTokens * 3 + 500) {
      suspiciousPlayers.push({
        ...p,
        reason: `Баланс (${fmt(tokens)} ⬦) превышает сумму депозитов (${fmt(effectiveDepTokens)} ⬦) более чем в 3 раза`
      });
    }
  }

  if (suspiciousPlayers.length === 0) {
    console.log('   ✅ Подозрительных игроков по критериям эвристики не выявлено.');
  } else {
    console.log(`   ⚠️ Найдено кандидатов с аномальным балансом: ${suspiciousPlayers.length}`);
    console.log('');
    for (const sp of suspiciousPlayers) {
      const uLabel = sp.username ? `@${sp.username}` : (sp.name || `ID ${sp.user_id}`);
      console.log(`   • Игрок ID: ${sp.user_id} (${uLabel})`);
      console.log(`     Баланс: ${fmt(sp.user_tokens)} ⬦ (~${fmtRub(sp.user_tokens)})`);
      console.log(`     Депозиты: ${fmt(sp.deposit_sum)} ⬦ по ledger / ${sp.total_deposited_rub || 0} ₽ в профиле`);
      console.log(`     Оплаченных выводов: ${sp.paid_withdrawals_count}`);
      console.log(`     Причина подозрения: ${sp.reason}`);
      console.log('');
    }
  }

  // -------------------------------------------------------------------------
  // 4. ИТОГОВАЯ СВОДКА
  // -------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------------------------------');
  console.log('4. ИТОГОВАЯ СВОДКА');
  console.log('--------------------------------------------------------------------------------------------');
  console.log(`• Всего пользователей в БД:             ${playerStats.length}`);
  console.log(`• Всего токенов на балансах игроков:    ${fmt(totalUserTokens)} ⬦ (${fmtRub(totalUserTokens)})`);
  console.log(`• Всего разрывов в цепочке ledger:      ${gaps.length} шт.`);
  console.log(`• Чистый разрыв (Net Gap):              ${totalNetGapTokens >= 0 ? '+' : ''}${fmt(totalNetGapTokens)} ⬦ (${fmtRub(totalNetGapTokens)})`);
  console.log(`• Суммарный объём разрывов (Abs Gap):   ${fmt(totalAbsGapTokens)} ⬦ (${fmtRub(totalAbsGapTokens)})`);
  console.log('');
  console.log('📌 ПРИМЕЧАНИЕ О СОХРАННОСТИ ИСТОРИИ:');
  console.log('   История до внедрения db.js в transactions_ledger отсутствует.');
  console.log('   Поэтому у старых аккаунтов начальные операции и расхождения за прошлые');
  console.log('   периоды восстановить через ledger невозможно — это штатное поведение.');
  console.log('='.repeat(92));

  // Явное закрытие базы данных
  try { db.close(); } catch (_) {}

  process.exit(0);
}

main();
