import type { Sql } from "postgres"
import type { MigrationStep } from "./steps.js"

/**
 * User-owned repos that belong to a registered org their owner is a member of. `run` fixes these
 * and `verify` counts what is left, so both read one definition.
 *
 * A repo any project of a different owner already references is excluded. Re-owning it would leave
 * that project's next capture creating a second, user-owned row for the same repo, since a repo
 * takes its owner from the project the session belongs to.
 */
const orgOwnedCandidates = (sql: Sql) => sql`
  from repos r
  join orgs o on r.host = 'github.com' and lower(o."githubSlug") = lower(r.owner)
  join "userOrgs" uo on uo."userId" = r."userId" and uo."orgId" = o.id
  where r."ownerOrgId" is null
    and not exists (
      select 1 from projects p
      where (p."ownerOrgId" is null or p."ownerOrgId" <> o.id)
        and (
          p."repoId" = r.id
          or exists (
            select 1 from sessions s
            join messages m on m."sessionId" = s.id
            where s."projectId" = p.id and m."repoId" = r.id
          )
        )
    )
`

/**
 * Repos not spelled the way `reposRepo.upsertByIdentity` would write them today. A forge treats
 * `ACME/Serana` and `acme/serana` as one repo, so the writer folds case; rows written before it did
 * are spelled however their remote was.
 *
 * `host: "local"` is excluded: a remoteless repo is keyed by its absolute root path, and a path is
 * case-sensitive.
 */
const notCanonical = (sql: Sql) => sql`
  lower(r.host) <> 'local'
    and (r.host <> lower(r.host)
      or r.owner <> lower(r.owner)
      or r."repoName" <> lower(r."repoName"))
`

/**
 * Unlinked projects paired with the repo named after them, preferring `github.com` where the same
 * name exists on more than one host. A project appears once per surviving candidate, so a caller
 * that needs an unambiguous answer counts them and takes only the projects with exactly one.
 */
const namedRepoCandidates = (sql: Sql) => sql`
  select "projectId", "repoId" from (
    select p.id as "projectId", r.id as "repoId", r.host,
      bool_or(r.host = 'github.com') over (partition by p.id) as "hasGithub"
    from projects p
    join repos r on r."repoName" = p.name
      and ((p."ownerId" is not null and r."userId" = p."ownerId")
        or (p."ownerOrgId" is not null and r."ownerOrgId" = p."ownerOrgId"))
    where p."repoId" is null
  ) matches
  where ("hasGithub" and host = 'github.com') or not "hasGithub"
`

/**
 * Whether anything is left to converge. This runs on every `db:migrate`, including ones with no new
 * migrations, so a settled database pays a lookup rather than a join over `messages`, the largest
 * table in the schema. Every clause stops at its first matching row.
 *
 * Each clause matches only what the transaction below can actually change. A project whose named
 * repos stay ambiguous can never be linked, so counting it would re-enter the transaction on every
 * migrate for a row that cannot move.
 */
export const hasWork = async (client: Sql): Promise<boolean> => {
  const [row] = await client<{ readonly pending: boolean }[]>`
    select (
      exists (select 1 ${orgOwnedCandidates(client)})
      or exists (select 1 from repos r where ${notCanonical(client)})
      or exists (
        select 1 from (${namedRepoCandidates(client)}) preferred
        group by "projectId" having count(*) = 1
      )
      or exists (
        select 1 from projects p
        where p."repoId" is null
          and exists (
            select 1 from sessions s
            join messages m on m."sessionId" = s.id
            where s."projectId" = p.id and m."repoId" is not null
          )
      )
    ) as pending
  `
  return row?.pending ?? true
}

/**
 * Moves everything owned by the duplicates in `repo_merge` onto their survivor, then deletes the
 * duplicates. Both passes below merge repo rows, so both use this.
 *
 * Children move before their repo is deleted: `commits` and `pullRequests` cascade with it.
 *
 * A commit is unique per `(repoId, sha)` and a pull request per `(repoId, number)`, and two rows for
 * one real repository routinely hold the same commit. Repointing it onto a survivor that already has
 * that sha would violate the constraint and abort the migration, so a colliding child is dropped —
 * the surviving row describes the same commit.
 */
const mergeOnto = async (sql: Sql): Promise<void> => {
  await sql`
    update messages set "repoId" = m."survivorId"
    from repo_merge m
    where messages."repoId" = m.id and m.id <> m."survivorId"
  `
  await sql`
    update projects set "repoId" = m."survivorId"
    from repo_merge m
    where projects."repoId" = m.id and m.id <> m."survivorId"
  `

  await sql`
    delete from commits c using repo_merge m
    where c."repoId" = m.id and m.id <> m."survivorId"
      and exists (
        select 1 from commits keep
        where keep."repoId" = m."survivorId" and keep.sha = c.sha
      )
  `
  await sql`
    update commits set "repoId" = m."survivorId"
    from repo_merge m
    where commits."repoId" = m.id and m.id <> m."survivorId"
  `

  // A pull request carries session links keyed `(sessionId, prId)`. They move to the surviving row
  // first, so deleting the duplicate does not cascade them away; a link the session already has to
  // the survivor would collide on that key, so it is dropped rather than moved.
  await sql`
    delete from "sessionPullRequests" spr
    using "pullRequests" dup, repo_merge m, "pullRequests" keep
    where spr."prId" = dup.id and dup."repoId" = m.id and m.id <> m."survivorId"
      and keep."repoId" = m."survivorId" and keep.number = dup.number
      and exists (
        select 1 from "sessionPullRequests" held
        where held."prId" = keep.id and held."sessionId" = spr."sessionId"
      )
  `
  await sql`
    update "sessionPullRequests" spr set "prId" = keep.id
    from "pullRequests" dup, repo_merge m, "pullRequests" keep
    where spr."prId" = dup.id and dup."repoId" = m.id and m.id <> m."survivorId"
      and keep."repoId" = m."survivorId" and keep.number = dup.number
  `
  await sql`
    delete from "pullRequests" dup using repo_merge m
    where dup."repoId" = m.id and m.id <> m."survivorId"
      and exists (
        select 1 from "pullRequests" keep
        where keep."repoId" = m."survivorId" and keep.number = dup.number
      )
  `
  await sql`
    update "pullRequests" set "repoId" = m."survivorId"
    from repo_merge m
    where "pullRequests"."repoId" = m.id and m.id <> m."survivorId"
  `

  await sql`
    delete from repos using repo_merge m
    where repos.id = m.id and m.id <> m."survivorId"
  `
}

/**
 * Folds case, re-owns to an org, then links each project to its repo — one transaction, in that
 * order. Case comes first because folding it merges rows: an unfolded repo reads as two groups and
 * would be re-owned twice, which the org unique index rejects.
 *
 * `uuid` has no `min()` aggregate, so a group's survivor is the row `order by id` puts first.
 */
const reown = async (client: Sql): Promise<void> => {
  if (!(await hasWork(client))) return

  await client.begin(async (sql) => {
    await sql`
      create temporary table repo_merge on commit drop as
      select r.id,
        lower(r.host) as host, lower(r.owner) as owner, lower(r."repoName") as "repoName",
        first_value(r.id) over (
          partition by lower(r.host), lower(r.owner), lower(r."repoName"),
            r."userId", r."ownerOrgId"
          order by r.id
        ) as "survivorId"
      from repos r
      where lower(r.host) <> 'local'
    `
    await mergeOnto(sql)
    await sql`
      update repos set host = m.host, owner = m.owner, "repoName" = m."repoName"
      from repo_merge m
      where repos.id = m.id
        and (repos.host, repos.owner, repos."repoName") is distinct from
            (m.host, m.owner, m."repoName")
    `
    await sql`drop table repo_merge`

    await sql`
      create temporary table repo_merge on commit drop as
      select r.id, o.id as "orgId",
        first_value(r.id) over (
          partition by r.host, r.owner, r."repoName", o.id order by r.id
        ) as "survivorId"
      ${orgOwnedCandidates(sql)}
    `
    await mergeOnto(sql)
    await sql`
      update repos set "ownerOrgId" = m."orgId", "userId" = null
      from repo_merge m
      where repos.id = m.id and m.id = m."survivorId"
    `

    // The repo named after the project, when the host preference leaves exactly one.
    await sql`
      with counted as (
        select "projectId", "repoId", count(*) over (partition by "projectId") as n
        from (${namedRepoCandidates(sql)}) preferred
      )
      update projects p set "repoId" = c."repoId"
      from counted c
      where p.id = c."projectId" and c.n = 1
    `

    // Otherwise the repo the project's sessions reference most, mirroring `dominantRepoId` in
    // sessions.repo.ts widened from one session to the whole project.
    await sql`
      with unresolved as (
        select id from projects where "repoId" is null
      ), dominant as (
        select s."projectId" as "projectId", m."repoId" as "repoId",
          row_number() over (
            partition by s."projectId"
            order by count(*) desc, min(m."lineNumber") asc
          ) as rn
        from sessions s
        join messages m on m."sessionId" = s.id
        where m."repoId" is not null and s."projectId" in (select id from unresolved)
        group by s."projectId", m."repoId"
      )
      update projects p set "repoId" = d."repoId"
      from dominant d
      where p.id = d."projectId" and d.rn = 1
    `
  })
}

const verify = async (client: Sql): Promise<void> => {
  const [unowned] = await client<{ readonly count: number }[]>`
    select count(*)::int as count ${orgOwnedCandidates(client)}
  `
  if (unowned === undefined || unowned.count > 0) {
    throw new Error(
      `${unowned?.count ?? "?"} repo row(s) should be org-owned but are not converged`,
    )
  }

  const [uncanonical] = await client<{ readonly count: number }[]>`
    select count(*)::int as count from repos r where ${notCanonical(client)}
  `
  if (uncanonical === undefined || uncanonical.count > 0) {
    throw new Error(
      `${uncanonical?.count ?? "?"} repo row(s) are still spelled with their remote's casing`,
    )
  }

  const [unlinked] = await client<{ readonly count: number }[]>`
    select count(*)::int as count
    from projects p
    where p."repoId" is null
      and exists (
        select 1 from sessions s
        join messages m on m."sessionId" = s.id
        where s."projectId" = p.id and m."repoId" is not null
      )
  `
  if (unlinked === undefined || unlinked.count > 0) {
    throw new Error(`${unlinked?.count ?? "?"} project(s) have a dominant repo but no repoId`)
  }
}

export const repoOwnershipBackfillStep: MigrationStep = {
  name: "repo-ownership-backfill",
  run: ({ client }) => reown(client),
  verify: ({ client }) => verify(client),
}
