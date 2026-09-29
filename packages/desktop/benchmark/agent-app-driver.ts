#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { access, cp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { ReadinessTarget } from "./corpus"
import { sdk } from "./driver-sdk"
import { launchOpenCode, type AppLaunch, type OwnedProcess } from "./launch"
import { materializeCorpus, type MaterializedCorpus } from "./materialize"
import type { Activation } from "./settle"

/**
 * OpenCode's application-owned driver for the public Agent App Benchmark.
 *
 * Trusted NDJSON adapter over stdin/stdout: it materializes the canonical
 * OpenCode corpus through `opencode import`, launches the packaged desktop app
 * from sealed state snapshots, and returns raw per-action readiness evidence.
 * The framework owns scheduling, repetitions, resource sampling, statistics,
 * and reports. Supported scenarios: app start and the session list walk, over
 * the public corpus or a private one.
 */

const here = import.meta.dir
const repoRoot = path.resolve(here, "..", "..", "..")
const APP_START_SCENARIO_IDS = ["app-start", "app-start-real-sessions"]
const SESSION_SWITCH_SCENARIO_IDS = ["session-switch-walk", "session-switch-walk-real-sessions"]

type Clock = { kind: "single-monotonic-clock"; clock: string; start: number; end: number }
type ReadinessCheck = { id: string; passed: true; observedAt?: number }
type ReadinessReceipt = { endpoint: "correct-content-painted-and-input-ready"; checks: ReadinessCheck[] }

const log = (line: string) => process.stderr.write(`[opencode-driver ${new Date().toISOString().slice(11, 23)}] ${line}\n`)

function readinessReceipt(observedAt: number): ReadinessReceipt {
  return {
    endpoint: "correct-content-painted-and-input-ready",
    checks: ["content-identity", "first-fold-painted", "two-presentations", "trusted-input"].map((id) => ({ id, passed: true, observedAt })),
  }
}

function execution(caseId: string, clock: Clock) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness: readinessReceipt(clock.end) }
}

function activationExecution(caseId: string, { clock, frameLog }: Activation) {
  return { ...execution(caseId, clock), frameLog }
}

async function sha256Files(files: string[]) {
  const hash = createHash("sha256")
  for (const file of files) hash.update(await readFile(file))
  return hash.digest("hex")
}

async function gitHead(cwd: string) {
  const child = Bun.spawn({ cmd: ["git", "rev-parse", "HEAD"], cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const commit = stdout.trim()
  if (code !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error("OpenCode source revision is invalid")
  return commit
}

const executable = (() => {
  const configured = process.env.OPENCODE_BENCHMARK_EXECUTABLE?.trim()
  if (!configured) throw new Error("OPENCODE_BENCHMARK_EXECUTABLE must point at the packaged OpenCode desktop executable")
  return configured
})()
await access(executable)

const desktopPackage = JSON.parse(await readFile(path.join(repoRoot, "packages", "desktop", "package.json"), "utf8")) as { version?: string }
if (typeof desktopPackage.version !== "string") throw new Error("OpenCode desktop version is missing")
const sourceCommit = await gitHead(repoRoot)
const driverFiles = ["agent-app-driver.ts", "driver-sdk.ts", "corpus.ts", "materialize.ts", "launch.ts", "settle.ts", "cdp-page.ts", "process-family.ts", "idle-process-family.ts"].map((name) => path.join(here, name))
const driverDigestSha256 = await sha256Files(driverFiles)
const applicationAsar = path.resolve(path.dirname(executable), "..", "Resources", "app.asar")
const buildDigestSha256 = await sha256Files([executable, applicationAsar])

type Prepared = {
  materialization: MaterializedCorpus
  privateRoot: string
  stateHandles: { P0: string; P1: string }
}

let prepared: Prepared | undefined
let current: { launch: AppLaunch; attemptDir: string } | undefined
let attemptSequence = 0

const requirePrepared = () => {
  if (!prepared) throw new Error("OpenCode driver has not prepared the public corpus")
  return prepared
}
const resolveTarget = (logicalSessionId: string): ReadinessTarget => {
  const target = requirePrepared().materialization.targets.get(logicalSessionId)
  if (!target) throw new Error(`OpenCode has no materialized target for ${logicalSessionId}`)
  return target
}
const requireStateHandle = (handle: unknown) => {
  const handles = requirePrepared().stateHandles
  if (handle !== handles.P0 && handle !== handles.P1) throw new Error("OpenCode rejected an unknown state handle")
  return handle as string
}

async function startFromHandle(handle: string) {
  if (current) throw new Error("OpenCode application is already running")
  const { privateRoot, materialization } = requirePrepared()
  const attemptDir = path.join(privateRoot, "attempts", `${String(++attemptSequence).padStart(3, "0")}-${path.basename(handle)}`)
  await mkdir(path.dirname(attemptDir), { recursive: true, mode: 0o700 })
  await cp(handle, attemptDir, { recursive: true, errorOnExist: true, mode: fsConstants.COPYFILE_FICLONE })
  const launch = await launchOpenCode({
    executable,
    stateRoot: attemptDir,
    workspaces: materialization.workspaces,
    control: resolveTarget("control"),
    log,
  })
  current = { launch, attemptDir }
  return launch
}

async function closeCurrent() {
  const running = current
  current = undefined
  if (!running) return { terminated: [] as OwnedProcess[], survivors: [] as OwnedProcess[] }
  const result = await running.launch.shutdown()
  if (result.survivors.length === 0) await rm(running.attemptDir, { recursive: true, force: true })
  return result
}

type PreparedCache = {
  corpusDigestSha256: string
  materialization: Omit<MaterializedCorpus, "targets" | "workspaces"> & {
    targets: Array<[string, ReadinessTarget]>
    workspaces: Array<[string, string]>
  }
}

const PREPARED_CACHE_FILE = "prepared.json"

/** A materialization and its P1 left in AGENT_APP_BENCHMARK_STATE_CACHE by an earlier scenario of the same run. */
async function readPreparedCache(stateRoot: string, corpusDigestSha256: string): Promise<MaterializedCorpus | undefined> {
  let cache: PreparedCache
  try {
    cache = JSON.parse(await readFile(path.join(stateRoot, PREPARED_CACHE_FILE), "utf8")) as PreparedCache
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (cache.corpusDigestSha256 !== corpusDigestSha256) throw new Error("OpenCode prepared-state cache belongs to a different corpus")
  return { ...cache.materialization, targets: new Map(cache.materialization.targets), workspaces: new Map(cache.materialization.workspaces) }
}

async function writePreparedCache(stateRoot: string, materialization: MaterializedCorpus) {
  const cache: PreparedCache = {
    corpusDigestSha256: materialization.manifest.corpusDigestSha256,
    materialization: { ...materialization, targets: [...materialization.targets], workspaces: [...materialization.workspaces] },
  }
  await writeFile(path.join(stateRoot, PREPARED_CACHE_FILE), JSON.stringify(cache), { mode: 0o600 })
}

async function seedInitializedState(p0: string, p1: string) {
  await rm(p1, { recursive: true, force: true })
  await cp(p0, p1, { recursive: true, errorOnExist: true, mode: fsConstants.COPYFILE_FICLONE })
  const launch = await launchOpenCode({
    executable,
    stateRoot: p1,
    workspaces: requirePrepared().materialization.workspaces,
    control: resolveTarget("control"),
    log,
  })
  const closed = await launch.shutdown()
  if (closed.survivors.length > 0) throw new Error("OpenCode P1 initialization left a surviving process")
}

await sdk.serveDriver({
  hello: async () => ({
    protocolVersion: 1,
    application: { id: "opencode", name: "OpenCode", version: desktopPackage.version, buildDigestSha256 },
    driver: { name: "opencode-desktop-driver", version: "2", sourceCommit, digestSha256: driverDigestSha256 },
    scenarios: [...APP_START_SCENARIO_IDS, ...SESSION_SWITCH_SCENARIO_IDS],
    sourceEventFormats: ["opencode-event"],
    materializationModes: ["native-opencode"],
    clockRule: "settle-31-frames",
    guiFramework: "electron",
  }),
  prepare: async (params) => {
    if (prepared) throw new Error("OpenCode driver is already prepared")
    // The run directory is handed over as macOS spells it (`/var/...`), while
    // git and the app resolve worktrees to the real path (`/private/var/...`).
    // Sessions are imported and opened under the real path so both agree.
    const privateRoot = path.join(await realpath(path.resolve(params.runDirectory)), "driver-state", "opencode")
    // A run's scenarios share one materialization and P1 through the state
    // cache; every launch still starts from its own copy under the run
    // directory.
    const stateCache = process.env.AGENT_APP_BENCHMARK_STATE_CACHE
    const stateRoot = stateCache ? path.join(await realpath(stateCache), "opencode") : privateRoot
    await mkdir(stateRoot, { recursive: true, mode: 0o700 })
    const p0 = path.join(stateRoot, "P0")
    const p1 = path.join(stateRoot, "P1")
    const cached = stateCache ? await readPreparedCache(stateRoot, params.corpusDigestSha256) : undefined
    const materialization = cached ?? await materializeCorpus({
      repoRoot,
      corpusDirectory: params.corpusDirectory,
      corpusManifestPath: params.corpusManifestPath,
      expectedCorpusDigestSha256: params.corpusDigestSha256,
      expectedEventSchemaDigestSha256: params.eventSchemaDigestSha256,
      stateRoot: p0,
      workspaceRoot: path.join(stateRoot, "workspaces"),
      scratchRoot: path.join(stateRoot, "scratch"),
      log,
    })
    prepared = { materialization, privateRoot, stateHandles: { P0: p0, P1: p1 } }
    if (!cached) {
      try {
        await seedInitializedState(p0, p1)
      } catch (error) {
        log(`P1 unmeasured launch failed: ${error instanceof Error ? error.message : String(error)}; retrying once from a fresh P0 clone`)
        await seedInitializedState(p0, p1)
      }
      if (stateCache) await writePreparedCache(stateRoot, materialization)
    }
    return {
      materializationMode: "native-opencode",
      corpusDigestSha256: materialization.manifest.corpusDigestSha256,
      eventSchemaDigestSha256: materialization.manifest.sourceEventFormat.schemaDigestSha256,
      mappingDigestSha256: materialization.mappingDigestSha256,
      stateHandles: prepared.stateHandles,
      sessionMapping: materialization.sessionMapping,
    }
  },
  launch: async (params) => {
    const handle = requireStateHandle(params.stateHandle)
    resolveTarget(String(params.initialSessionId ?? "control"))
    const launch = await startFromHandle(handle)
    return {
      ready: true,
      processes: [launch.process],
      readiness: readinessReceipt(launch.readyAtMs),
    }
  },
  execute: async (params) => {
    const scenarioId = String(params.scenarioId)
    const benchmarkCase = params.case as Record<string, any>
    if (APP_START_SCENARIO_IDS.includes(scenarioId)) {
      if (current) throw new Error("OpenCode app-start requires no running application")
      const handle = requireStateHandle(params.stateHandle)
      const launch = await startFromHandle(handle)
      const clock: Clock = { kind: "single-monotonic-clock", clock: "bun-performance", start: launch.spawnAtMs, end: launch.readyAtMs }
      return { ...execution(String(benchmarkCase.caseId), clock), frameLog: launch.readyFrameLog }
    }
    if (!current) throw new Error("OpenCode session activation requires a running application")
    const { launch } = current
    if (SESSION_SWITCH_SCENARIO_IDS.includes(scenarioId) && benchmarkCase.workload === "list-walk") {
      const destination = resolveTarget(String(benchmarkCase.destinationSessionId))
      const source = resolveTarget(String(benchmarkCase.sourceSessionId ?? "control"))
      if ((benchmarkCase.sessionState === "cold") === (await launch.wasDisplayed(destination))) {
        throw new Error(`OpenCode list-walk ${String(benchmarkCase.sessionState)} step to ${destination.logicalSessionId} does not match this process's visits`)
      }
      // A first visit opens the destination's tab, a return clicks it; either
      // way the strip ends up in walk order, so the step must leave the
      // destination's tab directly right of the source's.
      const measured = await launch.activate(destination)
      if (benchmarkCase.walkPosition !== 0) {
        const tabs = await launch.tabSessionIds()
        const sourceTab = tabs.indexOf(source.sessionId)
        if (sourceTab < 0 || tabs[sourceTab + 1] !== destination.sessionId) {
          throw new Error(`OpenCode's tab for ${destination.logicalSessionId} is ${sourceTab < 0 ? "open without" : "not directly right of"} ${source.logicalSessionId}'s`)
        }
      }
      return activationExecution(String(benchmarkCase.caseId), measured)
    }
    if (SESSION_SWITCH_SCENARIO_IDS.includes(scenarioId)) {
      const destination = resolveTarget(String(benchmarkCase.destinationSessionId))
      const control = resolveTarget(String(benchmarkCase.sourceSessionId ?? "control"))
      if (benchmarkCase.workload !== "resource-control") {
        if (benchmarkCase.sessionState === "cold" && (await launch.wasDisplayed(destination))) {
          throw new Error("OpenCode cold destination was already displayed in this process (the app opens a project's most recent session when the project is opened)")
        }
        // Untimed, before the control visit settles: only the control tab stays
        // open, so the strip never overflows and the previous destination stays
        // on screen until the next case starts.
        await launch.resetTabs(control)
        await launch.activate(control)
      }
      return activationExecution(String(benchmarkCase.caseId), await launch.activate(destination))
    }
    throw new Error(`OpenCode driver does not support scenario ${scenarioId}`)
  },
  shutdown: async () => closeCurrent(),
})
