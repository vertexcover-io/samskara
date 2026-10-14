import { render, screen, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { BuildStamp } from "./BuildStamp.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

test("S2: each label names the value beside it, not the one across the divider", () => {
  vi.stubEnv("VITE_APP_VERSION", "1.2.3")
  vi.stubEnv("VITE_GIT_COMMIT", "abc1234")

  render(<BuildStamp />)

  expect(screen.getByText("Version").nextElementSibling).toHaveTextContent("1.2.3")
  expect(screen.getByText("Commit").nextElementSibling).toHaveTextContent("abc1234")
})

test("S3: a bundle built without git info still renders, marked as a dev build", () => {
  vi.stubEnv("VITE_APP_VERSION", "")
  vi.stubEnv("VITE_GIT_COMMIT", "")

  render(<BuildStamp />)
  const stamp = within(screen.getByTestId("build-stamp"))

  expect(stamp.getByText("dev")).toBeInTheDocument()
  expect(stamp.getByText("unknown")).toBeInTheDocument()
})
