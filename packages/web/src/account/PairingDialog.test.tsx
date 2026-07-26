import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { PairingDialog } from "./PairingDialog.js"

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type CliCode = () => Promise<Response>

const stubCliCode = (cliCode: CliCode): ReturnType<typeof vi.fn> => {
  const spy = vi.fn((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/cli-code")) return cliCode()
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

const renderDialog = () => render(<PairingDialog open onClose={() => {}} />)

afterEach(() => {
  vi.unstubAllGlobals()
})

test("S29: the pairing dialog exposes a role=dialog named 'Pair the CLI' with a Generate code action - not an unlabelled panel", () => {
  stubCliCode(() => new Promise<Response>(() => {}))

  renderDialog()

  const dialog = screen.getByRole("dialog", { name: "Pair the CLI" })
  expect(dialog).toHaveAttribute("aria-modal", "true")
  expect(screen.getByRole("button", { name: /generate code/i })).toBeInTheDocument()
})

test("S30: a pending cli-code request renders 'Generating…' and marks the generate control disabled - not a still-clickable button", async () => {
  stubCliCode(() => new Promise<Response>(() => {}))

  renderDialog()
  await userEvent.click(screen.getByRole("button", { name: /generate code/i }))

  const generating = await screen.findByRole("button", { name: /generating/i })
  expect(generating).toBeDisabled()
})

test("S31: a returned code renders the code itself, an expiry string, and a Copy action - not just a bare code", async () => {
  stubCliCode(() => Promise.resolve(jsonResponse(200, { code: "abc123" })))

  renderDialog()
  await userEvent.click(screen.getByRole("button", { name: /generate code/i }))

  expect(await screen.findByText("abc123")).toBeInTheDocument()
  expect(screen.getByText(/expires/i)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument()
})

test("S32: activating Generate twice while the first request is pending issues exactly one call to /api/auth/cli-code - not two", async () => {
  const spy = stubCliCode(() => new Promise<Response>(() => {}))

  renderDialog()
  const generate = screen.getByRole("button", { name: /generate code/i })
  await userEvent.click(generate)
  await userEvent.click(generate)

  expect(spy).toHaveBeenCalledTimes(1)
})

test("S33: a failed cli-code request names the failure and offers retry while showing no code - not a silent empty dialog", async () => {
  stubCliCode(() => Promise.resolve(jsonResponse(500, { error: "boom" })))

  renderDialog()
  await userEvent.click(screen.getByRole("button", { name: /generate code/i }))

  expect(await screen.findByRole("alert")).toHaveTextContent(/server responded with 500/i)
  expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument()
})

test("S29b: Escape closes the dialog and focus is trapped inside it while open - not left on the page behind", async () => {
  stubCliCode(() => new Promise<Response>(() => {}))
  const onClose = vi.fn()

  render(<PairingDialog open onClose={onClose} />)

  await waitFor(() => {
    const focused = document.activeElement
    expect(focused).toBeInstanceOf(HTMLElement)
    if (focused instanceof HTMLElement) {
      expect(screen.getByRole("dialog", { name: "Pair the CLI" })).toContainElement(focused)
    }
  })

  await userEvent.keyboard("{Escape}")
  expect(onClose).toHaveBeenCalledTimes(1)
})

test("S29c: closing the dialog whose opener has unmounted focuses the declared fallback - not the document body", async () => {
  stubCliCode(() => new Promise<Response>(() => {}))

  const fallback = document.createElement("button")
  fallback.textContent = "Account menu"
  document.body.appendChild(fallback)

  const opener = document.createElement("button")
  opener.textContent = "Pair the CLI"
  document.body.appendChild(opener)
  opener.focus()

  const { rerender } = render(
    <PairingDialog open onClose={() => {}} restoreFocusTo={() => fallback} />,
  )

  await waitFor(() => expect(screen.getByRole("dialog", { name: "Pair the CLI" })).toBeVisible())
  opener.remove()

  rerender(<PairingDialog open={false} onClose={() => {}} restoreFocusTo={() => fallback} />)

  await waitFor(() => expect(fallback).toHaveFocus())
  fallback.remove()
})

test("S29d: closing the dialog opened while focus already sat on <body> focuses the fallback - not <body> again", async () => {
  stubCliCode(() => new Promise<Response>(() => {}))

  const fallback = document.createElement("button")
  fallback.textContent = "Account menu"
  document.body.appendChild(fallback)
  document.body.focus()

  const { rerender } = render(
    <PairingDialog open onClose={() => {}} restoreFocusTo={() => fallback} />,
  )

  await waitFor(() => expect(screen.getByRole("dialog", { name: "Pair the CLI" })).toBeVisible())

  rerender(<PairingDialog open={false} onClose={() => {}} restoreFocusTo={() => fallback} />)

  await waitFor(() => expect(fallback).toHaveFocus())
  fallback.remove()
})

test("S29e: a still-mounted opener keeps the restore target - the fallback does not hijack a valid one", async () => {
  stubCliCode(() => new Promise<Response>(() => {}))

  const fallback = document.createElement("button")
  fallback.textContent = "Account menu"
  document.body.appendChild(fallback)

  const opener = document.createElement("button")
  opener.textContent = "Opener"
  document.body.appendChild(opener)
  opener.focus()

  const { rerender } = render(
    <PairingDialog open onClose={() => {}} restoreFocusTo={() => fallback} />,
  )

  await waitFor(() => expect(screen.getByRole("dialog", { name: "Pair the CLI" })).toBeVisible())

  rerender(<PairingDialog open={false} onClose={() => {}} restoreFocusTo={() => fallback} />)

  await waitFor(() => expect(opener).toHaveFocus())
  opener.remove()
  fallback.remove()
})
