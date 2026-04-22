import { randomUUID } from "node:crypto";
import { chatClient } from "../chatClient.js";
import { chatQueue, QUEUE_NAME } from "../queue.js";
import { CONTINUE_PROMPT, MAX_PROMPT_TOKENS } from "../config.js";
import {
  // appendPartial,
  // clearPartial,
  getHistory,
  reserveMessageIndexes,
  saveHistory,
} from "../history.js";
import { trimMessagesByTokens } from "../tokenizer.js";
import { logger } from "../logger.js";

export async function streamChatCompletion({
  prompt,
  conversationId,
  userId,
  requestId,
  continuation,
  continuationMessageId,
  onDelta,
  isClientClosed,
}) {
  const messageId = randomUUID();
  const startedAt = Date.now();
  const history = await getHistory(conversationId);

  let status = "streaming";
  let assistantReply = "";
  let deltaCount = 0;
  let caughtError = null;

  try {
    const requestHistory = [...history];

    if (continuation) {
      if (prompt) {
        requestHistory.push({
          role: "user",
          content: prompt + "\n\n" + CONTINUE_PROMPT,
        });
      } else {
        requestHistory.push({
          role: "user",
          content: CONTINUE_PROMPT,
        });
      }
    }

    if (prompt && !continuation) {
      requestHistory.push({ role: "user", content: prompt });
    }

    const messages = trimMessagesByTokens(requestHistory, MAX_PROMPT_TOKENS);

    logger.info("chat_stream_prepared", {
      requestId,
      conversationId,
      historyMessages: history.length,
      promptMessages: messages.length,
    });

    const upstreamStartedAt = Date.now();

    const controller = new AbortController();
    const stream = await chatClient.chat.send(
      {
        chatRequest: {
          models: ["openai/gpt-5.4", "anthropic/claude-opus-4.6-fast"],
          messages,
          maxCompletionTokens: 47,
          stream: true,
        },
      },
      {
        signal: controller.signal,
      },
    );

    let firstDeltaAt = null;

    // let lastPersist = Date.now();

    // await appendPartial(conversationId, "");

    for await (const chunk of stream) {
      if (isClientClosed()) {
        status = "interrupted";
        controller.abort();
        break;
      }

      const choice = chunk.choices?.[0];

      if ("error" in chunk) {
        if (choice?.finishReason === "error") {
          logger.error("chat_stream_error", chunk.error, {
            requestId,
            conversationId,
            clientClosed: isClientClosed(),
            hasAssistantReply: Boolean(assistantReply),
            deltaCount,
            status: "error",
            durationMs: Date.now() - startedAt,
          });

          throw chunk.error;
        }
      }

      const content = choice?.delta?.content;
      if (!content) continue;

      if (firstDeltaAt === null) {
        firstDeltaAt = Date.now();
        logger.info("chat_stream_first_delta", {
          requestId,
          conversationId,
          latencyMs: firstDeltaAt - upstreamStartedAt,
        });
      }

      assistantReply += content;
      deltaCount++;

      // if (Date.now() - lastPersist > 200) {
      //   await appendPartial(conversationId, assistantReply);
      //   lastPersist = Date.now();
      // }

      await onDelta({ content, messageId });
    }

    if (status === "streaming") {
      status = "completed";
    }
  } catch (err) {
    if (status !== "interrupted") {
      status = "error";
    }
    err.messageId = messageId;
    caughtError = err;
  } finally {
    // await clearPartial(conversationId);
  }

  if (!assistantReply) {
    logger.info("chat_stream_stopped", {
      requestId,
      conversationId,
      clientClosed: isClientClosed(),
      hasAssistantReply: Boolean(assistantReply),
      deltaCount,
      status,
      durationMs: Date.now() - startedAt,
    });
    if (caughtError) {
      throw caughtError;
    }
    return;
  }

  let persistedMessages;
  let updatedHistory;

  if (continuation) {
    const nextMessageIndex = await reserveMessageIndexes(conversationId, 1);
    persistedMessages = [
      {
        messageId,
        role: "assistant",
        content: assistantReply,
        messageIndex: nextMessageIndex,
        parentMessageId: continuationMessageId,
        status,
        model: "openai/gpt-5.4",
        metadata: {
          continuation: true,
        },
      },
    ];
    const lastHistoryMessage = history.at(-1);
    if (lastHistoryMessage?.role === "assistant") {
      updatedHistory = [
        ...history.slice(0, -1),
        {
          ...lastHistoryMessage,
          content: `${lastHistoryMessage.content}${assistantReply}`,
          messageIndex: nextMessageIndex,
        },
      ];
    } else {
      updatedHistory = [
        ...history,
        {
          role: "assistant",
          content: assistantReply,
          messageIndex: nextMessageIndex,
        },
      ];
    }
  } else {
    const nextMessageIndex = await reserveMessageIndexes(conversationId, 2);
    persistedMessages = [
      {
        messageId: randomUUID(),
        role: "user",
        content: prompt,
        messageIndex: nextMessageIndex,
        metadata: {},
      },
      {
        messageId,
        role: "assistant",
        content: assistantReply,
        messageIndex: nextMessageIndex + 1,
        status,
        model: "openai/gpt-5.4",
        metadata: {},
      },
    ];
    updatedHistory = [
      ...history,
      {
        role: "user",
        content: prompt,
        messageIndex: nextMessageIndex,
      },
      {
        role: "assistant",
        content: assistantReply,
        messageIndex: nextMessageIndex + 1,
      },
    ];
  }

  await saveHistory(conversationId, updatedHistory);
  try {
    const job = await chatQueue.add(QUEUE_NAME, {
      conversationId,
      userId,
      messages: persistedMessages,
    });

    logger.info("chat_persist_job_enqueued", {
      requestId,
      conversationId,
      jobId: job.id,
      deltaCount,
      status,
      responseLength: assistantReply.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error("chat_persist_job_enqueue_failed", error, {
      requestId,
      status,
      conversationId,
    });
    throw error;
  }

  logger.info("chat_stream_completed", {
    requestId,
    conversationId,
    deltaCount,
    status,
    responseLength: assistantReply.length,
    durationMs: Date.now() - startedAt,
  });

  if (caughtError) {
    throw caughtError;
  }
}

async function searchCompletions(query) {
  const { rows } = await pool.query(
    `
      SELECT
        message_id AS "messageId",
        parent_message_id AS "parentMessageId",
        role,
        content,
        message_index AS "messageIndex",
        model,
        status,
        metadata,
        created_at AS "createdAt"
      FROM messages
      WHERE content ILIKE $1 OR role ILIKE $1
      ORDER BY
        created_at DESC
        LIMIT 50
    `,
    [`%${query}%`],
  );

  return rows;
}
