import { Worker } from "bullmq";
import Redis from "ioredis";
import { client } from "./chat-client.js";
import { pool } from "./db/initDB.js";
import { logger } from "./logger.js";
import {
  CONVERSATION_UPDATES_CHANNEL,
  getConversationListItem,
} from "./services/conversationService.js";

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const publisher = new Redis(process.env.REDIS_URL);

export const WORKER_NAME = "chat-persist";

const worker = new Worker(
  WORKER_NAME,
  async (job) => {
    const { name, data } = job;
    if (name === "persist") {
      await handlePersist(data);
    }
  },
  {
    connection,
    concurrency: 5,
  },
);

worker.on("completed", (job) => {
  logger.info("persist_job_completed", {
    jobId: job.id,
    name: job.name,
    attemptsMade: job.attemptsMade,
  });
});

worker.on("failed", (job, err) => {
  logger.error("persist_job_failed", err, {
    jobId: job?.id,
    name: job?.name,
    attemptsMade: job?.attemptsMade,
  });
});

async function generateConversationTitle({ userMessage, assistantMessage }) {
  const stream = await client.chat.send({
    chatRequest: {
      models: ["openai/gpt-5.4-mini"],
      messages: [
        {
          role: "system",
          content: `你是一个会话标题生成器。

要求：
1. 基于用户问题和助手回答生成一个简短标题
2. 不超过20个汉字
3. 不要加引号、句号或多余解释
4. 不要使用“关于”“讨论”“聊天”等空泛词
5. 直接输出标题`,
        },
        {
          role: "user",
          content: `用户：${userMessage}\n助手：${assistantMessage}`,
        },
      ],
      maxCompletionTokens: 30,
      stream: false,
    },
  });

  const title = stream.choices?.[0]?.message?.content?.trim();
  return title ? title.slice(0, 40) : null;
}

async function handlePersist(data) {
  const { conversationId, messages, userId = null } = data;
  const startedAt = Date.now();

  const client = await pool.connect();
  let shouldGenerateTitle = false;
  let generatedTitleInput = null;

  try {
    await client.query("BEGIN");

    const firstUserMessage = messages.find(
      (message) => message.role === "user",
    );
    const existingConversationResult = await client.query(
      `
        SELECT title
        FROM conversations
        WHERE id = $1
        FOR UPDATE
      `,
      [conversationId],
    );
    const existingTitle = existingConversationResult.rows[0]?.title ?? null;

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
      [conversationId, userId, existingTitle],
    );

    shouldGenerateTitle = existingTitle == null;

    if (shouldGenerateTitle) {
      const assistantMessage = messages.find(
        (message) => message.role === "assistant",
      );
      if (firstUserMessage?.content && assistantMessage?.content) {
        generatedTitleInput = {
          userMessage: firstUserMessage.content,
          assistantMessage: assistantMessage.content,
        };
      }
    }

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

    logger.info("persist_transaction_committed", {
      conversationId,
      messageCount: messages.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("persist_transaction_failed", err, {
      conversationId,
      messageCount: messages.length,
      durationMs: Date.now() - startedAt,
    });
    throw err; // BullMQ 会自动 retry
  } finally {
    client.release();
  }

  if (shouldGenerateTitle && generatedTitleInput) {
    try {
      const generatedTitle =
        await generateConversationTitle(generatedTitleInput);
      if (generatedTitle) {
        await pool.query(
          `
            UPDATE conversations
            SET title = $2, updated_at = NOW()
            WHERE id = $1 AND (title IS NULL OR title = '')
          `,
          [conversationId, generatedTitle],
        );
        const conversation = await getConversationListItem(conversationId);
        if (conversation) {
          await publisher.publish(
            CONVERSATION_UPDATES_CHANNEL,
            JSON.stringify({ conversation }),
          );
        }
        logger.info("conversation_title_generated", {
          conversationId,
          title: generatedTitle,
        });
      }
    } catch (error) {
      logger.error("conversation_title_generation_failed", error, {
        conversationId,
      });
    }
  }
}
