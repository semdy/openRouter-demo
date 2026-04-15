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
