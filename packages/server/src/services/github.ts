import type { Env } from "../lib/env.js"

export type GithubProfile = {
  readonly githubId: number
  readonly login: string
  readonly avatarUrl?: string
  readonly email?: string
}

export interface GithubClient {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>
  getProfile(accessToken: string): Promise<GithubProfile>
  getOrgs(accessToken: string): Promise<ReadonlyArray<string>>
  getVerifiedEmails(accessToken: string): Promise<ReadonlyArray<string>>
}

const jsonHeaders = (accessToken: string) => ({
  Accept: "application/json",
  Authorization: `Bearer ${accessToken}`,
  "User-Agent": "samskara",
})

const readJson = async (res: Response, context: string): Promise<unknown> => {
  if (!res.ok) throw new Error(`github ${context} failed (${res.status})`)
  return res.json()
}

export const createGithubClient = (env: Env): GithubClient => ({
  async exchangeCode(code, redirectUri) {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.githubClientId,
        client_secret: env.githubClientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    const body = (await readJson(res, "code exchange")) as { access_token?: string }
    if (!body.access_token) throw new Error("github code exchange failed")
    return { accessToken: body.access_token }
  },

  async getProfile(accessToken) {
    const res = await fetch("https://api.github.com/user", { headers: jsonHeaders(accessToken) })
    const body = (await readJson(res, "profile")) as {
      id: number
      login: string
      avatar_url?: string
      email?: string | null
    }
    return {
      githubId: body.id,
      login: body.login,
      avatarUrl: body.avatar_url,
      email: body.email ?? undefined,
    }
  },

  async getOrgs(accessToken) {
    const perPage = 100
    const maxPages = 10
    const logins: string[] = []
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`https://api.github.com/user/orgs?per_page=${perPage}&page=${page}`, {
        headers: jsonHeaders(accessToken),
      })
      const body = (await readJson(res, "orgs")) as ReadonlyArray<{ login: string }>
      logins.push(...body.map((org) => org.login.toLowerCase()))
      if (body.length < perPage) break
    }
    return logins
  },

  async getVerifiedEmails(accessToken) {
    const res = await fetch("https://api.github.com/user/emails", {
      headers: jsonHeaders(accessToken),
    })
    const body = (await readJson(res, "emails")) as ReadonlyArray<{
      email: string
      verified: boolean
    }>
    return body.filter((e) => e.verified).map((e) => e.email)
  },
})
