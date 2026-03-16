const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).end();

  const { password, telegram_id, first_name } = req.body;

  if (password !== '2026') {
    return res.status(401).json({ ok: false, error: 'Неверный код' });
  }

  try {
    // Проверяем есть ли рабочий
    let result = await pool.query('SELECT * FROM workers WHERE id = $1', [String(telegram_id)]);

    if (result.rows.length === 0) {
      // Новый рабочий — регистрируем
      await pool.query(
        'INSERT INTO workers (id, name) VALUES ($1, $2)',
        [String(telegram_id), first_name || 'Рабочий']
      );
      result = await pool.query('SELECT * FROM workers WHERE id = $1', [String(telegram_id)]);

      // Уведомление тебе
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: ADMIN_ID,
        text: `👷 <b>Новый рабочий!</b>\nИмя: ${first_name}\nTG ID: ${telegram_id}`,
        parse_mode: 'HTML'
      });
    }

    return res.status(200).json({ ok: true, worker: result.rows[0] });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
