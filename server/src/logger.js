import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const isTTY = process.stdout.isTTY;

const transport =
  isDev && isTTY ? { transport: { target: "pino-pretty" } } : {};

const logger = pino({
  ...transport,
});

export { logger };
