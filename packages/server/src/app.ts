import { Hono } from "hono"

export const app = new Hono()

app.get("/health", (c) => c.json({ status: "ok" }))

// TODO(milestone): mount ./routes (GitHub OAuth + Organization gating, MCP route, ingest, search)
