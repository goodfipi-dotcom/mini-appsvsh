// Проверка личности пользователя по подписи Telegram (initData).
// До этого вход был по общему PIN, который лежал в открытом HTML — любой мог зайти админом.
import crypto from 'crypto';
import { query, queryOne } from './_db.js';

const MAX_AGE_SEC = 86400; // сутки: Telegram не обновляет initData, пока Mini App открыт

/**
 * Проверяет подпись initData от Telegram Mini App.
 * @returns {{ok:true, user:object, authDate:number} | {ok:false, reason:string}}
 */
export function verifyInitData(initData, botToken = process.env.TG_TOKEN) {
  if (!initData) return { ok: false, reason: 'no_init_data' };
  if (!botToken) return { ok: false, reason: 'no_bot_token' };

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };

  const dataCheckString = [...params.entries()]
    .filter(([k]) => k !== 'hash' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > MAX_AGE_SEC) {
    return { ok: false, reason: 'expired' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, reason: 'bad_user' };
  }
  if (!user?.id) return { ok: false, reason: 'no_user' };

  return { ok: true, user, authDate };
}

/** Достаёт initData из заголовка или тела запроса */
export function extractInitData(req) {
  return (
    req.headers['x-telegram-init-data'] ||
    req.headers['x-init-data'] ||
    req.body?.initData ||
    req.query?.initData ||
    ''
  );
}

function isAdminId(telegramId) {
  const admins = String(process.env.ADMIN_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return admins.includes(String(telegramId));
}

/**
 * Полная авторизация: подпись + запись рабочего в базе + права.
 * @returns {{ok:true, telegramId, user, worker, role, isAdmin} | {ok:false, status, error}}
 */
export async function authenticate(req, { requireWorker = false, requireAdmin = false } = {}) {
  const initData = extractInitData(req);
  const check = verifyInitData(initData);

  if (!check.ok) {
    return { ok: false, status: 401, error: 'unauthorized', reason: check.reason };
  }

  const telegramId = String(check.user.id);
  const isAdmin = isAdminId(telegramId);

  const worker = await queryOne(
    `SELECT id, name, telegram_username, stars, total_orders, total_earnings,
            bank_details, level, active, role, status, notify_orders, city_id
       FROM workers WHERE id = $1`,
    [telegramId]
  );

  if (requireAdmin && !isAdmin) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  if (requireWorker && !isAdmin) {
    if (!worker) return { ok: false, status: 403, error: 'not_registered' };
    if (worker.active === false) return { ok: false, status: 403, error: 'access_revoked' };
  }

  if (worker) {
    query('UPDATE workers SET last_seen = NOW() WHERE id = $1', [telegramId]).catch(() => {});
  }

  return {
    ok: true,
    telegramId,
    user: check.user,
    worker,
    isAdmin,
    role: isAdmin ? 'admin' : worker?.role || 'guest'
  };
}

/** Ответ на неудачную авторизацию — единый формат для всех эндпоинтов */
export function denyResponse(res, auth) {
  const messages = {
    unauthorized: 'Откройте приложение через Telegram',
    forbidden: 'Недостаточно прав',
    not_registered: 'Вы не в списке рабочих. Запросите доступ у диспетчера',
    access_revoked: 'Доступ отключён. Обратитесь к диспетчеру'
  };
  return res.status(auth.status).json({
    error: auth.error,
    message: messages[auth.error] || 'Доступ запрещён'
  });
}
