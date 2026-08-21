import type { InferResponseType } from "hono/client"
import type { Client } from "./client.js"

export type Ok<T> = InferResponseType<T, 200>

export type SyncStatusRow = Ok<Client["api"]["sync-status"]["$get"]>["rows"][number]
