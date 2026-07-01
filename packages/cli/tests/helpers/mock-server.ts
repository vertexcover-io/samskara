// AI-generated. See PROMPT.md for the prompts and model used.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Tiny in-process HTTP mock server for the CLI tests.
 *
 * Records every request, lets the test inspect bodies, and supports
 * scripted failure sequences (HTTP 500 N times then 200) to drive the
 * retry/backoff tests (REQ-045). Built on `node:http` so we don't need
 * undici MockAgent wiring.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface RawHandlerResult {
  status: number;
  contentType?: string;
  bytes: Uint8Array | Buffer;
}

export type Handler = (req: RecordedRequest) => { status: number; body: unknown };
export type RawHandler = (req: RecordedRequest) => RawHandlerResult;

export interface MockServerHandle {
  url: string;
  requests: RecordedRequest[];
  /** Push a one-shot response (FIFO) — overrides default OK for the matching path. */
  enqueue: (path: string, status: number, body?: unknown) => void;
  setHandler: (path: string, handler: Handler) => void;
  /** Like setHandler but the response body is raw bytes (e.g. NDJSON blobs). */
  setRawHandler: (path: string, handler: RawHandler) => void;
  /** Match a method+path tuple to a JSON handler. */
  setMethodHandler: (method: string, path: string, handler: Handler) => void;
  stop: () => Promise<void>;
}

export const startMockServer = async (): Promise<MockServerHandle> => {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, Handler>();
  const rawHandlers = new Map<string, RawHandler>();
  const methodHandlers = new Map<string, Handler>();
  const oneShots = new Map<string, Array<{ status: number; body: unknown }>>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const path = req.url ?? "";
      const method = req.method ?? "";
      const recorded: RecordedRequest = { method, path, body };
      requests.push(recorded);

      const queue = oneShots.get(path);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        if (next) {
          res.statusCode = next.status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(next.body ?? {}));
          return;
        }
      }
      // Method+path handler takes precedence over plain-path handler.
      const methodHandler = methodHandlers.get(`${method} ${path}`);
      if (methodHandler) {
        const out = methodHandler(recorded);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.body ?? {}));
        return;
      }
      const rawHandler = rawHandlers.get(path);
      if (rawHandler) {
        const out = rawHandler(recorded);
        res.statusCode = out.status;
        res.setHeader("content-type", out.contentType ?? "application/octet-stream");
        const buf = out.bytes instanceof Buffer ? out.bytes : Buffer.from(out.bytes);
        res.end(buf);
        return;
      }
      const handler = handlers.get(path);
      if (handler) {
        const out = handler(recorded);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.body ?? {}));
        return;
      }
      // Default: 200 echoing the real server's contract — account for every
      // event we received (all counted as freshly accepted). The client's
      // offset-verification (accepted + duplicates === sent) depends on this;
      // a mock that always reported 0 would spuriously fail verification.
      const sentEvents =
        body && typeof body === "object" && Array.isArray((body as { events?: unknown[] }).events)
          ? (body as { events: unknown[] }).events.length
          : 0;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, accepted_events: sentEvents, skipped_duplicates: 0 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    requests,
    enqueue: (path, status, body) => {
      const queue = oneShots.get(path) ?? [];
      queue.push({ status, body: body ?? {} });
      oneShots.set(path, queue);
    },
    setHandler: (path, handler) => handlers.set(path, handler),
    setRawHandler: (path, handler) => rawHandlers.set(path, handler),
    setMethodHandler: (method, path, handler) => methodHandlers.set(`${method} ${path}`, handler),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
