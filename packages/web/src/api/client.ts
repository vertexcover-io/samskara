import type { AppType } from "@samskara/server/app"
import { hc } from "hono/client"

export type ApiErrorKind = "unauthorized" | "notFound" | "network" | "server"

export type ApiError = {
  readonly kind: ApiErrorKind
  /** Stable API error code when the server supplied one. */
  readonly code: string | null
  readonly message: string
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError }

/** The web build is served beside the API, so a root-relative base is the whole URL. */
export const client = hc<AppType>("/", { init: { credentials: "same-origin" } })

export type Client = typeof client

type OkBody<R> = R extends { ok: true; json: () => Promise<infer B> } ? B : never

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

const networkFailure = (error: unknown): ApiError =>
  error instanceof Error && error.name === "AbortError"
    ? failure("network", "The request was cancelled.")
    : failure("network", "The server is unreachable.")

export const request = async <R extends Response>(
  send: () => Promise<R>,
): Promise<ApiResult<OkBody<R>>> => {
  let response: Response
  try {
    response = await send()
  } catch (error) {
    return { ok: false, error: networkFailure(error) }
  }

  const body: unknown = await response.json().catch(() => MALFORMED)
  if (!response.ok) return { ok: false, error: errorForStatus(response.status, errorCode(body)) }
  if (body === MALFORMED) {
    return { ok: false, error: failure("server", "The server sent a malformed response.") }
  }

  return { ok: true, data: body as OkBody<R> }
}
