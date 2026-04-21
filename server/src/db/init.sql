-- db/init.sql

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  user_id TEXT,
  title TEXT,
  summary TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  parent_message_id TEXT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  message_index INTEGER NOT NULL,
  model TEXT,
  status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'fk_messages_conversation_id'
      AND t.relname = 'messages'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT fk_messages_conversation_id
      FOREIGN KEY (conversation_id)
      REFERENCES conversations(conversation_id)
      ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'fk_parent_message'
      AND t.relname = 'messages'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT fk_parent_message
      FOREIGN KEY (parent_message_id)
      REFERENCES messages(message_id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- 可选索引（很推荐）
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
ON messages(conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_message_index
ON messages(conversation_id, message_index);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_last_message
ON messages (conversation_id, message_index DESC, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
ON messages(message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_conversation_id_unique
ON conversations(conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
ON conversations(last_message_at DESC, id DESC);
