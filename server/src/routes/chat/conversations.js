import express from "express";
import { randomUUID } from "node:crypto";
import { writeSSE } from "./shared.js";
import { createRedisSubscriber } from "../../redis.js";
import { logger } from "../../logger.js";
import {
  CONVERSATION_UPDATES_CHANNEL,
  deleteConversationCascade,
  getConversationListItem,
  getConversationMessages as getConversationMessagesService,
  listConversations,
  updateConversationTitle,
} from "../../services/conversations.js";

const router = express.Router();

router.get("/", getConversations);
router.get("/stream", updateConversationStream);
router.patch("/:conversationId", updateConversation);
router.delete("/:conversationId", deleteConversation);
router.get("/:conversationId/messages", getConversationMessages);

export async function getConversations(req, res) {
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

function getConversationIdParam(req) {
  const conversationId =
    typeof req.params?.conversationId === "string"
      ? req.params.conversationId.trim()
      : "";

  return conversationId;
}

export async function updateConversation(req, res) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const conversationId = getConversationIdParam(req);
  const rawTitle = req.body?.title;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";

  if (!conversationId) {
    return res.status(400).json({ error: "Invalid conversationId" });
  }

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const conversation = await updateConversationTitle(conversationId, title);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    logger.info("conversation_title_updated", {
      requestId,
      conversationId,
      titleLength: title.length,
      durationMs: Date.now() - requestStartedAt,
    });

    return res.json({ ...conversation });
  } catch (error) {
    logger.error("conversation_title_update_failed", error, {
      requestId,
      conversationId,
      durationMs: Date.now() - requestStartedAt,
    });

    return res.status(400).json({ error: error.message });
  }
}

export async function deleteConversation(req, res) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const conversationId = getConversationIdParam(req);

  if (!conversationId) {
    return res.status(400).json({ error: "Invalid conversationId" });
  }

  try {
    const result = await deleteConversationCascade(conversationId);
    if (!result) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    logger.info("conversation_deleted", {
      requestId,
      conversationId,
      deletedMessages: result.deletedMessages,
      durationMs: Date.now() - requestStartedAt,
    });

    return res.json({
      ok: true,
      conversationId: result.conversationId,
      deletedMessages: result.deletedMessages,
    });
  } catch (error) {
    logger.error("conversation_delete_failed", error, {
      requestId,
      conversationId,
      durationMs: Date.now() - requestStartedAt,
    });

    return res.status(400).json({ error: error.message });
  }
}

export async function getConversationMessages(req, res) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const conversationId = getConversationIdParam(req);

  if (!conversationId) {
    return res.status(400).json({ error: "Invalid conversationId" });
  }

  try {
    const conversation = await getConversationListItem(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const items = await getConversationMessagesService(conversationId);

    logger.info("conversation_messages_fetched", {
      requestId,
      conversationId,
      count: items.length,
      durationMs: Date.now() - requestStartedAt,
    });

    return res.json({
      conversationId,
      items,
    });
  } catch (error) {
    logger.error("conversation_messages_fetch_failed", error, {
      requestId,
      conversationId,
      durationMs: Date.now() - requestStartedAt,
    });

    return res.status(400).json({ error: error.message });
  }
}

const conversationStreamClients = new Map();
const conversationSubscriber = createRedisSubscriber();

await conversationSubscriber.subscribe(CONVERSATION_UPDATES_CHANNEL);

conversationSubscriber.on("message", (channel, payload) => {
  if (channel !== CONVERSATION_UPDATES_CHANNEL) return;

  try {
    const parsedPayload = JSON.parse(payload);

    if (parsedPayload.userId) {
      const targets = conversationStreamClients.get(parsedPayload.userId);
      if (!targets?.size) {
        return;
      }
      for (const res of targets) {
        writeSSE(res, "conversation_updated", parsedPayload);
      }
      return;
    }

    for (const clientResponses of conversationStreamClients.values()) {
      for (const res of clientResponses) {
        writeSSE(res, "conversation_updated", parsedPayload);
      }
    }
  } catch (error) {
    logger.error("conversation_update_subscriber_failed", error);
  }
});

function getClientsCount() {
  return Array.from(conversationStreamClients.values()).reduce(
    (total, entries) => total + entries.size,
    0,
  );
}

export async function updateConversationStream(req, res) {
  const requestId = randomUUID();
  const clientId = req.query.clientId;

  if (!clientId) {
    return res.status(400).json({ error: "clientId is required" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const clientResponses = conversationStreamClients.get(clientId) ?? new Set();
  clientResponses.add(res);
  conversationStreamClients.set(clientId, clientResponses);

  writeSSE(res, "ready", { ok: true });

  logger.info("conversation_stream_connected", {
    requestId,
    clientId,
    clientCount: getClientsCount(),
  });

  res.on("close", () => {
    const currentResponses = conversationStreamClients.get(clientId);
    currentResponses?.delete(res);
    if (currentResponses && currentResponses.size === 0) {
      conversationStreamClients.delete(clientId);
    }
    logger.info("conversation_stream_disconnected", {
      requestId,
      clientId,
      clientCount: getClientsCount(),
    });
  });
}

export default router;
