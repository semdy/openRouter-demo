import { randomUUID } from "node:crypto";
import { chatClient } from "../chatClient.js";
import { chatQueue, QUEUE_NAME } from "../queue.js";
import { CONTINUE_PROMPT, MAX_PROMPT_TOKENS } from "../config.js";
import {
  appendPartial,
  clearPartial,
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
  onDelta,
  isClientClosed,
}) {
  const startedAt = Date.now();
  const history = await getHistory(conversationId);
  const requestHistory = [...history];

  if (continuation) {
    requestHistory.push({
      role: "user",
      content: CONTINUE_PROMPT,
    });
  }

  requestHistory.push({ role: "user", content: prompt });

  const messages = trimMessagesByTokens(requestHistory, MAX_PROMPT_TOKENS);

  logger.info("chat_stream_prepared", {
    requestId,
    conversationId,
    historyMessages: history.length,
    promptMessages: messages.length,
  });

  const upstreamStartedAt = Date.now();
  const stream = await chatClient.chat.send({
    chatRequest: {
      models: ["openai/gpt-5.4", "anthropic/claude-opus-4.6-fast"],
      messages,
      maxCompletionTokens: 47,
      stream: true,
    },
  });

  let assistantReply = "";
  await appendPartial(conversationId, "");

  let firstDeltaAt = null;
  let deltaCount = 0;

  try {
    let lastPersist = Date.now();

    for await (const chunk of stream) {
      if (isClientClosed()) break;

      if ("error" in chunk) {
        throw new Error(`chat stream error: ${chunk.error.message}`);
      }

      const content = chunk.choices?.[0]?.delta?.content;
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

      if (Date.now() - lastPersist > 200) {
        await appendPartial(conversationId, assistantReply);
        lastPersist = Date.now();
      }

      await onDelta(content);
    }
  } finally {
    await clearPartial(conversationId);
  }

  if (isClientClosed() || !assistantReply) {
    logger.info("chat_stream_stopped", {
      requestId,
      conversationId,
      clientClosed: isClientClosed(),
      hasAssistantReply: Boolean(assistantReply),
      deltaCount,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const nextMessageIndex = await reserveMessageIndexes(conversationId, 2);
  const persistedMessages = [
    {
      messageId: randomUUID(),
      role: "user",
      content: prompt,
      messageIndex: nextMessageIndex,
      metadata: {
        continuation,
      },
    },
    {
      messageId: randomUUID(),
      role: "assistant",
      content: assistantReply,
      messageIndex: nextMessageIndex + 1,
      model: "openai/gpt-5.4",
      metadata: {},
    },
  ];
  const updatedHistory = [
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
      responseLength: assistantReply.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error("chat_persist_job_enqueue_failed", error, {
      requestId,
      conversationId,
    });
    throw error;
  }

  logger.info("chat_stream_completed", {
    requestId,
    conversationId,
    deltaCount,
    responseLength: assistantReply.length,
    durationMs: Date.now() - startedAt,
  });
}
