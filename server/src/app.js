import express from "express";
// import cors from 'cors';
// import helmet from "helmet";
import { logger } from "./logger.js";
import { pool } from "./db/index.js";
import { initDB } from "./db/initDB.js";
import apiRouter from "./routes/index.js";
import { cors } from "./middlewares/cors.js";
import { PORT } from "./config.js";

const app = express();

// app.use(helmet());
// app.use(cors());
app.use(cors);
app.use(express.json());

app.use("/api", apiRouter);

// Simple health check endpoint
// app.get("/health/check", (_, res) => {
//   res.send("ok");
// });

// Health check for db connection
app.get("/health/check", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "healthy",
      timestamp: result.rows[0].now,
      uptime: process.uptime(),
    });
  } catch (error) {
    res
      .status(503)
      .json({ status: "unhealthy", error: "Database connection failed" });
  }
});

app.use((err, req, res, next) => {
  logger.error("Internal Error:", err);
  res
    .status(err.statusCode || 500)
    .json({ message: err.message, details: err.details || err.errors });
});

await initDB();

app.listen(PORT, () => {
  logger.info("Server started", { port: PORT });
});
