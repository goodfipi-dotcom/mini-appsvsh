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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  res.status(200).end(); // Отвечаем Telegram сразу

  const update = req.body;

  try {
    // Нажатие inline-кнопок
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const chatId = String(cb.message.chat.id);

      // Подтверждаем нажатие кнопки
      await axios.post(`${BOT_API}/answerCallbackQuery`, { callback_query_id: cb.id });

      if (data.startsWith('approve_')) {
        const orderId = parseInt(data.split('_')[1]);
        const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (orderRes.rows.length === 0) return;

        const order = orderRes.rows[0];
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['waiting_price', orderId]);

        await sendTG(chatId,
          `📋 <b>Заявка №${orderId}</b>\n` +
          `📍 ${order.address}\n🔧 ${order.task}\n\n` +
          `Ответь на это сообщение в формате:\n` +
          `<code>цена_клиента маржа количество_рабочих</code>\n\n` +
          `Пример: <code>1500 200 2</code>\n` +
          `(клиент 1500₽, твоя маржа 200₽, нужно 2 рабочих)`
        );

      } else if (data.startsWith('reject_')) {
        const orderId = parseInt(data.split('_')[1]);
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['rejected', orderId]);
        await sendTG(chatId, `❌ Заявка №${orderId} отклонена`);
      }
    }

    // Текстовое сообщение от тебя (установка цены)
    if (update.message && String(update.message.chat.id) === ADMIN_ID) {
      const text = (update.message.text || '').trim();
      const parts = text.split(' ');

      if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        // Ищем заказ в статусе waiting_price
        const orderRes = await pool.query("SELECT * FROM orders WHERE status = 'waiting_price' ORDER BY created_at DESC LIMIT 1");
        if (orderRes.rows.length === 0) return;

        const order = orderRes.rows[0];
        const clientPrice = parseInt(parts[0]);
        const margin = parseInt(parts[1]);
        const workersNeeded = parseInt(parts[2]);
        const workerPrice = clientPrice - margin;

        await pool.query(
          'UPDATE orders SET client_price=$1, margin=$2, worker_price=$3, workers_needed=$4, status=$5 WHERE id=$6',
          [clientPrice, margin, workerPrice, workersNeeded, 'published', order.id]
        );

        // Рассылаем всем рабочим
        const workersResult = await pool.query('SELECT id FROM workers');
        for (const worker of workersResult.rows) {
          try {
            await sendTG(worker.id,
              `🔥 <b>НОВЫЙ ЗАКАЗ №${order.id}</b>\n\n` +
              `🔧 ${order.task}\n💰 Ставка: ${workerPrice}₽\n\n` +
              `Открой приложение чтобы принять заказ!`
            );
          } catch (e) { /* игнорируем если рабочий заблокировал бота */ }
        }

        await sendTG(ADMIN_ID,
          `✅ <b>Заказ №${order.id} опубликован!</b>\n` +
          `Рабочим: ${workerPrice}₽ | Маржа: ${margin}₽ | Нужно: ${workersNeeded} чел.\n` +
          `Рабочих в системе: ${workersResult.rows.length}`
        );
      }
    }

  } catch (err) {
    console.error('Webhook error:', err);
  }
}
