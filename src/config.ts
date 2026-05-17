import { env } from "node:process";

export interface AppConfig {
    siyuanUrl: string;
    siyuanToken: string;
    webhookSecret: string;
    host: string;
    port: number;
    readerUrl: string;
    ingestSecret: string;
    emitHtml: boolean;
    logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

function required(name: string, value: string | undefined): string {
    if (!value || value.trim() === "") {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value.trim();
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }
    return value === "true" || value === "1";
}

function parseInt10(value: string | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        throw new Error(`Invalid integer: ${value}`);
    }
    return parsed;
}

function parseLogLevel(value: string | undefined): AppConfig["logLevel"] {
    const allowed: AppConfig["logLevel"][] = ["trace", "debug", "info", "warn", "error", "fatal"];
    const level = (value ?? "info") as AppConfig["logLevel"];
    if (!allowed.includes(level)) {
        throw new Error(`Invalid LOG_LEVEL: ${value}. Allowed: ${allowed.join(", ")}`);
    }
    return level;
}

export function loadConfig(): AppConfig {
    return {
        siyuanUrl: required("SIYUAN_URL", env.SIYUAN_URL).replace(/\/+$/, ""),
        siyuanToken: required("SIYUAN_TOKEN", env.SIYUAN_TOKEN),
        webhookSecret: env.WEBHOOK_SECRET?.trim() ?? "",
        host: env.HOST?.trim() || "0.0.0.0",
        port: parseInt10(env.PORT, 3000),
        readerUrl: required("READER_URL", env.READER_URL).replace(/\/+$/, ""),
        ingestSecret: required("INGEST_SECRET", env.INGEST_SECRET),
        emitHtml: parseBool(env.EMIT_HTML, true),
        logLevel: parseLogLevel(env.LOG_LEVEL),
    };
}
