import pg from 'pg';
import axios from 'axios';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const BOT_API  = `https://api.telegram.org/bot${TG_TOKEN}`;

const RANKS = [
  { name: 'Новобранец', min: 0   },
  { name: 'Рабочий',    min: 6   },
  { name: 'Мастер',     min: 16  },
  { name: 'Прораб',     min: 31  },
  { name: 'Бригадир',   min: 51  },
  { name: 'Легенда',    min: 81  },
];

function getRankName(stars) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (stars >= r.min) rank = r;
  }
  return rank.name;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, order_id, worker_id, bank_details, stars } = req.body;

  try {

    // ── ПРИНЯТЬ ЗАКАЗ ──────────────────────────────
    if (action === 'accept_order') {
      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
      if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

      const order = orderRes.rows[0];
      if (order.status !== 'published') return res.status(400).json({ error: 'Заказ уже недоступен' });

      const acceptedBy = order.accepted_by || [];
      if (acceptedBy.includes(String(worker_id))) {
        return res.status(400).json({ error: 'Вы уже приняли этот заказ' });
      }

      const newAccepted = [...acceptedBy, String(worker_id)];
      const newStatus = newAccepted.length >= order.workers_needed ? 'in_progress' : 'published';

      await pool.query(
        'UPDATE orders SET accepted_by = $1::TEXT[], status = $2 WHERE id = $3',
        [newAccepted, newStatus, order_id]
      );

      // Обновляем счётчик заказов рабочего
      await pool.query(
        'UPDATE workers SET total_orders = total_orders + 1 WHERE id = $1',
        [String(worker_id)]
      );

      // Имя рабочего
      const workerRes = await pool.query('SELECT name FROM workers WHERE id = $1', [String(worker_id)]);
      const workerName = workerRes.rows[0]?.name || `ID:${worker_id}`;

      // Уведомление админу
      try {
        await axios.post(`${BOT_API}/sendMessage`, {
          chat_id: ADMIN_ID,
          text: `✅ <b>Заказ #${order_id} принят!</b>\n👷 ${workerName}\n🔧 ${order.task || order.service}\n📍 ${order.address}`,
          parse_mode: 'HTML'
        });
        if (newStatus === 'in_progress') {
          await axios.post(`${BOT_API}/sendMessage`, {
            chat_id: ADMIN_ID,
            text: `🚀 <b>Заказ #${order_id} укомплектован!</b> Бригада собрана.`,
            parse_mode: 'HTML'
          });
        }
      } catch (e) {}

      return res.status(200).json({ success: true, phone: order.phone, address: order.address });
    }

    // ── СОХРАНИТЬ РЕКВИЗИТЫ ────────────────────────
    if (action === 'save_details') {
      await pool.query(
        'UPDATE workers SET bank_details = $1 WHERE id = $2',
        [bank_details || '', String(worker_id)]
      );
      return res.status(200).json({ success: true });
    }

    // ── ВЫДАТЬ ЗВЁЗДЫ (только админ) ──────────────
    if (action === 'give_stars') {
      const starsCount = parseInt(stars) || 0;
      if (starsCount < 1 || starsCount > 5) {
        return res.status(400).json({ error: 'Неверное количество звёзд' });
      }

      // Обновляем звёзды
      const updRes = await pool.query(
        `UPDATE workers
         SET stars = stars + $1,
             level = $2
         WHERE id = $3
         RETURNING name, stars`,
        [starsCount, getRankName(starsCount), String(worker_id)]
      );

      if (updRes.rows.length === 0) {
        return res.status(404).json({ error: 'Рабочий не найден' });
      }

      const worker = updRes.rows[0];
      const newTotal = worker.stars;
      const rankName = getRankName(newTotal);

      // Обновляем звание
      await pool.query(
        'UPDATE workers SET level = $1 WHERE id = $2',
        [rankName, String(worker_id)]
      );

      // Уведомление рабочему
      try {
        await axios.post(`${BOT_API}/sendMessage`, {
          chat_id: String(worker_id),
          text: `⭐ <b>Вы получили +${starsCount} звёзд!</b>\n\nВсего звёзд: ${newTotal}⭐\nЗвание: ${rankName}\n\nТак держать! 💪`,
          parse_mode: 'HTML'
        });
      } catch (e) {}

      return res.status(200).json({ success: true, newTotal, rankName });
    }

    return res.status(400).json({ error: 'Неизвестное действие' });

  } catch (err) {
    console.error('worker-actions error:', err);
    return res.status(500).json({ error: err.message });
  }
}
