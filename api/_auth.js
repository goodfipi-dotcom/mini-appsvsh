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

/** Сессия, полученная по ссылке из бота — запасной путь для платформ без подписи */
async function sessionFromToken(req) {
  const token = String(
    req.headers['x-session-token'] || req.body?.session_token || req.query?.session_token || ''
  ).trim();
  if (!token) return null;

  const row = await queryOne(
    `UPDATE worker_sessions SET last_seen = NOW()
      WHERE token = $1 AND expires_at > NOW()
      RETURNING worker_id`,
    [token]
  );
  return row?.worker_id ? String(row.worker_id) : null;
}

/**
 * Полная авторизация. Личность подтверждается либо подписью Telegram,
 * либо сессией, выданной по персональной ссылке из бота.
 * @returns {{ok:true, telegramId, user, worker, role, isAdmin} | {ok:false, status, error}}
 */
export async function authenticate(req, { requireWorker = false, requireAdmin = false } = {}) {
  const initData = extractInitData(req);
  const check = verifyInitData(initData);

  let telegramId;
  let tgUser = null;

  if (check.ok) {
    telegramId = String(check.user.id);
    tgUser = check.user;
  } else {
    const fromSession = await sessionFromToken(req);
    if (!fromSession) {
      return { ok: false, status: 401, error: 'unauthorized', reason: check.reason };
    }
    telegramId = fromSession;
  }
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
    user: tgUser,
    worker,
    isAdmin,
    role: isAdmin ? 'admin' : worker?.role || 'guest'
  };
}

/** Выдаёт долгую сессию — чтобы не запрашивать ссылку при каждом заходе */
export async function issueSession(telegramId, days = 90) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO worker_sessions (token, worker_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' days')::interval)`,
    [token, String(telegramId), String(days)]
  );
  return token;
}

/**
 * Обменивает одноразовый ключ из ссылки на сессию.
 * Ключ живёт 15 минут и срабатывает один раз.
 */
export async function redeemLoginToken(token) {
  if (!token) return null;
  const row = await queryOne(
    `UPDATE login_tokens SET used_at = NOW()
      WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
      RETURNING worker_id`,
    [String(token).trim()]
  );
  return row?.worker_id ? String(row.worker_id) : null;
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
