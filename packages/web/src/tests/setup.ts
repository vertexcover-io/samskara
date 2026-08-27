import "@testing-library/jest-dom/vitest"
import { cleanup, configure } from "@testing-library/react"
import { afterEach, vi } from "vitest"

// jsdom implements no layout, so it ships no scrollIntoView at all.
Element.prototype.scrollIntoView = vi.fn()

// Testing Library waits 1000ms by default, which is a bet on how fast the machine mounts a route.
// A loaded CI runner is an order of magnitude slower than a laptop -- the v0.2.0 release run spent
// 8.6s on a file that takes 0.6s here -- so the default turns a slow first render into a failure
// that no code change can reproduce. The wait only elapses when an assertion never comes true.
configure({ asyncUtilTimeout: 5_000 })

afterEach(cleanup)
