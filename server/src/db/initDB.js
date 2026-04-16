import { pool } from "./index.js";

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT,
      summary TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_message_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      message_id TEXT,
      conversation_id TEXT,
      role TEXT,
      content TEXT,
      message_index INTEGER,
      model TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS user_id TEXT,
      ADD COLUMN IF NOT EXISTS title TEXT,
      ADD COLUMN IF NOT EXISTS summary TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS message_id TEXT,
      ADD COLUMN IF NOT EXISTS message_index INTEGER,
      ADD COLUMN IF NOT EXISTS model TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  await pool.query(`
    UPDATE messages
    SET message_id = CONCAT('legacy-', id)
    WHERE message_id IS NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
    ON messages(conversation_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
    ON messages(conversation_id, created_at DESC, id DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_message_index
    ON messages(conversation_id, message_index);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
    ON messages(message_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
    ON conversations(last_message_at DESC);
  `);

  console.log("DB initialized");
}
