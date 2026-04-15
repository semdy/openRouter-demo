import { Buffer } from "node:buffer";
import { pool } from "../db/initDB.js";

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

export async function getConversationListItem(conversationId) {
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
      WHERE c.id = $1
      LIMIT 1
    `,
    [conversationId],
  );

  return result.rows[0] ? mapConversationRow(result.rows[0]) : null;
}

export async function listConversations({ cursor, pageSize = 20 }) {
  pageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
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
    items: items.map(mapConversationRow),
    nextCursor:
      hasMore && lastItem
        ? encodeCursor(lastItem.lastMessageAt, lastItem.id)
        : null,
  };
}
