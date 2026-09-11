import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, test, vi } from "vitest"
import { DeleteProjectDialog } from "./DeleteProjectDialog.js"

const PROJECT = { id: "p-1", slug: "samskara", sessionCount: 12 }

const renderDialog = (project = PROJECT) =>
  render(
    <MemoryRouter>
      <DeleteProjectDialog open project={project} onClose={() => {}} />
    </MemoryRouter>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

test("SC9: the confirm button unlocks only on the exact slug", async () => {
  renderDialog()
  const input = screen.getByRole("textbox", { name: /project slug/i })
  const confirm = screen.getByRole("button", { name: /delete project/i })

  await userEvent.type(input, "samskar")
  expect(confirm).toBeDisabled()

  await userEvent.clear(input)
  await userEvent.type(input, "Samskara")
  expect(confirm).toBeDisabled()

  await userEvent.clear(input)
  await userEvent.type(input, "samskara")
  expect(confirm).toBeEnabled()
})

test("SC11: the dialog names how many sessions the delete destroys", () => {
  renderDialog(PROJECT)

  expect(screen.getByText(/12 sessions/)).toBeInTheDocument()
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stubDelete = (response: Response) => {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(response),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const arm = async (slug = PROJECT.slug) => {
  await userEvent.type(screen.getByRole("textbox", { name: /project slug/i }), slug)
  await userEvent.click(screen.getByRole("button", { name: /delete project/i }))
}

test("SC50: a refused delete says the account may no longer do it, and stays on the page", async () => {
  stubDelete(jsonResponse(403, { error: "forbidden" }))
  renderDialog()

  await arm()

  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent(/no longer be deleted by this account/i)
  expect(screen.getByRole("button", { name: /delete project/i })).toBeInTheDocument()
})

test("SC51: a delete that fails for any other reason surfaces the server's own message", async () => {
  stubDelete(jsonResponse(500, { error: "internal" }))
  renderDialog()

  await arm()

  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent(/500/)
  expect(alert).not.toHaveTextContent(/no longer be deleted/i)
})

test("SC52: a successful delete calls the project's own endpoint once", async () => {
  const fetchMock = stubDelete(new Response(null, { status: 204 }))
  renderDialog()

  await arm()

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  const call = fetchMock.mock.calls[0]
  expect(String(call?.[0])).toContain(`/api/projects/${PROJECT.id}`)
  expect(call?.[1]?.method).toBe("DELETE")
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
