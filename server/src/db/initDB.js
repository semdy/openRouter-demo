import { logger } from "../logger.js";
import { pool } from "./index.js";

async function ensureConstraint(dbClient, { table, constraint, statement }) {
  await dbClient.query(
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          WHERE c.conname = ${`'${constraint}'`}
            AND t.relname = ${`'${table}'`}
        ) THEN
          ${statement};
        END IF;
      END
      $$;
    `,
  );
}

export async function initDB() {
  const dbClient = await pool.connect();

  try {
    await dbClient.query("BEGIN");

    await dbClient.query(`
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
    `);

    await dbClient.query(`
      DO $$
      DECLARE
        id_type TEXT;
      BEGIN
        SELECT data_type
        INTO id_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'conversations'
          AND column_name = 'id';

        IF id_type IN ('text', 'character varying') THEN
          IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'conversations'
              AND column_name = 'conversation_id'
          ) THEN
            UPDATE conversations
            SET conversation_id = COALESCE(conversation_id, id);
            ALTER TABLE conversations DROP COLUMN conversation_id;
          END IF;

          ALTER TABLE conversations RENAME COLUMN id TO conversation_id;
          ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_pkey;
          ALTER TABLE conversations ADD COLUMN id BIGSERIAL;
          ALTER TABLE conversations ADD PRIMARY KEY (id);
        END IF;
      END
      $$;
    `);

    await dbClient.query(`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS conversation_id TEXT,
        ADD COLUMN IF NOT EXISTS user_id TEXT,
        ADD COLUMN IF NOT EXISTS title TEXT,
        ADD COLUMN IF NOT EXISTS summary TEXT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await dbClient.query(`
      UPDATE conversations
      SET conversation_id = COALESCE(conversation_id, id::text)
      WHERE conversation_id IS NULL;
    `);

    await dbClient.query(`
      ALTER TABLE conversations
        ALTER COLUMN conversation_id SET NOT NULL,
        ALTER COLUMN updated_at SET DEFAULT NOW(),
        ALTER COLUMN last_message_at SET DEFAULT NOW(),
        ALTER COLUMN created_at SET DEFAULT NOW();
    `);

    await dbClient.query(`
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
    `);

    await dbClient.query(`
      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS message_id TEXT,
        ADD COLUMN IF NOT EXISTS parent_message_id TEXT,
        ADD COLUMN IF NOT EXISTS conversation_id TEXT,
        ADD COLUMN IF NOT EXISTS role TEXT,
        ADD COLUMN IF NOT EXISTS content TEXT,
        ADD COLUMN IF NOT EXISTS message_index INTEGER,
        ADD COLUMN IF NOT EXISTS model TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT,
        ADD COLUMN IF NOT EXISTS metadata JSONB,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await dbClient.query(`
      UPDATE messages
      SET message_id = CONCAT('legacy-', id)
      WHERE message_id IS NULL;
    `);

    await dbClient.query(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY conversation_id
            ORDER BY created_at ASC, id ASC
          ) - 1 AS next_message_index
        FROM messages
      )
      UPDATE messages m
      SET message_index = ranked.next_message_index
      FROM ranked
      WHERE m.id = ranked.id
        AND m.message_index IS NULL;
    `);

    await dbClient.query(`
      UPDATE messages
      SET metadata = '{}'::jsonb
      WHERE metadata IS NULL;
    `);

    await dbClient.query(`
      UPDATE messages
      SET content = ''
      WHERE content IS NULL;
    `);

    await dbClient.query(`
      ALTER TABLE messages
        ALTER COLUMN message_id SET NOT NULL,
        ALTER COLUMN conversation_id SET NOT NULL,
        ALTER COLUMN role SET NOT NULL,
        ALTER COLUMN content SET DEFAULT '',
        ALTER COLUMN content SET NOT NULL,
        ALTER COLUMN message_index SET NOT NULL,
        ALTER COLUMN metadata SET DEFAULT '{}'::jsonb,
        ALTER COLUMN metadata SET NOT NULL,
        ALTER COLUMN created_at SET DEFAULT NOW();
    `);

    // 创建索引
    await dbClient.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_conversation_id_unique
      ON conversations(conversation_id);
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
      ON conversations(last_message_at DESC);
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      ON messages(conversation_id);
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
      ON messages(conversation_id, created_at DESC, id DESC);
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_message_index
      ON messages(conversation_id, message_index);
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_last_message
      ON messages (conversation_id, message_index DESC, created_at DESC, id DESC);
    `);

    await dbClient.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
      ON messages(message_id);
    `);

    await ensureConstraint(dbClient, {
      table: "messages",
      constraint: "fk_parent_message",
      statement: `
        ALTER TABLE messages
        ADD CONSTRAINT fk_parent_message
        FOREIGN KEY (parent_message_id)
        REFERENCES messages(message_id)
        ON DELETE CASCADE
      `,
    });

    await ensureConstraint(dbClient, {
      table: "messages",
      constraint: "fk_messages_conversation_id",
      statement: `
        ALTER TABLE messages
        ADD CONSTRAINT fk_messages_conversation_id
        FOREIGN KEY (conversation_id)
        REFERENCES conversations(conversation_id)
        ON DELETE CASCADE
      `,
    });

    await dbClient.query("COMMIT");
    logger.info("DB initialized");
  } catch (error) {
    await dbClient.query("ROLLBACK");
    throw error;
  } finally {
    dbClient.release();
  }
}
