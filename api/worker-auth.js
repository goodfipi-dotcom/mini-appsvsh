import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const WORKER_PIN = process.env.WORKER_PIN || '2026';

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT,
      telegram_username TEXT DEFAULT '',
      stars INTEGER DEFAULT 0,
      total_orders INTEGER DEFAULT 0,
      total_earnings INTEGER DEFAULT 0,
      bank_details TEXT DEFAULT '',
      level TEXT DEFAULT 'Новобранец',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Миграция: добавляем telegram_username если нет
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'workers'
  `);
  const existing = cols.rows.map(r => r.column_name);
  if (!existing.includes('telegram_username')) {
    await pool.query(`ALTER TABLE workers ADD COLUMN telegram_username TEXT DEFAULT ''`);
  }
  if (!existing.includes('stars')) {
    await pool.query(`ALTER TABLE workers ADD COLUMN stars INTEGER DEFAULT 0`);
  }
}

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['https://mini-appsvsh.vercel.app'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDB();

    // GET — список рабочих (лидерборд)
    if (req.method === 'GET') {
      const result = await pool.query(
        'SELECT id, name, telegram_username, stars, total_orders, total_earnings, created_at FROM workers ORDER BY stars DESC, total_orders DESC LIMIT 50'
      );
      return res.status(200).json(result.rows);
    }

    // DELETE — удалить рабочего (только админ)
    if (req.method === 'DELETE') {
      const secret = req.headers['x-admin-secret'] || '';
      if (ADMIN_SECRET && secret !== ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing worker id' });
      await pool.query('DELETE FROM workers WHERE id = $1', [id]);
      return res.status(200).json({ success: true, ok: true, deleted: id });
    }

    // POST — вход / регистрация
    if (req.method === 'POST') {
      const { password, telegram_id, first_name, telegram_username } = req.body;

      if (password !== WORKER_PIN) {
        return res.status(403).json({ error: 'Wrong PIN' });
      }

      if (!telegram_id) {
        return res.status(400).json({ error: 'Missing telegram_id' });
      }

      const wid = String(telegram_id);
      const existing = await pool.query('SELECT * FROM workers WHERE id = $1', [wid]);

      if (existing.rows.length > 0) {
        // Обновляем имя и username при каждом входе
        if (first_name || telegram_username) {
          await pool.query(
            'UPDATE workers SET name = COALESCE(NULLIF($1, \'\'), name), telegram_username = COALESCE(NULLIF($2, \'\'), telegram_username) WHERE id = $3',
            [first_name || '', telegram_username || '', wid]
          );
        }
        const updated = await pool.query('SELECT * FROM workers WHERE id = $1', [wid]);
        return res.status(200).json({ ok: true, worker: updated.rows[0] });
      }

      // Новый рабочий
      await pool.query(
        'INSERT INTO workers (id, name, telegram_username, stars, total_orders) VALUES ($1, $2, $3, 0, 0)',
        [wid, first_name || 'Рабочий', telegram_username || '']
      );
      const newWorker = await pool.query('SELECT * FROM workers WHERE id = $1', [wid]);
      return res.status(200).json({ ok: true, worker: newWorker.rows[0], isNew: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Worker auth error:', err);
    return res.status(500).json({ error: err.message });
  }
}
