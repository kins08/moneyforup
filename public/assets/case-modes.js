(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MONEYFORUP_CASE_MODES = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  /**
   * MoneyForUp — режимы кейсов для витрины.
   *
   * Все предметы здесь ВИРТУАЛЬНЫЕ: это игровые косметические коллекционные
   * предметы с токеновой ценностью. Они не подразумевают вывод реальных денег,
   * ставки, cash-out или гарантированную прибыль. Случайность передаёт
   * вызывающая сторона (random01), чтобы источник оставался на сервере.
   *
   * ЦЕНА РЕЖИМА (`price`) — единственное место, где она задана. Сервер и
   * браузер читают этот же файл, поэтому менять цену нужно только здесь.
   * После изменения цены обязательно пересчитайте RTP: он равен
   * EV(предметов) / price и обязан оставаться в диапазоне 0.82–0.86
   * (`node test-upgrade-math.js` падает, если RTP вышел из диапазона).
   */

  const VERSION = 1;

  /**
   * Веса по тирам (сумма 100 на режим):
   * cheap 8+8, low 8+8+8, profit 9×5, high 5+5, jackpot 2, secret 3.
   */
  const MODES = {
    starter_drop: {
      id: 'starter_drop',
      name: 'STARTER DROP',
      tagline: 'Серебро и минимализм',
      desc: 'Минималистичная стартовая коллекция с серебристыми гаджетами и аксессуарами.',
      icon: '🥈',
      price: 250,
      priceMin: 100,
      priceMax: 300,
      theme: {
        accent: '#c9d2dc',
        accent2: '#8f9aa8',
        panel: '#14171c',
        border: '#2a303a',
        glow: 'rgba(201, 210, 220, 0.35)'
      },
      items: [
        { code: 'starter_drop#0', name: 'Серебряный брелок «Пиксель»', icon: '🔑', price: 120, w: 8, tier: 'cheap' },
        { code: 'starter_drop#1', name: 'Матовая нашивка «Монолит»', icon: '🏷️', price: 140, w: 8, tier: 'cheap' },
        { code: 'starter_drop#2', name: 'Кабель-браслет «Сталь»', icon: '🔗', price: 155, w: 8, tier: 'low' },
        { code: 'starter_drop#3', name: 'Подставка «Алюминий»', icon: '📐', price: 170, w: 8, tier: 'low' },
        { code: 'starter_drop#4', name: 'Кольцо-держатель «Хром»', icon: '💍', price: 190, w: 8, tier: 'low' },
        { code: 'starter_drop#5', name: 'Стилус «Сребро»', icon: '🖊️', price: 200, w: 9, tier: 'profit' },
        { code: 'starter_drop#6', name: 'Мини-динамик «Платина»', icon: '🔊', price: 220, w: 9, tier: 'profit' },
        { code: 'starter_drop#7', name: 'Фонарь «Иней»', icon: '🔦', price: 235, w: 9, tier: 'profit' },
        { code: 'starter_drop#8', name: 'Чехол «Меркурий»', icon: '📱', price: 250, w: 9, tier: 'profit' },
        { code: 'starter_drop#9', name: 'Наушники «Луна»', icon: '🎧', price: 260, w: 9, tier: 'profit' },
        { code: 'starter_drop#10', name: 'Смарт-часы «Аргент»', icon: '⌚', price: 270, w: 5, tier: 'high' },
        { code: 'starter_drop#11', name: 'Дрон «Серебро»', icon: '🛸', price: 285, w: 5, tier: 'high' },
        { code: 'starter_drop#12', name: 'Серебряный сапфир «Нимб»', icon: '💎', price: 295, w: 2, tier: 'jackpot' },
        { code: 'starter_drop#13', name: 'Лунный обсидиан «Тишина»', icon: '🌙', price: 300, w: 3, tier: 'secret' }
      ]
    },

    cyber_rush: {
      id: 'cyber_rush',
      name: 'CYBER RUSH',
      tagline: 'Неон режет тьму',
      desc: 'Неоновый набор кибер-гаджетов в синих и фиолетовых тонах.',
      icon: '⚡',
      price: 750,
      priceMin: 500,
      priceMax: 1000,
      theme: {
        accent: '#35d6ff',
        accent2: '#a855f7',
        panel: '#0a0f1e',
        border: '#1e3a5f',
        glow: 'rgba(53, 214, 255, 0.35)'
      },
      items: [
        { code: 'cyber_rush#0', name: 'Неоновая нашивка «Vortex»', icon: '🌀', price: 500, w: 8, tier: 'cheap' },
        { code: 'cyber_rush#1', name: 'Голограмма «Кибер-кот»', icon: '🐾', price: 520, w: 8, tier: 'cheap' },
        { code: 'cyber_rush#2', name: 'Кабель «Плазма»', icon: '🔌', price: 545, w: 8, tier: 'low' },
        { code: 'cyber_rush#3', name: 'Очки «Нейро-скан»', icon: '🕶️', price: 575, w: 8, tier: 'low' },
        { code: 'cyber_rush#4', name: 'Перчатка «Импульс»', icon: '🧤', price: 605, w: 8, tier: 'low' },
        { code: 'cyber_rush#5', name: 'Неоновый клинок «Vortex»', icon: '🗡️', price: 620, w: 9, tier: 'profit' },
        { code: 'cyber_rush#6', name: 'Дрон «Синтвейв»', icon: '🛸', price: 645, w: 9, tier: 'profit' },
        { code: 'cyber_rush#7', name: 'Шлем «Овердрайв»', icon: '🪖', price: 670, w: 9, tier: 'profit' },
        { code: 'cyber_rush#8', name: 'Экзо-ранец «Фантом»', icon: '🎒', price: 695, w: 9, tier: 'profit' },
        { code: 'cyber_rush#9', name: 'Визор «Хром-Нейрон»', icon: '🥽', price: 720, w: 9, tier: 'profit' },
        { code: 'cyber_rush#10', name: 'Кибер-мотоцикл «Рэйв»', icon: '🏍️', price: 750, w: 5, tier: 'high' },
        { code: 'cyber_rush#11', name: 'Голографический волк «Байт»', icon: '🐺', price: 780, w: 5, tier: 'high' },
        { code: 'cyber_rush#12', name: 'Ядро «Сингулярность»', icon: '🔮', price: 830, w: 2, tier: 'jackpot' },
        { code: 'cyber_rush#13', name: 'Прототип «Зеро»', icon: '👾', price: 890, w: 3, tier: 'secret' }
      ]
    },

    golden_vault: {
      id: 'golden_vault',
      name: 'GOLDEN VAULT',
      tagline: 'Золото не тускнеет',
      desc: 'Коллекция чёрно-золотых артефактов для витрины ценителя.',
      icon: '👑',
      price: 3500,
      priceMin: 2000,
      priceMax: 5000,
      theme: {
        accent: '#ffd76a',
        accent2: '#b8860b',
        panel: '#0d0b07',
        border: '#3a2c12',
        glow: 'rgba(255, 215, 106, 0.35)'
      },
      items: [
        { code: 'golden_vault#0', name: 'Золотой жетон «Проба»', icon: '🪙', price: 2050, w: 8, tier: 'cheap' },
        { code: 'golden_vault#1', name: 'Кожаный браслет «Аурум»', icon: '📿', price: 2250, w: 8, tier: 'cheap' },
        { code: 'golden_vault#2', name: 'Печать «Карат»', icon: '🏵️', price: 2400, w: 8, tier: 'low' },
        { code: 'golden_vault#3', name: 'Монокль «Версаль»', icon: '🧐', price: 2550, w: 8, tier: 'low' },
        { code: 'golden_vault#4', name: 'Кольцо «Меркурий»', icon: '💍', price: 2700, w: 8, tier: 'low' },
        { code: 'golden_vault#5', name: 'Часы «Гранд-Ор»', icon: '⌚', price: 2850, w: 9, tier: 'profit' },
        { code: 'golden_vault#6', name: 'Шкатулка «Барон»', icon: '🗝️', price: 3000, w: 9, tier: 'profit' },
        { code: 'golden_vault#7', name: 'Кубок «Империя»', icon: '🏆', price: 3150, w: 9, tier: 'profit' },
        { code: 'golden_vault#8', name: 'Фонтан «Жидкое золото»', icon: '⛲', price: 3300, w: 9, tier: 'profit' },
        { code: 'golden_vault#9', name: 'Статуэтка «Крез»', icon: '🗿', price: 3450, w: 9, tier: 'profit' },
        { code: 'golden_vault#10', name: 'Золотая маска «Аврора»', icon: '🎭', price: 3650, w: 5, tier: 'high' },
        { code: 'golden_vault#11', name: 'Скипетр «Монарх»', icon: '🪄', price: 3850, w: 5, tier: 'high' },
        { code: 'golden_vault#12', name: 'Золотой телец «Гефест»', icon: '🐂', price: 4100, w: 2, tier: 'jackpot' },
        { code: 'golden_vault#13', name: 'Венец «Аурум»', icon: '👑', price: 4400, w: 3, tier: 'secret' }
      ]
    },

    glitch_mode: {
      id: 'glitch_mode',
      name: 'GLITCH MODE',
      tagline: 'Система дала сбой',
      desc: 'Сбойная коллекция красно-чёрных артефактов с эффектом цифрового шума.',
      icon: '📺',
      price: 11000,
      priceMin: 7500,
      priceMax: 15000,
      theme: {
        accent: '#ff2e4d',
        accent2: '#ff7a90',
        panel: '#0a0a0c',
        border: '#3a0d15',
        glow: 'rgba(255, 46, 77, 0.4)'
      },
      items: [
        { code: 'glitch_mode#0', name: 'Битый пиксель «Глюк»', icon: '🟥', price: 7600, w: 8, tier: 'cheap' },
        { code: 'glitch_mode#1', name: 'Артефакт «Сбой»', icon: '⚠️', price: 8000, w: 8, tier: 'cheap' },
        { code: 'glitch_mode#2', name: 'Красный контур «Ошибка»', icon: '🔺', price: 8300, w: 8, tier: 'low' },
        { code: 'glitch_mode#3', name: 'Маска «Красный шум»', icon: '🎭', price: 8600, w: 8, tier: 'low' },
        { code: 'glitch_mode#4', name: 'Кассета «Помехи»', icon: '📼', price: 8900, w: 8, tier: 'low' },
        { code: 'glitch_mode#5', name: 'Клинок «Глитч»', icon: '🗡️', price: 9100, w: 9, tier: 'profit' },
        { code: 'glitch_mode#6', name: 'Перчатка «Баг»', icon: '🧤', price: 9400, w: 9, tier: 'profit' },
        { code: 'glitch_mode#7', name: 'Визор «Сбой-9»', icon: '🥽', price: 9700, w: 9, tier: 'profit' },
        { code: 'glitch_mode#8', name: 'Дрон «Красный код»', icon: '🛸', price: 10000, w: 9, tier: 'profit' },
        { code: 'glitch_mode#9', name: 'Ядро «Фатальная ошибка»', icon: '🧨', price: 10300, w: 9, tier: 'profit' },
        { code: 'glitch_mode#10', name: 'Экзо-скелет «Протокол R»', icon: '🦾', price: 10700, w: 5, tier: 'high' },
        { code: 'glitch_mode#11', name: 'Мотоцикл «Глитч-Раннер»', icon: '🏍️', price: 11100, w: 5, tier: 'high' },
        { code: 'glitch_mode#12', name: 'Ключ «Красная комната»', icon: '🗝️', price: 11900, w: 2, tier: 'jackpot' },
        { code: 'glitch_mode#13', name: 'Нулевой экземпляр «NULL»', icon: '👾', price: 12900, w: 3, tier: 'secret' }
      ]
    },

    omega_core: {
      id: 'omega_core',
      name: 'OMEGA CORE',
      tagline: 'Предел достигнут',
      desc: 'Обсидианово-хромовая коллекция с фиолетовыми голографическими акцентами.',
      icon: '🌌',
      price: 35000,
      priceMin: 20000,
      priceMax: 50000,
      theme: {
        accent: '#a78bfa',
        accent2: '#e2e8f0',
        panel: '#08070d',
        border: '#2b2440',
        glow: 'rgba(167, 139, 250, 0.35)'
      },
      items: [
        { code: 'omega_core#0', name: 'Осколок «Обсидиан»', icon: '🪨', price: 20500, w: 8, tier: 'cheap' },
        { code: 'omega_core#1', name: 'Хромовый жетон «Омега»', icon: '⚙️', price: 22500, w: 8, tier: 'cheap' },
        { code: 'omega_core#2', name: 'Голограмма «Фиалка»', icon: '🪻', price: 24000, w: 8, tier: 'low' },
        { code: 'omega_core#3', name: 'Перчатка «Хром»', icon: '🧤', price: 25500, w: 8, tier: 'low' },
        { code: 'omega_core#4', name: 'Визор «Ультрафиолет»', icon: '🥽', price: 27000, w: 8, tier: 'low' },
        { code: 'omega_core#5', name: 'Клинок «Оникс»', icon: '🗡️', price: 28500, w: 9, tier: 'profit' },
        { code: 'omega_core#6', name: 'Ядро «Омега-1»', icon: '🧿', price: 30000, w: 9, tier: 'profit' },
        { code: 'omega_core#7', name: 'Экзо-костюм «Хром-Ноль»', icon: '🦾', price: 31500, w: 9, tier: 'profit' },
        { code: 'omega_core#8', name: 'Дрон «Гиперион»', icon: '🛸', price: 33000, w: 9, tier: 'profit' },
        { code: 'omega_core#9', name: 'Сфера «Сингулярность»', icon: '🔮', price: 34500, w: 9, tier: 'profit' },
        { code: 'omega_core#10', name: 'Кресло «Обсидиан»', icon: '🪑', price: 36500, w: 5, tier: 'high' },
        { code: 'omega_core#11', name: 'Скипетр «Хром-Владыка»', icon: '🪄', price: 38500, w: 5, tier: 'high' },
        { code: 'omega_core#12', name: 'Ядро «Абсолют»', icon: '💠', price: 41000, w: 2, tier: 'jackpot' },
        { code: 'omega_core#13', name: 'Прототип «Омега-Ноль»', icon: '👾', price: 44000, w: 3, tier: 'secret' }
      ]
    }
  };

  /** Режим по id или null. */
  function getMode(id) {
    return Object.prototype.hasOwnProperty.call(MODES, id) ? MODES[id] : null;
  }

  /**
   * Взвешенный ролл предмета. random01 — число [0,1) от вызывающей стороны.
   * Возвращает предмет + index/modeId/modeName/cost или null для неизвестного id.
   */
  function rollItem(modeId, random01) {
    const mode = getMode(modeId);
    if (!mode) return null;
    const total = mode.items.reduce((sum, item) => sum + item.w, 0);
    let target = random01 * total;
    let cumulative = 0;
    for (let i = 0; i < mode.items.length; i++) {
      cumulative += mode.items[i].w;
      if (target < cumulative) {
        return { ...mode.items[i], index: i, modeId: mode.id, modeName: mode.name, cost: mode.price };
      }
    }
    const last = mode.items.length - 1;
    return { ...mode.items[last], index: last, modeId: mode.id, modeName: mode.name, cost: mode.price };
  }

  /** EV и RTP режима (веса нормируются на их сумму) или null. */
  function caseRtp(modeId) {
    const mode = getMode(modeId);
    if (!mode) return null;
    const total = mode.items.reduce((sum, item) => sum + item.w, 0);
    const ev = mode.items.reduce((sum, item) => sum + (item.w / total) * item.price, 0);
    return { cost: mode.price, ev, rtp: ev / mode.price };
  }

  return { VERSION, MODES, getMode, rollItem, caseRtp };
});
