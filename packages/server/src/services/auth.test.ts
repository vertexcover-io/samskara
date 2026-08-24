import { describe, expect, test } from "vitest"
import type { RegisteredOrg } from "../repositories/orgs.repo.js"
import { isSuperAdminLogin, planMembership } from "./auth.js"

describe("planMembership", () => {
  test("SC16: adds only auto-add orgs and keeps every registered one", () => {
    const on: RegisteredOrg = { id: "on-id", githubSlug: "on", autoAddMembers: true }
    const off: RegisteredOrg = { id: "off-id", githubSlug: "off", autoAddMembers: false }

    const plan = planMembership([on, off])

    expect(plan.add).toEqual([on.id])
    expect(plan.keep).toEqual([on.id, off.id])
  })
})

describe("isSuperAdminLogin", () => {
  test("matches a configured login regardless of case", () => {
    expect(isSuperAdminLogin(["harit"], "Harit")).toBe(true)
    expect(isSuperAdminLogin(["harit"], "harit")).toBe(true)
  })

  test("rejects a login that is not configured, and an empty list admits nobody", () => {
    expect(isSuperAdminLogin(["harit"], "someone-else")).toBe(false)
    expect(isSuperAdminLogin([], "harit")).toBe(false)
  })
})
