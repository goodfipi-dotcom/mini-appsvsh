import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MASTER_CODE = "2026"; // Всегда в кавычках

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Принудительно очищаем входящие данные
  const telegram_id = req.body.telegram_id;
  const password = req.body.password ? req.body.password.toString().trim() : "";
  const first_name = req.body.first_name || "Новый боец";

  try {
    // 1. Сначала ищем по Telegram ID (авто-вход)
    let { data: worker } = await supabase
      .from('workers')
      .select('*')
      .eq('telegram_id', telegram_id)
      .single();

    if (worker) {
      return res.status(200).json({ ok: true, worker });
    }

    // 2. Если ID не найден, проверяем мастер-код
    if (password === MASTER_CODE) {
      const { data: newWorker, error: createError } = await supabase
        .from('workers')
        .insert([{ 
          name: first_name, 
          telegram_id: telegram_id,
          auth_code: MASTER_CODE,
          total_hours: 0,
          total_earnings: 0,
          rating: 5.0,
          level: 'Новичок'
        }])
        .select()
        .single();

      if (createError) throw createError;
      return res.status(200).json({ ok: true, worker: newWorker });
    }

    // Если ничего не подошло
    return res.status(401).json({ ok: false, error: 'Неверный код доступа' });

  } catch (e) {
    console.error("Auth Error:", e.message);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
}
