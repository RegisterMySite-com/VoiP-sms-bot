-- D1 schema for SMS Bot by RegisterMySite
-- Apply with: npm run db:migrate   (or db:migrate:local)

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  twilio_sid TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  source TEXT NOT NULL CHECK (source IN ('inbound', 'dashboard', 'auto-reply')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages (from_number);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages (to_number);
CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages (twilio_sid);

CREATE TABLE IF NOT EXISTS conversations (
  phone TEXT PRIMARY KEY,
  last_direction TEXT,
  last_preview TEXT,
  last_status TEXT,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_last ON conversations (last_message_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
