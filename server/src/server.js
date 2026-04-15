import express from "express";
import { logger } from "./logger.js";
import { initDB } from "./db/initDB.js";
import {
  conversationMessagesHandler,
  conversationsHandler,
  conversationsStreamHandler,
  deleteConversationHandler,
  updateConversationHandler,
} from "./handlers/conversations.js";
import { completionsHandler } from "./handlers/completions.js";

const app = express();
app.use(express.json());

app.get("/api/conversations", conversationsHandler);
app.get("/api/conversations/stream", conversationsStreamHandler);
app.patch("/api/conversations/:conversationId", updateConversationHandler);
app.delete("/api/conversations/:conversationId", deleteConversationHandler);
app.get(
  "/api/conversations/:conversationId/messages",
  conversationMessagesHandler,
);

app.post("/api/completions", completionsHandler);

app.get("/health/check", (_, res) => {
  res.send("ok");
});

await initDB();

app.listen(3000, () => {
  logger.info("server_started", { port: 3000 });
});
