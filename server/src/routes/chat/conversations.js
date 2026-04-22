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
import { ApiError } from "../../shared.js";

const router = express.Router();

router.get("/", getConversations);
router.get("/stream", updateConversationStream);
router.patch("/:conversationId", updateConversation);
router.delete("/:conversationId", deleteConversation);
router.get("/:conversationId/messages", getConversationMessages);

export async function getConversations(req, res) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const { cursor, pageSize, clientId } = req.query;

  if (!clientId) {
    throw new Error("Invalid clientId");
  }

  try {
    const result = await listConversations({
      clientId,
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
    throw new ApiError(error.message);
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
    throw new ApiError("Invalid conversationId");
  }

  if (!title) {
    throw new ApiError("title is required");
  }

  try {
    const conversation = await updateConversationTitle(conversationId, title);
    if (!conversation) {
      throw new ApiError("Conversation not found");
    }

    logger.info("conversation_title_updated", {
      requestId,
      conversationId,
      titleLength: title.length,
      durationMs: Date.now() - requestStartedAt,
    });

    return res.json(conversation);
  } catch (error) {
    logger.error("conversation_title_update_failed", error, {
      requestId,
      conversationId,
      durationMs: Date.now() - requestStartedAt,
    });

    throw new ApiError(error.message);
  }
}

export async function deleteConversation(req, res) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const conversationId = getConversationIdParam(req);

  if (!conversationId) {
    throw new ApiError("Invalid conversationId");
  }

  try {
    const result = await deleteConversationCascade(conversationId);
    if (!result) {
      throw new ApiError("Conversation not found", 404);
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

    throw new ApiError(error.message);
  }
}

export async function getConversationMessages(req, res) {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const conversationId = getConversationIdParam(req);

  if (!conversationId) {
    throw new ApiError("Invalid conversationId");
  }

  try {
    // const conversation = await getConversationListItem(conversationId);
    // if (!conversation) {
    //   // throw new ApiError("Conversation not found");
    //   return res.json({
    //     conversationId,
    //     items: [],
    //   });
    // }

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

    throw new ApiError(error.message);
  }
}

const conversationStreamClients = new Map();
const conversationSubscriber = createRedisSubscriber();

await conversationSubscriber.subscribe(CONVERSATION_UPDATES_CHANNEL);

conversationSubscriber.on("message", (channel, payload) => {
  if (channel !== CONVERSATION_UPDATES_CHANNEL) return;

  try {
    const parsedPayload = JSON.parse(payload);
    if (!parsedPayload || typeof parsedPayload !== "object") {
      logger.error("conversation_update_subscriber_invalid_payload_type");
      return;
    }
    const clientId =
      typeof parsedPayload.userId === "string"
        ? parsedPayload.userId.trim()
        : null;

    if (!clientId) {
      logger.error("conversation_update_subscriber_without_clientId");
      return;
    }

    const targets = conversationStreamClients.get(clientId);

    if (!targets?.size) {
      logger.error("conversation_update_subscriber_without_targets");
      return;
    }

    for (const res of targets) {
      writeSSE(res, "conversation_updated", parsedPayload);
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
  const clientId = req.query?.clientId?.trim();

  if (!clientId) {
    throw new ApiError("clientId is required");
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
