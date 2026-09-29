import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"
import type { ReadinessTarget } from "./corpus"
import { benchmarkRoot, type ClockFrame, type PageSettle } from "./driver-sdk"
import { appStartReadiness, openCodeFacts, sessionActivation, settleExpressionFor } from "./settle"

const { frameLogMismatch } = (await import(pathToFileURL(path.join(benchmarkRoot, "src", "clock-rule.mjs")).href)) as {
  frameLogMismatch(frameLog: unknown, clock: { start: number; end: number }): string | null
}

const target: ReadinessTarget = {
  logicalSessionId: "s1",
  sessionId: "ses_1",
  workspaceId: "w1",
  title: "Session one",
  messageCount: 4,
  latestPartIds: ["prt_a", "prt_b"],
}

/** Names the serialized facts use that neither the DOM and ES libraries nor the function itself declare. */
function undeclaredNames(source: string) {
  const fileName = "/facts.js"
  const text = `const facts = ${source};\n`
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile
  host.getSourceFile = (name, version) => (name === fileName ? ts.createSourceFile(name, text, version) : getSourceFile(name, version))
  const fileExists = host.fileExists
  host.fileExists = (name) => name === fileName || fileExists(name)
  const program = ts.createProgram([fileName], options, host)
  return program
    .getSemanticDiagnostics(program.getSourceFile(fileName))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .filter((message) => message.startsWith("Cannot find name"))
}

function frame(at: number, signature: string | null, mutated = false): ClockFrame {
  const ready = signature !== null
  return {
    at,
    signature,
    mutated,
    gates: {
      displayedDestination: true,
      latestTurnPainted: ready,
      noPlaceholder: true,
      firstFoldComplete: ready,
      composerEditable: true,
      windowVisibleFocused: true,
    },
  }
}

/** Two unready frames, a mutated ready frame that restarts the run, then 31 unchanged ready frames. */
function pageSettle(startAt: number, timeOrigin: number): PageSettle {
  const frames = [frame(startAt + 8, null), frame(startAt + 16, null), frame(startAt + 24, "a"), frame(startAt + 32, "a", true)]
  for (let index = 1; index <= 30; index += 1) frames.push(frame(startAt + 32 + index * 8, "a"))
  return { startAt, settledAt: startAt + 32, timeOrigin, frames }
}

describe("openCodeFacts", () => {
  test("serializes with no name the renderer lacks", () => {
    const source = openCodeFacts.toString()
    expect(source).not.toContain("__name")
    expect(undeclaredNames(source)).toEqual([])
  }, 30_000)

  test("the check catches a name from the driver's side", () => {
    expect(undeclaredNames("(target) => ({ displayed: () => target.sessionId === benchmarkRoot })")).toEqual([
      "Cannot find name 'benchmarkRoot'.",
    ])
  }, 30_000)

  test("the framework's expression carries the facts and only the facts' target", () => {
    const expression = settleExpressionFor(target, 30_000)
    expect(() => new Function(`return ${expression}`)).not.toThrow()
    expect(expression).toContain(openCodeFacts.toString())
    expect(expression).toContain(JSON.stringify({ sessionId: "ses_1", latestPartIds: ["prt_a", "prt_b"] }))
    expect(expression).not.toContain("Session one")
  })
})

describe("clocks from a resolved page settle", () => {
  test("a switch runs on the renderer clock from the trusted pointerdown to the settle", () => {
    const settle = pageSettle(1_000, 5_000)
    const { clock, frameLog } = sessionActivation(settle)
    expect(clock).toEqual({ kind: "single-monotonic-clock", clock: "performance.now", start: 1_000, end: 1_032 })
    expect(frameLog.startAt).toBe(1_000)
    expect(frameLog.offsetMs).toBe(0)
    expect(frameLog.frames).toEqual(settle.frames)
    expect(frameLogMismatch(frameLog, clock)).toBeNull()
  })

  test("app start runs on the driver clock from spawn, with the renderer frames offset onto it", () => {
    const driverTimeOrigin = 10_000
    const rendererTimeOrigin = 10_750.5
    const spawnAtMs = 200
    const settle = pageSettle(1_000, rendererTimeOrigin)
    const { readyAtMs, readyFrameLog } = appStartReadiness(settle, spawnAtMs, driverTimeOrigin)
    expect(readyFrameLog.offsetMs).toBe(750.5)
    expect(readyFrameLog.startAt).toBe(200 - 750.5)
    expect(readyAtMs).toBe(1_032 + 750.5)
    expect(readyFrameLog.frames).toEqual(settle.frames)
    expect(frameLogMismatch(readyFrameLog, { start: spawnAtMs, end: readyAtMs })).toBeNull()
  })

  test("the framework rejects an app-start clock that ignores the offset", () => {
    const settle = pageSettle(1_000, 10_750.5)
    const { readyFrameLog } = appStartReadiness(settle, 200, 10_000)
    expect(frameLogMismatch(readyFrameLog, { start: 200, end: settle.settledAt })).not.toBeNull()
  })
})
