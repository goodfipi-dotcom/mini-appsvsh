// Применение миграций по порядку. Каждая — идемпотентна, повтор безопасен.
// Запуск: node migrations/run.mjs           (все непринятые)
//         node migrations/run.mjs --dry     (только показать план)
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

if (!process.env.DATABASE_URL) {
  console.error('Нет DATABASE_URL. Запускай так:  set -a && . ./.env.local && set +a && node migrations/run.mjs');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMP DEFAULT NOW()
    )`);

  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
  );

  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`· ${file} — уже применена`);
      continue;
    }
    if (DRY) {
      console.log(`→ ${file} — БУДЕТ применена`);
      continue;
    }

    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✅ ${file} — применена`);
      ran++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`❌ ${file} — ОШИБКА, откат: ${e.message}`);
      throw e;
    } finally {
      client.release();
    }
  }

  console.log(DRY ? 'Это был сухой прогон, ничего не менялось.' : `Готово. Применено миграций: ${ran}`);
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
