import { randomUUID } from "node:crypto";
import { writeSSE } from "./common.js";
import { createRedisSubscriber } from "../redis.js";
import { logger } from "../logger.js";
import {
  CONVERSATION_UPDATES_CHANNEL,
  listConversations,
} from "../services/conversationService.js";

export async function conversationsHandler(req, res) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const { cursor, pageSize } = req.query;

  try {
    const result = await listConversations({
      cursor: typeof cursor === "string" ? cursor : undefined,
      pageSize: typeof pageSize === "string" ? Number(pageSize) : undefined,
    });

    logger.info("conversation_list_fetched", {
      requestId,
      pageSize: typeof pageSize === "string" ? Number(pageSize) : undefined,
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
}

const conversationStreamClients = new Set();
const conversationSubscriber = createRedisSubscriber();

await conversationSubscriber.subscribe(CONVERSATION_UPDATES_CHANNEL);

conversationSubscriber.on("message", (channel, payload) => {
  if (channel !== CONVERSATION_UPDATES_CHANNEL) return;

  for (const res of conversationStreamClients) {
    res.write(`event: conversation_updated\ndata: ${payload}\n\n`);
  }
});

export async function conversationsStreamHandler(req, res) {
  const requestId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  conversationStreamClients.add(res);

  writeSSE(res, "ready", { ok: true });

  logger.info("conversation_stream_connected", {
    requestId,
    clients: conversationStreamClients.size,
  });

  res.on("close", () => {
    conversationStreamClients.delete(res);
    logger.info("conversation_stream_disconnected", {
      requestId,
      clients: conversationStreamClients.size,
    });
  });
}
