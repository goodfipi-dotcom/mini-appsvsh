import { query, queryOne, normalizePhone } from './_db.js';
import { authenticate, denyResponse } from './_auth.js';
import { sendTelegram, broadcast, findRecipientsForOrder, logOrderEvent } from './_notify.js';

const MINI_APP_URL = process.env.MINI_APP_URL || 'https://mini-appsvsh.vercel.app';

const ALLOWED_ORIGINS = [
  'https://mini-appsvsh.vercel.app',
  'https://goodfipi-dotcom.github.io',
  'http://localhost:3000'
];

// Ограничение частоты: в памяти, сбрасывается при холодном старте — достаточно против ботов
const rateLimitMap = new Map();
function checkRateLimit(key, maxPerHour = 3) {
  const now = Date.now();
  const windowMs = 3600000;
  const timestamps = (rateLimitMap.get(key) || []).filter(t => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(key, timestamps);
  return timestamps.length <= maxPerHour;
}

function sanitize(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').replace(/['"`;\\]/g, '').trim().slice(0, 500);
}

function isValidPhone(phone) {
  const clean = normalizePhone(phone);
  return clean.length >= 10 && clean.length <= 15;
}

const ALLOWED_SOURCES = ['avito', 'direct', 'telegram', 'referral', 'organic', 'social', 'admin'];
function normalizeSource(src) {
  const s = String(src || '').toLowerCase().trim();
  return ALLOWED_SOURCES.includes(s) ? s : 'direct';
}

function orderCard(order, title) {
  return `${title}\n\n` +
    `📍 ${order.city || 'Октябрьский'}\n` +
    `🔧 ${order.service || order.task || 'Задача'}\n` +
    `🏠 ${order.address || ''}\n` +
    `👷 Рабочих: ${order.workers_needed || 1}\n` +
    (order.comment ? `💬 ${order.comment}\n` : '') +
    (order.worker_price ? `💰 Оплата рабочему: ${order.worker_price} ₽\n` : '');
}

const openAppKeyboard = {
  inline_keyboard: [[{ text: '🚀 Открыть VSH Service', web_app: { url: MINI_APP_URL } }]]
};

/** Находит или создаёт клиента по телефону. Возвращает id или null. */
async function upsertClient({ phone, name, city, source, sourceDetail }) {
  const clean = normalizePhone(phone);
  if (!clean) return null;

  const existing = await queryOne(
    `SELECT id FROM clients WHERE REGEXP_REPLACE(COALESCE(phone,''), '\\D', '', 'g') = $1 LIMIT 1`,
    [clean]
  );

  if (existing) {
    await query(
      `UPDATE clients SET total_orders = COALESCE(total_orders,0) + 1,
                          last_activity = NOW(),
                          name = CASE WHEN COALESCE(name,'') = '' THEN $2 ELSE name END
       WHERE id = $1`,
      [existing.id, name || '']
    );
    return existing.id;
  }

  const created = await queryOne(
    `INSERT INTO clients (phone, name, city, source, source_detail, total_orders, last_activity)
     VALUES ($1,$2,$3,$4,$5,1,NOW()) RETURNING id`,
    [clean, name || '', city || 'Октябрьский', source, sourceDetail || '']
  );
  return created?.id || null;
}

async function resolveCityId(cityName) {
  if (!cityName) return null;
  const row = await queryOne(
    `SELECT id FROM cities WHERE LOWER(name) = LOWER($1) OR slug = LOWER($1) LIMIT 1`,
    [String(cityName).trim()]
  );
  return row?.id || null;
}

/** Рассылка заявки подходящим рабочим + отчёт админу о недоставленных */
async function publishToWorkers(order) {
  const recipients = await findRecipientsForOrder(order);

  if (recipients.length === 0) {
    const adminId = String(process.env.ADMIN_ID || '').split(',')[0].trim();
    if (adminId) {
      await sendTelegram(adminId,
        `⚠️ Заявка №${order.id} опубликована, но <b>подходящих рабочих не найдено</b>.\n` +
        `Проверьте: активные рабочие, их города и специализации.`,
        { orderId: order.id, type: 'no_recipients', role: 'admin' });
    }
    return { sent: 0, failed: 0 };
  }

  const result = await broadcast(
    recipients,
    orderCard(order, `🔥 <b>НОВАЯ ЗАЯВКА №${order.id}</b>`) + `\nОткройте приложение, чтобы принять заказ 👇`,
    { keyboard: openAppKeyboard, orderId: order.id, type: 'new_order', role: 'worker' }
  );

  await logOrderEvent(order.id, 'published', 'system', 'system',
    `разослано ${result.sent} из ${recipients.length}`);

  return result;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, X-Admin-Secret');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Изменение и удаление — только администратор ──
    if (req.method === 'DELETE' || req.method === 'PATCH') {
      const serverKey = process.env.ADMIN_SECRET || '';
      const providedKey = req.headers['x-admin-secret'] || '';
      const isServerCall = serverKey && providedKey === serverKey; // для бота на сервере

      if (!isServerCall) {
        const auth = await authenticate(req, { requireAdmin: true });
        if (!auth.ok) return denyResponse(res, auth);
      }
    }

    // ── Список заявок ──
    if (req.method === 'GET') {
      const { status, client_id, worker_id, limit } = req.query;
      const conditions = [];
      const params = [];

      if (status)    { params.push(status);    conditions.push(`status = $${params.length}`); }
      if (client_id) { params.push(client_id); conditions.push(`client_id = $${params.length}`); }
      if (worker_id) { params.push(String(worker_id)); conditions.push(`worker_id = $${params.length}`); }

      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const max = Math.min(Number(limit) || 200, 500);

      const { rows } = await query(
        `SELECT * FROM orders${where} ORDER BY created_at DESC LIMIT ${max}`,
        params
      );
      return res.status(200).json(rows);
    }

    // ── Удаление заявки ──
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Не указан номер заявки' });
      await query('DELETE FROM orders WHERE id = $1', [id]);
      await logOrderEvent(id, 'deleted', 'admin', 'admin');
      return res.status(200).json({ success: true, deleted: id });
    }

    // ── Изменение заявки ──
    if (req.method === 'PATCH') {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: 'Не указан номер заявки' });

      const editable = ['service', 'task', 'address', 'phone', 'city', 'comment',
                        'workers_needed', 'status', 'client_price', 'worker_price',
                        'margin', 'service_id'];
      const fields = [];
      const values = [];

      for (const key of editable) {
        if (b[key] !== undefined) {
          values.push(b[key]);
          fields.push(`${key} = $${values.length}`);
        }
      }
      if (b.city !== undefined) {
        const cityId = await resolveCityId(b.city);
        if (cityId) { values.push(cityId); fields.push(`city_id = $${values.length}`); }
      }
      if (b.status === 'completed') fields.push(`completed_at = NOW()`);
      if (!fields.length) return res.status(400).json({ error: 'Нечего обновлять' });

      fields.push(`updated_at = NOW()`);
      values.push(b.id);

      const updated = await queryOne(
        `UPDATE orders SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (!updated) return res.status(404).json({ error: 'Заявка не найдена' });

      let delivery = null;
      if (b.status === 'published') {
        delivery = await publishToWorkers(updated);
      } else if (b.status) {
        await logOrderEvent(updated.id, b.status, 'admin', 'admin');
      }

      return res.status(200).json({ success: true, order: updated, delivery });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // ── Рабочий принимает заявку (атомарно) ──
      if (body.action === 'accept_order') {
        let workerId;
        let workerRecord = null;

        // Бот принимает заявку от имени рабочего, нажавшего кнопку в Telegram.
        // Ключ бота хранится на сервере, поэтому подменить рабочего снаружи нельзя.
        const serverKey = process.env.ADMIN_SECRET || '';
        const providedKey = req.headers['x-admin-secret'] || '';
        const fromBot = serverKey && providedKey === serverKey && body.worker_id;

        if (fromBot) {
          workerId = String(body.worker_id);
          workerRecord = await queryOne(
            `SELECT id, name, active FROM workers WHERE id = $1`, [workerId]
          );
          if (!workerRecord) {
            return res.status(403).json({ error: 'not_registered', message: 'Рабочий не найден' });
          }
          if (workerRecord.active === false) {
            return res.status(403).json({ error: 'access_revoked', message: 'Доступ отключён диспетчером' });
          }
        } else {
          const auth = await authenticate(req, { requireWorker: true });
          if (!auth.ok) return denyResponse(res, auth);
          workerId = auth.telegramId; // из подписи, а не из тела — иначе можно принять за другого
          workerRecord = auth.worker;
        }

        const { order_id } = body;
        if (!order_id) return res.status(400).json({ error: 'Не указан номер заявки' });

        const order = await queryOne(
          `UPDATE orders
              SET status = 'accepted',
                  worker_id = $2,
                  accepted_by = array_append(accepted_by, $2::text),
                  updated_at = NOW()
            WHERE id = $1 AND status = 'published'
          RETURNING *`,
          [order_id, workerId]
        );

        if (!order) {
          return res.status(409).json({ error: 'already_taken', message: 'Заявка уже принята другим рабочим' });
        }

        await query(`UPDATE workers SET status = 'busy' WHERE id = $1`, [workerId]).catch(() => {});
        await logOrderEvent(order.id, 'accepted', workerId, 'worker');

        const workerName = workerRecord?.name || workerId;
        const adminId = String(process.env.ADMIN_ID || '').split(',')[0].trim();
        if (adminId) {
          await sendTelegram(adminId,
            `👷 <b>Заявка №${order.id} принята</b>\n\n` +
            `Рабочий: ${workerName} (${workerId})\n` +
            `🔧 ${order.service || order.task}\n📍 ${order.city}, ${order.address}\n` +
            `📞 Клиент: ${order.phone}`,
            { orderId: order.id, type: 'accepted', role: 'admin' });
        }

        return res.status(200).json({ success: true, phone: order.phone, order });
      }

      const {
        name, address, task, phone, source, source_detail, service,
        city, client_price, worker_price, margin, comment, workers_needed, ref
      } = body;

      // ── Заявка, созданная администратором вручную ──
      if (source === 'admin') {
        const auth = await authenticate(req, { requireAdmin: true });
        if (!auth.ok) return denyResponse(res, auth);

        const cityName = sanitize(city) || 'Октябрьский';
        const cityId = await resolveCityId(cityName);
        const clientId = await upsertClient({
          phone, name, city: cityName, source: 'admin', sourceDetail: source_detail
        });

        const created = await queryOne(
          `INSERT INTO orders (service, task, address, phone, city, city_id, client_id,
                               client_price, worker_price, margin, workers_needed, comment,
                               source, status)
           VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'admin','published') RETURNING *`,
          [sanitize(service) || sanitize(task) || '', sanitize(address), normalizePhone(phone),
           cityName, cityId, clientId, client_price || 0, worker_price || 0, margin || 0,
           workers_needed || 1, sanitize(comment)]
        );

        await logOrderEvent(created.id, 'created', auth.telegramId, 'admin');
        const delivery = await publishToWorkers(created);

        return res.status(200).json({ success: true, orderId: created.id, delivery });
      }

      // ── Заявка от заказчика (сайт, открытый доступ) ──
      if (!task || !sanitize(task)) return res.status(400).json({ error: 'Опишите задачу' });
      if (!isValidPhone(phone))     return res.status(400).json({ error: 'Введите корректный номер телефона' });
      if (!address || !sanitize(address)) return res.status(400).json({ error: 'Укажите адрес' });

      const cleanPhone = normalizePhone(phone);
      if (!checkRateLimit('phone:' + cleanPhone, 3)) {
        return res.status(429).json({ error: 'Слишком много заявок. Попробуйте через час.' });
      }

      const safeName = sanitize(name);
      const safeTask = sanitize(task);
      const safeAddress = sanitize(address);
      const safeCity = sanitize(city) || 'Октябрьский';
      const src = normalizeSource(source);
      const srcDetail = sanitize(source_detail) || (ref ? `ref:${sanitize(ref)}` : '');

      const cityId = await resolveCityId(safeCity);
      const clientId = await upsertClient({
        phone: cleanPhone, name: safeName, city: safeCity, source: src, sourceDetail: srcDetail
      });

      const created = await queryOne(
        `INSERT INTO orders (name, address, task, service, phone, city, city_id, client_id,
                             source, source_detail, referral_code, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'waiting_admin') RETURNING *`,
        [safeName, safeAddress, safeTask, sanitize(service) || safeTask, cleanPhone,
         safeCity, cityId, clientId, src, srcDetail, sanitize(ref)]
      );

      await logOrderEvent(created.id, 'created', cleanPhone, 'client', `источник: ${src}`);

      const adminId = String(process.env.ADMIN_ID || '').split(',')[0].trim();
      if (adminId) {
        await sendTelegram(adminId,
          `🔔 <b>НОВАЯ ЗАЯВКА №${created.id} С САЙТА</b>\n\n` +
          `👤 ${safeName || 'без имени'}\n` +
          `📍 ${safeCity}, ${safeAddress}\n` +
          `🔧 ${safeTask}\n` +
          `📞 ${cleanPhone}\n` +
          `📊 Источник: ${src}${srcDetail ? ` (${srcDetail})` : ''}`,
          {
            keyboard: { inline_keyboard: [[
              { text: '✅ ОДОБРИТЬ', callback_data: `approve:${created.id}` },
              { text: '❌ ОТКЛОНИТЬ', callback_data: `reject:${created.id}` }
            ]] },
            orderId: created.id,
            type: 'new_order',
            role: 'admin'
          });
      }

      return res.status(200).json({ success: true, orderId: created.id });
    }

    return res.status(405).json({ error: 'Метод не поддерживается' });
  } catch (err) {
    console.error('[order] ошибка:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}
