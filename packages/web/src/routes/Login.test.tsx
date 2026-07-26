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
