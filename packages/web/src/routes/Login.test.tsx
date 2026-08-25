import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { expect, test } from "vitest"
import { Login } from "./Login.js"

test("S1: the sign-in control is an anchor to /api/auth/github/start - not a button that never leaves the SPA", () => {
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )

  const link = screen.getByRole("link", { name: /continue with github/i })
  expect(link).toHaveAttribute("href", "/api/auth/github/start")
})

test("S2: the GitHub mark is decorative - it must not leak into the link's accessible name", () => {
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )

  expect(screen.getByRole("link", { name: "Continue with GitHub" })).toBeInTheDocument()
  expect(screen.getByRole("heading", { level: 1, name: "samskara" })).toBeInTheDocument()
})
