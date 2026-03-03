const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const app = express();

app.use(cors());
app.use(express.json());

// Подключение к базе PostgreSQL (Railway заполнит это сам)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Твои данные, которые ты предоставил
const TG_TOKEN = '8174571129:AAEZqfwEWUMDluztgkuqHkBeeuLlcnMTX58';
const ADMIN_ID = '7693616720';

// Создание таблицы в базе данных
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        name TEXT,
        address TEXT,
        task TEXT,
        phone TEXT,
        status TEXT DEFAULT 'waiting_admin',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("База данных готова к работе");
  } catch (err) {
    console.error("Ошибка инициализации БД:", err);
  }
}
initDB();

app.post('/api/order', async (req, res) => {
  const { name, address, task, phone } = req.body;
  
  try {
    // 1. Сохраняем заказ в базу данных
    const result = await pool.query(
      'INSERT INTO orders (name, address, task, phone) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, address, task, phone]
    );
    const orderId = result.rows[0].id;

    // 2. Формируем текст для тебя (админа)
    const message = `🔔 НОВЫЙ ЗАКАЗ №${orderId}\n\n` +
                    `👤 Имя: ${name}\n` +
                    `📍 Адрес: ${address}\n` +
                    `🔧 Задача: ${task}\n` +
                    `📞 Тел: ${phone}`;

    // 3. Отправляем уведомление тебе в Telegram напрямую
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: ADMIN_ID,
      text: message,
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ ОДОБРИТЬ ДЛЯ БРИГАД", callback_data: `approve_${orderId}` }]
        ]
      }
    });

    res.status(200).json({ success: true, orderId });
  } catch (err) {
    console.error("Ошибка при обработке заказа:", err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Сервер VSH запущен на порту ${PORT}`));
