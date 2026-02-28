// index.js
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const speech = require('@google-cloud/speech');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const config = require('./config');

// Проверка конфигурации
if (!config.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!config.ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID is required');
if (!config.PUBLIC_URL) throw new Error('PUBLIC_URL is required');

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация бота
const bot = new TelegramBot(config.BOT_TOKEN, { webHook: true });
bot.setWebHook(`${config.PUBLIC_URL}/bot${config.BOT_TOKEN}`, 
  config.WH_SECRET ? { secret_token: config.WH_SECRET } : undefined
);

// Webhook endpoint
app.post(`/bot${config.BOT_TOKEN}`, (req, res) => {
  if (config.WH_SECRET) {
    const token = req.get('x-telegram-bot-api-secret-token');
    if (token !== config.WH_SECRET) return res.sendStatus(401);
  }
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get('/', (_, res) => res.status(200).send('✅ Voice Bot is running'));

// Google Speech клиент
const speechClient = new speech.SpeechClient({
  keyFilename: path.join(__dirname, config.GOOGLE_KEY_PATH)
});

// Google Sheets клиент
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, config.GOOGLE_KEY_PATH),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// Настройки команд бота
bot.setMyCommands([
  { command: 'start', description: 'Запустити бота' },
  { command: 'stats', description: 'Статистика використання' },
  { command: 'help', description: 'Допомога' }
]);

// Хранилище для статистики
const stats = {
  total: 0,
  today: 0,
  lastReset: new Date().setHours(0,0,0,0)
};

// Обновление статистики
function updateStats() {
  const now = new Date().setHours(0,0,0,0);
  if (now > stats.lastReset) {
    stats.today = 0;
    stats.lastReset = now;
  }
  stats.total++;
  stats.today++;
}

// === ОСНОВНАЯ ЛОГИКА ===

// Команда /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Проверяем, что это админ
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    return bot.sendMessage(chatId, '⛔ Цей бот персональний і доступний тільки для власника.');
  }

  await bot.sendMessage(chatId, 
    '🎤 <b>Вітаю, Адміне!</b>\n\n' +
    'Я ваш персональний бот для розпізнавання голосових повідомлень.\n\n' +
    '📤 Просто надішліть мені голосове повідомлення, і я:\n' +
    '1️⃣ Розпізнаю мову через Google AI\n' +
    '2️⃣ Запишу текст у Google Таблицю\n' +
    '3️⃣ Надішлю вам результат\n\n' +
    '📊 Також доступна команда /stats для перегляду статистики',
    { parse_mode: 'HTML' }
  );
});

// Команда /stats
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    return;
  }

  const statsMessage = 
    '📊 <b>Статистика використання</b>\n\n' +
    `📝 Всього розпізнано: <b>${stats.total}</b>\n` +
    `📅 Сьогодні: <b>${stats.today}</b>\n` +
    `💰 Безкоштовних хвилин залишилось: <b>60</b> з 60/міс`;

  await bot.sendMessage(chatId, statsMessage, { parse_mode: 'HTML' });
});

// Команда /help
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    return;
  }

  await bot.sendMessage(chatId,
    '❓ <b>Допомога</b>\n\n' +
    '🎤 <b>Голосові повідомлення</b>\n' +
    'Просто надішліть голосове – я розпізнаю його автоматично.\n\n' +
    '📋 <b>Команди:</b>\n' +
    '/start - Запустити бота\n' +
    '/stats - Статистика\n' +
    '/help - Це повідомлення\n\n' +
    '📊 <b>Google Таблиця:</b>\n' +
    'Всі результати зберігаються у вашій таблиці',
    { parse_mode: 'HTML' }
  );
});

// Обработка голосовых сообщений
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  
  // Проверяем, что это админ
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    console.log(`🚫 Попытка использования от ${chatId}`);
    return;
  }

  const processingMsg = await bot.sendMessage(chatId, '🎤 Обробляю голосове повідомлення...');

  try {
    // Получаем файл
    const fileId = msg.voice.file_id;
    const fileLink = await bot.getFileLink(fileId);
    
    // Скачиваем
    const filePath = path.join(os.tmpdir(), `${fileId}.ogg`);
    const writer = fs.createWriteStream(filePath);
    
    const response = await axios({
      method: 'get',
      url: fileLink,
      responseType: 'stream'
    });
    
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Распознаем
    const transcript = await transcribeAudio(filePath);
    
    // Удаляем временный файл
    fs.unlinkSync(filePath);
    
    if (!transcript) {
      await bot.editMessageText('❌ Не вдалося розпізнати мову. Спробуйте ще раз.', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
      return;
    }

    // Сохраняем в таблицу
    await saveToSheet(chatId, transcript, msg.voice.duration);
    
    // Обновляем статистику
    updateStats();

    // Отправляем результат
    await bot.editMessageText(`✅ <b>Розпізнано:</b>\n\n${transcript}`, {
      chat_id: chatId,
      message_id: processingMsg.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎤 Надіслати ще', callback_data: 'voice_again' }]
        ]
      }
    });

  } catch (error) {
    console.error('❌ Ошибка:', error);
    await bot.editMessageText('❌ Сталася помилка. Спробуйте ще раз.', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });
  }
});

// Обработка inline кнопок
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data === 'voice_again') {
    await bot.sendMessage(chatId, '🎤 Надішліть голосове повідомлення:');
  }

  await bot.answerCallbackQuery(callbackQuery.id);
});

// Функция распознавания аудио
async function transcribeAudio(filePath) {
  try {
    const file = fs.readFileSync(filePath);
    const audioBytes = file.toString('base64');

    const audio = { content: audioBytes };
    const config_request = {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 48000,
      languageCode: config.SPEECH_LANGUAGE,
      enableAutomaticPunctuation: true,
      model: 'phone_call',
    };
    
    const request = { audio, config: config_request };
    const [response] = await speechClient.recognize(request);
    
    return response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
  } catch (error) {
    console.error('❌ Ошибка распознавания:', error);
    return null;
  }
}

// Функция сохранения в Google Sheets
async function saveToSheet(chatId, transcript, duration) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    
    const now = new Date();
    const formattedDate = now.toLocaleString('uk-UA', { 
      timeZone: config.TZ,
      hour12: false 
    });

    // Создаем лист если его нет
    try {
      await sheets.spreadsheets.values.get({
        spreadsheetId: config.SPREADSHEET_ID,
        range: 'Голосові!A1'
      });
    } catch (e) {
      // Создаем новый лист
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        resource: {
          requests: [{
            addSheet: {
              properties: { title: 'Голосові' }
            }
          }]
        }
      });
      
      // Добавляем заголовки
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: 'Голосові!A1:E1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Дата', 'Час', 'Тривалість', 'Текст', 'Посилання']]
        }
      });
    }

    // Добавляем запись
    const [datePart, timePart] = formattedDate.split(', ');
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: 'Голосові!A:E',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          datePart,
          timePart,
          `${Math.round(duration)} сек`,
          transcript,
          `https://t.me/${config.BOT_USERNAME}`
        ]]
      }
    });

    console.log('✅ Сохранено в таблицу');
  } catch (error) {
    console.error('❌ Ошибка сохранения:', error);
  }
}

// Самопинг для Render
setInterval(() => {
  axios.get(config.PUBLIC_URL).catch(() => {});
}, 14 * 60 * 1000);

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Voice Bot запущен на порту', PORT);
  console.log('👤 Admin ID:', config.ADMIN_CHAT_ID);
  console.log('🌐 Webhook URL:', `${config.PUBLIC_URL}/bot${config.BOT_TOKEN}`);
});
