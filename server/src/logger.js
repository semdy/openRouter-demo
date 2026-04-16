import pino from "pino";

const isDev = process.env.NODE_ENV === "development";
// const isTTY = process.stdout.isTTY;

const transport = isDev /* && isTTY */
  ? {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
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
          msg: error instanceof Error ? error.message : event,
          stack: error instanceof Error ? error.stack : undefined,
          ...(fields || error),
        },
      ]);
    },
  },
  ...transport,
});

export { logger };
