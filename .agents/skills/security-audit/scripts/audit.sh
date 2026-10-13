#!/usr/bin/env bash
# Механический скан MoneyForUp.
# Ничего не «доказывает» — подсвечивает места, которые надо разобрать руками.
#
# Запуск:  bash .agents/skills/security-audit/scripts/audit.sh
# Ничего не меняет на диске, в сеть не ходит.

set -uo pipefail

TARGET="${1:-.}"
cd "$TARGET" 2>/dev/null || { echo "Нет каталога: $TARGET"; exit 1; }

BOT="bot.js"
[ -f "$BOT" ] || { echo "Не найден $BOT (запусти из корня проекта)"; exit 1; }

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; OFF=$'\033[0m'
HITS=0

h() { printf '\n%s── %s %s\n' "$BOLD" "$1" "$OFF"; }
# hit <файл> <номер> <текст> — обрезает строки и МАСКИРУЕТ секреты в выводе
hit() {
  local text
  text=$(printf '%.130s' "$3" | sed 's/^[[:space:]]*//')
  # комментарии не считаем — это шум, а не код
  case "$text" in
    //*|/\**|\**) return 0 ;;
  esac
  text=$(printf '%s' "$text" | sed -E "s/'[A-Za-z0-9_-]{24,}'/'***СКРЫТО***'/g")
  printf '  %s%-22s%s %s\n' "$DIM" "$1:$2" "$OFF" "$text"
  HITS=$((HITS+1))
}
note() { printf '  %s↳ %s%s\n' "$DIM" "$1" "$OFF"; }
ok()   { printf '  %s✓ %s%s\n' "$GRN" "$1" "$OFF"; }

scan() { # scan <заголовок> <regex> [подсказка]
  h "$1"
  local out
  out=$(grep -nEi "$2" "$BOT" 2>/dev/null | head -25)
  if [ -z "$out" ]; then ok "совпадений нет"; else
    while IFS= read -r line; do
      hit "$BOT" "${line%%:*}" "${line#*:}"
    done <<< "$out"
    [ -n "${3:-}" ] && note "$3"
  fi
}

printf '%s\n' "${BOLD}Аудит MoneyForUp — механический скан${OFF}"
printf '%s\n' "${DIM}Найдено совпадений: подсвечены места для ручного разбора, а не готовые находки.${OFF}"
printf '%s\n' "${DIM}Разбор: reference/attack-surface.md · Триаж: reference/triage.md${OFF}"

# ─────────────────────────────────────────────────────────────────────────────
h "0. БОЕВЫЕ КЛЮЧИ ПЛАТЁЖЕК В КОДЕ (проверять первым!)"
# Публичный репозиторий + реальный ключ провайдера = полный контроль над приёмом платежей.
creds=$(grep -nE "(API_KEY|SECRET_KEY|MERCHANT|_KEY|TOKEN) *= *process\.env\.[A-Z_]+ *\|\| *['\"][A-Za-z0-9_-]{16,}['\"]" "$BOT" 2>/dev/null | head -20)
if [ -n "$creds" ]; then
  printf '  %s!!! НАЙДЕНЫ РЕАЛЬНЫЕ УЧЁТНЫЕ ДАННЫЕ В КОДЕ — РОТАЦИЯ НЕМЕДЛЕННО !!!%s\n' "$RED$BOLD" "$OFF"
  while IFS= read -r line; do hit "$BOT" "${line%%:*}" "${line#*:}"; done <<< "$creds"
  note "Значения замаскированы в выводе, но лежат открытым текстом в файле и в истории git."
  note "1) отозвать/перевыпустить ключи в ЛК провайдера  2) убрать дефолты  3) чистить историю git"
  note "Секрет подписи вебхука в открытом виде = любой может подделать зачисление депозита."
else
  ok "Дефолтных боевых ключей не найдено"
fi

# Публичность репозитория усиливает всё остальное
if command -v gh >/dev/null 2>&1; then
  slug=$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#.*[:/]([^/]+/[^/]+)$#\1#')
  vis=$(gh api "repos/$slug" --jq '.visibility' 2>/dev/null)
  case "$vis" in
    public)  printf '  %s! Репозиторий ПУБЛИЧНЫЙ — любой секрет в коде считается скомпрометированным%s\n' "$RED" "$OFF"; HITS=$((HITS+1));;
    private) ok "Репозиторий приватный";;
    *)       note "Публичность репозитория определить не удалось — проверь вручную";;
  esac
fi

# ─────────────────────────────────────────────────────────────────────────────
h "1. Маршруты, меняющие деньги (P0)"
routes=$(grep -n "url.pathname === " "$BOT" | grep -Ei "record-bet|sync-balance|withdraw|stake|claim|invoice|webhook|promo|boost" | head -25)
if [ -n "$routes" ]; then
  while IFS= read -r line; do hit "$BOT" "${line%%:*}" "${line#*:}"; done <<< "$routes"
fi
note "По каждому: чем аутентифицируется и что из body влияет на u.tokens"

scan "2. Клиентские числа, влияющие на баланс" \
  "body\.(tokens|winTokens|betTokens|amount|rub)|body\.tokens" \
  "Каждое такое поле = потенциальный P0. Сервер обязан вычислять результат сам"

scan "3. Псевдозащита: эвристические потолки" \
  "calcMaxTk|NON_DEPOSITOR_CAP|maxAllowedBet|\+ 100|\+ 200|Math\.max\(500" \
  "Сверка клиентского числа с клиентским же числом — не защита (triage.md)"

scan "4. Проверки, отключаемые полем из запроса" \
  "&& !body\.|&& !req\.|&& !url\." \
  "Любое условие, зависящее от тела запроса, обходится присылкой поля"

scan "5. Вебхуки: аутентификация" \
  "webhook|X-Signature|x-signature|X-Secret|x-merchantid|EXPECTED_SECRET" \
  "Проверка должна быть обязательной и криптографической"

scan "6. Опциональная проверка подписи" \
  "if \(sig &&|if \(signature &&|if \(authHeader &&" \
  "«Нет заголовка» не должно означать «проверка пройдена»"

scan "7. Секреты по умолчанию" \
  "process\.env\.[A-Z_]+ *\|\| *['\"][^'\"]+['\"]" \
  "Публичный репозиторий: дефолт = публичный ключ. Падать на старте, а не подставлять"

scan "8. Сравнения секретов" \
  "(secret|token|hash|sig|calcSig|password)[^;]*[!=]== *" \
  "Для секретов нужен crypto.timingSafeEqual, не !=="

scan "9. Предсказуемые идентификаторы заказов" \
  "orderId *= *['\"][^;]*Date\.now" \
  "Date.now() + userId перебирается: перейти на crypto.randomBytes(16)"

scan "10. Проверка auth_date" \
  "authDate|auth_date" \
  "Отклонять будущее (age < 0) и сузить окно для денежных операций до 5 минут"

scan "11. Эскалация привилегий" \
  "isAdmin|ADMIN_ID|ADMIN_USERNAME" \
  "isAdmin не должен присваивать права сам; только явный ADMIN_ID из env"

scan "12. Инъекция в HTML-сообщения (parse_mode: HTML)" \
  "parse_mode: *'HTML'" \
  "Проверить, что весь пользовательский ввод экранирован (& < >)"

scan "13. Отсутствие rate limiting" \
  "rateLimit|rate_limit|too many requests|429" \
  "Если пусто — лимитов нет вообще: /api/promo, /api/withdraw, вебхуки"

scan "14. Утечка лишних полей в API" \
  "isAdmin: isAdmin|totalDeposited|lastDeposit" \
  "На клиент уходит только то, что нужно клиенту"

scan "15. Логирование чувствительных данных" \
  "console\.log\(.*(initData|BOT_TOKEN|SECRET|secret)" \
  "Секреты и initData в логах = утечка при сборе логов"

# ─────────────────────────────────────────────────────────────────────────────
h "15b. ДВОЙНОЕ ПРИМЕНЕНИЕ БАЛАНСА (saveUser + atomicBalanceChange)"
# Порядок критичен: saveUser() пишет НОВОЕ значение, atomicBalanceChange() прибавляет delta поверх него.
# Если они идут в порядке SAVE -> ATOMIC, delta применяется ДВАЖДЫ. Проверено PoC: poc-db-double-write.js
if [ -f "db.js" ]; then
  # выпишем строки в порядке следования и посмотрим пары
  # Дистанция <= 4 строк = одна операция. Больше — это уже разные функции (ложное срабатывание).
  grep -nE "saveUser|atomicBalanceChange" "$BOT" | sed 's/ *try { *//' \
  | awk -F: '{ kind = ($0 ~ /saveUser/) ? "SAVE" : "ATOMIC"; printf "%s %s\n", $1, kind }' \
  | awk '{ if (prev == "SAVE" && $2 == "ATOMIC" && $1 - prevline <= 4) {
             printf "  %s! bot.js:%s SAVE затем %s ATOMIC => баланс изменён ДВАЖДЫ%s\n", RED, prevline, $1, OFF; bad++ }
           prev = $2; prevline = $1 }
         END { if (!bad) printf "  %s✓ опасных пар SAVE->ATOMIC не найдено%s\n", GRN, OFF;
               exit 0 }'
  # подсказка по количеству мест, где вообще трогают баланс
  n=$(grep -cE "state\.|saveUser" "$BOT" 2>/dev/null || echo 0)
  note "Всего вызовов saveUser/atomicBalanceChange: $(grep -cE 'saveUser|atomicBalanceChange' "$BOT")"
  note "Проверка вживую: node .agents/skills/security-audit/scripts/poc-db-double-write.js"
else
  ok "db.js нет — баланс хранится только в памяти (см. п.16)"
fi

h "16. Хранение состояния и деплой"
if [ -f "db.js" ]; then
  ok "Есть persistent-хранилище (db.js)"
  if grep -q "data/" .gitignore 2>/dev/null; then ok "data/ в .gitignore"; else
    printf '  %s! data/ не в .gitignore — база уйдёт в публичный репозиторий%s\n' "$RED" "$OFF"; HITS=$((HITS+1))
  fi
  if grep -qE "db\.exec\(\`|db\.exec\('" db.js && ! grep -q "prepare(" db.js; then
    printf '  %s! SQL собирается строками без prepare() — риск инъекции%s\n' "$RED" "$OFF"; HITS=$((HITS+1))
  else
    ok "SQL через подготовленные выражения (db.prepare)"
  fi
else
  if grep -qE "new Map\(\)" "$BOT" && ! grep -qE "writeFileSync|STATE_FILE" "$BOT"; then
    printf '  %s! Состояние только в памяти: рестарт обнулит балансы и заявки%s\n' "$YEL" "$OFF"; HITS=$((HITS+1))
  else
    ok "Найдена запись состояния на диск"
  fi
fi

# Дубликат фронтенда — классическая ловушка: правишь один файл, в прод уходит другой
if [ -f "index.html" ] && [ -f "public/index.html" ]; then
  if diff -q index.html public/index.html >/dev/null 2>&1; then
    printf '  %s! ДВЕ КОПИИ index.html идентичны%s\n' "$YEL" "$OFF"
    HITS=$((HITS+1))
    DEPLOY_DIR=$(grep -oE '"directory": *"[^"]+"' wrangler.jsonc 2>/dev/null | grep -oE '"[^"]+"$' | tr -d '"')""
    note "В прод (wrangler assets.directory) уходит: public/  — править нужно public/index.html"
    note "index.html в корне — дубликат. Любая правка только одного файла = фикс не доехал до прода"
  else
    ok "Копии index.html различаются — проверь, какая в проде"
  fi
fi

h "17. Секреты в репозитории"
# Заглушки-плейсхолдеры (пример/test/AAaaBB/xxxx/your) не считаем находкой — иначе ложное срабатывание
PLACEHOLDER='example|sample|placeholder|your[_-]|change[_-]?me|xxx|AAaaBB|123456789:[A-Za-z]*[0-9]{8}|test[_-]?token'
# Ловим ОБЕ формы: пряную ('SECRET = "k"') и «дефолт в env» ('SECRET = process.env.SECRET || "k"')
SECRETNAME='(BOT_TOKEN|PLATEGA_SECRET|HELEKET_API_KEY|COINSO_SECRET_KEY|COINSO_API_KEY|PAYMENT_WEBHOOK_SECRET|WITHDRAW_KEY|JWT_SECRET)'
found=$(grep -rnEi "${SECRETNAME}[A-Z_]*[[:space:]]*=[^;]*['\"][A-Za-z0-9_:-]{16,}['\"]" \
  . --include="*.js" --include="*.json" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null \
  | grep -vEi "$PLACEHOLDER" | head -10)
if [ -n "$found" ]; then
  while IFS= read -r line; do
    printf '  %s! %s%s\n' "$RED" "$(printf '%.120s' "$line" | sed -E "s/'[A-Za-z0-9_-]{20,}'/'***СКРЫТО***'/g")" "$OFF"
    HITS=$((HITS+1))
  done <<< "$found"
  note "Настоящие ключи в коде. Если репозиторий публичный — ключи считать скомпрометированными"
else
  ok "Реальных токенов/ключей в файлах не найдено (заглушки отфильтрованы)"
fi
if git -C . ls-files --error-unmatch .env >/dev/null 2>&1; then
  printf '  %s! .env отслеживается git — секреты в истории%s\n' "$RED" "$OFF"; HITS=$((HITS+1))
else
  ok ".env не в git"
fi

h "18. Клиент доверяет серверу, а не наоборот"
if [ -f index.html ]; then
  grep -noE "localStorage\.(set|get)Item\(['\"][a-zA-Z_]*[Tt]okens?['\"]" index.html | head -8 | while IFS= read -r l; do
    printf '  %s%s%s\n' "$DIM" "index.html:$l" "$OFF"
  done
  note "Баланс на клиенте — только визуализация. Источник истины — ответ /api/balance"
fi

# ─────────────────────────────────────────────────────────────────────────────
printf '\n%s\n' "$(printf '─%.0s' {1..64})"
printf '%sСовпадений для ручного разбора: %s%s\n' "$BOLD" "$HITS" "$OFF"
cat <<'EOF'

Дальше — вручную (скрипт тут бессилен):
  1. По каждому P0-маршруту пройти 4 вопроса из SKILL.md §4 Шаг 3
  2. Написать PoC и запустить локально:   node .agents/skills/security-audit/scripts/poc-balance-bypass.js
     (этот PoC теперь бьёт по ЖИВОМУ серверу; exit 1 = эксплойт работает)
  3. Отсеять по reference/triage.md  →  FIX NOW / FIX SOON / Гипотезы
  4. Чинить по reference/fix-patterns.md, затем прогнать PoC повторно

Проверка денежной логики на живом сервере (сильнее любого статического скана):
  node .agents/skills/security-audit/scripts/e2e-game-authority-test.js     # P0-1: исход раунда решает сервер
  node .agents/skills/security-audit/scripts/e2e-exploit-test.js            # P0-5: баланс применяется один раз
  node .agents/skills/security-audit/scripts/poc-db-double-write.js         # слой БД, без сервера
Все три поднимают реальный bot.js в /tmp через scripts/lib/server-harness.js — прод не трогается.

ИНВАРИАНТ ПОСЛЕ ФИКСА P0-5: баланс меняется ТОЛЬКО через applyBalance()/setBalanceTo() в bot.js.
db.saveUser() больше НЕ пишет tokens — выставить баланс через неё нельзя (это норма, не баг).

ИНВАРИАНТ ПОСЛЕ ФИКСА P0-1: клиент присылает только ВЫБОР (game, bet, mult).
Выигрыш, вердикт и множитель сверх границ игры сервер обязан игнорировать.
Сверка балансов: opening (50 ⬦ при регистрации, ВНЕ ledger) + SUM(ledger.amount) == users.tokens.
Сравнивать SUM(ledger) с балансом напрямую НЕЛЬЗЯ — получишь ложное расхождение по каждому игроку.

Базовая линия известных находок: reference/known-findings.md (не переоткрывать закрытое)
EOF
