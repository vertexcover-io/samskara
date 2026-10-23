import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Native Codex 0.163.0 rollout fixtures, consumed only by the real app-server in tests. */
export const createCodexTranscriptWriter = (home: string, cwd: string, id: string) => {
  const timestamp = "2026-06-01T12:00:00.000Z"
  const path = join(
    home,
    ".codex",
    "sessions",
    "2026",
    "06",
    "01",
    `rollout-2026-06-01T12-00-00-${id}.jsonl`,
  )
  const event = (payload: Readonly<Record<string, unknown>>) => ({
    timestamp,
    type: "event_msg",
    payload,
  })
  const line = (value: unknown): string => `${JSON.stringify(value)}\n`
  const append = async (values: ReadonlyArray<unknown>): Promise<void> =>
    appendFile(path, values.map(line).join(""))
  const changes = {
    [join(cwd, "native-a.md")]: { type: "add", content: "Native artifact A" },
    [join(cwd, "native-b.md")]: {
      type: "update",
      unified_diff: "@@ -1 +1 @@\n-old\n+Native artifact B",
      move_path: null,
    },
  }
  return {
    path,
    start: async () => {
      await mkdir(join(home, ".codex", "sessions", "2026", "06", "01"), { recursive: true })
      await writeFile(
        path,
        [
          {
            timestamp,
            type: "session_meta",
            payload: {
              id,
              timestamp,
              cwd,
              originator: "codex_cli_rs",
              cli_version: "0.163.0",
              source: "exec",
              model_provider: "openai",
              git: {
                commit_hash: "0123456789012345678901234567890123456789",
                branch: "main",
                repository_url: "https://github.com/acme/widgets",
              },
            },
          },
          event({ type: "task_started", turn_id: "turn-1", model_context_window: 128_000 }),
          {
            timestamp,
            type: "turn_context",
            payload: {
              turn_id: "turn-1",
              cwd,
              approval_policy: "never",
              sandbox_policy: { type: "read-only" },
              model: "gpt-5.4",
            },
          },
          event({
            type: "user_message",
            message: "Codex capture acceptance fixture",
            images: [],
            local_images: [],
            text_elements: [],
          }),
          event({
            type: "patch_apply_begin",
            call_id: "patch",
            turn_id: "turn-1",
            auto_approved: true,
            changes,
          }),
        ]
          .map(line)
          .join(""),
      )
    },
    finish: async () => {
      await writeFile(join(cwd, "native-a.md"), "Native artifact A")
      await writeFile(join(cwd, "native-b.md"), "Native artifact B")
      await append([
        event({
          type: "patch_apply_end",
          call_id: "patch",
          turn_id: "turn-1",
          stdout: "done",
          stderr: "",
          success: true,
          status: "completed",
          changes,
        }),
        event({
          type: "agent_message",
          message: "Native Codex capture complete",
          phase: "final_answer",
        }),
        event({
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: "Native Codex capture complete",
        }),
      ])
    },
    resume: async () =>
      append([
        event({ type: "task_started", turn_id: "turn-2", model_context_window: 128_000 }),
        event({
          type: "user_message",
          message: "Resume after watcher restart",
          images: [],
          local_images: [],
          text_elements: [],
        }),
        event({
          type: "agent_message",
          message: "Resumed Codex capture complete",
          phase: "final_answer",
        }),
        event({
          type: "task_complete",
          turn_id: "turn-2",
          last_agent_message: "Resumed Codex capture complete",
        }),
      ]),
  }
}
