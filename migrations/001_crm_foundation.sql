-- 001_crm_foundation.sql — фундамент CRM: связи заказ↔клиент↔рабочий, источники, справочники, журнал доставки
-- Идемпотентно: можно запускать повторно. Ничего не удаляет.
-- Применение: node migrations/run.mjs

-- ─────────────────────────────────────────────────────────
-- Справочники: города и услуги (управляются из админки, не вшиты в вёрстку)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cities (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  region      TEXT DEFAULT '',
  active      BOOLEAN DEFAULT TRUE,
  sort_order  INTEGER DEFAULT 100,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_categories (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  icon        TEXT DEFAULT '',
  sort_order  INTEGER DEFAULT 100,
  active      BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS services (
  id           SERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  category_id  INTEGER REFERENCES service_categories(id) ON DELETE SET NULL,
  description  TEXT DEFAULT '',
  price_from   INTEGER,                  -- NULL = «цена по оценке», выдумывать нельзя
  price_to     INTEGER,
  price_unit   TEXT DEFAULT '',          -- час / смена / объект
  active       BOOLEAN DEFAULT TRUE,
  sort_order   INTEGER DEFAULT 100,
  created_at   TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────
-- Объекты клиента: дом, гараж, дача — повторный заказ начинается с готового адреса
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_objects (
  id          SERIAL PRIMARY KEY,
  client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  city_id     INTEGER REFERENCES cities(id) ON DELETE SET NULL,
  title       TEXT DEFAULT '',
  address     TEXT DEFAULT '',
  object_type TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────
-- Специализации рабочих: заявка идёт нужным людям, а не всем подряд
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_specializations (
  worker_id  TEXT NOT NULL,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_id, service_id)
);

-- ─────────────────────────────────────────────────────────
-- Журнал доставки уведомлений: конец молчаливым сбоям
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER,
  recipient    TEXT NOT NULL,            -- telegram chat_id
  recipient_role TEXT DEFAULT '',        -- admin / worker / client
  channel      TEXT DEFAULT 'telegram',
  type         TEXT DEFAULT '',          -- new_order / published / accepted / ...
  status       TEXT DEFAULT 'pending',   -- pending / sent / failed
  attempts     INTEGER DEFAULT 0,
  error        TEXT DEFAULT '',
  payload      TEXT DEFAULT '',
  created_at   TIMESTAMP DEFAULT NOW(),
  sent_at      TIMESTAMP
);

-- ─────────────────────────────────────────────────────────
-- История заказа по шагам — кто что сделал и когда
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_events (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL,
  type       TEXT NOT NULL,              -- created / approved / published / accepted / completed / cancelled
  actor      TEXT DEFAULT '',            -- telegram_id или 'system'
  actor_role TEXT DEFAULT '',
  payload    TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────
-- Портфолио: реальные объекты, до/процесс/после
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolio_cases (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  city_id       INTEGER REFERENCES cities(id) ON DELETE SET NULL,
  service_id    INTEGER REFERENCES services(id) ON DELETE SET NULL,
  order_id      INTEGER,
  description   TEXT DEFAULT '',
  media_before  TEXT[] DEFAULT '{}',
  media_process TEXT[] DEFAULT '{}',
  media_after   TEXT[] DEFAULT '{}',
  workers_count INTEGER,
  duration      TEXT DEFAULT '',
  published     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────
-- Расширение существующих таблиц (только добавление колонок)
-- ─────────────────────────────────────────────────────────
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS client_id     INTEGER;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS worker_id     TEXT;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS service_id    INTEGER;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS city_id       INTEGER;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS object_id     INTEGER;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS source        TEXT DEFAULT 'direct';
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS source_detail TEXT DEFAULT '';
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS referral_code TEXT DEFAULT '';
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMP;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMP DEFAULT NOW();

ALTER TABLE workers ADD COLUMN IF NOT EXISTS telegram_id TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS phone       TEXT DEFAULT '';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS city_id     INTEGER;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS status      TEXT DEFAULT 'available';  -- available / busy / off
ALTER TABLE workers ADD COLUMN IF NOT EXISTS active      BOOLEAN DEFAULT TRUE;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS role        TEXT DEFAULT 'worker';     -- worker / dispatcher / admin
ALTER TABLE workers ADD COLUMN IF NOT EXISTS notify_orders BOOLEAN DEFAULT TRUE;    -- заменяет workers_stream_active из JSON-файла
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_seen   TIMESTAMP;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram_id   TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source        TEXT DEFAULT 'direct';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source_detail TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS total_revenue INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes         TEXT DEFAULT '';

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_id  INTEGER;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS worker_id TEXT;

-- ─────────────────────────────────────────────────────────
-- Заполнение: telegram_id = id (у существующих рабочих id и есть telegram_id)
-- ─────────────────────────────────────────────────────────
UPDATE workers SET telegram_id = id WHERE telegram_id IS NULL;

-- Город по умолчанию + привязка существующих заявок
INSERT INTO cities (slug, name, region, sort_order)
VALUES ('oktyabrskiy', 'Октябрьский', 'Республика Башкортостан', 1)
ON CONFLICT (slug) DO NOTHING;

UPDATE orders o SET city_id = c.id
  FROM cities c
 WHERE o.city_id IS NULL AND TRIM(LOWER(COALESCE(o.city,''))) = LOWER(c.name);

-- Связать существующие заявки с клиентами по телефону (нормализация: только цифры)
UPDATE orders o SET client_id = cl.id
  FROM clients cl
 WHERE o.client_id IS NULL
   AND REGEXP_REPLACE(COALESCE(o.phone,''), '\D', '', 'g') <> ''
   AND REGEXP_REPLACE(COALESCE(o.phone,''), '\D', '', 'g') = REGEXP_REPLACE(COALESCE(cl.phone,''), '\D', '', 'g');

-- Связать принятые заявки с рабочим (accepted_by — массив, берём первый элемент)
UPDATE orders SET worker_id = accepted_by[1]
 WHERE worker_id IS NULL AND array_length(accepted_by, 1) >= 1;

-- ─────────────────────────────────────────────────────────
-- Индексы
-- ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_status        ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created       ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_client        ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_worker        ON orders(worker_id);
CREATE INDEX IF NOT EXISTS idx_orders_source        ON orders(source);
CREATE INDEX IF NOT EXISTS idx_workers_active       ON workers(active, notify_orders);
CREATE INDEX IF NOT EXISTS idx_workers_city         ON workers(city_id);
CREATE INDEX IF NOT EXISTS idx_clients_phone        ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_client_objects_owner ON client_objects(client_id);
CREATE INDEX IF NOT EXISTS idx_notifications_order  ON notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_order_events_order   ON order_events(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_id     ON chat_messages(id DESC);
