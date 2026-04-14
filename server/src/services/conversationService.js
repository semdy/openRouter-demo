import { Buffer } from "node:buffer";
import { pool } from "../db/initDB.js";

export function buildConversationListItem({
  conversationId,
  userId = null,
  prompt,
  assistantReply,
  timestamp = new Date().toISOString(),
}) {
  const title = prompt?.replace(/\s+/g, " ").trim().slice(0, 80) || null;

  return {
    id: conversationId,
    userId,
    title,
    summary: null,
    updatedAt: timestamp,
    lastMessageAt: timestamp,
    createdAt: timestamp,
    lastMessageRole: "assistant",
    lastMessageContent: assistantReply,
  };
}

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

export async function listConversations({ cursor, limit = 20 }) {
  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const decodedCursor = decodeCursor(cursor);
  const params = [pageSize + 1];

  let cursorClause = "";
  if (decodedCursor) {
    params.push(decodedCursor.lastMessageAt, decodedCursor.id);
    cursorClause = `
      WHERE (c.last_message_at, c.id) < ($2::timestamptz, $3::text)
    `;
  }

  const result = await pool.query(
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
    items,
    nextCursor:
      hasMore && lastItem
        ? encodeCursor(lastItem.lastMessageAt, lastItem.id)
        : null,
  };
}
