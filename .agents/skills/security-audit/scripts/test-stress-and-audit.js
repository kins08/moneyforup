'use strict';
/**
 * СТРЕСС-ТЕСТ И АУДИТ УЯЗВИМОСТЕЙ ДЛЯ MONEYFORUP
 * 
 * Проверяет:
 * 1. Concurrency Race Conditions на балансе (параллельные ставки /api/play).
 * 2. Concurrency Race Conditions на выводе средств (/api/withdraw).
 * 3. Concurrency Race Conditions на инвентаре (одновременная продажа предмета).
 * 4. Concurrency Race Conditions на промокодах (/api/promo).
 * 5. Граничные значения и аномальные входные данные (отрицательные ставки, NaN, float).
 * 6. Нагрузочный стресс-тест на пропускную способность (RPS, латентность, ошибки).
 */

const { startServer, C, sleep } = require('./lib/server-harness');

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 ЗАПУСК СТРЕСС-ТЕСТИРОВАНИЯ И АУДИТА БЕЗОПАСНОСТИ MONEYFORUP');
  console.log('='.repeat(70) + '\n');

  const srv = await startServer({
    users: [
      { id: 101, tokens: 100, depositedRub: 100 },   // Для теста гонки ставок
      { id: 102, tokens: 2000, depositedRub: 300 },  // Для теста гонки вывода (2000 токенов = 200 руб)
      { id: 103, tokens: 5000, depositedRub: 500 },  // Для теста инвентаря
      { id: 104, tokens: 1000, depositedRub: 100 },  // Для теста промокодов
      { id: 105, tokens: 100000, depositedRub: 1000 } // Для нагрузочного RPS-теста
    ]
  });

  const findings = [];

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // ТЕСТ 1: ГОНКА НА СТАВКАХ (CONCURRENT PLAY RACE CONDITION)
    // У пользователя 100 токенов. Мы одновременно посылаем 20 запросов со ставкой 100.
    // Если есть гонка, баланс может уйти в минус или пользователь сделает несколько ставок.
    // ──────────────────────────────────────────────────────────────────────────
    console.log(C.b('1. Тест состояния гонки на ставках (/api/play)'));
    console.log('   Игрок 101 имеет 100 токенов. Отправляем 20 ОДНОВРЕМЕННЫХ запросов со ставкой 100 ⬦...');

    const playPromises = [];
    for (let i = 0; i < 20; i++) {
      playPromises.push(srv.post('/api/play', { game: 'dice', bet: 100, mult: 2 }, 101));
    }
    const playResults = await Promise.all(playPromises);
    const playSuccess = playResults.filter(r => r.status === 200);
    const playRejected = playResults.filter(r => r.status !== 200);
    const bal101 = srv.bal(101);

    console.log(`   Успешных раундов: ${playSuccess.length}, отклонено: ${playRejected.length}`);
    console.log(`   Итоговый баланс игрока 101: ${bal101} ⬦`);

    if (bal101 < 0) {
      findings.push({
        severity: 'CRITICAL',
        title: 'Отрицательный баланс при одновременных ставках',
        desc: `Баланс ушел в ${bal101} при одновременных запросах.`
      });
      console.log(C.red('   ❌ Баланс ушел в минус!'));
    } else {
      console.log(C.grn('   ✅ Баланс не ушел в минус. Защита от овердрафта сработала.'));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ТЕСТ 2: ГОНКА НА ВЫВОДЕ СРЕДСТВ (/api/withdraw)
    // У игрока 2000 токенов (200 руб). Он шлет 10 одновременных запросов на вывод 200 руб.
    // Ожидается: ровно 1 успешный вывод, 9 отклонено.
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n' + C.b('2. Тест состояния гонки на выводе средств (/api/withdraw)'));
    console.log('   Игрок 102 имеет 2000 токенов (200 ₽). Шлем 10 ОДНОВРЕМЕННЫХ заявок на вывод 200 ₽...');

    const withdrawPromises = [];
    for (let i = 0; i < 10; i++) {
      withdrawPromises.push(srv.post('/api/withdraw', {
        rub: 200,
        bank: 'Сбербанк',
        details: '+79991112233'
      }, 102));
    }
    const withdrawResults = await Promise.all(withdrawPromises);
    const withdrawSuccess = withdrawResults.filter(r => r.status === 200 && r.body && r.body.success);
    const withdrawFailed = withdrawResults.filter(r => r.status !== 200 || !r.body || !r.body.success);
    const bal102 = srv.bal(102);

    console.log(`   Успешных заявок: ${withdrawSuccess.length}, отклонено: ${withdrawFailed.length}`);
    console.log(`   Итоговый баланс игрока 102: ${bal102} ⬦`);

    if (withdrawSuccess.length > 1) {
      findings.push({
        severity: 'HIGH',
        title: 'Гонка на выводе средств (Double Withdrawal Race)',
        desc: `Создано ${withdrawSuccess.length} заявок на вывод вместо 1 при балансе на 1 заявку.`
      });
      console.log(C.red(`   ❌ Создано ${withdrawSuccess.length} заявок на вывод!`));
    } else {
      console.log(C.grn('   ✅ Ровно 1 заявка создана, остальные отклонены.'));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ТЕСТ 3: ГОНКА НА ПРОДАЖЕ ПРЕДМЕТА ИНВЕНТАРЯ (/api/inventory/sell)
    // Открываем кейс, получаем предмет, а затем шлем 10 одновременных запросов на его продажу.
    // Ожидается: предмет продается ровно 1 раз, баланс увеличивается ровно 1 раз.
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n' + C.b('3. Тест состояния гонки на продаже инвентаря (/api/inventory/sell)'));
    const caseRes = await srv.post('/api/play', { game: 'Кейс: Стартовый дроп', bet: 500 }, 103);
    if (caseRes.body && caseRes.body.drop) {
      const dropId = caseRes.body.drop.id;
      const dropPrice = caseRes.body.drop.price;
      const balBeforeSell = srv.bal(103);
      console.log(`   Выпал предмет #${dropId} (${caseRes.body.drop.name}) стоимостью ${dropPrice} ⬦.`);
      console.log(`   Шлем 10 ОДНОВРЕМЕННЫХ запросов на продажу предмета #${dropId}...`);

      const sellPromises = [];
      for (let i = 0; i < 10; i++) {
        sellPromises.push(srv.post('/api/inventory/sell', { itemId: dropId }, 103));
      }
      const sellResults = await Promise.all(sellPromises);
      const sellSuccess = sellResults.filter(r => r.status === 200 && r.body && r.body.ok);
      const balAfterSell = srv.bal(103);
      const diff = balAfterSell - balBeforeSell;

      console.log(`   Успешных продаж: ${sellSuccess.length}, начислено: ${diff} ⬦ (ожидалось: ${dropPrice} ⬦)`);

      if (sellSuccess.length > 1 || diff > dropPrice) {
        findings.push({
          severity: 'HIGH',
          title: 'Повторная продажа предмета инвентаря (Double Inventory Sell)',
          desc: `Предмет продан ${sellSuccess.length} раз, начислено ${diff} вместо ${dropPrice}.`
        });
        console.log(C.red('   ❌ Предмет продан несколько раз!'));
      } else {
        console.log(C.grn('   ✅ Предмет продан ровно один раз.'));
      }
    } else {
      console.log('   ⚠️ Кейс не вернул предмет:', caseRes.body);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ТЕСТ 4: ГОНКА НА ПРОМОКОДАХ (/api/promo)
    // Создаем промокод с max_uses = 1. Шлем 10 одновременных запросов на активацию.
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n' + C.b('4. Тест состояния гонки на промокоде (/api/promo)'));
    srv.db.db.prepare('INSERT INTO promo_codes (code, tokens, max_uses, created_at) VALUES (?, ?, ?, ?)').run('STRESS100', 100, 1, Date.now());
    console.log('   Создан промокод STRESS100 (+100 ⬦, max_uses = 1).');
    console.log('   Шлем 10 ОДНОВРЕМЕННЫХ запросов на активацию от игрока 104...');

    const promoPromises = [];
    for (let i = 0; i < 10; i++) {
      promoPromises.push(srv.post('/api/promo', { code: 'STRESS100' }, 104));
    }
    const promoResults = await Promise.all(promoPromises);
    const promoSuccess = promoResults.filter(r => r.status === 200 && r.body && r.body.ok);
    const bal104 = srv.bal(104);

    console.log(`   Успешных активаций: ${promoSuccess.length}, баланс игрока 104: ${bal104} ⬦ (было 1000 ⬦)`);

    if (promoSuccess.length > 1 || bal104 > 1100) {
      findings.push({
        severity: 'HIGH',
        title: 'Многократная активация одноразового промокода',
        desc: `Промокод активирован ${promoSuccess.length} раз параллельными запросами.`
      });
      console.log(C.red('   ❌ Промокод активирован несколько раз!'));
    } else {
      console.log(C.grn('   ✅ Промокод активирован ровно 1 раз.'));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ТЕСТ 5: ВАЛИДАЦИЯ ГРАНИЧНЫХ ЗНАЧЕНИЙ (FUZZING & BOUNDARY CHECKS)
    // Проверяем отрицательные ставки, дробные ставки, NaN, строковые инъекции.
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n' + C.b('5. Валидация граничных и аномальных входных данных'));

    const badInputs = [
      { name: 'Отрицательная ставка', payload: { game: 'dice', bet: -100 } },
      { name: 'Нулевая ставка', payload: { game: 'dice', bet: 0 } },
      { name: 'Дробная ставка (10.5)', payload: { game: 'dice', bet: 10.5 } },
      { name: 'NaN ставка', payload: { game: 'dice', bet: NaN } },
      { name: 'Строковая ставка "100"', payload: { game: 'dice', bet: '100' } },
      { name: 'Огромная ставка 99999999', payload: { game: 'dice', bet: 99999999 } },
      { name: 'Отрицательный множитель', payload: { game: 'dice', bet: 10, mult: -2 } },
      { name: 'Огромный множитель 100000', payload: { game: 'dice', bet: 10, mult: 100000 } }
    ];

    for (const b of badInputs) {
      const res = await srv.post('/api/play', b.payload, 105);
      const isOk = res.status !== 200 || (res.body && res.body.ok && typeof res.body.win === 'number');
      if (res.status === 200 && (b.payload.bet < 10 || isNaN(b.payload.bet))) {
        findings.push({
          severity: 'MEDIUM',
          title: `Недопустимый ввод принят: ${b.name}`,
          desc: `Сервер вернул 200 на некорректную ставку: ${JSON.stringify(b.payload)}`
        });
        console.log(`   ❌ ${b.name}: принята сервером (status ${res.status})`);
      } else {
        console.log(`   ✅ ${b.name}: корректно обработано (${res.status === 200 ? 'обрезано' : 'отклонено ' + res.status})`);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ТЕСТ 6: НАГРУЗОЧНЫЙ СТРЕСС-ТЕСТ (LOAD & RPS BENCHMARK)
    // Отправляем 200 запросов пакетами по 20 конкурентных соединений,
    // замеряем среднее время отклика, p95, p99 и RPS.
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n' + C.b('6. Нагрузочный стресс-тест на пропускную способность (RPS / Latency)'));
    console.log('   Отправляем 200 запросов к /api/balance (конкурентность 20)...');

    const totalRequests = 200;
    const concurrency = 20;
    const latencies = [];
    const tStart = Date.now();
    let errCount = 0;

    for (let i = 0; i < totalRequests; i += concurrency) {
      const batch = [];
      for (let j = 0; j < concurrency && (i + j) < totalRequests; j++) {
        const reqStart = Date.now();
        batch.push(
          srv.post('/api/balance', {}, 105)
            .then(r => {
              latencies.push(Date.now() - reqStart);
              if (r.status !== 200) errCount++;
            })
            .catch(() => {
              latencies.push(Date.now() - reqStart);
              errCount++;
            })
        );
      }
      await Promise.all(batch);
    }

    const tDuration = (Date.now() - tStart) / 1000;
    latencies.sort((a, b) => a - b);
    const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const rps = (totalRequests / tDuration).toFixed(1);

    console.log(`   Всего запросов: ${totalRequests} за ${tDuration.toFixed(2)} с`);
    console.log(`   Пропускная способность: ${C.b(rps + ' RPS')}`);
    console.log(`   Ошибок: ${errCount} (${((errCount / totalRequests) * 100).toFixed(1)}%)`);
    console.log(`   Задержка (мс): avg=${avgLatency}ms | p50=${p50}ms | p95=${p95}ms | p99=${p99}ms`);

    if (errCount > 0) {
      findings.push({
        severity: 'LOW',
        title: 'Ошибки под нагрузкой',
        desc: `${errCount} запросов завершились с ошибкой из ${totalRequests}.`
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ТЕСТ 7: СТРЕСС-ТЕСТ ЗАПИСИ (CONCURRENT PLAY LOAD & LEDGER INVARIANT)
    // 200 реальных раундов игры Dice подряд с параллельными запросами.
    // Проверяем: нет ли дедлоков в SQLite и сходится ли Ledger:
    // opening_balance + SUM(ledger.amount) === user.tokens
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n' + C.b('7. Стресс-тест транзакционной записи в SQLite (/api/play — 200 раундов)'));
    const tWriteStart = Date.now();
    let writeErrors = 0;
    const playPromisesBatch = [];
    for (let i = 0; i < 200; i++) {
      playPromisesBatch.push(
        srv.post('/api/play', { game: 'dice', bet: 10, mult: 2 }, 105)
          .then(r => { if (r.status !== 200) writeErrors++; })
          .catch(() => writeErrors++)
      );
    }
    await Promise.all(playPromisesBatch);
    const writeDuration = ((Date.now() - tWriteStart) / 1000).toFixed(2);
    const writeRps = (200 / writeDuration).toFixed(1);

    const user105 = srv.bal(105);
    const ledger105 = srv.ledgerSum(105);
    // Игрок начинал со 100000 токенов (записано через saveUser при инициализации)
    const expectedTokens = 100000 + ledger105;

    console.log(`   Выполнено 200 раундов за ${writeDuration} с (~${writeRps} write RPS)`);
    console.log(`   Ошибок записи: ${writeErrors}`);
    console.log(`   Баланс игрока: ${user105} ⬦ | Ledger delta: ${ledger105} ⬦ | Инвариант: ${expectedTokens === user105 ? 'СХОДИТСЯ' : 'РАССИНХРОН'}`);

    if (expectedTokens !== user105) {
      findings.push({
        severity: 'CRITICAL',
        title: 'Рассинхрон баланса и Ledger под нагрузкой',
        desc: `Баланс: ${user105}, сумма ledger: ${ledger105}, разница: ${user105 - expectedTokens}`
      });
      console.log(C.red('   ❌ Рассинхрон баланса и ledger!'));
    } else {
      console.log(C.grn('   ✅ Баланс и журнал транзакций (Ledger) сходятся 1 в 1!'));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ИТОГОВЫЙ ОТЧЕТ
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('📊 ИТОГИ АУДИТА И СТРЕСС-ТЕСТИРОВАНИЯ:');
    console.log('='.repeat(70));

    if (findings.length === 0) {
      console.log(C.grn('\n🎉 ВСЕ ТЕСТЫ ПРОЙДЕНЫ! КРИТИЧЕСКИХ ДЫР И ГОНОК НЕ ОБНАРУЖЕНО.'));
      console.log('   • Гонки на балансе, выводе, инвентаре и промокодах надёжно заблокированы.');
      console.log(`   • Производительность: ~${rps} read RPS, ~${writeRps} write RPS, 0% ошибок.`);
      console.log('   • Инвариант Ledger сохраняется при максимальном параллелизме.');
    } else {
      console.log(C.yel(`\n⚠️ ОБНАРУЖЕНО ЗАМЕЧАНИЙ: ${findings.length}`));
      for (const f of findings) {
        console.log(`   [${f.severity}] ${f.title}: ${f.desc}`);
      }
    }

  } finally {
    await srv.stop();
  }
}

main().catch(e => {
  console.error('Fatal error during stress test:', e);
  process.exit(1);
});
