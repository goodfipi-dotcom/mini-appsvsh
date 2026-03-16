const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const BOT_API = `https://api.telegram.org/bot${TG_TOKEN}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).end();

  const { action, order_id, worker_id, bank_details } = req.body;

  try {
    if (action === 'accept_order') {
      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
      if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

      const order = orderRes.rows[0];
      if (order.status !== 'published') return res.status(400).json({ error: 'Заказ уже недоступен' });

      const acceptedBy = order.accepted_by || [];
      if (acceptedBy.includes(String(worker_id))) {
        return res.status(400).json({ error: 'Ты уже принял этот заказ' });
      }

      // Добавляем рабочего
      const newAccepted = [...acceptedBy, String(worker_id)];
      let newStatus = order.status;

      if (newAccepted.length >= order.workers_needed) {
        newStatus = 'in_progress';
      }

      await pool.query(
        'UPDATE orders SET accepted_by = $1, status = $2 WHERE id = $3',
        [newAccepted, newStatus, order_id]
      );

      // Получаем имя рабочего
      const workerRes = await pool.query('SELECT name FROM workers WHERE id = $1', [String(worker_id)]);
      const workerName = workerRes.rows[0]?.name || `ID:${worker_id}`;

      // Уведомление тебе
      await axios.post(`${BOT_API}/sendMessage`, {
        chat_id: ADMIN_ID,
        text: `✅ <b>Заказ №${order_id} принят!</b>\n👷 ${workerName}\n🔧 ${order.task || order.service}\n📍 ${order.address}`,
        parse_mode: 'HTML'
      });

      if (newStatus === 'in_progress') {
        await axios.post(`${BOT_API}/sendMessage`, {
          chat_id: ADMIN_ID,
          text: `🚀 <b>Заказ №${order_id} укомплектован!</b> Бригада собрана.`,
          parse_mode: 'HTML'
        });
      }

      return res.status(200).json({ success: true, address: order.address });
    }

    if (action === 'save_details') {
      await pool.query('UPDATE workers SET bank_details = $1 WHERE id = $2', [bank_details, String(worker_id)]);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Неизвестное действие' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
