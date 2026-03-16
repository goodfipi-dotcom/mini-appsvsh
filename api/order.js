const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const BOT_API = `https://api.telegram.org/bot${TG_TOKEN}`;

async function sendTG(chat_id, text, reply_markup = null) {
  const payload = { chat_id, text, parse_mode: 'HTML' };
  if (reply_markup) payload.reply_markup = reply_markup;
  await axios.post(`${BOT_API}/sendMessage`, payload);
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      name TEXT,
      address TEXT,
      task TEXT,
      phone TEXT,
      service TEXT,
      client_price INTEGER DEFAULT 0,
      worker_price INTEGER DEFAULT 0,
      margin INTEGER DEFAULT 0,
      workers_needed INTEGER DEFAULT 1,
      comment TEXT,
      status TEXT DEFAULT 'waiting_admin',
      accepted_by TEXT[] DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT,
      total_hours INTEGER DEFAULT 0,
      total_earnings INTEGER DEFAULT 0,
      rating REAL DEFAULT 5.0,
      level TEXT DEFAULT 'Новичок',
      bank_details TEXT DEFAULT ''
    );
  `);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDB();

    // GET — список заказов для рабочих
    if (req.method === 'GET') {
      const { status } = req.query;
      let query = 'SELECT * FROM orders';
      let params = [];
      if (status) {
        query += ' WHERE status = $1';
        params = [status];
      }
      query += ' ORDER BY created_at DESC';
      const result = await pool.query(query, params);
      return res.status(200).json(result.rows);
    }

    // POST — создать заказ
    if (req.method === 'POST') {
      const { name, address, task, phone, source, service, client_price, worker_price, margin, comment, workers_needed } = req.body;

      if (source === 'admin') {
        // Заказ от админа — сразу публикуем
        const result = await pool.query(
          `INSERT INTO orders (service, address, client_price, worker_price, margin, workers_needed, comment, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'published') RETURNING id`,
          [service || task, address, client_price || 0, worker_price || 0, margin || 0, workers_needed || 1, comment || '']
        );
        const orderId = result.rows[0].id;

        // Уведомляем всех рабочих
        const workersResult = await pool.query('SELECT id, name FROM workers');
        for (const worker of workersResult.rows) {
          try {
            await sendTG(worker.id,
              `🔥 <b>НОВЫЙ ЗАКАЗ №${orderId}</b>\n\n` +
              `🔧 ${service || task}\n` +
              `💰 Ставка: ${worker_price}₽\n\n` +
              `Открой приложение чтобы принять заказ!`
            );
          } catch (e) { /* рабочий мог заблокировать бота */ }
        }

        // Подтверждение админу
        await sendTG(ADMIN_ID,
          `✅ <b>Заказ №${orderId} опубликован!</b>\n\n` +
          `🔧 ${service || task}\n📍 ${address}\n` +
          `💰 Клиент: ${client_price}₽ | Рабочим: ${worker_price}₽ | Маржа: ${margin}₽\n` +
          `👷 Нужно: ${workers_needed} чел.`
        );

        return res.status(200).json({ success: true, orderId });

      } else {
        // Заявка от клиента
        const result = await pool.query(
          `INSERT INTO orders (name, address, task, phone, status)
           VALUES ($1,$2,$3,$4,'waiting_admin') RETURNING id`,
          [name || '', address, task, phone]
        );
        const orderId = result.rows[0].id;

        // Уведомление тебе с кнопками
        await sendTG(ADMIN_ID,
          `🔔 <b>НОВАЯ ЗАЯВКА №${orderId}</b>\n\n` +
          `👤 ${name}\n📍 ${address}\n🔧 ${task}\n📞 ${phone}`,
          {
            inline_keyboard: [[
              { text: '✅ ОДОБРИТЬ', callback_data: `approve_${orderId}` },
              { text: '❌ ОТКЛОНИТЬ', callback_data: `reject_${orderId}` }
            ]]
          }
        );

        return res.status(200).json({ success: true, orderId });
      }
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
