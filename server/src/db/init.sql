-- db/init.sql

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id TEXT,
  role TEXT,
  content TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 可选索引（很推荐）
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
ON messages(conversation_id);