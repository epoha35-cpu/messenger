const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

// ===== СОЗДАЕМ СЕРВЕР =====
const app = express();
const port = process.env.PORT || 3000;

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ===== МИДЛВАРЫ =====
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Отдаем статику (index.html, style.css)

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
async function getUsers() {
  const result = await pool.query('SELECT * FROM users');
  return result.rows;
}

async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

async function getChats(userId) {
  const result = await pool.query(
    `SELECT c.*, u.name as partner_name, u.color as partner_color, u.is_admin as partner_is_admin
     FROM chats c
     JOIN users u ON u.id = c.partner_id
     WHERE c.user_id = $1
     ORDER BY c.updated_at DESC`,
    [userId]
  );
  return result.rows;
}

async function getMessages(chatId) {
  const result = await pool.query(
    'SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC',
    [chatId]
  );
  return result.rows;
}

// ===== СОЗДАНИЕ ТАБЛИЦ (если их нет) =====
async function initDatabase() {
  try {
    // Таблица пользователей
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        password VARCHAR(100) NOT NULL,
        color VARCHAR(20) DEFAULT '#6c8cff',
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица чатов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id VARCHAR(50) PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        partner_id VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Таблица сообщений
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(50) PRIMARY KEY,
        chat_id VARCHAR(50) NOT NULL,
        from_user_id VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Индексы для быстрого поиска
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    `);

    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error.message);
  }
}

// ===== АПИ ЭНДПОИНТЫ =====

// 1. РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
  const { id, name, password, color } = req.body;

  if (!id || !name || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  try {
    const existing = await getUserById(id);
    if (existing) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    await pool.query(
      'INSERT INTO users (id, name, password, color, is_admin) VALUES ($1, $2, $3, $4, $5)',
      [id, name, password, color || '#6c8cff', false]
    );

    res.json({
      success: true,
      user: { id, name, isAdmin: false, color: color || '#6c8cff' }
    });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 2. ВХОД
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;

  if (!id || !password) {
    return res.status(400).json({ error: 'Заполните ID и пароль' });
  }

  try {
    const user = await getUserById(id);
    if (!user) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }

    if (user.password !== password) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        isAdmin: user.is_admin || false,
        color: user.color
      }
    });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 3. ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ
app.get('/api/users', async (req, res) => {
  try {
    const users = await getUsers();
    const list = users.map(u => ({
      id: u.id,
      name: u.name,
      color: u.color,
      isAdmin: u.is_admin || false
    }));
    res.json(list);
  } catch (error) {
    console.error('Ошибка получения пользователей:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 4. ПОЛУЧИТЬ ЧАТЫ
app.get('/api/chats', async (req, res) => {
  const userId = req.query.userId;

  if (!userId) {
    return res.status(400).json({ error: 'Не указан userId' });
  }

  try {
    const chats = await getChats(userId);

    // Добавляем сообщения в каждый чат
    const chatsWithMessages = await Promise.all(chats.map(async (chat) => {
      const messages = await getMessages(chat.id);
      return {
        ...chat,
        messages: messages
      };
    }));

    res.json(chatsWithMessages);
  } catch (error) {
    console.error('Ошибка получения чатов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 5. СОЗДАТЬ ЧАТ
app.post('/api/chats', async (req, res) => {
  const { userId, partnerId } = req.body;

  if (!userId || !partnerId) {
    return res.status(400).json({ error: 'Не указаны userId или partnerId' });
  }

  try {
    // Проверяем, существует ли партнер
    const partner = await getUserById(partnerId);
    if (!partner) {
      return res.status(400).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, есть ли уже чат
    const existing = await pool.query(
      'SELECT * FROM chats WHERE user_id = $1 AND partner_id = $2',
      [userId, partnerId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Чат уже существует' });
    }

    const chatId = Date.now().toString(36);

    // Создаем чат для первого пользователя
    await pool.query(
      'INSERT INTO chats (id, user_id, partner_id) VALUES ($1, $2, $3)',
      [chatId, userId, partnerId]
    );

    // Создаем зеркальный чат для второго пользователя
    await pool.query(
      'INSERT INTO chats (id, user_id, partner_id) VALUES ($1, $2, $3)',
      [chatId + '_mirror', partnerId, userId]
    );

    res.json({ success: true, chatId });
  } catch (error) {
    console.error('Ошибка создания чата:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 6. ОТПРАВИТЬ СООБЩЕНИЕ
app.post('/api/messages', async (req, res) => {
  const { chatId, fromUserId, text } = req.body;

  if (!chatId || !fromUserId || !text) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }

  try {
    const messageId = Date.now().toString(36);

    // Добавляем сообщение
    await pool.query(
      'INSERT INTO messages (id, chat_id, from_user_id, text) VALUES ($1, $2, $3, $4)',
      [messageId, chatId, fromUserId, text]
    );

    // Обновляем время чата
    await pool.query(
      'UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [chatId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 7. УДАЛИТЬ ЧАТ
app.delete('/api/chats', async (req, res) => {
  const { userId, chatId } = req.body;

  if (!userId || !chatId) {
    return res.status(400).json({ error: 'Не указаны userId или chatId' });
  }

  try {
    await pool.query('DELETE FROM chats WHERE user_id = $1 AND id = $2', [userId, chatId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка удаления чата:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 8. СДЕЛАТЬ АДМИНОМ
app.post('/api/admin/make', async (req, res) => {
  const { userId, adminId } = req.body;

  try {
    const admin = await getUserById(adminId);
    if (!admin || !admin.is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }

    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 9. УДАЛИТЬ ПОЛЬЗОВАТЕЛЯ
app.delete('/api/admin/users', async (req, res) => {
  const { userId, adminId } = req.body;

  try {
    const admin = await getUserById(adminId);
    if (!admin || !admin.is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }

    // Удаляем сообщения
    await pool.query(
      'DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = $1 OR partner_id = $1)',
      [userId]
    );

    // Удаляем чаты
    await pool.query('DELETE FROM chats WHERE user_id = $1 OR partner_id = $1', [userId]);

    // Удаляем пользователя
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 10. УДАЛИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ
app.delete('/api/admin/users/all', async (req, res) => {
  const { adminId } = req.body;

  try {
    const admin = await getUserById(adminId);
    if (!admin || !admin.is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }

    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM chats');
    await pool.query('DELETE FROM users');

    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 11. ПОЛУЧИТЬ ОДИН ЧАТ
app.get('/api/chat', async (req, res) => {
  const chatId = req.query.chatId;
  const userId = req.query.userId;

  if (!chatId || !userId) {
    return res.status(400).json({ error: 'Не указаны chatId или userId' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM chats WHERE id = $1 AND user_id = $2',
      [chatId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    const chat = result.rows[0];
    const messages = await getMessages(chatId);
    chat.messages = messages;

    res.json(chat);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ===== ЗАПУСК СЕРВЕРА =====
app.listen(port, async () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
  await initDatabase();
  console.log(`🌐 Открой: http://localhost:${port}`);
});