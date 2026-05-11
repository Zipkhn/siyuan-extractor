import Fastify from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Extractor } from "./extractor.js";
import type { WebhookPayload } from "./types.js";

const config = loadConfig();
const logger = createLogger(config);
const extractor = new Extractor(config, logger);

const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024, // 1 MB — webhooks are tiny
});

// The plugin runs in the user's browser at http://localhost:6806 and POSTs
// here cross-origin. Allow that explicitly. In prod, restrict to the actual
// Siyuan origin.
await app.register(cors, {
    origin: (origin, cb) => {
        if (!origin) {
            // Same-origin / curl / server-to-server : allow.
            cb(null, true);
            return;
        }
        try {
            const { hostname } = new URL(origin);
            if (hostname === "localhost" || hostname === "127.0.0.1") {
                cb(null, true);
                return;
            }
        } catch {
            // fallthrough
        }
        cb(new Error(`Origin ${origin} not allowed`), false);
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Publish-Secret"],
    credentials: false,
});

app.get("/health", async () => ({ status: "ok" }));

const WEBHOOK_PAYLOAD_SCHEMA = {
    type: "object",
    required: ["event", "project", "docId", "version", "publishedAt"],
    additionalProperties: false,
    properties: {
        event: { type: "string", enum: ["publish", "unpublish"] },
        project: { type: "string", pattern: "^[a-z0-9-]+$" },
        docId: { type: "string", pattern: "^[0-9]{14}-[a-z0-9]{7}$" },
        version: { type: "integer", minimum: 0 },
        publishedAt: { type: "string", format: "date-time" },
    },
} as const;

app.post<{ Body: WebhookPayload }>(
    "/webhook",
    {
        schema: { body: WEBHOOK_PAYLOAD_SCHEMA },
    },
    async (request, reply) => {
        if (!verifySecret(request.headers["x-publish-secret"], config.webhookSecret)) {
            request.log.warn({ ip: request.ip }, "webhook rejected: bad secret");
            return reply.code(401).send({ error: "Invalid X-Publish-Secret header" });
        }
        const payload = request.body;
        try {
            if (payload.event === "publish") {
                const result = await extractor.handlePublish(payload);
                return reply.send({ ok: true, ...result });
            }
            const result = await extractor.handleUnpublish(payload);
            return reply.send({ ok: true, ...result });
        } catch (e) {
            request.log.error({ err: errToObj(e), payload }, "webhook handler failed");
            return reply.code(500).send({ error: e instanceof Error ? e.message : "internal error" });
        }
    },
);

function verifySecret(header: string | string[] | undefined, expected: string): boolean {
    if (!expected) {
        // No secret configured server-side → accept any request (insecure; dev-only).
        return true;
    }
    const got = Array.isArray(header) ? header[0] : header;
    if (typeof got !== "string" || got.length !== expected.length) {
        return false;
    }
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function errToObj(e: unknown): Record<string, unknown> {
    if (e instanceof Error) {
        return { name: e.name, message: e.message, stack: e.stack };
    }
    return { value: String(e) };
}

async function main(): Promise<void> {
    try {
        await app.listen({ host: config.host, port: config.port });
    } catch (e) {
        logger.fatal({ err: errToObj(e) }, "failed to start server");
        process.exit(1);
    }
}

void main();
