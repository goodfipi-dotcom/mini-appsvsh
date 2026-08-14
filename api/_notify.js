// Надёжная отправка в Telegram с журналом доставки.
// Раньше: fetch без проверки ответа + catch, который глотал ошибку.
// Из-за этого отозванный токен два месяца ронял ВСЕ уведомления о заявках, и никто не знал.
import { query } from './_db.js';

const API = token => `https://api.telegram.org/bot${token}`;
const MAX_ATTEMPTS = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callTelegram(method, payload) {
  const token = process.env.TG_TOKEN;
  if (!token) return { ok: false, error: 'TG_TOKEN не задан' };

  try {
    const res = await fetch(`${API(token)}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      return {
        ok: false,
        error: data.description || `HTTP ${res.status}`,
        code: data.error_code || res.status,
        retryAfter: data.parameters?.retry_after
      };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: `сеть: ${e.message}` };
  }
}

/** Ошибки, при которых повтор бессмыслен: получатель не начинал диалог, заблокировал бота и т.п. */
function isPermanent(code) {
  return code === 400 || code === 401 || code === 403;
}

/**
 * Отправляет сообщение и записывает результат в журнал notifications.
 * Никогда не бросает исключение — но и никогда не молчит о провале.
 */
export async function sendTelegram(chatId, text, {
  keyboard = null,
  parseMode = 'HTML',
  orderId = null,
  type = '',
  role = '',
  alertAdminOnFail = true
} = {}) {
  const payload = { chat_id: chatId, text, parse_mode: parseMode };
  if (keyboard) payload.reply_markup = keyboard;

  let logId = null;
  try {
    const { rows } = await query(
      `INSERT INTO notifications (order_id, recipient, recipient_role, type, status, payload)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
      [orderId, String(chatId), role, type, String(text).slice(0, 500)]
    );
    logId = rows[0]?.id;
  } catch (e) {
    console.error('[notify] журнал недоступен:', e.message);
  }

  let last = { ok: false, error: 'не отправлялось' };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await callTelegram('sendMessage', payload);

    if (last.ok) {
      if (logId) {
        await query(
          `UPDATE notifications SET status='sent', attempts=$2, sent_at=NOW(), error='' WHERE id=$1`,
          [logId, attempt]
        ).catch(() => {});
      }
      return { ok: true, attempts: attempt };
    }

    if (isPermanent(last.code)) break;
    if (attempt < MAX_ATTEMPTS) await sleep(last.retryAfter ? last.retryAfter * 1000 : attempt * 700);
  }

  console.error(`[notify] НЕ ДОСТАВЛЕНО получателю ${chatId}: ${last.error}`);

  if (logId) {
    await query(
      `UPDATE notifications SET status='failed', attempts=$2, error=$3 WHERE id=$1`,
      [logId, MAX_ATTEMPTS, String(last.error).slice(0, 500)]
    ).catch(() => {});
  }

  // Сообщаем владельцу, что уведомление не дошло — но только если сломался не его собственный канал
  if (alertAdminOnFail) {
    const adminId = String(process.env.ADMIN_ID || '').split(',')[0].trim();
    if (adminId && String(chatId) !== adminId) {
      await callTelegram('sendMessage', {
        chat_id: adminId,
        text: `⚠️ Не доставлено уведомление${orderId ? ` по заявке №${orderId}` : ''}\n` +
              `Получатель: ${chatId}\nПричина: ${last.error}`,
        parse_mode: 'HTML'
      });
    }
  }

  return { ok: false, error: last.error, attempts: MAX_ATTEMPTS };
}

/** Рассылка нескольким получателям. Возвращает сводку — сколько дошло, сколько нет. */
export async function broadcast(recipients, text, opts = {}) {
  const results = { sent: 0, failed: 0, failures: [] };

  for (const chatId of recipients) {
    const r = await sendTelegram(chatId, text, { ...opts, alertAdminOnFail: false });
    if (r.ok) results.sent++;
    else {
      results.failed++;
      results.failures.push({ chatId, error: r.error });
    }
  }

  if (results.failed > 0) {
    const adminId = String(process.env.ADMIN_ID || '').split(',')[0].trim();
    if (adminId) {
      await callTelegram('sendMessage', {
        chat_id: adminId,
        text: `⚠️ Рассылка${opts.orderId ? ` по заявке №${opts.orderId}` : ''}: ` +
              `доставлено ${results.sent}, не дошло ${results.failed}.\n` +
              results.failures.slice(0, 5).map(f => `• ${f.chatId}: ${f.error}`).join('\n')
      });
    }
  }

  return results;
}

/** Кому рассылать заявку: активные, с включёнными уведомлениями, нужного города и специализации */
export async function findRecipientsForOrder(order) {
  const conditions = ['w.active = TRUE', 'w.notify_orders = TRUE'];
  const params = [];

  if (order.city_id) {
    params.push(order.city_id);
    conditions.push(`(w.city_id IS NULL OR w.city_id = $${params.length})`);
  }

  if (order.service_id) {
    params.push(order.service_id);
    conditions.push(`(
      NOT EXISTS (SELECT 1 FROM worker_specializations ws WHERE ws.worker_id = w.id)
      OR EXISTS (SELECT 1 FROM worker_specializations ws WHERE ws.worker_id = w.id AND ws.service_id = $${params.length})
    )`);
  }

  const { rows } = await query(
    `SELECT w.id FROM workers w WHERE ${conditions.join(' AND ')}`,
    params
  );
  return rows.map(r => r.id);
}

/** Запись события в историю заказа */
export async function logOrderEvent(orderId, type, actor = 'system', actorRole = 'system', payload = '') {
  await query(
    `INSERT INTO order_events (order_id, type, actor, actor_role, payload) VALUES ($1,$2,$3,$4,$5)`,
    [orderId, type, String(actor), actorRole, String(payload).slice(0, 1000)]
  ).catch(e => console.error('[events] не записано:', e.message));
}
