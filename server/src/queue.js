import { Queue } from "bullmq";
import Redis from "ioredis";
import { WORKER_NAME } from "./worker.js";

const connection = new Redis(process.env.REDIS_URL);

export const QUEUE_NAME = "persist";

export const chatQueue = new Queue(WORKER_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});
