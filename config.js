// config.js
module.exports = {
  // Telegram Bot токен (получить у @BotFather)
  BOT_TOKEN: '8608271158:AAHAChhSwKGA15uHEMeYLW7ipcnhDM_OwnQ',
  
  // Ваш Telegram ID (можно узнать у @userinfobot)
  ADMIN_CHAT_ID: '1359858854',
  
  // Публичный URL (для Render/VPS)
  PUBLIC_URL: process.env.RENDER_EXTERNAL_URL || 'https://your-app.onrender.com',
  
  // Секрет для webhook (опционально)
  WH_SECRET: 'your-secret-string-here',
  
  // Путь к файлу с ключами Google
  GOOGLE_KEY_PATH: './credentials.json',
  
  // ID вашей Google таблицы
  SPREADSHEET_ID: '1ggDffsu8vVJf6oAssfI2CB6_ZguZjFKBR4oU9ZwakGw',
  
  // Настройки распознавания
  SPEECH_LANGUAGE: 'uk-UA', // или 'ru-RU'
  
  // Часовой пояс
  TZ: 'Europe/Kyiv',
  
  // Имя бота (без @)
  BOT_USERNAME: 'UH_VA_bot'
};
