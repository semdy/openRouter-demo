import { Worker } from "bullmq";
import Redis from "ioredis";
import { pool } from "./db/initDB.js";

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const WORKER_NAME = "chat-persist";

const worker = new Worker(
  WORKER_NAME,
  async (job) => {
    const { name, data } = job;
    if (name === "persist") {
      await handlePersist(data);
    }
  },
  { connection },
);

worker.on("completed", (job) => {
  console.log(`${job.id} has completed!`);
});

worker.on("failed", (job, err) => {
  console.log(`${job.id} has failed with ${err.message}`);
});

async function handlePersist(data) {
  const { conversationId, messages, userId = null } = data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const firstUserMessage = messages.find((message) => message.role === "user");
    const conversationTitle = firstUserMessage?.content
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    await client.query(
      `
        INSERT INTO conversations (id, user_id, title, updated_at, last_message_at)
        VALUES ($1, $2, $3, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          user_id = COALESCE(EXCLUDED.user_id, conversations.user_id),
          title = COALESCE(conversations.title, EXCLUDED.title),
          updated_at = NOW(),
          last_message_at = NOW()
      `,
      [conversationId, userId, conversationTitle || null],
    );

    const values = [];
    const params = [];

    messages.forEach((msg, i) => {
      const idx = i * 7;
      values.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`,
      );
      params.push(
        msg.messageId,
        conversationId,
        msg.role,
        msg.content,
        msg.messageIndex ?? null,
        msg.model ?? null,
        JSON.stringify(msg.metadata ?? {}),
      );
    });

    await client.query(
      `
        INSERT INTO messages (
          message_id,
          conversation_id,
          role,
          content,
          message_index,
          model,
          metadata
        )
        VALUES ${values.join(",")}
        ON CONFLICT (message_id) DO NOTHING
      `,
      params,
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err; // BullMQ 会自动 retry
  } finally {
    client.release();
  }
}
