import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const BOT_API  = `https://api.telegram.org/bot${TG_TOKEN}`;

async function sendTG(chat_id, text, reply_markup = null) {
  const payload = { chat_id, text, parse_mode: 'HTML' };
  if (reply_markup) payload.reply_markup = JSON.stringify(reply_markup);
  try {
    await fetch(`${BOT_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('TG send error:', e.message);
  }
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
      city TEXT DEFAULT 'Октябрьский',
      client_price INTEGER DEFAULT 0,
      worker_price INTEGER DEFAULT 0,
      margin INTEGER DEFAULT 0,
      workers_needed INTEGER DEFAULT 1,
      comment TEXT,
      status TEXT DEFAULT 'waiting_admin',
      accepted_by TEXT[] DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Добавляем колонки city и phone если их нет (для существующей базы)
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'orders'
  `);
  const existing = cols.rows.map(r => r.column_name);

  if (!existing.includes('city')) {
    await pool.query(`ALTER TABLE orders ADD COLUMN city TEXT DEFAULT 'Октябрьский'`);
  }
  if (!existing.includes('phone')) {
    await pool.query(`ALTER TABLE orders ADD COLUMN phone TEXT DEFAULT ''`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDB();

    // ── GET — список заказов ──
    if (req.method === 'GET') {
      const { status } = req.query;
      let query = 'SELECT * FROM orders';
      const params = [];

      if (status) {
        query += ' WHERE status = $1';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC';
      const result = await pool.query(query, params);
      return res.status(200).json(result.rows);
    }

    // ── POST — создать заказ ──
    if (req.method === 'POST') {
      const {
        name, address, task, phone, source, service,
        city, client_price, worker_price, margin,
        comment, workers_needed, status
      } = req.body;

      if (source === 'admin') {
        // ── Заказ от админа — сразу публикуем ──
        const result = await pool.query(
          `INSERT INTO orders (service, address, phone, city, client_price, worker_price, margin, workers_needed, comment, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published') RETURNING id`,
          [
            service || task || '',
            address || '',
            phone || '',
            city || 'Октябрьский',
            client_price || 0,
            worker_price || 0,
            margin || 0,
            workers_needed || 1,
            comment || ''
          ]
        );
        const orderId = result.rows[0].id;

        // Уведомляем всех рабочих в Telegram
        try {
          const workersResult = await pool.query('SELECT id, name FROM workers');
          for (const worker of workersResult.rows) {
            try {
              await sendTG(worker.id,
                `🔥 <b>НОВАЯ ЗАЯВКА №${orderId}</b>\n\n` +
                `🔧 ${service || task}\n` +
                `📍 ${city || 'Октябрьский'}, ${address}\n` +
                `👷 Нужно рабочих: ${workers_needed || 1}\n` +
                (comment ? `💬 ${comment}\n` : '') +
                `\nОткрой приложение чтобы принять заявку!`
              );
            } catch (e) {
              // Рабочий мог заблокировать бота — пропускаем
            }
          }
        } catch (e) {
          console.error('Workers notify error:', e.message);
        }

        // Подтверждение админу
        try {
          await sendTG(ADMIN_ID,
            `✅ <b>Заказ №${orderId} опубликован!</b>\n\n` +
            `🔧 ${service || task}\n` +
            `📍 ${city}, ${address}\n` +
            `📞 ${phone}\n` +
            `👷 Нужно: ${workers_needed || 1} чел.` +
            (comment ? `\n💬 ${comment}` : '')
          );
        } catch (e) {
          console.error('Admin notify error:', e.message);
        }

        return res.status(200).json({ success: true, orderId });

      } else {
        // ── Заявка от клиента (с будущего сайта) ──
        const result = await pool.query(
          `INSERT INTO orders (name, address, task, phone, city, status)
           VALUES ($1, $2, $3, $4, $5, 'waiting_admin') RETURNING id`,
          [name || '', address || '', task || '', phone || '', city || 'Октябрьский']
        );
        const orderId = result.rows[0].id;

        // Уведомление админу с кнопками
        try {
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
        } catch (e) {
          console.error('Admin notify error:', e.message);
        }

        return res.status(200).json({ success: true, orderId });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Order API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
