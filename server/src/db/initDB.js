import { logger } from "../logger.js";
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
      message_id TEXT UNIQUE NOT NULL,
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
      ADD COLUMN IF NOT EXISTS parent_message_id TEXT,
      ADD COLUMN IF NOT EXISTS message_index INTEGER,
      ADD COLUMN IF NOT EXISTS model TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB;
  `);

  await pool.query(`
    UPDATE messages
    SET message_id = CONCAT('legacy-', id)
    WHERE message_id IS NULL;
  `);

  await pool.query(`
    ALTER TABLE messages
    ALTER COLUMN message_id SET NOT NULL;
  `);

  await pool.query(`
    UPDATE messages
    SET message_index = 0
    WHERE message_index IS NULL;
  `);

  await pool.query(`
    ALTER TABLE messages
    ALTER COLUMN message_index SET NOT NULL;
  `);

  await pool.query(`
    UPDATE messages
    SET metadata = '{}'::jsonb
    WHERE metadata IS NULL;
  `);

  await pool.query(`
    ALTER TABLE messages
    ALTER COLUMN metadata SET NOT NULL;
  `);

  await pool.query(`
    ALTER TABLE messages
    ADD CONSTRAINT messages_message_id_unique UNIQUE (message_id);
  `);

  // parent 外键
  await pool.query(`
    ALTER TABLE messages
      ADD CONSTRAINT fk_parent_message
      FOREIGN KEY (parent_message_id)
      REFERENCES messages(message_id)
      ON DELETE SET NULL;
  `);

  // 创建索引
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
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_last_message
    ON messages (conversation_id, message_index DESC, created_at DESC, id DESC);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
    ON messages(message_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
    ON conversations(last_message_at DESC);
  `);

  logger.info("DB initialized");
}
