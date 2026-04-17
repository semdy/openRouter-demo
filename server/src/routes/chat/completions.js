import express from "express";
import { randomUUID } from "node:crypto";
import { writeSSE } from "./shared.js";
import { logger } from "../../logger.js";
import { streamChatCompletion } from "../../services/completions.js";
import { MAX_CONCURRENT } from "../../config.js";

const router = express.Router();

router.post("/", completions);

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

export async function completions(req, res) {
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

  const { prompt, conversationId, clientId, continuation } = req.body;
  const resolvedConversationId =
    typeof conversationId === "string" ? conversationId.trim() : randomUUID();

  logger.info("chat_request_started", {
    requestId,
    conversationId: resolvedConversationId,
    clientId,
    continuation: Boolean(continuation),
    promptLength: prompt?.length ?? 0,
    currentRequests,
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Conversation-Id", resolvedConversationId);
  res.flushHeaders?.();

  let clientClosed = false;

  res.on("close", () => {
    if (!res.writableEnded) {
      clientClosed = true;
      logger.info("chat_request_client_closed", {
        requestId,
        conversationId: resolvedConversationId,
        durationMs: Date.now() - requestStartedAt,
      });
    } else {
      logger.info("chat_response_closed", {
        requestId,
        conversationId: resolvedConversationId,
        durationMs: Date.now() - requestStartedAt,
      });
    }
  });

  res.on("finish", () => {
    logger.info("chat_response_finished", {
      requestId,
      conversationId: resolvedConversationId,
      durationMs: Date.now() - requestStartedAt,
    });
  });

  try {
    await streamChatCompletion({
      prompt,
      requestId,
      conversationId: resolvedConversationId,
      userId: clientId,
      continuation,
      onDelta: async (content) => {
        writeSSE(res, "delta", { content });
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
      conversationId: resolvedConversationId,
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
      conversationId: resolvedConversationId,
      clientId,
      currentRequests,
      durationMs: Date.now() - requestStartedAt,
      clientClosed,
    });
  }
}

export default router;
