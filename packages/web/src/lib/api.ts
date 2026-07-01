// AI-generated. See PROMPT.md for the prompts and model used.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ArtifactContent,
  ArtifactMeta,
  RepoFacets,
  RepoSummary,
  SearchFacets,
  SearchResult,
  SessionCommit,
  SessionDetail,
  SessionListItem,
  ToolCallPair,
  TranscriptEvent,
  User,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const baseHeaders = (init?: HeadersInit): Headers => {
  const h = new Headers(init);
  h.set("accept", "application/json");
  return h;
};

export const apiFetch = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = baseHeaders(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : null) ??
      `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
};

// ----- Auth ---------------------------------------------------------------

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      qc.clear();
    },
  });
};

export const useMe = () =>
  useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<{ user: User }>("/api/auth/me"),
    retry: false,
    refetchOnWindowFocus: false,
  });

export interface CliCodeResponse {
  code: string;
  expiresInSeconds: number;
}

export const useCliCode = () =>
  useMutation({
    mutationFn: () => apiFetch<CliCodeResponse>("/api/auth/cli-code", { method: "POST" }),
  });

// ----- Repos --------------------------------------------------------------

export const useEnabledRepos = () =>
  useQuery({
    queryKey: ["repos"],
    queryFn: () => apiFetch<{ repos: RepoSummary[] }>("/api/repos"),
  });

export const useRepoSessions = (
  canonicalUrl: string | undefined,
  filters: { users?: string[]; branches?: string[] } = {},
) => {
  const users = filters.users ?? [];
  const branches = filters.branches ?? [];
  return useQuery({
    queryKey: ["repo-sessions", canonicalUrl, [...users].sort(), [...branches].sort()],
    enabled: !!canonicalUrl,
    queryFn: () => {
      const qs = new URLSearchParams();
      qs.set("repo", canonicalUrl ?? "");
      for (const u of users) qs.append("user", u);
      for (const b of branches) qs.append("branch", b);
      return apiFetch<{ repo: { canonical_url: string } | null; sessions: SessionListItem[] }>(
        `/api/repos/sessions?${qs.toString()}`,
      );
    },
  });
};

export const useRepoFacets = (canonicalUrl: string | undefined) =>
  useQuery({
    queryKey: ["repo-facets", canonicalUrl],
    enabled: !!canonicalUrl,
    queryFn: () =>
      apiFetch<RepoFacets>(`/api/repos/facets?repo=${encodeURIComponent(canonicalUrl ?? "")}`),
  });

// ----- Sessions -----------------------------------------------------------

export const useRecentSessions = (
  params: {
    limit?: number;
    agent?: string;
    branch?: string;
    repos?: string[];
    users?: string[];
  } = {},
) => {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.agent) qs.set("agent", params.agent);
  if (params.branch) qs.set("branch", params.branch);
  for (const r of params.repos ?? []) qs.append("repo", r);
  for (const u of params.users ?? []) qs.append("user", u);
  const url = `/api/sessions${qs.toString() ? `?${qs.toString()}` : ""}`;
  return useQuery({
    queryKey: ["recent-sessions", qs.toString()],
    queryFn: () => apiFetch<{ sessions: SessionListItem[] }>(url),
  });
};

export const useSession = (id: string | undefined) =>
  useQuery({
    queryKey: ["session", id],
    enabled: !!id,
    queryFn: () => apiFetch<SessionDetail>(`/api/sessions/${id}`),
  });

export const useSessionEvents = (id: string | undefined) =>
  useQuery({
    queryKey: ["session-events", id],
    enabled: !!id,
    queryFn: () => apiFetch<{ events: TranscriptEvent[] }>(`/api/sessions/${id}/events`),
  });

export const useSessionChildren = (id: string | undefined) =>
  useQuery({
    queryKey: ["session-children", id],
    enabled: !!id,
    queryFn: () => apiFetch<{ children: SessionListItem[] }>(`/api/sessions/${id}/children`),
  });

export const useSessionToolCalls = (id: string | undefined) =>
  useQuery({
    queryKey: ["session-tool-calls", id],
    enabled: !!id,
    queryFn: () => apiFetch<{ tool_calls: ToolCallPair[] }>(`/api/sessions/${id}/tool-calls`),
  });

export const useSessionCommits = (id: string | undefined) =>
  useQuery({
    queryKey: ["session-commits", id],
    enabled: !!id,
    queryFn: () => apiFetch<{ commits: SessionCommit[] }>(`/api/sessions/${id}/commits`),
  });

export const useSessionArtifacts = (id: string | undefined) =>
  useQuery({
    queryKey: ["session-artifacts", id],
    enabled: !!id,
    queryFn: () => apiFetch<{ artifacts: ArtifactMeta[] }>(`/api/sessions/${id}/artifacts`),
  });

export const useSessionArtifact = (id: string | undefined, artifactId: string | undefined) =>
  useQuery({
    queryKey: ["session-artifact", id, artifactId],
    enabled: !!id && !!artifactId,
    queryFn: () => apiFetch<ArtifactContent>(`/api/sessions/${id}/artifacts/${artifactId}`),
  });

// ----- Search -------------------------------------------------------------

export interface SearchFilters {
  q: string;
  repo?: string;
  branch?: string;
  agent?: string;
  model?: string;
  has_pr?: boolean;
  since?: string;
  limit?: number;
  tag?: string;
  user?: string;
}

export const useSearchFacets = () =>
  useQuery({
    queryKey: ["search-facets"],
    queryFn: () => apiFetch<SearchFacets>("/api/search/facets"),
  });

export const useSearch = (filters: SearchFilters | null) =>
  useQuery({
    queryKey: ["search", filters],
    // Run as long as the caller provided a filters object — empty `q` is
    // valid and triggers the server's recency-ordered listing path.
    enabled: !!filters,
    queryFn: () => {
      const qs = new URLSearchParams();
      if (!filters) {
        return Promise.resolve({
          results: [] as SearchResult[],
          strategy: "rrf" as "rrf" | "recency",
        });
      }
      // Only set `q` when non-empty — keeps the URL clean and avoids
      // sending an empty-string query.
      if (filters.q && filters.q.length > 0) qs.set("q", filters.q);
      if (filters.repo) qs.set("repo", filters.repo);
      if (filters.branch) qs.set("branch", filters.branch);
      if (filters.agent) qs.set("agent", filters.agent);
      if (filters.model) qs.set("model", filters.model);
      if (filters.tag) qs.set("tag", filters.tag);
      if (filters.user) qs.set("user", filters.user);
      if (filters.has_pr !== undefined) qs.set("has_pr", String(filters.has_pr));
      if (filters.since) qs.set("since", filters.since);
      if (filters.limit) qs.set("limit", String(filters.limit));
      return apiFetch<{ results: SearchResult[]; strategy: "rrf" | "recency" }>(
        `/api/search?${qs.toString()}`,
      );
    },
  });
