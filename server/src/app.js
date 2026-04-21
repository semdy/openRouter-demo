import express from "express";
import { logger } from "./logger.js";
import { initDB } from "./db/initDB.js";
import apiRouter from "./routes/index.js";
import { cors } from "./middlewares/cors.js";

const app = express();

app.use(cors);
app.use(express.json());

app.use("/api", apiRouter);

app.get("/health/check", (_, res) => {
  res.send("ok");
});

app.use((err, req, res, next) => {
  res.status(400).json({ message: err.message });
});

await initDB();

app.listen(3000, () => {
  logger.info("Server started", { port: 3000 });
});
