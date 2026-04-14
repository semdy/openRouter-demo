import { pool } from "./db/initDB.js";
import {
  CACHE_TTL_SECONDS,
  MAX_PROMPT_TOKENS,
  MAX_TURNS,
  PARTIAL_CACHE_TTL_SECONDS,
  SYSTEM_PROMPT,
} from "./config.js";
import { redis } from "./redis.js";
import {
  countMessageTokens,
  trimMessagesByTokens,
  trimMessagesByTurns,
} from "./tokenizer.js";

export async function appendPartial(conversationId, partial) {
  await redis.set(
    `chat:partial:${conversationId}`,
    partial,
    "EX",
    PARTIAL_CACHE_TTL_SECONDS,
  );
}

export async function clearPartial(conversationId) {
  await redis.del(`chat:partial:${conversationId}`);
}

export async function getHistory(conversationId) {
  const data = await redis.get(`chat:${conversationId}`);
  let cachedHistory = [];

  if (data) {
    cachedHistory = withSystemPrompt(JSON.parse(data));
  }

  const oldestCachedMessageIndex = cachedHistory
    .filter((message) => message.role !== "system")
    .reduce((minIndex, message) => {
      if (typeof message.messageIndex !== "number") {
        return minIndex;
      }
      return Math.min(minIndex, message.messageIndex);
    }, Number.POSITIVE_INFINITY);

  const needsBackfill =
    cachedHistory.length === 0 ||
    (Number.isFinite(oldestCachedMessageIndex) &&
      countMessageTokens(cachedHistory) < MAX_PROMPT_TOKENS);

  if (!needsBackfill) {
    return cachedHistory;
  }

  if (cachedHistory.length === 0) {
    const result = await pool.query(
      `
        SELECT role, content, message_index AS "messageIndex"
        FROM (
          SELECT role, content, message_index, created_at, id
          FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2
        ) recent
        ORDER BY
          COALESCE(message_index, 2147483647) ASC,
          created_at ASC,
          id ASC
      `,
      [conversationId, MAX_TURNS * 2],
    );

    if (result.rows.length === 0) {
      return withSystemPrompt([]);
    }

    const history = withSystemPrompt(result.rows);
    await saveHistory(conversationId, history);
    return history;
  }

  const result = await pool.query(
    `
      SELECT role, content, message_index AS "messageIndex"
      FROM messages
      WHERE conversation_id = $1
        AND message_index < $2
      ORDER BY message_index DESC
      LIMIT $3
    `,
    [conversationId, oldestCachedMessageIndex, MAX_TURNS * 4],
  );

  if (result.rows.length === 0) {
    return cachedHistory;
  }

  const backfilledHistory = [...result.rows.reverse(), ...cachedHistory];
  const history = trimMessagesByTokens(
    withSystemPrompt(backfilledHistory),
    MAX_PROMPT_TOKENS,
  );

  await saveHistory(conversationId, history);
  return history;
}

export async function saveHistory(conversationId, messages) {
  const historyForCache = trimMessagesByTurns(withSystemPrompt(messages));
  await redis.set(
    `chat:${conversationId}`,
    JSON.stringify(historyForCache),
    "EX",
    CACHE_TTL_SECONDS,
  );
}

async function getCurrentMaxMessageIndex(conversationId) {
  const result = await pool.query(
    `
      SELECT COALESCE(MAX(message_index), -1) AS max_index
      FROM messages
      WHERE conversation_id = $1
    `,
    [conversationId],
  );

  return Number(result.rows[0]?.max_index ?? -1);
}

export async function reserveMessageIndexes(conversationId, count) {
  const counterKey = `chat:message-index:${conversationId}`;

  if (!(await redis.exists(counterKey))) {
    const currentMax = await getCurrentMaxMessageIndex(conversationId);
    await redis.set(counterKey, currentMax, "NX");
  }

  const endIndex = await redis.incrby(counterKey, count);
  return endIndex - count + 1;
}

export function withSystemPrompt(messages) {
  const rest = messages.filter((m) => m.role !== "system");
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    ...rest,
  ];
}
