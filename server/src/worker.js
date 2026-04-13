import { Worker } from "bullmq";
import Redis from "ioredis";
import pkg from "pg";

const { Pool } = pkg;
const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10, // 最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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
  const { conversationId, messages } = data;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const values = [];
    const params = [];

    messages.forEach((msg, i) => {
      const idx = i * 3;
      values.push(`($${idx + 1}, $${idx + 2}, $${idx + 3})`);
      params.push(conversationId, msg.role, msg.content);
    });

    await client.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ${values.join(",")}`,
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
