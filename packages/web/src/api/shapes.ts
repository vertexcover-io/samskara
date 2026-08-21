import type { InferResponseType } from "hono/client"
import type { Client } from "./client.js"

export type Ok<T> = InferResponseType<T, 200>

export type SyncStatusRow = Ok<Client["api"]["sync-status"]["$get"]>["rows"][number]

export type ProjectSummary = Ok<Client["api"]["projects"]["$get"]>["projects"][number]
export type CurrentUser = Ok<Client["api"]["auth"]["me"]["$get"]>
export type PairingCode = Ok<Client["api"]["auth"]["cli-code"]["$post"]>
export type LogoutAck = Ok<Client["api"]["auth"]["logout"]["$post"]>
