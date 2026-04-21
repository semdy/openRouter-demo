import { Buffer } from "node:buffer";
import * as db from "../db/index.js";
import { redis } from "../redis.js";
import { logger } from "../logger.js";

export const CONVERSATION_UPDATES_CHANNEL = "conversation-updates";

function encodeCursor(lastMessageAt, id) {
  return Buffer.from(
    JSON.stringify({
      lastMessageAt,
      id,
    }),
  ).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;

  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!decoded?.lastMessageAt || !decoded?.id) {
    throw new Error("Invalid cursor");
  }

  return decoded;
}

function mapConversationRow(row) {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    summary: row.summary,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    lastMessageRole: row.lastMessageRole,
    lastMessageContent: row.lastMessageContent,
  };
}

function mapMessageRow(row) {
  return {
    messageId: row.messageId,
    parentMessageId: row.parentMessageId,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    messageIndex: row.messageIndex,
    model: row.model,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export async function getConversationListItem(conversationId) {
  const result = await db.query(
    `
      SELECT
        c.id,
        c.user_id AS "userId",
        c.title,
        c.summary,
        c.updated_at AS "updatedAt",
        c.last_message_at AS "lastMessageAt",
        c.created_at AS "createdAt",
        m.role AS "lastMessageRole",
        m.content AS "lastMessageContent"
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT role, content
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY message_index DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      ) m ON TRUE
      WHERE c.id = $1
      LIMIT 1
    `,
    [conversationId],
  );

  return result.rows[0] ? mapConversationRow(result.rows[0]) : null;
}

export async function listConversations({ clientId, cursor, pageSize = 20 }) {
  pageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const decodedCursor = decodeCursor(cursor);
  const params = [pageSize + 1];

  let cursorClause = "";
  if (decodedCursor) {
    params.push(decodedCursor.lastMessageAt, decodedCursor.id, clientId);
    cursorClause = `
      WHERE (c.last_message_at, c.id) < ($2::timestamptz, $3::text) AND c.user_id = $4
    `;
  } else {
    params.push(clientId);
    cursorClause += `WHERE c.user_id = $2`;
  }

  const result = await db.query(
    `
      SELECT
        c.id,
        c.user_id AS "userId",
        c.title,
        c.summary,
        c.updated_at AS "updatedAt",
        c.last_message_at AS "lastMessageAt",
        c.created_at AS "createdAt",
        m.role AS "lastMessageRole",
        m.content AS "lastMessageContent"
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT role, content
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY message_index DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      ) m ON TRUE
      ${cursorClause}
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT $1
    `,
    params,
  );

  const hasMore = result.rows.length > pageSize;
  const items = result.rows.slice(0, pageSize);
  const lastItem = items.at(-1);

  return {
    items: items.map(mapConversationRow),
    nextCursor:
      hasMore && lastItem
        ? encodeCursor(lastItem.lastMessageAt, lastItem.id)
        : null,
  };
}

export async function updateConversationTitle(conversationId, title) {
  const result = await db.query(
    `
      UPDATE conversations
      SET title = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `,
    [conversationId, title],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const conversation = await getConversationListItem(conversationId);
  if (!conversation) {
    return null;
  }

  if (conversation.userId) {
    try {
      await redis.publish(
        CONVERSATION_UPDATES_CHANNEL,
        JSON.stringify(conversation),
      );
    } catch (error) {
      logger.error("conversation_title_update_publish_failed", error, {
        conversationId,
      });
    }
  } else {
    logger.info("conversation_title_update_publish_without_clientId", {
      conversationId,
    });
  }

  return conversation;
}

export async function deleteConversationCascade(conversationId) {
  const dbClient = await db.getClient();
  try {
    await dbClient.query("BEGIN");

    const conversationResult = await dbClient.query(
      `
        SELECT id
        FROM conversations
        WHERE id = $1
        FOR UPDATE
      `,
      [conversationId],
    );

    if (conversationResult.rowCount === 0) {
      await dbClient.query("ROLLBACK");
      return null;
    }

    const messageDeleteResult = await dbClient.query(
      `
        DELETE FROM messages
        WHERE conversation_id = $1
      `,
      [conversationId],
    );

    await dbClient.query(
      `
        DELETE FROM conversations
        WHERE id = $1
      `,
      [conversationId],
    );

    await redis.del(
      `chat:${conversationId}`,
      `chat:partial:${conversationId}`,
      `chat:message-index:${conversationId}`,
    );

    await dbClient.query("COMMIT");

    return {
      conversationId,
      deletedMessages: messageDeleteResult.rowCount ?? 0,
    };
  } catch (error) {
    await dbClient.query("ROLLBACK");
    throw error;
  } finally {
    dbClient.release();
  }
}

export async function getConversationMessages(conversationId) {
  const result = await db.query(
    `
      SELECT
        message_id AS "messageId",
        parent_message_id AS "parentMessageId",
        role,
        content,
        message_index AS "messageIndex",
        model,
        metadata,
        created_at AS "createdAt"
      FROM messages
      WHERE conversation_id = $1
      ORDER BY
        COALESCE(message_index, 2147483647) ASC,
        created_at ASC,
        id ASC
    `,
    [conversationId],
  );

  return result.rows.map(mapMessageRow);
}
