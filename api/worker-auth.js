import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegram_id, password } = req.body;

  try {
    // 1. АВТО-ВХОД по Telegram ID
    if (telegram_id && !password) {
      const { data: worker } = await supabase
        .from('workers')
        .select('*')
        .eq('telegram_id', telegram_id)
        .single();
        
      if (worker) return res.status(200).json({ ok: true, worker });
      return res.status(401).json({ ok: false, error: 'Нужен ПИН-код' });
    }

    // 2. ВХОД ПО ПИН-КОДУ
    if (password) {
      const { data: worker, error } = await supabase
        .from('workers')
        .select('*')
        .eq('auth_code', password)
        .single();

      if (error || !worker) {
        return res.status(401).json({ ok: false, error: 'Неверный ПИН-код' });
      }

      // Привязываем Telegram ID к этому рабочему
      if (telegram_id && !worker.telegram_id) {
        await supabase.from('workers').update({ telegram_id }).eq('id', worker.id);
        worker.telegram_id = telegram_id;
      }

      return res.status(200).json({ ok: true, worker });
    }
    return res.status(400).json({ error: 'Пустой запрос' });
  } catch (e) {
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
}
