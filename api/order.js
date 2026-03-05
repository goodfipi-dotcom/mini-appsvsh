import { createClient } from '@supabase/supabase-js';

// Подключение к Supabase через переменные окружения Vercel
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// Для Telegram уведомлений
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, address, task, phone } = req.body || {};

    // Проверка обязательных полей
    if (!address || !task || !phone) {
      return res.status(400).json({ error: 'Заполните адрес, задачу и номер телефона' });
    }

    // Сохраняем заказ в Supabase
    // ВАЖНО: колонки name, phone, service, address, date, status должны быть в таблице!
    const { data, error } = await supabase
      .from('orders')
      .insert([
        {
          name: name || null,
          phone: phone || null,
          service: task || null,    // В базе это колонка service
          address: address || null,  // В базе это колонка address
          date: new Date().toISOString(),
          status: 'new',
        },
      ]);

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Ошибка сохранения заказа в базу: ' + error.message });
    }

    // Отправка уведомления в Telegram
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: `🚀 НОВЫЙ ЗАКАЗ VSH SERVICE:\n\n👤 Имя: ${name}\n📍 Адрес: ${address}\n🔧 Задача: ${task}\n📞 Тел: ${phone}`,
          }),
        });
      } catch (e) {
        console.error('Telegram error:', e);
      }
    }

    return res.status(200).json({ success: true });

  } catch (e) {
    console.error('Unexpected error:', e);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
