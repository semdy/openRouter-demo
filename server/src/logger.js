import pino from "pino";

const isDev = process.env.NODE_ENV === "development";
// const isTTY = process.stdout.isTTY;

const options = isDev /* && isTTY */
  ? {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          // destination: "./logs/log.log",
        },
      },
    }
  : process.env.LOG_ROTATE === "true"
    ? {
        transport: {
          target: "pino-roll",
          options: {
            file: "logs/log",
            frequency: "daily",
            dateFormat: "yyyy.MM.dd",
            mkdir: true,
          },
        },
      }
    : {};

const logger = pino({
  hooks: {
    logMethod(args, method) {
      const [event, error, fields] = args;
      if (
        event instanceof Error ||
        (typeof event === "string" &&
          ((!fields && !error) || /%[sdoOj]/.test(event)))
      ) {
        return method.apply(this, [event]);
      }
      return method.apply(this, [
        {
          msg: event,
          errMsg: error instanceof Error ? error.message : undefined,
          stack: error instanceof Error ? error.stack : undefined,
          ...(fields || error),
        },
      ]);
    },
  },
  ...options,
});

export { logger };
