import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { IngestClient, IngestError } from "../ingest-client.js";
import type { AppConfig } from "../config.js";

const config: AppConfig = {
    siyuanUrl: "http://siyuan",
    siyuanToken: "x",
    webhookSecret: "",
    host: "0.0.0.0",
    port: 3000,
    readerUrl: "https://reader.test",
    ingestSecret: "test-ingest-secret-with-at-least-32chars",
    emitHtml: true,
    logLevel: "fatal",
};

const silentLogger = pino({ level: "silent" });
const client = new IngestClient(config, silentLogger);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
    return new Response(null, { status, headers });
}

beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

describe("IngestClient — auth", () => {
    it("sets Authorization: Bearer on every request", async () => {
        fetchMock().mockResolvedValue(emptyResponse(200, { "x-request-id": "r1" }));
        await client.headAsset("proj", "a".repeat(64));
        const [, init] = fetchMock().mock.calls[0];
        const headers = new Headers((init as RequestInit).headers);
        expect(headers.get("authorization")).toBe(`Bearer ${config.ingestSecret}`);
    });
});

describe("IngestClient — headAsset", () => {
    it("returns true on 200", async () => {
        fetchMock().mockResolvedValue(emptyResponse(200));
        expect(await client.headAsset("proj", "a".repeat(64))).toBe(true);
    });
    it("returns false on 404", async () => {
        fetchMock().mockResolvedValue(emptyResponse(404));
        expect(await client.headAsset("proj", "a".repeat(64))).toBe(false);
    });
    it("throws on unexpected status (e.g. 400)", async () => {
        fetchMock().mockResolvedValue(emptyResponse(400, { "x-request-id": "rq" }));
        await expect(client.headAsset("proj", "a".repeat(64))).rejects.toBeInstanceOf(IngestError);
    });
});

describe("IngestClient — postAsset", () => {
    it("returns ingested on 200 { status: 'ingested' }", async () => {
        fetchMock().mockResolvedValue(
            jsonResponse(200, { status: "ingested", sha256: "a", sizeBytes: 3, requestId: "r" }),
        );
        const r = await client.postAsset("proj", "a".repeat(64), "image/png", Buffer.from("xxx"));
        expect(r.status).toBe("ingested");
    });
    it("returns exists on 200 { status: 'exists' }", async () => {
        fetchMock().mockResolvedValue(
            jsonResponse(200, { status: "exists", sha256: "a", requestId: "r" }),
        );
        const r = await client.postAsset("proj", "a".repeat(64), "image/png", Buffer.from("xxx"));
        expect(r.status).toBe("exists");
    });
    it("throws IngestError on 4xx (e.g. 413 payload_too_large)", async () => {
        fetchMock().mockResolvedValue(
            jsonResponse(413, { error: "payload_too_large", limitBytes: 4194304, requestId: "r" }),
        );
        await expect(
            client.postAsset("proj", "a".repeat(64), "image/png", Buffer.from("xxx")),
        ).rejects.toMatchObject({ name: "IngestError", status: 413, code: "payload_too_large" });
    });
});

describe("IngestClient — postDoc", () => {
    const samplePayload = {
        schema: "siyuan-snapshot/v1" as const,
        doc: {
            id: "20260517100000-aaaaaaa",
            project: "proj",
            slug: "p",
            title: "t",
            excerpt: "",
            version: 1,
            published_at: "2026-05-17T10:00:00.000Z",
            updated_at: "2026-05-17T10:00:00.000Z",
        },
        content: { blocks: [] },
        content_hash: "a".repeat(64),
        assets: [],
        outbound_refs: [],
        search_text: "",
        html: null,
    };

    it("maps 200 ingested", async () => {
        fetchMock().mockResolvedValue(jsonResponse(200, { status: "ingested", requestId: "r" }));
        const r = await client.postDoc(samplePayload);
        expect(r.status).toBe("ingested");
    });

    it("maps 200 unchanged", async () => {
        fetchMock().mockResolvedValue(jsonResponse(200, { status: "unchanged", requestId: "r" }));
        const r = await client.postDoc(samplePayload);
        expect(r.status).toBe("unchanged");
    });

    it("maps 409 missing_asset into a typed result (no throw)", async () => {
        const missing = ["a".repeat(64), "b".repeat(64)];
        fetchMock().mockResolvedValue(
            jsonResponse(409, { error: "missing_asset", missing, requestId: "r" }),
        );
        const r = await client.postDoc(samplePayload);
        expect(r.status).toBe("missing_asset");
        if (r.status === "missing_asset") {
            expect(r.missing).toEqual(missing);
        }
    });

    it("throws on 401", async () => {
        fetchMock().mockResolvedValue(jsonResponse(401, { error: "unauthorized", requestId: "r" }));
        await expect(client.postDoc(samplePayload)).rejects.toMatchObject({
            name: "IngestError",
            status: 401,
        });
    });
});

describe("IngestClient — postUnpublish", () => {
    it("maps 200 removed", async () => {
        fetchMock().mockResolvedValue(jsonResponse(200, { status: "removed", requestId: "r" }));
        const r = await client.postUnpublish("proj", "20260517100000-aaaaaaa");
        expect(r.status).toBe("removed");
    });
    it("maps 200 already_absent", async () => {
        fetchMock().mockResolvedValue(jsonResponse(200, { status: "already_absent", requestId: "r" }));
        const r = await client.postUnpublish("proj", "20260517100000-aaaaaaa");
        expect(r.status).toBe("already_absent");
    });
});
