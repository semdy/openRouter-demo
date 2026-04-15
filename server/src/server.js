import express from "express";
import { logger } from "./logger.js";
import { initDB } from "./db/initDB.js";
import {
  getConversationMessagesHandler,
  getConversationsHandler,
  getConversationsStreamHandler,
  deleteConversationHandler,
  updateConversationHandler,
} from "./handlers/conversations.js";
import { completionsHandler } from "./handlers/completions.js";

const app = express();
const corsOriginsRaw = process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? "*";
const allowedCorsOrigins = corsOriginsRaw
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsAllowMethods =
  process.env.CORS_ALLOW_METHODS ?? "GET,POST,PATCH,DELETE,OPTIONS";
const corsAllowHeaders =
  process.env.CORS_ALLOW_HEADERS ?? "Content-Type,Authorization";
const corsAllowCredentials = process.env.CORS_ALLOW_CREDENTIALS === "true";

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const allowAllOrigins =
    allowedCorsOrigins.length === 0 || allowedCorsOrigins.includes("*");
  const originAllowed =
    allowAllOrigins ||
    (typeof requestOrigin === "string" &&
      allowedCorsOrigins.includes(requestOrigin));

  if (originAllowed) {
    if (allowAllOrigins) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (requestOrigin) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
    }
  }

  if (corsAllowCredentials && !allowAllOrigins && originAllowed) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Access-Control-Allow-Methods", corsAllowMethods);
  res.setHeader("Access-Control-Allow-Headers", corsAllowHeaders);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
});
app.use(express.json());

app.get("/api/conversations", getConversationsHandler);
app.get("/api/conversations/stream", getConversationsStreamHandler);
app.patch("/api/conversations/:conversationId", updateConversationHandler);
app.delete("/api/conversations/:conversationId", deleteConversationHandler);
app.get(
  "/api/conversations/:conversationId/messages",
  getConversationMessagesHandler,
);

app.post("/api/completions", completionsHandler);

app.get("/health/check", (_, res) => {
  res.send("ok");
});

await initDB();

app.listen(3000, () => {
  logger.info("server_started", { port: 3000 });
});
