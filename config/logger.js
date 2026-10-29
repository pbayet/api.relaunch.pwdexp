import winston from "winston";
import "winston-daily-rotate-file";
import path from "node:path";

const production = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

const logDir = path.resolve("logs");

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.uncolorize(),
  winston.format.printf(
    ({ level, message, timestamp }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`,
  ),
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(
    ({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`,
  ),
);

// Rotation quotidienne, 14 jours de rétention. Rien sur disque en test.
const transports = isTest
  ? []
  : [
      new winston.transports.DailyRotateFile({
        dirname: path.join(logDir, "errors"),
        filename: "errors_%DATE%.log",
        datePattern: "YYYY-MM-DD",
        level: "error",
        maxSize: "20m",
        maxFiles: "14d",
        format: fileFormat,
      }),
      new winston.transports.DailyRotateFile({
        dirname: path.join(logDir, "success"),
        filename: "output_%DATE%.log",
        datePattern: "YYYY-MM-DD",
        level: "info",
        maxSize: "20m",
        maxFiles: "14d",
        format: fileFormat,
      }),
    ];

transports.push(
  new winston.transports.Console({ format: consoleFormat, silent: isTest }),
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (production ? "info" : "debug"),
  exitOnError: false,
  transports,
});
