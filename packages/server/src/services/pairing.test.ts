import { describe, expect, test } from "vitest"
import { createPairingStore } from "./pairing.js"

describe("createPairingStore", () => {
  test("mint returns a non-empty code and redeem yields the minting userId", () => {
    const store = createPairingStore()
    const code = store.mint("user-1")

    expect(code).toBeTruthy()
    expect(store.redeem(code)).toBe("user-1")
  })

  test("a code is single-use: the second redeem returns null", () => {
    const store = createPairingStore()
    const code = store.mint("user-1")

    expect(store.redeem(code)).toBe("user-1")
    expect(store.redeem(code)).toBeNull()
  })

  test("a code never expires: minting others leaves an older code redeemable", () => {
    const store = createPairingStore()
    const first = store.mint("user-1")

    store.mint("user-2")
    store.mint("user-3")

    expect(store.redeem(first)).toBe("user-1")
  })

  test("minting for a user drops that user's previous unused code, so codes cannot pile up", () => {
    const store = createPairingStore()
    const first = store.mint("user-1")

    const second = store.mint("user-1")

    expect(store.redeem(first)).toBeNull()
    expect(store.redeem(second)).toBe("user-1")
  })

  test("one user's re-mint leaves another user's code alone", () => {
    const store = createPairingStore()
    const other = store.mint("user-2")

    store.mint("user-1")
    store.mint("user-1")

    expect(store.redeem(other)).toBe("user-2")
  })

  test("an unknown code redeems as null", () => {
    expect(createPairingStore().redeem("nope")).toBeNull()
  })
})
