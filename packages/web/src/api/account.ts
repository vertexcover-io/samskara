import { postJson } from "./client.js"
import type { ApiResult, LogoutAck, PairingCode } from "./types.js"

const asFields = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null

const parsePairingCode = (body: unknown): PairingCode | null => {
  const fields = asFields(body)
  if (!fields) return null
  return typeof fields.code === "string" && fields.code.length > 0 ? { code: fields.code } : null
}

const parseLogoutAck = (body: unknown): LogoutAck | null => {
  const fields = asFields(body)
  if (!fields) return null
  return fields.ok === true ? { ok: true } : null
}

export const requestPairingCode = (): Promise<ApiResult<PairingCode>> =>
  postJson("/api/auth/cli-code", parsePairingCode)

export const logout = (): Promise<ApiResult<LogoutAck>> =>
  postJson("/api/auth/logout", parseLogoutAck)
