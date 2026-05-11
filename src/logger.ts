import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig): pino.Logger {
    return pino({
        level: config.logLevel,
        base: { service: "siyuan-extractor" },
        timestamp: pino.stdTimeFunctions.isoTime,
        transport:
            process.env.NODE_ENV === "production"
                ? undefined
                : {
                      target: "pino-pretty",
                      options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
                  },
    });
}

export type Logger = pino.Logger;
