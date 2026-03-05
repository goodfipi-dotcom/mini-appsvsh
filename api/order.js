import { createClient } from '@supabase/supabase-js'

// Подключение к Supabase через переменные окружения
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// Для Telegram уведомлений (опционально)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, address, task, phone } = req.body;

  if (!address || !task || !phone) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  // Сохраняем заказ в Supabase
  const { data, error } = await supabase
    .from('orders')
    .insert([{ 
      name, 
      phone, 
      service: task, 
      date: new Date().toISOString(), 
      status: 'new' 
    }]);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Отправка уведомления в Telegram (если настроено)
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `Новый заказ VSH SERVICE:\nИмя: ${name}\nТел: ${phone}\nЗадача: ${task}\nАдрес: ${address}`
        })
      });
    } catch (e) {
      console.error("Telegram error:", e);
    }
  }

  res.status(200).json({ success: true });
}
