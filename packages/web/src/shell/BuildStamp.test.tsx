import { render, screen, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { BuildStamp } from "./BuildStamp.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

test("S1: the stamp labels each value, so a screenshot alone says which is the version and which is the commit", () => {
  vi.stubEnv("VITE_APP_VERSION", "1.2.3")
  vi.stubEnv("VITE_GIT_COMMIT", "abc1234")

  render(<BuildStamp />)
  const stamp = within(screen.getByTestId("build-stamp"))

  expect(stamp.getByText("Version")).toBeInTheDocument()
  expect(stamp.getByText("1.2.3")).toBeInTheDocument()
  expect(stamp.getByText("Commit")).toBeInTheDocument()
  expect(stamp.getByText("abc1234")).toBeInTheDocument()
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
