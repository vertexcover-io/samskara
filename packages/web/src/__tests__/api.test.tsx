// AI-generated. See PROMPT.md for the prompts and model used.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  useEnabledRepos,
  useRecentSessions,
  useRepoFacets,
  useRepoSessions,
} from "../lib/api";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const captured: FetchCall[] = [];

const mockFetch = (responder: (url: string, init: RequestInit) => Response) => {
  captured.length = 0;
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push({ url, init });
    return responder(url, init);
  });
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  globalThis.fetch = mockFetch(() => jsonResponse(200, {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const wrap =
  (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

describe("apiFetch", () => {
  it("sends credentials: include and accept: application/json", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { ok: true }));
    await apiFetch<{ ok: boolean }>("/api/foo");
    expect(captured[0]?.url).toBe("/api/foo");
    expect(captured[0]?.init.credentials).toBe("include");
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("sets content-type when a body is supplied", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { ok: true }));
    await apiFetch("/api/post", { method: "POST", body: JSON.stringify({ a: 1 }) });
    const headers = new Headers(captured[0]?.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("throws ApiError with status on non-2xx", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(401, { error: "unauthorized" }));
    await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("useEnabledRepos", () => {
  it("GETs /api/repos and returns repo list", async () => {
    globalThis.fetch = mockFetch(() =>
      jsonResponse(200, {
        repos: [
          {
            id: "r-1",
            canonical_url: "github.com/x/y",
            display_name: null,
            access: "owner",
            session_count: 1,
            last_activity: null,
          },
        ],
      }),
    );
    const qc = new QueryClient();
    const { result } = renderHook(() => useEnabledRepos(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(captured[0]?.url).toBe("/api/repos");
    expect(result.current.data?.repos).toHaveLength(1);
  });
});

describe("useRepoSessions / useRepoFacets", () => {
  const canonical = "github.com/vertexcover-io/claude-sessions";

  it("requests /api/repos/sessions with repo as a query param (not path)", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { repo: null, sessions: [] }));
    const qc = new QueryClient();
    const { result } = renderHook(() => useRepoSessions(canonical, { branches: ["main"] }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = captured[0]?.url ?? "";
    expect(url).toMatch(/^\/api\/repos\/sessions\?/);
    expect(url).toContain(`repo=${encodeURIComponent(canonical)}`);
    expect(url).toContain("branch=main");
    expect(url).not.toContain(`${encodeURIComponent(canonical)}/sessions`);
  });

  it("requests /api/repos/facets with repo as a query param (not path)", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { branches: [], users: [] }));
    const qc = new QueryClient();
    const { result } = renderHook(() => useRepoFacets(canonical), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = captured[0]?.url ?? "";
    expect(url).toBe(`/api/repos/facets?repo=${encodeURIComponent(canonical)}`);
  });
});

describe("useRecentSessions", () => {
  it("appends query params to /api/sessions", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { sessions: [] }));
    const qc = new QueryClient();
    const { result } = renderHook(() => useRecentSessions({ limit: 5, agent: "claude-code" }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = captured[0]?.url ?? "";
    expect(url).toMatch(/^\/api\/sessions\?/);
    expect(url).toContain("limit=5");
    expect(url).toContain("agent=claude-code");
  });
});
