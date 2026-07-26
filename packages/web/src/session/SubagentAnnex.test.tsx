import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test, vi } from "vitest"
import { buildPayload, message, text } from "../tests/session-fixtures.js"
import { SubagentAnnex } from "./SubagentAnnex.js"
import { toDetail } from "./records.js"

const AGENT = {
  agentId: "a1",
  agentType: "db-schema-auditor",
  description: "Audit unique constraints",
  parentAgentId: null,
}

const branchRecords = () => {
  const detail = toDetail(
    buildPayload({
      subagents: [AGENT],
      messages: [
        message({ lineNumber: 1, msgType: "turnEvent", subType: "agentSpawn", agentId: "a1" }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "assistant",
          agentId: "a1",
          isSubagent: true,
          content: text("No unique constraints on the three tables"),
        }),
      ],
    }),
  )
  return detail.branches.get("a1") ?? []
}

test("S42: activating Open branch reveals the branch conversation and flips the trigger to aria-expanded true", async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()

  const { rerender } = render(
    <SubagentAnnex
      agent={AGENT}
      records={branchRecords()}
      open={false}
      onOpen={onOpen}
      onExit={vi.fn()}
    />,
  )

  const trigger = screen.getByRole("button", { name: /open branch/i })
  expect(trigger).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByText(/No unique constraints on the three tables/)).not.toBeInTheDocument()

  await user.click(trigger)
  expect(onOpen).toHaveBeenCalledWith("a1", trigger)

  rerender(
    <SubagentAnnex
      agent={AGENT}
      records={branchRecords()}
      open={true}
      onOpen={onOpen}
      onExit={vi.fn()}
    />,
  )

  const expanded = screen.getByRole("button", { name: /close branch/i })
  expect(expanded).toHaveAttribute("aria-expanded", "true")
  const branch = screen.getByRole("region", { name: /db-schema-auditor conversation/i })
  expect(within(branch).getByText(/No unique constraints on the three tables/)).toBeInTheDocument()
})

test("S42b: an open annex trigger reads 'Close branch' so its label matches the action it performs", () => {
  render(
    <SubagentAnnex
      agent={AGENT}
      records={branchRecords()}
      open={true}
      onOpen={vi.fn()}
      onExit={vi.fn()}
    />,
  )

  const trigger = screen.getByRole("button", { name: /close branch/i })
  expect(trigger).toHaveAttribute("aria-expanded", "true")
  expect(screen.queryByRole("button", { name: /open branch/i })).not.toBeInTheDocument()
})

test("S42: an annex names its agent type and task so the branch stays traceable to what spawned it", () => {
  render(
    <SubagentAnnex
      agent={AGENT}
      records={branchRecords()}
      open={false}
      onOpen={vi.fn()}
      onExit={vi.fn()}
    />,
  )

  expect(screen.getByText("db-schema-auditor")).toBeInTheDocument()
  expect(screen.getByText(/Audit unique constraints/)).toBeInTheDocument()
})

test("S42: the annex trigger exits the branch when it is already open, without needing the keyboard", async () => {
  const user = userEvent.setup()
  const onExit = vi.fn()

  render(
    <SubagentAnnex
      agent={AGENT}
      records={branchRecords()}
      open={true}
      onOpen={vi.fn()}
      onExit={onExit}
    />,
  )

  await user.click(screen.getByRole("button", { name: /close branch/i }))

  expect(onExit).toHaveBeenCalledTimes(1)
})
