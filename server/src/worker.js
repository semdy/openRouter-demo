import { Worker } from "bullmq";
import Redis from "ioredis";
import { redis } from "./redis.js";
import { chatClient } from "./chatClient.js";
import * as db from "./db/index.js";
import { logger } from "./logger.js";
import {
  CONVERSATION_UPDATES_CHANNEL,
  getConversationListItem,
} from "./services/conversations.js";
import { GENERATE_TITLE_PROMPT } from "./config.js";

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

async function generateConversationTitleByLLM({
  userMessage,
  assistantMessage,
}) {
  const stream = await chatClient.chat.send({
    chatRequest: {
      models: ["openai/gpt-5.4-mini"],
      messages: [
        {
          role: "system",
          content: GENERATE_TITLE_PROMPT,
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
  const { conversationId, messages, userId } = data;
  const startedAt = Date.now();

  const dbClient = await db.getClient();
  let shouldGenerateTitle = false;
  let generatedTitleInput = null;

  try {
    await dbClient.query("BEGIN");

    const firstUserMessage = messages.find(
      (message) => message.role === "user",
    );
    const existingConversationResult = await dbClient.query(
      `
        SELECT title
        FROM conversations
        WHERE id = $1
        FOR UPDATE
      `,
      [conversationId],
    );
    const existingTitle = existingConversationResult.rows[0]?.title ?? null;

    await dbClient.query(
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
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}), $${idx + 8}), $${idx + 8}), $${idx + 9})`,
      );
      params.push(
        msg.messageId,
        msg.parentMessageId ?? null,
        conversationId,
        msg.role,
        msg.content,
        msg.messageIndex ?? null,
        msg.model ?? null,
        msg.status ?? null,
        JSON.stringify(msg.metadata ?? {}),
      );
    });

    await dbClient.query(
      `
        INSERT INTO messages (
          message_id,
          parent_message_id,
          conversation_id,
          role,
          content,
          message_index,
          model,
          status,
          metadata
        )
        VALUES ${values.join(",")}
        ON CONFLICT (message_id) DO NOTHING
      `,
      params,
    );

    await dbClient.query("COMMIT");

    logger.info("persist_transaction_committed", {
      conversationId,
      messageCount: messages.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    await dbClient.query("ROLLBACK");
    logger.error("persist_transaction_failed", err, {
      conversationId,
      messageCount: messages.length,
      durationMs: Date.now() - startedAt,
    });
    throw err; // BullMQ 会自动 retry
  } finally {
    dbClient.release();
  }

  if (shouldGenerateTitle && generatedTitleInput) {
    try {
      const generatedTitle =
        await generateConversationTitleByLLM(generatedTitleInput);
      if (generatedTitle) {
        await db.query(
          `
            UPDATE conversations
            SET title = $2, updated_at = NOW()
            WHERE id = $1 AND (title IS NULL OR title = '')
          `,
          [conversationId, generatedTitle],
        );
        const conversation = await getConversationListItem(conversationId);
        if (conversation) {
          try {
            await redis.publish(
              CONVERSATION_UPDATES_CHANNEL,
              JSON.stringify({
                ...conversation,
                userId: conversation.userId ?? userId ?? null,
              }),
            );
            logger.info("conversation_title_generated_and_published", {
              conversationId,
              title: generatedTitle,
            });
          } catch (error) {
            logger.error("conversation_title_publish_failed", error, {
              conversationId,
            });
          }
        }
      }
    } catch (error) {
      logger.error("conversation_title_generation_failed", error, {
        conversationId,
      });
    }
  }
}
