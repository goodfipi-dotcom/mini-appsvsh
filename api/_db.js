// Общий пул подключений к базе. Раньше каждый файл создавал свой — Neon держал лишние коннекты.
import pg from 'pg';

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      // Neon на бесплатном тарифе засыпает после простоя и просыпается 5-10 секунд —
      // при коротком ожидании запрос падал с «connection timeout»
      connectionTimeoutMillis: 30000,
      keepAlive: true
    });
    pool.on('error', e => console.error('[db] ошибка пула:', e.message));
  }
  return pool;
}

const isConnectionError = e =>
  /terminated|timeout|ECONNRESET|ETIMEDOUT|Connection terminated|socket hang up/i.test(e?.message || '');

/** Запрос с одной повторной попыткой: спящая база рвёт первое соединение */
export async function query(text, params) {
  try {
    return await getPool().query(text, params);
  } catch (e) {
    if (!isConnectionError(e)) throw e;
    console.warn('[db] соединение оборвалось, повторяю запрос');
    try { await pool.end(); } catch {}
    pool = null;
    return await getPool().query(text, params);
  }
}

/** Первая строка результата или null */
export async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

/** Только цифры — для сравнения телефонов между собой */
export function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}
