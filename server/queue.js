import { Queue } from "bullmq";
import Redis from "ioredis";

const connection = new Redis();

export const chatQueue = new Queue("chat-persist", {
  connection,
});
