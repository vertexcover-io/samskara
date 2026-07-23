import { describe, expect, test } from "vitest"
import { createPairingStore } from "./pairing.js"

describe("createPairingStore", () => {
  test("mint returns a non-empty code and redeem yields the minting userId", () => {
    const store = createPairingStore()
    const code = store.mint("user-1")

    expect(code).toBeTruthy()
    expect(store.redeem(code)).toBe("user-1")
  })

  test("redeeming an unknown code returns null", () => {
    const store = createPairingStore()

    expect(store.redeem("nope")).toBeNull()
  })

  test("a code is single-use: the second redeem returns null", () => {
    const store = createPairingStore()
    const code = store.mint("user-1")

    expect(store.redeem(code)).toBe("user-1")
    expect(store.redeem(code)).toBeNull()
  })

  test("a code past its 5m TTL redeems as null", () => {
    let now = 1_000_000
    const store = createPairingStore(() => now)
    const code = store.mint("user-1")

    now += 5 * 60 * 1000 + 1
    expect(store.redeem(code)).toBeNull()
  })

  test("a code just inside the 5m TTL still redeems", () => {
    let now = 1_000_000
    const store = createPairingStore(() => now)
    const code = store.mint("user-1")

    now += 5 * 60 * 1000 - 1
    expect(store.redeem(code)).toBe("user-1")
  })
})
