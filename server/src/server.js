// =====================================
// Full Production-Ready Demo
// Features:
// - fetch streaming
// - Redis conversation storage
// - multi-turn context
// - token trimming (simple version)
// - abort support
// - concurrency control
// =====================================

// install:
// npm i express @openrouter/sdk ioredis

import express from "express";
import Redis from "ioredis";
import { OpenRouter } from "@openrouter/sdk";
import { estimateTokens } from "./tokenizer.js";
import { initDB } from "./db/initDB.js";
import { chatQueue, QUEUE_NAME } from "./queue.js";

const app = express();
app.use(express.json());

// ===== Config =====
const MAX_TURNS = 10; // keep last 10 rounds
const MAX_CONCURRENT = 5;
const CONTINUE_PROMPT = `
继续完成上一个回答。

要求：
1. 从已有内容的末尾继续
2. 不要重复已经输出的内容
3. 保持语气和风格一致
4. 直接续写，不要解释
`;

// ===== Redis =====
const redis = new Redis(process.env.REDIS_URL);

// ===== OpenRouter =====
const openRouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ===== Simple concurrency control =====
let currentRequests = 0;

function acquire() {
  if (currentRequests >= MAX_CONCURRENT) return false;
  currentRequests++;
  return true;
}

function release() {
  currentRequests--;
}

// ===== Helpers =====

// ===== Token estimation (simple version, replace with tiktoken in prod) =====
// function estimateTokens(text) {
//   // rough: 1 token ≈ 4 chars (English), adjust if needed
//   return Math.ceil(text.length / 4);
// }

function countMessageTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);
}

function trimMessagesByTokens(messages, maxTokens = 8000) {
  const system = messages.find((m) => m.role === "system");
  let rest = messages.filter((m) => m.role !== "system");

  let result = system ? [system] : [];

  // keep from latest backwards
  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i];
    result.splice(system ? 1 : 0, 0, msg);

    if (countMessageTokens(result) > maxTokens) {
      result.splice(system ? 1 : 0, 1);
      break;
    }
  }

  return result;
}

function trimMessagesByTurns(messages) {
  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  const trimmed = rest.slice(-MAX_TURNS * 2); // user+assistant

  return system ? [system, ...trimmed] : trimmed;
}

// ===== Streaming persistence =====
async function appendPartial(conversationId, partial) {
  await redis.set(`chat:partial:${conversationId}`, partial, "EX", 60 * 10);
}

async function clearPartial(conversationId) {
  await redis.del(`chat:partial:${conversationId}`);
}

async function getHistory(conversationId) {
  const data = await redis.get(`chat:${conversationId}`);
  return data ? JSON.parse(data) : [];
}

async function saveHistory(conversationId, messages) {
  await redis.set(
    `chat:${conversationId}`,
    JSON.stringify(messages),
    "EX",
    60 * 60, // 1 hour TTL
  );
}

// ===== API =====

app.post("/api/chat", async (req, res) => {
  if (!acquire()) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { prompt, conversationId, continuation } = req.body;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  try {
    // ===== load history =====
    let history = await getHistory(conversationId);

    // inject system prompt if first time
    if (history.length === 0) {
      history.push({
        role: "system",
        content: "You are a helpful assistant.",
      });
    }

    if (continuation) {
      history.push({
        role: "user",
        content: CONTINUE_PROMPT,
      });
    }

    // add user message
    history.push({ role: "user", content: prompt });

    // trim (token-based)
    const messages = trimMessagesByTokens(history, 8000);

    // ===== call LLM =====
    const stream = await openRouter.chat.send({
      model: "openai/gpt-4o",
      messages,
      stream: true,
    });

    let assistantReply = "";

    // streaming persistence init
    await appendPartial(conversationId, "");

    let lastPersist = Date.now();

    for await (const chunk of stream) {
      if (closed) break;

      if ("error" in chunk) {
        res.write(
          JSON.stringify({
            type: "error",
            message: chunk.error.message,
          }) + "\n",
        );
        break;
      }

      const content = chunk.choices?.[0]?.delta?.content;

      if (content) {
        assistantReply += content;

        // persist partial result
        if (Date.now() - lastPersist > 200) {
          await appendPartial(conversationId, assistantReply);
          lastPersist = Date.now();
        }

        res.write(
          JSON.stringify({
            type: "content",
            content,
          }) + "\n",
        );
      }
    }

    // ===== save assistant reply =====
    await clearPartial(conversationId);

    if (!closed && assistantReply) {
      history.push({ role: "assistant", content: assistantReply });
      await saveHistory(conversationId, history);

      // 异步持久化
      await chatQueue.add(QUEUE_NAME, {
        conversationId,
        messages: history.slice(-2), // 只存本轮 user + assistant
      });
    }

    res.write(JSON.stringify({ type: "end" }) + "\n");
    res.end();
  } catch (err) {
    res.write(
      JSON.stringify({
        type: "error",
        message: err.message,
      }) + "\n",
    );
    res.end();
  } finally {
    release();
  }
});

// health checker
app.get("/health", (_, res) => {
  res.send("ok");
});

await initDB();
app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});

/**
 * async function* chatStream(prompt) {
  const stream = await openRouter.chat.send({...});

  for await (const chunk of stream) {
    if ('error' in chunk) {
      throw new Error(chunk.error.message);
    }

    const content = chunk.choices?.[0]?.delta?.content;
    if (content) yield content;
  }
}
 */
