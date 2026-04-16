import path from "node:path";
import fs from "node:fs";

export class Logger {
  static levels = ["fatal", "error", "warn", "info", "debug", "trace"];

  constructor(logFilePath) {
    this.logLevelIndex = Logger.levels.indexOf("info");

    if (logFilePath) {
      logFilePath = path.normalize(logFilePath);
      this.stream = fs.createWriteStream(logFilePath, {
        flags: "a",
        encoding: "utf8",
        mode: 0o666,
      });
    }
  }

  setLevel(level) {
    const index = Logger.levels.indexOf(level);
    if (index === -1) {
      this.logLevelIndex = Logger.levels.indexOf("info");
      console.warn(`Invalid log level: ${level}, falling back to "info"`);
      return;
    }
    this.logLevelIndex = index;
  }

  format(level, event, fields) {
    return JSON.stringify({
      level: level.toUpperCase(),
      event,
      timestamp: new Date().toISOString(),
      ...(typeof fields === "string" ? { msg: fields } : fields),
    });
  }

  log(level, event, fields) {
    const levelIndex = Logger.levels.indexOf(level);
    if (levelIndex === -1 || levelIndex > this.logLevelIndex) return;

    const message = this.format(level, event, fields);
    if (level === "error") {
      console.error(message);
      return;
    }

    console.log(message);
  }

  info(event, fields) {
    this.log("info", event, fields);
  }

  fatal(event, fields) {
    this.log("fatal", event, fields);
  }

  error(event, error, fields) {
    this.log("error", event, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...fields,
    });
  }

  warn(event, fields) {
    this.log("warn", event, fields);
  }

  debug(event, fields) {
    this.log("debug", event, fields);
  }

  trace(event, fields) {
    this.log("trace", event, fields);
  }

  logToFile(level, event, fields) {
    const message = this.format(level, event, fields);
    this.stream?.write(message + "\n");
  }
}

export function createLogger(logFilePath) {
  return new Logger(logFilePath);
}

export const logger = new Logger();

if (process.env.LOG_LEVEL) {
  logger.setLevel(process.env.LOG_LEVEL);
}
