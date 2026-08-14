// Вход рабочего. Раньше: общий ПИН, который лежал в открытом HTML.
// Теперь: личность подтверждает подпись Telegram, а ПИН — только код приглашения при первой регистрации,
// и сверяется он на сервере.
import { query, queryOne } from './_db.js';
import { authenticate, denyResponse } from './_auth.js';
import { sendTelegram } from './_notify.js';

const ALLOWED_ORIGINS = [
  'https://mini-appsvsh.vercel.app',
  'https://goodfipi-dotcom.github.io',
  'http://localhost:3000'
];

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, X-Admin-Secret');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Рейтинг: открытый список, без телефонов и реквизитов ──
    if (req.method === 'GET') {
      const { rows } = await query(
        `SELECT id, name, telegram_username, stars, total_orders, total_earnings, status, created_at
           FROM workers
          WHERE active = TRUE
          ORDER BY stars DESC, total_orders DESC
          LIMIT 50`
      );
      return res.status(200).json(rows);
    }

    // ── Вход в приложение ──
    if (req.method === 'POST') {
      const auth = await authenticate(req);
      if (!auth.ok) return denyResponse(res, auth);

      const { telegramId, user, isAdmin } = auth;
      const firstName = user.first_name || 'Рабочий';
      const username = user.username || '';

      let worker = auth.worker;

      // Уже в системе
      if (worker) {
        if (worker.active === false) {
          return res.status(403).json({ error: 'access_revoked', message: 'Доступ отключён. Обратитесь к диспетчеру' });
        }
        await query(
          `UPDATE workers
              SET name = COALESCE(NULLIF($2,''), name),
                  telegram_username = COALESCE(NULLIF($3,''), telegram_username),
                  last_seen = NOW()
            WHERE id = $1`,
          [telegramId, firstName, username]
        );
        worker = await queryOne('SELECT * FROM workers WHERE id = $1', [telegramId]);
        return res.status(200).json({ ok: true, worker, isAdmin });
      }

      // Кода приглашения больше нет: кто открыл приложение из бота — тот и зарегистрирован.
      // Контроль остаётся у диспетчера: любого можно отключить (active = FALSE),
      // а телефон заказчика рабочий получает только после того, как принял заявку.
      await query(
        `INSERT INTO workers (id, telegram_id, name, telegram_username, stars, total_orders, active, role, status, notify_orders, last_seen)
         VALUES ($1,$1,$2,$3,0,0,TRUE,'worker','available',TRUE,NOW())
         ON CONFLICT (id) DO NOTHING`,
        [telegramId, firstName, username]
      );
      worker = await queryOne('SELECT * FROM workers WHERE id = $1', [telegramId]);

      const adminId = String(process.env.ADMIN_ID || '').split(',')[0].trim();
      if (adminId) {
        await sendTelegram(adminId,
          `🆕 <b>Новый рабочий в системе</b>\n\n` +
          `${firstName}${username ? ` (@${username})` : ''}\nID: ${telegramId}`,
          { type: 'new_worker', role: 'admin' });
      }

      return res.status(200).json({ ok: true, worker, isNew: true, isAdmin });
    }

    // ── Управление доступом рабочего (только администратор) ──
    if (req.method === 'PATCH') {
      const auth = await authenticate(req, { requireAdmin: true });
      if (!auth.ok) return denyResponse(res, auth);

      const { id, active, role, city_id, status, notify_orders, phone } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Не указан рабочий' });

      const fields = [];
      const values = [];
      const set = (col, val) => { values.push(val); fields.push(`${col} = $${values.length}`); };

      if (active !== undefined)        set('active', !!active);
      if (role !== undefined)          set('role', role);
      if (city_id !== undefined)       set('city_id', city_id);
      if (status !== undefined)        set('status', status);
      if (notify_orders !== undefined) set('notify_orders', !!notify_orders);
      if (phone !== undefined)         set('phone', phone);

      if (!fields.length) return res.status(400).json({ error: 'Нечего обновлять' });

      values.push(String(id));
      const worker = await queryOne(
        `UPDATE workers SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (!worker) return res.status(404).json({ error: 'Рабочий не найден' });

      // Человек должен узнать, что доступ выключили или вернули
      if (active !== undefined) {
        await sendTelegram(String(id),
          active
            ? '✅ Ваш доступ к заявкам VSH Service включён.'
            : '⛔️ Ваш доступ к заявкам VSH Service отключён диспетчером.',
          { type: 'access_change', role: 'worker', alertAdminOnFail: false });
      }

      return res.status(200).json({ success: true, worker });
    }

    // ── Отключение рабочего. Запись не удаляем — история заказов должна остаться ──
    if (req.method === 'DELETE') {
      const auth = await authenticate(req, { requireAdmin: true });
      if (!auth.ok) return denyResponse(res, auth);

      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Не указан рабочий' });

      const worker = await queryOne(
        `UPDATE workers SET active = FALSE, notify_orders = FALSE WHERE id = $1 RETURNING id, name`,
        [String(id)]
      );
      if (!worker) return res.status(404).json({ error: 'Рабочий не найден' });

      return res.status(200).json({ success: true, ok: true, deactivated: worker.id });
    }

    return res.status(405).json({ error: 'Метод не поддерживается' });
  } catch (err) {
    console.error('[worker-auth] ошибка:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
