import { useEffect, useState } from "react"

type CurrentUser = {
  readonly id: string
  readonly githubLogin: string
  readonly email: string | null
  readonly name: string | null
  readonly avatarUrl: string | null
}

export function App() {
  const [user, setUser] = useState<CurrentUser | null>(null)

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .catch(() => setUser(null))
  }, [])

  return (
    <main className="grid min-h-dvh place-items-center gap-4 text-2xl font-semibold">
      <h1>samskara</h1>
      {user ? (
        <p className="text-base">Signed in as {user.githubLogin}</p>
      ) : (
        <a
          href="/api/auth/github/start"
          className="rounded bg-neutral-900 px-4 py-2 text-base text-white"
        >
          Login with GitHub
        </a>
      )}
    </main>
  )
}
