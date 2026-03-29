import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initClientDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE,
      name TEXT DEFAULT '',
      city TEXT DEFAULT 'Октябрьский',
      ref_code TEXT UNIQUE,
      referred_by TEXT DEFAULT '',
      stars INTEGER DEFAULT 0,
      total_orders INTEGER DEFAULT 0,
      total_referrals INTEGER DEFAULT 0,
      referral_orders INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      client_phone TEXT,
      client_name TEXT DEFAULT '',
      worker_name TEXT DEFAULT '',
      rating INTEGER DEFAULT 5,
      text TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

function generateRefCode(name) {
  const letters = (name || 'VSH').replace(/[^a-zA-Zа-яА-Я0-9]/g, '').slice(0, 3).toUpperCase();
  const digits = Math.random().toString(36).substring(2, 6).toUpperCase();
  return letters + digits;
}

// Уровни лояльности
const LEVELS = [
  { min: 0,   icon: '🆕', name: 'Новичок' },
  { min: 5,   icon: '👍', name: 'Знакомый клиент' },
  { min: 15,  icon: '⭐', name: 'Активный клиент' },
  { min: 30,  icon: '🌟', name: 'Постоянный клиент' },
  { min: 50,  icon: '🔥', name: 'Лояльный клиент' },
  { min: 100, icon: '💎', name: 'VIP-клиент' },
];

function getLevel(stars) {
  let level = LEVELS[0];
  for (const l of LEVELS) if (stars >= l.min) level = l;
  return level;
}

function formatClient(row) {
  const stars = row.stars || 0;
  const level = getLevel(stars);
  return {
    ...row,
    level_icon: level.icon,
    level_name: level.name,
    stars: stars,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initClientDB();

    // ── GET — профиль клиента ──
    if (req.method === 'GET') {
      const { phone, action, ref_code } = req.query;

      // Профиль по телефону
      if (phone || action === 'profile') {
        const p = (phone || '').replace(/\D/g, '');
        if (!p) return res.status(400).json({ error: 'Missing phone' });
        const result = await pool.query('SELECT * FROM clients WHERE phone = $1', [p]);
        if (result.rows.length === 0) return res.status(200).json({ success: false, error: 'not_found' });
        return res.status(200).json({ success: true, client: formatClient(result.rows[0]) });
      }

      // Проверить реф-код
      if (ref_code) {
        const result = await pool.query('SELECT name FROM clients WHERE ref_code = $1', [ref_code]);
        return res.status(200).json({ valid: result.rows.length > 0, referrer: result.rows[0]?.name || '' });
      }

      return res.status(400).json({ error: 'Missing params' });
    }

    // ── POST ──
    if (req.method === 'POST') {
      const { action, phone, name, ref, city, client_phone, client_name, rating, text } = req.body;

      // Регистрация / получение клиента
      if (action === 'get_or_create' || !action) {
        if (!phone) return res.status(400).json({ error: 'Missing phone' });
        const cleanPhone = phone.replace(/\D/g, '');

        // Ищем существующего
        const existing = await pool.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);
        if (existing.rows.length > 0) {
          // Обновляем заказы и баллы
          await pool.query(
            'UPDATE clients SET total_orders = total_orders + 1, stars = stars + 5 WHERE phone = $1',
            [cleanPhone]
          );
          // Начисляем баллы пригласившему
          const client = existing.rows[0];
          if (client.referred_by) {
            await pool.query(
              'UPDATE clients SET referral_orders = referral_orders + 1, stars = stars + 3 WHERE ref_code = $1',
              [client.referred_by]
            );
          }
          const updated = await pool.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);
          return res.status(200).json({ success: true, client: formatClient(updated.rows[0]), isNew: false });
        }

        // Новый клиент
        const refCode = generateRefCode(name);
        await pool.query(
          `INSERT INTO clients (phone, name, city, ref_code, referred_by, total_orders, stars)
           VALUES ($1, $2, $3, $4, $5, 1, 5)`,
          [cleanPhone, name || '', city || 'Октябрьский', refCode, ref || '']
        );

        // Начисляем баллы пригласившему за нового клиента
        if (ref) {
          await pool.query(
            'UPDATE clients SET total_referrals = total_referrals + 1, stars = stars + 2 WHERE ref_code = $1',
            [ref]
          );
        }

        const newClient = await pool.query('SELECT * FROM clients WHERE phone = $1', [cleanPhone]);
        return res.status(200).json({ success: true, client: formatClient(newClient.rows[0]), isNew: true });
      }

      // Отзыв
      if (action === 'review') {
        const cp = (client_phone || '').replace(/\D/g, '');
        if (!cp || !rating) return res.status(400).json({ error: 'Missing fields' });

        await pool.query(
          `INSERT INTO reviews (client_phone, client_name, rating, text, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [cp, client_name || '', parseInt(rating), text || '']
        );
        // +2 балла за отзыв
        await pool.query('UPDATE clients SET stars = stars + 2 WHERE phone = $1', [cp]);

        return res.status(200).json({ success: true, message: 'Отзыв отправлен на модерацию' });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Client API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
