// Импорт отзывов с Avito в нашу базу.
// Показывать их на сайте можно только честно — как отзывы Avito, со ссылкой на профиль.
// Отзывы о личных продажах (гитара, часы и т.п.) в услуги не попадают.
// Запуск: set -a && . ./.env.local && set +a && node scripts/import_avito_reviews.mjs
import pg from 'pg';

const {
  AVITO_CLIENT_ID: ID,
  AVITO_CLIENT_SECRET: SECRET,
  DATABASE_URL
} = process.env;

if (!ID || !SECRET || !DATABASE_URL) {
  console.error('Нет ключей Avito или DATABASE_URL в окружении');
  process.exit(1);
}

// Отзывы об этих объявлениях — это личные продажи, а не услуги
const NOT_A_SERVICE = /гитара|часы|перчатк|кулер|корпус|телефон|велосипед|Telegram-приложение|MiniApp/i;

async function getToken() {
  const res = await fetch('https://api.avito.ru/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ID,
      client_secret: SECRET
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Avito не выдал токен: ' + JSON.stringify(data));
  return data.access_token;
}

async function fetchReviews(token) {
  const all = [];
  for (let offset = 0; offset < 200; offset += 25) {
    const res = await fetch(`https://api.avito.ru/ratings/v1/reviews?offset=${offset}&limit=25`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) break;
    const data = await res.json();
    const batch = data.reviews || [];
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 25) break;
  }
  const seen = new Set();
  return all.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));
}

async function main() {
  const token = await getToken();
  const reviews = await fetchReviews(token);
  console.log(`Получено отзывов с Avito: ${reviews.length}`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  let imported = 0, skipped = 0;
  for (const r of reviews) {
    const itemTitle = r.item?.title || '';
    if (NOT_A_SERVICE.test(itemTitle)) { skipped++; continue; }

    const text = String(r.text || '').trim();
    if (!text) { skipped++; continue; }

    const created = r.createdAt ? new Date(r.createdAt * 1000 || r.createdAt) : null;

    await pool.query(
      `INSERT INTO reviews (client_name, author_name, rating, text, status,
                            source, source_id, source_item, published_at)
       VALUES ($1,$1,$2,$3,'approved','avito',$4,$5,$6)
       ON CONFLICT (source, source_id) WHERE source_id <> ''
       DO UPDATE SET text = EXCLUDED.text, rating = EXCLUDED.rating`,
      [r.sender?.name || 'Заказчик', r.score || 5, text, String(r.id), itemTitle,
       created && !isNaN(created) ? created : null]
    );
    imported++;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int total, ROUND(AVG(rating)::numeric,2) avg FROM reviews WHERE source='avito'`
  );
  console.log(`Импортировано: ${imported}, пропущено (не услуги): ${skipped}`);
  console.log(`Всего отзывов Avito в базе: ${rows[0].total}, средняя оценка: ${rows[0].avg}`);

  await pool.end();
}

main().catch(e => { console.error('Ошибка импорта:', e.message); process.exit(1); });
