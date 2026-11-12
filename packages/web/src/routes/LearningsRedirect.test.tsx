import { render, screen } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { expect, test } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { LearningsRedirect } from "./Learnings.js"

const renderAt = (entry: string) =>
  render(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/learnings" element={<LearningsRedirect />} />
        <Route path="*" element={<p>landed</p>} />
      </Routes>
    </TestRouter>,
  )

test.each([
  ["/learnings?project=p-2&show=10", "/projects/p-2/fixes?show=10"],
  ["/learnings", "/projects"],
])("SC703: an old link %s lands on %s", async (entry, expected) => {
  renderAt(entry)
  await screen.findByText("landed")
  expect(screen.getByTestId("location").textContent).toBe(expected)
})
