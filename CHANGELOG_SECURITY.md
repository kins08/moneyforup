# Security changelog

## Проверено 2026-10-16

- Подтверждено, что ветка `security-fixes-2026-10` ранее содержала placeholder-файлы: `bot.js` 45 B, `db.js` 44 B, `turso.js` 47 B.
- Добавлены `.gitignore` и `tools/init-turso.js` с миграциями для cooldown, fingerprint-колонок self-referral и идемпотентных платёжных таблиц.
- Добавлены/сохранены схемы `processed_payments`, `referral_payouts`, `challenge_claims` в миграции.

## Не завершено

- Полноценные `bot.js`, `db.js`, `turso.js` не загружены в ветку: GitHub upload большого локального набора не выполнен.
- `index.html` и `tg_block.js` не изменены; опасные `innerHTML` и клиентский `Math.random` остаются.
- Единая транзакция платёж → баланс → referral 15%, self-referral fingerprint enforcement, атомарное принятие дуэли и полная Turso-синхронизация не завершены.
- Эндпоинт дуэлей/accept в `bot.js` не найден; grep нашёл только упоминания termsAcceptedAt.
- Требуемые smoke-тесты не выполнены; `npm audit` пропущен, так как `node_modules` отсутствует.

PR #6 оставлен draft и с заголовком `DO NOT MERGE`.
