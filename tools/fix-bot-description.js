const fs = require('fs');
const { Bot } = require('grammy');

let token = process.argv[2] || process.env.BOT_TOKEN;
if (!token && fs.existsSync('.env')) {
  const content = fs.readFileSync('.env', 'utf8').replace(/^\uFEFF/, '');
  const m = content.match(/^BOT_TOKEN=(.*)$/m);
  if (m && m[1].trim()) token = m[1].trim().replace(/^["']|["']$/g, '');
}

if (!token) {
  console.log('Использование: node tools/fix-bot-description.js <ВАШ_BOT_TOKEN>');
  console.log('Или укажите BOT_TOKEN в .env / переменных окружения.');
  process.exit(1);
}

const bot = new Bot(token);

const desc = `🔥 MoneyForUp — игровая платформа, кейсы и стейкинг в Telegram!

Делай мани, ап-ап! 🚀

• 📦 Кейсы и дропы — скины и предметы
• 🚀 Ракетка 24/7 — успей забрать до взрыва
• 🍺 Скуф vs Альтушка, Dice, Колесо Фортуны
• 📈 Стейкинг 1 % в сутки с начислением каждую секунду
• 👥 Реферальная программа 15 % с пополнений
• 🎟 Промокоды и ежедневные бонусы

Жми «Старт» и забирай свои первые токены! 👇`;

const shortDesc = 'MoneyForUp — Делай мани, ап-ап! 🚀 Кейсы, Ракетка и стейкинг.';

(async () => {
  try {
    console.log('⏳ Обновляем описание бота (default)...');
    await bot.api.setMyDescription(desc);
    console.log('⏳ Обновляем описание бота (ru)...');
    await bot.api.setMyDescription(desc, { language_code: 'ru' });
    console.log('⏳ Обновляем краткое описание (default)...');
    await bot.api.setMyShortDescription(shortDesc);
    console.log('⏳ Обновляем краткое описание (ru)...');
    await bot.api.setMyShortDescription(shortDesc, { language_code: 'ru' });
    console.log('\n🎉 УСПЕШНО! Описание бота в Telegram очищено от JSON скобок и \\n');

    const dDefault = await bot.api.getMyDescription();
    const sDefault = await bot.api.getMyShortDescription();
    console.log('\n=== ТЕКУЩЕЕ ОПИСАНИЕ В TELEGRAM ===\n' + dDefault.description);
    console.log('\n=== ТЕКУЩЕЕ КРАТКОЕ ОПИСАНИЕ ===\n' + sDefault.short_description);
  } catch(e) {
    console.error('❌ Ошибка Telegram Bot API:', e.message);
  }
})();
