import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { service, address, comment, client_price, worker_price, margin, workers_needed } = req.body;

  try {
    // 1. Сохраняем в базу
    const { data: order, error: dbError } = await supabase
      .from('orders')
      .insert([{
        task: service,
        address,
        comment,
        client_price,
        worker_price,
        margin,
        workers_needed,
        status: 'published'
      }])
      .select().single();

    if (dbError) throw dbError;

    // 2. Достаем ID всех живых рабочих
    const { data: workers } = await supabase.from('workers').select('id').eq('is_banned', false);

    // 3. Рассылаем уведомление в Telegram
    if (workers && workers.length > 0) {
      const message = `🛠 **НОВЫЙ ЗАКАЗ!**\n\n` +
                      `📝 Задача: ${service}\n` +
                      `📍 Адрес: ${address}\n` +
                      `💰 Оплата: **${worker_price} ₽/час**\n` +
                      `👥 Нужно: ${workers_needed} чел.\n\n` +
                      `Заходи в приложение, чтобы успеть забрать!`;

      await Promise.all(workers.map(w => 
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: w.id,
            text: message,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: "🚀 ОТКРЫТЬ ПРИЛОЖЕНИЕ", url: "https://t.me/ТВОЙ_ЮЗЕРНЕЙМ_БОТА/app" }]]
            }
          })
        })
      ));
    }

    return res.status(200).json({ success: true, order_id: order.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
