// api/order.js
import { createClient } from '@supabase/supabase-js';

// Подключение к Supabase через переменные окружения Vercel
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL или SUPABASE_KEY не заданы в Vercel Environment Variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Для Telegram уведомлений (опционально)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, address, task, phone } = req.body || {};

    if (!address || !task || !phone) {
      return res.status(400).json({ error: 'Заполните адрес, задачу и номер телефона' });
    }

    console.log('Новый заказ:', { name, address, task, phone });

    // Сохраняем заказ в Supabase
    const { data, error } = await supabase
      .from('orders')
      .insert([
        {
          name: name || null,
          phone: phone || null,
          service: task || null,
          date: new Date().toISOString(),
          status: 'new',
        },
      ]);

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Ошибка сохранения заказа в базу' });
    }

    // Отправка уведомления в Telegram (если настроено)
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: `Новый заказ VSH SERVICE:\nИмя: ${name}\nТел: ${phone}\nЗадача: ${task}\nАдрес: ${address}`,
          }),
        });
      } catch (e) {
        console.error('Telegram error:', e);
        // не роняем функцию
      }
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('Unexpected error in /api/order:', e);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
