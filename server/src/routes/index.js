import express from "express";
import chatRouter from "./chat/index.js";

const router = express.Router();

router.use("/chat", chatRouter);

export default router;
