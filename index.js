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
const userState = new Map(); // chatId -> { step, partyNumber, parties, allParties, currentPage, totalPages, messageId }

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
      return bot.sendMessage(chatId, '❌ Немає активних партій (усі доставлені або таблиця порожня).');
    }

    // Сохраняем список партий в состоянии пользователя
    userState.set(chatId, {
      step: 'waiting_party',
      parties: parties.map(p => p.number),
      allParties: parties, // сохраняем полную информацию
      currentPage: 0,
      totalPages: Math.ceil(parties.length / 10) // по 10 партий на страницу
    });

    // Показываем первую страницу
    await showPartiesPage(chatId);

  } catch (error) {
    console.error('❌ Ошибка загрузки партий:', error);
    await bot.sendMessage(chatId, '❌ Помилка завантаження партій. Спробуйте пізніше.');
  }
});

// Функция показа страницы с партиями
async function showPartiesPage(chatId) {
  const state = userState.get(chatId);
  if (!state) return;

  const startIndex = state.currentPage * 10;
  const endIndex = Math.min(startIndex + 10, state.allParties.length);
  const currentParties = state.allParties.slice(startIndex, endIndex);

  // Формируем текст для текущей страницы
  let messageText = `📋 <b>Список активних партій (стор. ${state.currentPage + 1}/${state.totalPages}):</b>\n\n`;
  
  currentParties.forEach((party, index) => {
    const globalIndex = startIndex + index + 1;
    messageText += `<b>${globalIndex}.</b> <b>${party.number}</b>\n`;
    messageText += `   └─ ${party.from} → ${party.to}\n`;
    messageText += `   └─ ${party.status}\n\n`;
  });
  
  messageText += '👇 <b>Виберіть партію:</b>';

  // Создаем клавиатуру с номерами для текущей страницы
  const keyboard = [];
  
  // Кнопки с номерами партий (по 3 в ряд для компактности)
  for (let i = 0; i < currentParties.length; i += 3) {
    const row = [];
    for (let j = 0; j < 3 && i + j < currentParties.length; j++) {
      const party = currentParties[i + j];
      row.push({ 
        text: ` ${party.number} `,
        callback_data: `party_${party.number}`
      });
    }
    keyboard.push(row);
  }

  // Добавляем кнопки навигации (если нужно)
  const navRow = [];
  if (state.currentPage > 0) {
    navRow.push({ text: '⬅️ Назад', callback_data: 'prev_page' });
  }
  if (state.currentPage < state.totalPages - 1) {
    navRow.push({ text: 'Вперед ➡️', callback_data: 'next_page' });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }
  
  // Добавляем кнопку отмены
  keyboard.push([{ text: '     ❌ Скасувати     ', callback_data: 'cancel' }]);

  // Отправляем или обновляем сообщение
  if (state.messageId) {
    // Редактируем существующее сообщение
    await bot.editMessageText(messageText, {
      chat_id: chatId,
      message_id: state.messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  } else {
    // Отправляем новое сообщение и сохраняем его ID
    const sentMsg = await bot.sendMessage(chatId, messageText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
    state.messageId = sentMsg.message_id;
    userState.set(chatId, state);
  }
}

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
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  
  console.log('📩 Получен callback_query:', { chatId, data, messageId });
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) {
    console.log('⛔ Доступ запрещен');
    return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Доступ заборонено' });
  }

  await bot.answerCallbackQuery(callbackQuery.id);
  console.log('✅ Ответ на callback_query отправлен');

  // Кнопка отмены
  if (data === 'cancel') {
    console.log('🔄 Обработка cancel');
    userState.delete(chatId);
    await bot.editMessageText('❌ Дію скасовано.', {
      chat_id: chatId,
      message_id: messageId
    });
    return;
  }

  // Кнопки навигации по страницам
  if (data === 'prev_page' || data === 'next_page') {
    const state = userState.get(chatId);
    if (!state) return;

    if (data === 'prev_page' && state.currentPage > 0) {
      state.currentPage--;
    }
    if (data === 'next_page' && state.currentPage < state.totalPages - 1) {
      state.currentPage++;
    }

    userState.set(chatId, state);
    await showPartiesPage(chatId);
    return;
  }

  // Кнопки "Додати ще одну" и "Вибрати іншу партію"
  if (data === 'add_another' || data === 'choose_party') {
    await handleAfterAddButtons(callbackQuery, data);
    return;
  }

  // Проверяем состояние пользователя
  const state = userState.get(chatId);
  console.log('📊 Состояние пользователя:', state);

  if (!state) {
    console.log('⚠️ Нет состояния');
    await bot.editMessageText('❌ Сесія застаріла. Почніть заново з /party', {
      chat_id: chatId,
      message_id: messageId
    });
    return;
  }

  if (state.step !== 'waiting_party') {
    console.log('⚠️ Неправильный шаг:', state.step);
    return;
  }

  if (!data.startsWith('party_')) {
    console.log('⚠️ Неправильный формат data:', data);
    return;
  }

  const partyNumber = data.replace('party_', '');
  console.log('📋 Выбрана партия:', partyNumber);

  if (!state.parties.includes(partyNumber)) {
    console.log('❌ Партия не найдена');
    await bot.editMessageText(`❌ Партія ${partyNumber} не знайдена в списку`, {
      chat_id: chatId,
      message_id: messageId
    });
    return;
  }

  console.log('✅ Партия найдена, сохраняем состояние');

  userState.set(chatId, {
    step: 'waiting_message',
    partyNumber: partyNumber
  });

  try {
    await bot.editMessageText(
      `✅ Вибрано партію: <b>${partyNumber}</b>\n\n📝 Тепер надішліть текст, який хочете додати:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      }
    );
    console.log('✅ Сообщение обновлено');
  } catch (error) {
    console.error('❌ Ошибка при обновлении сообщения:', error);
  }
});

// Функция обработки кнопок после добавления
async function handleAfterAddButtons(callbackQuery, data) {
  const chatId = callbackQuery.message.chat.id;
  
  if (data === 'add_another') {
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
}

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  if (String(chatId) !== String(config.ADMIN_CHAT_ID)) return;
  if (msg.text?.startsWith('/')) return;
  if (!msg.text || msg.text.trim() === '') return;

  const state = userState.get(chatId);
  
  if (!state || state.step !== 'waiting_message') {
    return bot.sendMessage(chatId, 
      '❌ Спочатку виберіть партію командою /party',
      { reply_to_message_id: msg.message_id }
    );
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    
    await addNoteToParty(state.partyNumber, msg.text);
    
    userState.delete(chatId);
    
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

// === ФУНКЦИИ РАБОТЫ С GOOGLE SHEETS ===

// Получение списка партий с полной информацией
async function getPartiesList() {
  try {
    console.log('🔍 Читаю лист Рейсы...');
    
    const response = await sheets.spreadsheets.values.get({
      auth: await auth.getClient(),
      spreadsheetId: config.SPREADSHEET_ID,
      range: 'Рейсы!B:G'
    });

    console.log('✅ Ответ от Sheets получен');
    const rows = response.data.values || [];
    console.log(`📊 Найдено строк: ${rows.length}`);

    if (rows.length === 0) {
      console.log('⚠️ Лист Рейсы пуст');
      return [];
    }

    const parties = [];
    
    for (let i = 1; i < rows.length; i++) {
      const party = rows[i]?.[0];      // колонка B
      const from = rows[i]?.[1] || '';  // колонка C
      const to = rows[i]?.[2] || '';    // колонка D
      const status = rows[i]?.[5] || ''; // колонка G
      
      if (!party || party.toString().trim() === '') continue;
      
      const statusLower = status.toString().toLowerCase().trim();
      
      if (statusLower !== 'доставлено') {
        parties.push({
          number: party.toString().trim(),
          from: from.toString().trim(),
          to: to.toString().trim(),
          status: status.toString().trim() || 'немає статусу'
        });
        
        console.log(`✅ Партия ${party} добавлена: ${from} → ${to} (${status})`);
      } else {
        console.log(`⏭️ Партия ${party} пропущена (статус: Доставлено)`);
      }
    }
    
    console.log(`📋 Найдено активных партий: ${parties.length}`);
    
    return parties;
  } catch (error) {
    console.error('❌ Ошибка получения партий:', error);
    throw error;
  }
}

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
      if (rows[i] && rows[i][0] === partyNumber) { // колонка B (индекс 0)
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
    
    // Формируем новое значение (новое + перенос + старое)
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

// === ДИАГНОСТИКА ===
async function diagnoseSheets() {
  try {
    console.log('🔍 Диагностика доступа к таблице...');
    
    const sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    
    const info = await sheetsClient.spreadsheets.get({
      spreadsheetId: config.SPREADSHEET_ID
    });
    
    console.log('✅ Подключение к таблице успешно');
    console.log('📋 Название таблицы:', info.data.properties.title);
    console.log('📊 Доступные листы:');
    info.data.sheets.forEach(sheet => {
      console.log(`   - ${sheet.properties.title}`);
    });
    
    try {
      const test = await sheetsClient.spreadsheets.values.get({
        auth: await auth.getClient(),
        spreadsheetId: config.SPREADSHEET_ID,
        range: 'Рейсы!B1:G5'
      });
      console.log('✅ Лист "Рейсы" доступен');
      console.log('📋 Первые строки (B:G):', test.data.values);
    } catch (e) {
      console.error('❌ Лист "Рейсы" НЕ доступен:', e.message);
    }
    
  } catch (error) {
    console.error('❌ Диагностика провалена:', error);
  }
}

// Самопинг для Render
setInterval(() => {
  axios.get(config.PUBLIC_URL).catch(() => {});
}, 14 * 60 * 1000);

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('🚀 Bot запущен на порту', PORT);
  console.log('👤 Admin ID:', config.ADMIN_CHAT_ID);
  console.log('📊 Spreadsheet ID:', config.SPREADSHEET_ID);
  
  // Запускаем диагностику
  await diagnoseSheets();
});
