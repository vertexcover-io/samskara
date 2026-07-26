import type { ApiError, ApiErrorKind, ApiResult } from "./types.js"

const failure = (kind: ApiErrorKind, message: string): ApiError => ({ kind, message })

const errorForStatus = (status: number): ApiError => {
  if (status === 401) return failure("unauthorized", "Your session has expired.")
  if (status === 404) return failure("notFound", "That resource does not exist.")
  return failure("server", `The server responded with ${status}.`)
}

const MALFORMED = Symbol("malformed")

const requestJson = async <T>(
  path: string,
  parse: (body: unknown) => T | null,
  init: RequestInit,
): Promise<ApiResult<T>> => {
  const response = await fetch(path, { credentials: "same-origin", ...init }).catch(() => null)

  if (!response) return { ok: false, error: failure("network", "The server is unreachable.") }
  if (!response.ok) return { ok: false, error: errorForStatus(response.status) }

  const body = await response.json().catch(() => MALFORMED)
  const parsed = body === MALFORMED ? null : parse(body)

  if (parsed === null) {
    return { ok: false, error: failure("server", "The server sent a malformed response.") }
  }

  return { ok: true, data: parsed }
}

export const getJson = <T>(
  path: string,
  parse: (body: unknown) => T | null,
  init?: RequestInit,
): Promise<ApiResult<T>> => requestJson(path, parse, { ...init })

export const postJson = <T>(
  path: string,
  parse: (body: unknown) => T | null,
): Promise<ApiResult<T>> => requestJson(path, parse, { method: "POST" })
