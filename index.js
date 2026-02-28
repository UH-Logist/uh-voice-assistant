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
let auth;

// Используем credentials из переменной окружения CREDENTIALS_JSON
if (!process.env.CREDENTIALS_JSON) {
  console.error('❌ CREDENTIALS_JSON не найдена в переменных окружения!');
  throw new Error('CREDENTIALS_JSON environment variable is required');
}

try {
  const credentials = JSON.parse(process.env.CREDENTIALS_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  console.log('✅ Google Sheets авторизация настроена через CREDENTIALS_JSON');
} catch (error) {
  console.error('❌ Ошибка парсинга CREDENTIALS_JSON:', error.message);
  throw error;
}

const sheets = google.sheets({ version: 'v4' });

// Хранилище состояний пользователей
const userState = new Map(); // chatId -> { step, partyNumber, parties }

// Настройки команд бота
bot.setMyCommands([
  { command: 'start', description: 'Запустити бота' },
  { command: 'party', description: 'Вибрати партію для запису' },
  { command: 'cancel', description: 'Скасувати поточну дію' }
]);

// Команда /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    return bot.sendMessage(chatId, '⛔ Цей бот персональний і доступний тільки для власника.');
  }

  await bot.sendMessage(chatId, 
    '👋 <b>Вітаю!</b>\n\n' +
    'Цей бот допомагає додавати нотатки до партій у Google Таблиці.\n\n' +
    'Команди:\n' +
    '/party - Вибрати партію для запису\n' +
    '/cancel - Скасувати поточну дію',
    { parse_mode: 'HTML' }
  );
});

// Команда /party - выбор партии
bot.onText(/\/party/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) return;

  try {
    await bot.sendMessage(chatId, '🔍 Завантажую список партій...');
    
    // Получаем список партий из таблицы
    const parties = await getPartiesList();
    
    if (parties.length === 0) {
      return bot.sendMessage(chatId, '❌ Не знайдено жодної партії в таблиці.');
    }

    // Сохраняем список партий в состоянии пользователя
    userState.set(chatId, {
      step: 'waiting_party',
      parties: parties
    });

// Создаем клавиатуру с партиями (по 2 в ряд)
const keyboard = [];
for (let i = 0; i < parties.length; i += 2) {
  const row = [];
  // ВАЖНО: text - это то, что видит пользователь
  // callback_data - это то, что отправляется боту (должно быть уникальным)
  row.push({ 
    text: parties[i].toString(),
    callback_data: `party_${parties[i]}`  // Добавляем префикс
  });
  
  if (i + 1 < parties.length) {
    row.push({ 
      text: parties[i + 1].toString(),
      callback_data: `party_${parties[i + 1]}`  // Добавляем префикс
    });
  }
  keyboard.push(row);
}
    
    // Добавляем кнопку отмены
    keyboard.push([{ text: '❌ Скасувати', callback_data: 'cancel' }]);

    await bot.sendMessage(chatId, 
      '📋 <b>Виберіть номер партії:</b>', 
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    );

  } catch (error) {
    console.error('❌ Ошибка загрузки партий:', error);
    await bot.sendMessage(chatId, '❌ Помилка завантаження партій. Спробуйте пізніше.');
  }
});

// Команда /cancel
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) return;
  
  userState.delete(chatId);
  await bot.sendMessage(chatId, '✅ Дію скасовано.');
});

// Обработка callback-кнопок
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Доступ заборонено' });
  }

  if (data === 'cancel') {
    userState.delete(chatId);
    await bot.editMessageText('❌ Дію скасовано.', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id
    });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

// Проверяем, что это номер партии (callback_data начинается с "party_")
const state = userState.get(chatId);
if (state && state.step === 'waiting_party' && data.startsWith('party_')) {
  const partyNumber = data.replace('party_', ''); // Убираем префикс
  
  // Проверяем, что партия есть в списке
  if (!state.parties.includes(partyNumber)) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Невірний номер партії' });
  }

    // Сохраняем выбранную партию
    userState.set(chatId, {
      step: 'waiting_message',
      partyNumber: partyNumber
    });

    await bot.editMessageText(
      `✅ Вибрано партію: <b>${partyNumber}</b>\n\n📝 Тепер надішліть текст, який хочете додати:`,
      {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        parse_mode: 'HTML'
      }
    );
    
    bot.answerCallbackQuery(callbackQuery.id);
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  // Только админ
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) return;

  // Игнорируем команды
  if (msg.text?.startsWith('/')) return;
  if (!msg.text || msg.text.trim() === '') return;

  // Проверяем состояние пользователя
  const state = userState.get(chatId);
  
  if (!state || state.step !== 'waiting_message') {
    // Если не в режиме ожидания сообщения - предлагаем выбрать партию
    return bot.sendMessage(chatId, 
      '❌ Спочатку виберіть партію командою /party',
      {
        reply_to_message_id: msg.message_id
      }
    );
  }

  try {
    // Сообщаем, что начали обработку
    await bot.sendChatAction(chatId, 'typing');
    
    // Добавляем сообщение к партии
    const result = await addNoteToParty(state.partyNumber, msg.text);
    
    // Очищаем состояние
    userState.delete(chatId);
    
    // Отправляем подтверждение
    await bot.sendMessage(chatId, 
      `✅ <b>Нотатку додано до партії ${state.partyNumber}</b>\n\n` +
      `📝 <i>${msg.text}</i>`,
      {
        parse_mode: 'HTML',
        reply_to_message_id: msg.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '📋 Додати ще одну', callback_data: 'add_another' }],
            [{ text: '🔍 Вибрати іншу партію', callback_data: 'choose_party' }]
          ]
        }
      }
    );

    console.log(`✅ Сообщение добавлено к партии ${state.partyNumber}`);

  } catch (error) {
    console.error('❌ Ошибка добавления:', error);
    await bot.sendMessage(chatId, 
      '❌ Помилка при додаванні нотатки. Спробуйте ще раз.',
      { reply_to_message_id: msg.message_id }
    );
  }
});

// Обработка дополнительных callback-кнопок после успешного добавления
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Доступ заборонено' });
  }

  if (data === 'add_another') {
    // Оставляем ту же партию
    const state = userState.get(chatId);
    if (state && state.partyNumber) {
      userState.set(chatId, {
        step: 'waiting_message',
        partyNumber: state.partyNumber
      });
      await bot.sendMessage(chatId, 
        `📝 Надішліть ще один текст для партії <b>${state.partyNumber}</b>:`,
        { parse_mode: 'HTML' }
      );
    } else {
      await bot.sendMessage(chatId, '❌ Стан втрачено. Використайте /party');
    }
  }
  
  if (data === 'choose_party') {
    userState.delete(chatId);
    await bot.sendMessage(chatId, '🔍 Використайте /party для вибору іншої партії');
  }
  
  await bot.answerCallbackQuery(callbackQuery.id);
});

// === ФУНКЦИИ РАБОТЫ С GOOGLE SHEETS ===
// Получение списка партий из колонки B листа "Рейсы"
async function getPartiesList() {
  try {
    console.log('🔍 Читаю лист Рейсы...');
    
    const response = await sheets.spreadsheets.values.get({
      auth: await auth.getClient(),
      spreadsheetId: config.SPREADSHEET_ID,
      range: 'Рейсы!B:B'
    });

    console.log('✅ Ответ от Sheets получен');
    const rows = response.data.values || [];
    console.log(`📊 Найдено строк: ${rows.length}`);

    if (rows.length === 0) {
      console.log('⚠️ Лист Рейсы пуст');
      return [];
    }

    // Пропускаем заголовок (первую строку) и фильтруем пустые
    const parties = rows.slice(1)
      .map(row => row[0])
      .filter(party => party && party.toString().trim() !== '');
    
    console.log(`📋 Найдено партий: ${parties.length}`);
    console.log('📋 Первые 5 партий:', parties.slice(0, 5));
    
    return parties;
  } catch (error) {
    console.error('❌ Ошибка получения партий:', error);
    console.error('❌ Детали ошибки:', error.message);
    if (error.response) {
      console.error('❌ Ответ API:', error.response.data);
    }
    throw error;
  }
}

/*
// Получение списка партий из колонки B листа "Рейсы"
async function getPartiesList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      auth: await auth.getClient(),
      spreadsheetId: config.SPREADSHEET_ID,
      range: 'Рейсы!B:B'
    });

    const rows = response.data.values || [];
    // Пропускаем заголовок (первую строку) и фильтруем пустые
    const parties = rows.slice(1)
      .map(row => row[0])
      .filter(party => party && party.toString().trim() !== '');
    
    return parties;
  } catch (error) {
    console.error('❌ Ошибка получения партий:', error);
    throw error;
  }
}
*/
// Добавление заметки к партии в колонку H
async function addNoteToParty(partyNumber, note) {
  try {
    // Получаем текущую дату в формате ДД.ММ
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const datePrefix = `${day}.${month} - `;
    
    // Формируем новый текст с датой
    const newText = datePrefix + note;

    // Находим строку с нужной партией
    const response = await sheets.spreadsheets.values.get({
      auth: await auth.getClient(),
      spreadsheetId: config.SPREADSHEET_ID,
      range: 'Рейсы!B:H'
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    // Ищем строку с нужной партией (пропускаем заголовок)
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === partyNumber) { // колонка B (индекс 0 в массиве)
        targetRowIndex = i + 1; // +1 потому что строки в Sheets начинаются с 1
        break;
      }
    }

    if (targetRowIndex === -1) {
      throw new Error(`Партія ${partyNumber} не знайдена`);
    }

    // Получаем текущее содержимое ячейки H
    const cellResponse = await sheets.spreadsheets.values.get({
      auth: await auth.getClient(),
      spreadsheetId: config.SPREADSHEET_ID,
      range: `Рейсы!H${targetRowIndex}`
    });

    const currentValue = cellResponse.data.values?.[0]?.[0] || '';
    
    // Формируем новое значение (старое + перенос + новое)
    let newValue;
    if (currentValue.trim() === '') {
      newValue = newText;
    } else {
      newValue = newText + '\n' + currentValue;
    }

    // Обновляем ячейку
    await sheets.spreadsheets.values.update({
      auth: await auth.getClient(),
      spreadsheetId: config.SPREADSHEET_ID,
      range: `Рейсы!H${targetRowIndex}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[newValue]]
      }
    });

    console.log(`✅ Нотатка додана до партії ${partyNumber} в рядок ${targetRowIndex}`);
    return true;

  } catch (error) {
    console.error('❌ Ошибка добавления заметки:', error);
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

// ВРЕМЕННАЯ ФУНКЦИЯ для диагностики - добавьте перед app.listen()
async function diagnoseSheets() {
  try {
    console.log('🔍 Диагностика доступа к таблице...');
    
    // Проверяем, что можем подключиться
    const sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    
    // Получаем информацию о таблице
    const info = await sheetsClient.spreadsheets.get({
      spreadsheetId: config.SPREADSHEET_ID
    });
    
    console.log('✅ Подключение к таблице успешно');
    console.log('📋 Название таблицы:', info.data.properties.title);
    console.log('📊 Доступные листы:');
    info.data.sheets.forEach(sheet => {
      console.log(`   - ${sheet.properties.title}`);
    });
    
    // Проверяем лист Рейсы
    try {
      const test = await sheetsClient.spreadsheets.values.get({
        auth: await auth.getClient(),
        spreadsheetId: config.SPREADSHEET_ID,
        range: 'Рейсы!B1:B5'
      });
      console.log('✅ Лист "Рейсы" доступен');
      console.log('📋 Первые строки:', test.data.values);
    } catch (e) {
      console.error('❌ Лист "Рейсы" НЕ доступен:', e.message);
    }
    
  } catch (error) {
    console.error('❌ Диагностика провалена:', error);
  }
}

// Вызовите функцию
diagnoseSheets();

/*
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
let auth;

// Используем credentials из переменной окружения CREDENTIALS_JSON
if (!process.env.CREDENTIALS_JSON) {
  console.error('❌ CREDENTIALS_JSON не найдена в переменных окружения!');
  throw new Error('CREDENTIALS_JSON environment variable is required');
}

try {
  const credentials = JSON.parse(process.env.CREDENTIALS_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  console.log('✅ Google Sheets авторизация настроена через CREDENTIALS_JSON');
} catch (error) {
  console.error('❌ Ошибка парсинга CREDENTIALS_JSON:', error.message);
  throw error;
}

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
*/
