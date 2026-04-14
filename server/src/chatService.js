import { randomUUID } from "node:crypto";
import { OpenRouter } from "@openrouter/sdk";
import { chatQueue, QUEUE_NAME } from "./queue.js";
import { CONTINUE_PROMPT, MAX_PROMPT_TOKENS } from "./config.js";
import {
  appendPartial,
  clearPartial,
  getHistory,
  reserveMessageIndexes,
  saveHistory,
} from "./history.js";
import { trimMessagesByTokens } from "./tokenizer.js";

const openRouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

export async function streamChatCompletion({
  prompt,
  conversationId,
  continuation,
  onDelta,
  isClientClosed,
}) {
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

  if (process.env.NODE_ENV === "development") {
    console.log("messages:");
    console.log(messages);
  }

  const stream = await openRouter.chat.send({
    chatRequest: {
      models: ["openai/gpt-5.4", "anthropic/claude-opus-4.6-fast"],
      messages,
      maxCompletionTokens: 47,
      stream: true,
    },
  });

  let assistantReply = "";
  await appendPartial(conversationId, "");

  try {
    let lastPersist = Date.now();

    for await (const chunk of stream) {
      if (isClientClosed()) break;

      if ("error" in chunk) {
        throw new Error(`OpenRouter stream error: ${chunk.error.message}`);
      }

      const content = chunk.choices?.[0]?.delta?.content;
      if (!content) continue;

      assistantReply += content;

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
        continuation: Boolean(continuation),
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
  await chatQueue.add(QUEUE_NAME, {
    conversationId,
    messages: persistedMessages,
  });
}
