import { expect, test } from "vitest"
import { App } from "./App.js"

test("App is a render function", () => {
  expect(typeof App).toBe("function")
})
