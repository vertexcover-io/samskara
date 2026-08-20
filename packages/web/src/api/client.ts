import type { ApiError, ApiErrorKind, ApiResult } from "./types.js"

const failure = (kind: ApiErrorKind, message: string, code: string | null = null): ApiError => ({
  kind,
  code,
  message,
})

const errorCode = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null
  const error = (body as Record<string, unknown>).error
  return typeof error === "string" ? error : null
}

const errorForStatus = (status: number, code: string | null): ApiError => {
  if (status === 401) return failure("unauthorized", "Your session has expired.", code)
  if (status === 404) return failure("notFound", "That resource does not exist.", code)
  return failure("server", `The server responded with ${status}.`, code)
}

const MALFORMED = Symbol("malformed")

const requestJson = async <T>(
  path: string,
  parse: (body: unknown) => T | null,
  init: RequestInit,
): Promise<ApiResult<T>> => {
  let response: Response
  try {
    response = await fetch(path, { credentials: "same-origin", ...init })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: failure("network", "The request was cancelled.") }
    }
    return { ok: false, error: failure("network", "The server is unreachable.") }
  }

  const body = await response.json().catch(() => MALFORMED)
  if (!response.ok) return { ok: false, error: errorForStatus(response.status, errorCode(body)) }

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
