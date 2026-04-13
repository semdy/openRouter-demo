import { Worker } from "bullmq";
import Redis from "ioredis";
import pkg from "pg";

const { Pool } = pkg;

const connection = new Redis();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const worker = new Worker(
  "chat-persist",
  async (job) => {
    const { conversationId, messages } = job.data;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const msg of messages) {
        await client.query(
          `INSERT INTO messages (conversation_id, role, content)
           VALUES ($1, $2, $3)`,
          [conversationId, msg.role, msg.content],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err; // BullMQ 会自动 retry
    } finally {
      client.release();
    }
  },
  { connection },
);

worker.on("completed", (job) => {
  console.log("Persisted:", job.id);
});

worker.on("failed", (job, err) => {
  console.error("Failed:", err);
});
