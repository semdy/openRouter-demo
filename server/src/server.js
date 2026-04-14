import express from "express";
import { initDB } from "./db/initDB.js";
import { MAX_CONCURRENT } from "./config.js";
import { streamChatCompletion } from "./chatService.js";

const app = express();
app.use(express.json());

// ===== Simple concurrency control =====
let currentRequests = 0;

function acquire() {
  if (currentRequests >= MAX_CONCURRENT) return false;
  currentRequests++;
  return true;
}

function release() {
  currentRequests--;
}

function writeSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/conversation", async (req, res) => {
  if (!acquire()) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { prompt, conversationId, continuation } = req.body;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientClosed = false;

  res.on("close", () => {
    if (!res.writableEnded) {
      clientClosed = true;
      console.log("client disconnected early");
    } else {
      console.log("response closed after finish");
    }
  });

  res.on("finish", () => {
    console.log("response finished");
  });

  try {
    await streamChatCompletion({
      prompt,
      conversationId,
      continuation,
      onDelta: async (content) => {
        writeSSE(res, "delta", { content });
      },
      isClientClosed: () => clientClosed,
    });

    if (!clientClosed && !res.writableEnded) {
      writeSSE(res, "end", {});
      res.end();
    }
  } catch (err) {
    if (!res.writableEnded) {
      writeSSE(res, "error", {
        message: err.message,
      });
      res.end();
    }
  } finally {
    release();
  }
});

// health checker
app.get("/health/check", (_, res) => {
  res.send("ok");
});

await initDB();

app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
