#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Собирает Telegram-версию (moneyforup-tg.html) из базового файла (moneyforup.html)
+ текст Telegram-блока из tools/tg_block.js.

Запуск:  python3 tools/make_tg.py            (из корня проекта)
        python3 tools/make_tg.py --check      (только проверить, что все якоря на месте)

Правило: правки в оба файла вносим через базовый файл, TG-специфику — в tg_block.js.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, 'moneyforup.html')
OUT = os.path.join(ROOT, 'moneyforup-tg.html')
BLOCK = os.path.join(ROOT, 'tools', 'tg_block.js')

log = []


def rep(s, old, new, tag, count=1):
    n = s.count(old)
    assert n >= 1, 'НЕ НАЙДЕНО: ' + tag
    assert n == count, 'НАЙДЕНО %d РАЗ (ожидалось %d): %s' % (n, count, tag)
    log.append('ok: ' + tag)
    return s.replace(old, new, count)


def build(s):
    # 1. SDK Telegram (в браузере просто не загрузится)
    rep(s, '<title>MoneyForUp</title>\n',
        '<title>MoneyForUp</title>\n'
        '<!-- Telegram WebApp SDK: в браузере не загрузится — приложение продолжит работать как обычный сайт -->\n'
        '<script src="https://telegram.org/js/telegram-web-app.js"></script>\n',
        'SDK telegram-web-app.js')

    # 2. имя бота по умолчанию для TG-сборки
    s = rep(s, "const BOT_NAME='your_bot';                       // ← имя бота в Telegram без @ (в TG-сборке подставляется своё)",
            "const BOT_NAME='moneyforup_bot';                    // ← ЗАМЕНИТЕ на имя вашего бота (без @)",
            'имя бота для TG-сборки')

    # 3. переменная безопасной зоны
    s = rep(s, ':root{--bg:', ':root{--tgSafe:env(safe-area-inset-bottom,0px);--bg:',
            'переменная безопасной зоны', count=1)

    # 4. нижнее меню с учётом безопасной зоны
    s = rep(s, '.nav{position:fixed;max-width:712px;left:50%;transform:translateX(-50%);right:auto;bottom:12px;',
            '.nav{position:fixed;max-width:712px;left:50%;transform:translateX(-50%);right:auto;'
            'bottom:calc(12px + var(--tgSafe,0px));',
            'нижнее меню учитывает безопасную зону')

    # 5. кнопка «Поделиться в Telegram» на экране рефералов
    anchor_share = '<button class="secondary" id="copyLink" style="width:100%;margin-top:8px">Скопировать ссылку</button>'
    assert anchor_share in s, 'НЕ НАЙДЕНО: якорь реферального блока'
    s = s.replace(anchor_share, anchor_share +
                  '\n<button class="secondary" id="tgShare" style="width:100%;margin-top:8px">Поделиться в Telegram</button>'
                  '\n<div class="muted small" id="tgRefInfo" style="margin-top:9px"></div>', 1)
    log.append('ok: кнопка «Поделиться в Telegram»')

    # 6. сам Telegram-блок — сразу после betRubLine()
    anchor = ("function betRubLine(){\n"
              "  const el=q('#betRub');\n"
              "  if(el)el.innerHTML='Ставка '+fmt(S.bet)+' ⬦ ≈ <b>'+fmtRub(S.bet)+'</b>';\n"
              "}\n")
    assert anchor in s, 'НЕ НАЙДЕНО: якорь betRubLine()'
    block = open(BLOCK, encoding='utf-8').read().rstrip('\n')
    s = s.replace(anchor, anchor + '\n' + block + '\n', 1)
    log.append('ok: Telegram-адаптер')

    # 7. вибрации
    s = rep(s, "  S.balance-=bet;S.wagered+=bet;S.net-=bet;S.plays++;",
            "  S.balance-=bet;S.wagered+=bet;S.net-=bet;S.plays++;\n  tgHaptic('light');",
            'вибрация при ставке')
    s = rep(s, "  if(amount>0)S.hist.unshift({label:game+(note?' · '+note:''),delta:amount,t:Date.now()});\n  if(S.hist.length>40)S.hist=S.hist.slice(0,40);\n  save();syncUI();",
            "  if(amount>0)S.hist.unshift({label:game+(note?' · '+note:''),delta:amount,t:Date.now()});\n  if(S.hist.length>40)S.hist=S.hist.slice(0,40);\n  if(amount>0)tgHaptic('win');\n  save();syncUI();",
            'вибрация при выигрыше')
    s = rep(s, "    cancelAnimationFrame(raf);phase='done';cur=crash;boomT=performance.now();",
            "    cancelAnimationFrame(raf);phase='done';cur=crash;boomT=performance.now();if(!cashed)tgHaptic('lose');",
            'вибрация при остановке ракеты')
    s = rep(s, "          phase='done';busy=false;",
            "          phase='done';busy=false;tgHaptic('lose');",
            'вибрация при срыве в попрыгуне')

    # 8. инициализация при старте
    s = rep(s, "syncUI();screen('games');", "tgInit();tgRegister();syncUI();screen('games');",
            'инициализация Telegram при старте')

    # 9. BackButton в screen()
    s = rep(s, "  qa('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.nav===id));",
        "  try{TG&&TG.BackButton&&(id==='play'?TG.BackButton.show():TG.BackButton.hide())}catch(e){}\n"
        "  qa('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.nav===id));",
        'BackButton в screen()')
    return s


def main():
    check_only = '--check' in sys.argv
    src = open(BASE, encoding='utf-8').read()
    out = build(src)
    if check_only:
        print('\n'.join(log))
        print('\nвсе якоря на месте, сборка не запускалась')
        return
    open(OUT, 'w', encoding='utf-8').write(out)
    print('\n'.join(log))
    print('\nсоздан %s (%d байт)' % (os.path.relpath(OUT, ROOT), len(out.encode('utf-8'))))


if __name__ == '__main__':
    main()
