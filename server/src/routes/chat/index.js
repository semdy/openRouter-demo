import express from "express";
import completionsRouter from "./completions.js";
import conversationsRouter from "./conversations.js";

const router = express.Router();

router.use("/completions", completionsRouter);
router.use("/conversations", conversationsRouter);

export default router;
