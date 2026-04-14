import express from "express";
import { randomUUID } from "node:crypto";
import { initDB } from "./db/initDB.js";
import { MAX_CONCURRENT } from "./config.js";
import { listConversations } from "./services/conversationService.js";
import { streamChatCompletion } from "./services/chatService.js";
import { logger } from "./logger.js";

const app = express();
app.use(express.json());

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

function writeSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.get("/api/conversations", async (req, res) => {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const { page: cursor, pageSize: limit } = req.query;

  try {
    const result = await listConversations({
      cursor: typeof cursor === "string" ? cursor : undefined,
      limit: typeof limit === "string" ? Number(limit) : undefined,
    });

    logger.info("conversation_list_fetched", {
      requestId,
      limit: typeof limit === "string" ? Number(limit) : undefined,
      returnedCount: result.items.length,
      hasNextPage: Boolean(result.nextCursor),
      durationMs: Date.now() - requestStartedAt,
    });

    res.json(result);
  } catch (error) {
    logger.error("conversation_list_failed", error, {
      requestId,
      durationMs: Date.now() - requestStartedAt,
    });
    res.status(400).json({
      error: error.message,
    });
  }
});

app.post("/api/completions", async (req, res) => {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();

  if (!acquire()) {
    logger.info("chat_request_rejected", {
      requestId,
      reason: "too_many_requests",
      currentRequests,
    });
    return res.status(429).json({ error: "Too many requests" });
  }

  const { prompt, conversationId, continuation } = req.body;
  logger.info("chat_request_started", {
    requestId,
    conversationId,
    continuation: Boolean(continuation),
    promptLength: prompt?.length ?? 0,
    currentRequests,
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientClosed = false;

  res.on("close", () => {
    if (!res.writableEnded) {
      clientClosed = true;
      logger.info("chat_request_client_closed", {
        requestId,
        conversationId,
        durationMs: Date.now() - requestStartedAt,
      });
    } else {
      logger.info("chat_response_closed", {
        requestId,
        conversationId,
        durationMs: Date.now() - requestStartedAt,
      });
    }
  });

  res.on("finish", () => {
    logger.info("chat_response_finished", {
      requestId,
      conversationId,
      durationMs: Date.now() - requestStartedAt,
    });
  });

  try {
    await streamChatCompletion({
      prompt,
      requestId,
      conversationId,
      continuation,
      onDelta: async (content) => {
        writeSSE(res, "delta", { content });
      },
      onConversationEvent: async (event, data) => {
        writeSSE(res, event, data);
      },
      isClientClosed: () => clientClosed,
    });

    if (!clientClosed && !res.writableEnded) {
      writeSSE(res, "end", {});
      res.end();
    }
  } catch (err) {
    logger.error("chat_request_failed", err, {
      requestId,
      conversationId,
      durationMs: Date.now() - requestStartedAt,
    });
    if (!res.writableEnded) {
      writeSSE(res, "error", {
        message: err.message,
      });
      res.end();
    }
  } finally {
    release();
    logger.info("chat_request_completed", {
      requestId,
      conversationId,
      currentRequests,
      durationMs: Date.now() - requestStartedAt,
      clientClosed,
    });
  }
});

// health checker
app.get("/health/check", (_, res) => {
  res.send("ok");
});

await initDB();

app.listen(3000, () => {
  logger.info("server_started", { port: 3000 });
});
