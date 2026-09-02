import { execFile, execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, mintCliToken, mintSessionToken, test } from "./fixtures/auth.js"
import { API_BASE, WEB_BASE } from "./playwright.config.js"
import { seedDatabase } from "./seed.js"

// The command's whole surface is CLI stdout and exit code plus the artifact routes it feeds, so
// these drive the real binary against the live stack and read the files back through the
// path-shaped route the web UI renders them with.

const execFileAsync = promisify(execFile)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/src/index.ts")
const BUN_BIN = execFileSync("which", ["bun"], { encoding: "utf8" }).trim()

const SESSION_ID = "verify-artifacts-session"

const SEED = {
  projects: [
    {
      slug: "artifacts-demo",
      name: "Artifacts Demo",
      sessions: [{ id: SESSION_ID, title: "Artifacts upload target" }],
    },
  ],
}

const REPORT_HTML = '<!doctype html><html><body><img src="screenshots/step-1.png"></body></html>'

const STEP_1_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde,
])

let home: string

const runCli = async (
  args: ReadonlyArray<string>,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const env = {
    ...process.env,
    SAMSKARA_HOME: home,
    SAMSKARA_API_URL: API_BASE,
    SAMSKARA_WEB_URL: WEB_BASE,
  }
  const command = `bun ${CLI_ENTRY} ${args.join(" ")}`
  try {
    const { stdout, stderr } = await execFileAsync(BUN_BIN, [CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env,
    })
    console.log(`$ ${command}\n→ exit 0\nstdout:\n${stdout}${stderr ? `stderr:\n${stderr}\n` : ""}`)
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string }
    console.log(
      `$ ${command}\n→ exit ${err.code ?? 1}\nstdout:\n${err.stdout ?? ""}stderr:\n${err.stderr ?? ""}\n`,
    )
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
  home = await mkdtemp(join(tmpdir(), "samskara-artifacts-verify-"))
  await writeFile(join(home, "token"), await mintCliToken(), "utf8")
})

test("SC12: an uploaded report renders with its own screenshots", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "samskara-artifacts-workdir-"))
  await mkdir(join(workdir, "screenshots"), { recursive: true })
  const reportPath = join(workdir, "proof-report.html")
  const imagePath = join(workdir, "screenshots", "step-1.png")
  await writeFile(reportPath, REPORT_HTML, "utf8")
  await writeFile(imagePath, STEP_1_PNG)

  const { code, stdout } = await runCli([
    "artifacts",
    "upload",
    SESSION_ID,
    reportPath,
    imagePath,
    "--base-dir",
    workdir,
  ])

  expect(code).toBe(0)
  expect(stdout).toContain("proof-report.html")
  expect(stdout).toContain("screenshots/step-1.png")
  expect(stdout).toContain("2 uploaded, 0 failed")

  const sessionToken = await mintSessionToken()
  const read = (path: string) =>
    fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${sessionToken}` } })

  const listed = await read(`/api/sessions/${SESSION_ID}/artifacts`)
  expect(listed.status).toBe(200)
  const { artifacts } = (await listed.json()) as {
    artifacts: ReadonlyArray<{ relativePath: string }>
  }
  const relativePaths = artifacts.map((row) => row.relativePath).sort()
  expect(relativePaths).toEqual(["proof-report.html", "screenshots/step-1.png"])

  const reportRes = await read(`/api/artifacts/session/${SESSION_ID}/files/proof-report.html`)
  expect(reportRes.status).toBe(200)
  expect(await reportRes.text()).toBe(REPORT_HTML)

  // The path the report's own <img> tag resolves against its own URL, exactly as a browser
  // rendering it same-origin would request it.
  const imageRes = await read(`/api/artifacts/session/${SESSION_ID}/files/screenshots/step-1.png`)
  expect(imageRes.status).toBe(200)
  expect(imageRes.headers.get("content-type")).toBe("image/png")
  expect(Buffer.from(await imageRes.arrayBuffer())).toEqual(STEP_1_PNG)
})

test("SC19: a folder uploads whole, and its secret does not", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "samskara-artifacts-folder-"))
  await mkdir(join(workdir, "screenshots"), { recursive: true })
  await writeFile(join(workdir, "proof-report.html"), REPORT_HTML, "utf8")
  await writeFile(join(workdir, "screenshots", "step-1.png"), STEP_1_PNG)
  await writeFile(join(workdir, "screenshots", "step-2.png"), STEP_1_PNG)
  await writeFile(join(workdir, ".DS_Store"), "junk", "utf8")
  await writeFile(join(workdir, "credentials.json"), '{"token":"secret"}', "utf8")

  const { code, stdout } = await runCli([
    "artifacts",
    "upload",
    SESSION_ID,
    workdir,
    "--base-dir",
    workdir,
  ])

  expect(code).toBe(0)
  expect(stdout).toContain("proof-report.html")
  expect(stdout).toContain("screenshots/step-1.png")
  expect(stdout).toContain("screenshots/step-2.png")
  expect(stdout).not.toContain(".DS_Store")
  expect(stdout).not.toContain("credentials.json")
  expect(stdout).toContain("3 uploaded, 0 failed")

  const sessionToken = await mintSessionToken()
  const listed = await fetch(`${API_BASE}/api/sessions/${SESSION_ID}/artifacts`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  })
  expect(listed.status).toBe(200)
  const { artifacts } = (await listed.json()) as {
    artifacts: ReadonlyArray<{ relativePath: string }>
  }
  const relativePaths = artifacts.map((row) => row.relativePath).sort()
  expect(relativePaths).toEqual([
    "proof-report.html",
    "screenshots/step-1.png",
    "screenshots/step-2.png",
  ])
  expect(artifacts).toHaveLength(3)
})
