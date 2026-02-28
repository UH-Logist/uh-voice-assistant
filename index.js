// index.js
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const axios = require('axios');

// Загружаем конфигурацию
const config = require('./config');

// Проверка обязательных параметров
if (!config.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!config.ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID is required');
if (!config.SPREADSHEET_ID) throw new Error('SPREADSHEET_ID is required');

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация бота
const bot = new TelegramBot(config.BOT_TOKEN, { webHook: true });
bot.setWebHook(`${config.PUBLIC_URL}/bot${config.BOT_TOKEN}`);

// Webhook endpoint
app.post(`/bot${config.BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get('/', (_, res) => res.status(200).send('✅ Bot is running'));

// Google Sheets клиент
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// Настройки команд бота
bot.setMyCommands([
  { command: 'start', description: 'Запустити бота' },
  { command: 'help', description: 'Допомога' }
]);

// Команда /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Проверяем, что это админ
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    return bot.sendMessage(chatId, '⛔ Цей бот персональний і доступний тільки для власника.');
  }

  await bot.sendMessage(chatId, 
    '👋 <b>Вітаю!</b>\n\n' +
    'Надсилайте будь-які текстові повідомлення, і вони будуть зберігатися в Google Таблицю.\n\n' +
    'Команди:\n' +
    '/help - Допомога',
    { parse_mode: 'HTML' }
  );
});

// Команда /help
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) return;

  await bot.sendMessage(chatId,
    '📋 <b>Допомога</b>\n\n' +
    'Просто надішліть текстове повідомлення — воно автоматично збережеться в Google Таблицю.\n\n' +
    '📊 Дані зберігаються у листі "Текстові повідомлення"',
    { parse_mode: 'HTML' }
  );
});

// === СОХРАНЕНИЕ ТЕКСТОВЫХ СООБЩЕНИЙ ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  // Только админ
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) return;

  // Игнорируем команды и служебные сообщения
  if (msg.text?.startsWith('/') || msg.voice || msg.contact) return;
  if (!msg.text || msg.text.trim() === '') return;

  try {
    // Сохраняем в таблицу
    await saveTextToSheet(chatId, msg.text);
    
    // Подтверждение
    await bot.sendMessage(chatId, '✅ Повідомлення збережено в таблицю!', {
      reply_to_message_id: msg.message_id
    });

    console.log(`✅ Сообщение сохранено от ${chatId}: ${msg.text.substring(0, 50)}...`);
    
  } catch (error) {
    console.error('❌ Ошибка сохранения:', error);
    await bot.sendMessage(chatId, '❌ Помилка при збереженні');
  }
});

// === ФУНКЦИЯ СОХРАНЕНИЯ В GOOGLE SHEETS ===
async function saveTextToSheet(chatId, text) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    
    const now = new Date();
    const formattedDate = now.toLocaleString('uk-UA', { 
      timeZone: config.TZ || 'Europe/Kyiv',
      hour12: false 
    });

    // Проверяем/создаем лист
    try {
      await sheets.spreadsheets.values.get({
        spreadsheetId: config.SPREADSHEET_ID,
        range: 'Текстові повідомлення!A1'
      });
    } catch (e) {
      // Создаем новый лист
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        resource: {
          requests: [{
            addSheet: {
              properties: { 
                title: 'Текстові повідомлення',
                gridProperties: { frozenRowCount: 1 }
              }
            }
          }]
        }
      });
      
      // Добавляем заголовки
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: 'Текстові повідомлення!A1:C1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Дата і час', 'Текст повідомлення', 'Дія']]
        }
      });
    }

    // Добавляем запись
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: 'Текстові повідомлення!A:C',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          formattedDate,
          text,
          `=HYPERLINK("https://t.me/${config.BOT_USERNAME}", "Відповісти")`
        ]]
      }
    });

    console.log('✅ Сохранено в таблицу');
    
  } catch (error) {
    console.error('❌ Ошибка Sheets:', error);
    throw error;
  }
}

// Самопинг для Render
setInterval(() => {
  axios.get(config.PUBLIC_URL).catch(() => {});
}, 14 * 60 * 1000);

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Bot запущен на порту', PORT);
  console.log('👤 Admin ID:', config.ADMIN_CHAT_ID);
  console.log('📊 Spreadsheet ID:', config.SPREADSHEET_ID);
});
