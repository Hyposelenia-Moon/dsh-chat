PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS media_assets (
  path TEXT NOT NULL, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(path,chat_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, session_id TEXT NOT NULL,
  model TEXT, reasoning_effort TEXT, preset TEXT, cwd TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, session_id TEXT,
  turn_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  qq_message_id TEXT, sender_id TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS message_delivery_dedup ON messages(chat_id, qq_message_id, role) WHERE qq_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(chat_id, created_at);
CREATE TABLE IF NOT EXISTS message_dedup (message_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT, model TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT, chat_id TEXT NOT NULL,
  sender_id TEXT, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, actor_id TEXT,
  chat_id TEXT, turn_id TEXT, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_time ON audit(created_at);
CREATE TABLE IF NOT EXISTS feature_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK(scope IN ('global','group','user')),
  scope_id TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('fact','preference','event','relation','rule')),
  content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL, last_used_at INTEGER, superseded_by INTEGER,
  forgotten_at INTEGER, embedding BLOB, automatic INTEGER NOT NULL DEFAULT 0,
  actor_id TEXT, source_chat_id TEXT
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,scope_id,forgotten_at);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id INTEGER,
  signal TEXT NOT NULL CHECK(signal IN ('good','bad','correction','repeat')),
  note TEXT NOT NULL DEFAULT '', actor_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, file TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', emotion TEXT NOT NULL DEFAULT '', usage_count INTEGER NOT NULL DEFAULT 0,
  source_chat_id TEXT, actor_id TEXT, mime TEXT, width INTEGER, height INTEGER,
  bytes INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sticker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sticker_id INTEGER NOT NULL REFERENCES stickers(id),
  chat_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sticker_events_quota ON sticker_events(chat_id,kind,created_at);
CREATE TABLE IF NOT EXISTS letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('text','image','file')),
  file TEXT, actor_id TEXT, scheduled_at INTEGER, sent_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL UNIQUE,
  content TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'persona',
  active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  actor_id TEXT, automatic INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  approved_by TEXT, approved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_active ON profiles(active) WHERE active=1;
CREATE TABLE IF NOT EXISTS profile_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL REFERENCES profiles(id),
  previous_profile_id INTEGER, action TEXT NOT NULL, actor_id TEXT NOT NULL,
  reason TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, intent TEXT NOT NULL, steps TEXT NOT NULL,
  successful INTEGER NOT NULL DEFAULT 1, actor_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, chat_id TEXT NOT NULL, self_id TEXT,
  payload TEXT NOT NULL, run_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  actor_id TEXT NOT NULL, actor_role TEXT NOT NULL, turn_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT, lease_until INTEGER, last_error TEXT, result TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,run_at,lease_until);
PRAGMA user_version = 2;
