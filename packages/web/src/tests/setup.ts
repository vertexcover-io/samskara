import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

// jsdom implements no layout, so it ships no scrollIntoView at all.
Element.prototype.scrollIntoView = vi.fn()

afterEach(cleanup)
