import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MASTER_CODE = "2026";

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegram_id, password, first_name } = req.body;

  // Если Telegram ID не пришел (например, открыли в обычном браузере, а не в ТГ)
  if (!telegram_id) {
    return res.status(400).json({ ok: false, error: 'Зайдите через Telegram' });
  }

  const cleanPass = password ? password.toString().trim() : "";

  try {
    // 1. Проверяем, есть ли такой рабочий
    let { data: worker } = await supabase
      .from('workers')
      .select('*')
      .eq('telegram_id', telegram_id)
      .single();

    if (worker) return res.status(200).json({ ok: true, worker });

    // 2. Если новый — проверяем мастер-код
    if (cleanPass === MASTER_CODE) {
      const { data: newWorker, error: createError } = await supabase
        .from('workers')
        .insert([{ 
          name: first_name || 'Новый боец', 
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

    return res.status(401).json({ ok: false, error: 'Неверный код доступа' });

  } catch (e) {
    console.error("Auth Error:", e.message);
    return res.status(500).json({ ok: false, error: 'Ошибка базы данных' });
  }
}
