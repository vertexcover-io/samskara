import type { ProjectRemote } from "@samskara/core"
import { describe, expect, test } from "vitest"
import type { RegisteredOrg } from "../repositories/orgs.repo.js"
import { ownerFor } from "./projects.js"

const registered: RegisteredOrg = { id: "org-id", githubSlug: "acme", autoAddMembers: true }
const github = (owner: string): ProjectRemote => ({ host: "github.com", owner, repoName: "widget" })

describe("ownerFor", () => {
  test("SC17: picks the org only for a registered GitHub org the caller belongs to", () => {
    expect(ownerFor({ remote: undefined, org: null, isMember: false })).toEqual({ kind: "user" })

    expect(
      ownerFor({
        remote: { ...github("acme"), host: "gitlab.com" },
        org: registered,
        isMember: true,
      }),
    ).toEqual({ kind: "user" })

    expect(ownerFor({ remote: github("acme"), org: null, isMember: false })).toEqual({
      kind: "user",
    })

    expect(ownerFor({ remote: github("acme"), org: registered, isMember: true })).toEqual({
      kind: "org",
    })

    expect(ownerFor({ remote: github("acme"), org: registered, isMember: false })).toEqual({
      kind: "user",
      reason: "notMember",
    })
  })
})
