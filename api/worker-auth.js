import pg from 'pg';
import axios from 'axios';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT,
      stars INTEGER DEFAULT 0,
      total_orders INTEGER DEFAULT 0,
      total_earnings INTEGER DEFAULT 0,
      bank_details TEXT DEFAULT '',
      level TEXT DEFAULT 'Новобранец',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      name TEXT, address TEXT, task TEXT, service TEXT,
      phone TEXT, city TEXT DEFAULT 'Октябрьский',
      comment TEXT, workers_needed INTEGER DEFAULT 1,
      client_price INTEGER DEFAULT 0, worker_price INTEGER DEFAULT 0,
      margin INTEGER DEFAULT 0, status TEXT DEFAULT 'waiting_admin',
      accepted_by TEXT[] DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW()
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

    // GET — список рабочих для лидерборда и админки
    if (req.method === 'GET') {
      const result = await pool.query(
        'SELECT id, name, stars, total_orders, level, bank_details FROM workers ORDER BY stars DESC'
      );
      return res.status(200).json(result.rows);
    }

    // POST — вход / регистрация
    if (req.method === 'POST') {
      const { password, telegram_id, first_name } = req.body;
      const PIN = process.env.WORKER_PIN || '2026';

      if (password !== PIN) {
        return res.status(401).json({ ok: false, error: 'Неверный код' });
      }

      const workerId = String(telegram_id);
      let result = await pool.query('SELECT * FROM workers WHERE id = $1', [workerId]);

      if (result.rows.length === 0) {
        await pool.query(
          `INSERT INTO workers (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [workerId, first_name || 'Рабочий']
        );
        result = await pool.query('SELECT * FROM workers WHERE id = $1', [workerId]);

        try {
          await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            chat_id: ADMIN_ID,
            text: `👷 <b>Новый рабочий зарегистрирован!</b>\nИмя: ${first_name}\nID: <code>${telegram_id}</code>`,
            parse_mode: 'HTML'
          });
        } catch (e) {}
      }

      return res.status(200).json({ ok: true, worker: result.rows[0] });
    }

  } catch (err) {
    console.error('worker-auth error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
