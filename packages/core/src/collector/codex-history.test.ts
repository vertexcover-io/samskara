import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createLogger } from "../logging.js"
import { codexThreadSchema, createCodexHistoryClient } from "./codex-history.js"

test("native legacy spawn metadata supplies a parent only when the current field is absent", () => {
  const thread = {
    id: "child",
    cwd: "/work/app",
    createdAt: 1,
    updatedAt: 2,
    parentThreadId: null,
    source: { subAgent: { thread_spawn: { parent_thread_id: "legacy-parent", depth: 1 } } },
  }
  expect(codexThreadSchema.parse(thread).parentThreadId).toBe("legacy-parent")
  expect(
    codexThreadSchema.parse({ ...thread, parentThreadId: "current-parent" }).parentThreadId,
  ).toBe("current-parent")
  expect(
    codexThreadSchema.parse({ ...thread, source: "exec", forkedFromId: "fork-parent" })
      .parentThreadId,
  ).toBeNull()
  expect(
    codexThreadSchema.parse({ ...thread, forkedFromId: "fork-parent" }).parentThreadId,
  ).toBeNull()
  expect(
    codexThreadSchema.parse({ ...thread, source: { subAgent: { other: "unknown" } } })
      .parentThreadId,
  ).toBeNull()
})

test.each(["legacy", "paginated"])(
  "the history client pages all local sources and reads %s history without inference",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "samskara-codex-client-"))
    const script = join(home, "server.mjs")
    await writeFile(
      script,
      `
    import {createInterface} from 'node:readline';
    const thread={id:'root',cwd:'/work/app',createdAt:1,updatedAt:2,historyMode:'${mode}'};
    for await(const line of createInterface({input:process.stdin})){
      const q=JSON.parse(line); if(q.id===undefined) continue;
      let result;
      if(q.method==='initialize') result={};
      else if(q.method==='thread/list'){
        if(q.params.modelProviders?.length!==0 || !q.params.sourceKinds.includes('exec') || !q.params.sourceKinds.includes('subAgent')) process.exit(5);
        result={data:q.params.archived?[{...thread,id:'archived'}]:q.params.cursor?[{...thread,id:'page2'}]:[thread],nextCursor:!q.params.archived&&!q.params.cursor?'next':null};
      }
      else if(q.method==='thread/read') result={thread};
      else if(q.method==='thread/turns/list') result={data:[{id:'turn',status:'completed',items:[{id:'item',type:'agentMessage',text:'done'}]}],nextCursor:null};
      else if(q.method==='thread/items/list') result={data:[{turnId:'turn',item:{id:q.params.cursor?'second':'item',type:'agentMessage',text:'done'},startedAtMs:123}],nextCursor:q.params.cursor?null:'next'};
      else process.exit(6);
      process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
    }
  `,
    )
    const client = createCodexHistoryClient({
      home,
      command: process.execPath,
      args: [script],
      log: createLogger({ service: "codex-test" }, { level: "silent" }),
    })
    try {
      expect((await client.listThreads()).map((thread) => thread.id)).toEqual([
        "root",
        "page2",
        "archived",
      ])
      const history = await client.readThread("root")
      expect(history.items[0]).toMatchObject({ turnId: "turn", item: { text: "done" } })
      expect(history.items).toHaveLength(mode === "legacy" ? 1 : 2)
      expect(history.items[0]?.startedAtMs).toBe(mode === "legacy" ? undefined : 123)
    } finally {
      await client.close()
      await rm(home, { recursive: true, force: true })
    }
  },
)

test.each(["timeout", "malformed", "unsupported"])(
  "a %s history server fails within a bounded time and closes cleanly",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "samskara-codex-fault-"))
    const script = join(home, "server.mjs")
    await writeFile(
      script,
      `import {createInterface} from 'node:readline'; for await(const line of createInterface({input:process.stdin})){ const q=JSON.parse(line); if(q.id===undefined)continue; if('${mode}'==='timeout')continue; process.stdout.write('${mode}'==='malformed'?'invalid\\n':JSON.stringify({id:q.id,error:{code:-32601,message:'unknown method'}})+'\\n'); }`,
    )
    const client = createCodexHistoryClient({
      home,
      command: process.execPath,
      args: [script],
      timeoutMs: mode === "timeout" ? 200 : 10_000,
      log: createLogger({ service: "codex-test" }, { level: "silent" }),
    })
    try {
      await expect(client.listThreads()).rejects.toThrow(
        { timeout: /timed out/, malformed: /Invalid/, unsupported: /0.163.0/ }[mode],
      )
    } finally {
      await client.close()
      await rm(home, { recursive: true, force: true })
    }
  },
)

test.each(["legacy", "paginated"])(
  "incremental %s reads recover an older pending result after a settled turn",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "samskara-codex-pending-"))
    const script = join(home, "server.mjs")
    await writeFile(
      script,
      `import {createInterface} from 'node:readline';
    const result={id:'late',type:'commandExecution',status:'completed',aggregatedOutput:'late output',exitCode:0};
    const turn=id=>({id,status:'completed',items:id==='pending'?[result]:[]});
    for await(const line of createInterface({input:process.stdin})){
      const q=JSON.parse(line);if(q.id===undefined)continue;let reply={};
      if(q.method==='thread/read')reply={thread:{id:'root',cwd:'/work/app',createdAt:1,updatedAt:2,historyMode:'${mode}'}};
      if(q.method==='thread/turns/list'){
        if(q.params.sortDirection!=='desc')process.exit(4);
        if(q.params.cursor==='too-old')process.exit(5);
        reply={data:q.params.cursor?[turn('pending')]:[turn('new'),turn('settled')],nextCursor:q.params.cursor?'too-old':'older'};
      }
      if(q.method==='thread/items/list')reply={data:q.params.turnId==='pending'?[{turnId:'pending',item:result,completedAtMs:123}]:[],nextCursor:null};
      process.stdout.write(JSON.stringify({id:q.id,result:reply})+'\\n');
    }`,
    )
    const client = createCodexHistoryClient({
      home,
      command: process.execPath,
      args: [script],
      log: createLogger({ service: "codex-test" }, { level: "silent" }),
    })
    try {
      const history = await client.readThread("root", {
        settledTurns: new Set(["settled"]),
        pendingTurns: new Set(["pending"]),
      })
      expect(history.turns.map((turn) => turn.id)).toEqual(["pending", "settled", "new"])
      expect(history.items).toMatchObject([
        { turnId: "pending", item: { aggregatedOutput: "late output", status: "completed" } },
      ])
    } finally {
      await client.close()
      await rm(home, { recursive: true, force: true })
    }
  },
)
