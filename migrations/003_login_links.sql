-- 003_login_links.sql — вход по персональной ссылке из бота.
-- Нужен потому, что Telegram Desktop не всегда передаёт приложению подпись пользователя,
-- и вход по ней там не срабатывает. Ссылка работает на любой платформе и в любом браузере.
-- Идемпотентно.

-- Одноразовый ключ входа: бот выдаёт, приложение обменивает на долгую сессию
CREATE TABLE IF NOT EXISTS login_tokens (
  token       TEXT PRIMARY KEY,
  worker_id   TEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  expires_at  TIMESTAMP NOT NULL,
  used_at     TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_worker ON login_tokens(worker_id);
CREATE INDEX IF NOT EXISTS idx_login_tokens_expires ON login_tokens(expires_at);

-- Долгая сессия: чтобы человек не запрашивал ссылку каждый раз
CREATE TABLE IF NOT EXISTS worker_sessions (
  token       TEXT PRIMARY KEY,
  worker_id   TEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  expires_at  TIMESTAMP NOT NULL,
  last_seen   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_sessions_worker ON worker_sessions(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_expires ON worker_sessions(expires_at);
