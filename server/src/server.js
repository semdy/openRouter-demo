import express from "express";
import { logger } from "./logger.js";
import { initDB } from "./db/initDB.js";
import {
  getConversationMessages,
  getConversations,
  updateConversationStream,
  deleteConversation,
  updateConversation,
} from "./handlers/conversations.js";
import { completions } from "./handlers/completions.js";
import { cors } from "./middlewares/cors.js";

const app = express();

app.use(cors);
app.use(express.json());

app.get("/api/conversations", getConversations);
app.get("/api/conversations/stream", updateConversationStream);
app.patch("/api/conversations/:conversationId", updateConversation);
app.delete("/api/conversations/:conversationId", deleteConversation);
app.get(
  "/api/conversations/:conversationId/messages",
  getConversationMessages,
);

app.post("/api/completions", completions);

app.get("/health/check", (_, res) => {
  res.send("ok");
});

await initDB();

app.listen(3000, () => {
  logger.info("server_started", { port: 3000 });
});
