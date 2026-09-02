#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { ReadinessTarget } from "./corpus"
import { launchOpenCode, type ActivationClock, type AppLaunch, type OwnedProcess } from "./launch"
import { materializeCorpus, type MaterializedCorpus } from "./materialize"

/**
 * OpenCode's application-owned driver for the public Agent App Benchmark.
 *
 * Trusted NDJSON adapter over stdin/stdout: it materializes the canonical
 * OpenCode corpus through `opencode import`, launches the packaged desktop app
 * from sealed state snapshots, and returns raw per-action readiness evidence.
 * The framework owns scheduling, repetitions, resource sampling, statistics,
 * and reports. Supported scenarios: app-start-v3, session-switch-v3, and the
 * history trend of session-navigation-v1; panel-open returns and the
 * workspace-panel scenarios are reported as unsupported rather than scored.
 */

const here = import.meta.dir
const repoRoot = path.resolve(here, "..", "..", "..")
const benchmarkRoot = process.env.AGENT_APP_BENCHMARK_ROOT ?? path.resolve(repoRoot, "..", "agent-app-benchmark")
const sdk = (await import(pathToFileURL(path.join(benchmarkRoot, "src", "driver-sdk.mjs")).href)) as {
  serveDriver(handlers: Record<string, (params: any) => unknown>): Promise<void>
}
const fixtures = (await import(pathToFileURL(path.join(benchmarkRoot, "src", "workspace-fixture.mjs")).href)) as {
  verifyWorkspaceFixtureManifest(manifest: unknown): WorkspaceFixtureManifest
  generateWorkspaceFileBytes(seed: string, file: WorkspaceFixtureFile, revision: "initial" | "current"): Uint8Array
  attestWorkspaceFixture(
    manifest: WorkspaceFixtureManifest,
    readRevision: (filePath: string, revision: "initial" | "current") => Uint8Array | Promise<Uint8Array>,
  ): Promise<string>
}

type WorkspaceFixtureFile = { path: string; byteLength: number; changed: boolean }
type WorkspaceFixtureManifest = {
  seed: string
  directories: readonly string[]
  files: readonly WorkspaceFixtureFile[]
  manifestDigestSha256: string
}

type Clock = { kind: "single-monotonic-clock"; clock: string; start: number; end: number }
type ReadinessCheck = { id: string; passed: true; observedAt?: number }
type ReadinessReceipt = { endpoint: "correct-content-painted-and-input-ready"; checks: ReadinessCheck[] }

const log = (line: string) => process.stderr.write(`[opencode-driver] ${line}\n`)

function readinessReceipt(observedAt: number): ReadinessReceipt {
  return {
    endpoint: "correct-content-painted-and-input-ready",
    checks: ["content-identity", "first-fold-painted", "two-presentations", "trusted-input"].map((id) => ({ id, passed: true, observedAt })),
  }
}

function execution(caseId: string, clock: Clock) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness: readinessReceipt(clock.end) }
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

async function gitRun(args: string[], cwd: string) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Agent App Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
      GIT_COMMITTER_NAME: "Agent App Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
    },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`)
  return new Uint8Array(stdout)
}

/**
 * Writes the canonical workspace fixture into a workspace repository: the
 * initial revision is committed, the current revision is the working tree.
 * Attestation reads both back from git and disk, never from the generator.
 */
async function materializeWorkspaceFixture(manifest: WorkspaceFixtureManifest, directory: string) {
  for (const relative of manifest.directories) await mkdir(path.join(directory, relative), { recursive: true, mode: 0o700 })
  for (const file of manifest.files) {
    await writeFile(path.join(directory, file.path), fixtures.generateWorkspaceFileBytes(manifest.seed, file, "initial"))
  }
  await gitRun(["add", "-A"], directory)
  await gitRun(["commit", "-q", "-m", "benchmark workspace fixture"], directory)
  for (const file of manifest.files) {
    if (!file.changed) continue
    await writeFile(path.join(directory, file.path), fixtures.generateWorkspaceFileBytes(manifest.seed, file, "current"))
  }
  return fixtures.attestWorkspaceFixture(manifest, async (filePath, revision) =>
    revision === "initial" ? gitRun(["show", `HEAD:${filePath}`], directory) : new Uint8Array(await readFile(path.join(directory, filePath))),
  )
}

const executable = process.env.OPENCODE_BENCHMARK_EXECUTABLE?.trim()
if (!executable) throw new Error("OPENCODE_BENCHMARK_EXECUTABLE must point at the packaged OpenCode desktop executable")
await access(executable)

const desktopPackage = JSON.parse(await readFile(path.join(repoRoot, "packages", "desktop", "package.json"), "utf8")) as { version?: string }
if (typeof desktopPackage.version !== "string") throw new Error("OpenCode desktop version is missing")
const sourceCommit = await gitHead(repoRoot)
const driverFiles = ["agent-app-driver.ts", "corpus.ts", "materialize.ts", "launch.ts", "cdp-page.ts", "process-family.ts", "idle-process-family.ts"].map((name) => path.join(here, name))
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
let visitedDestinations = new Set<string>()

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
  visitedDestinations = new Set()
  return launch
}

async function closeCurrent() {
  const running = current
  current = undefined
  visitedDestinations = new Set()
  if (!running) return { terminated: [] as OwnedProcess[], survivors: [] as OwnedProcess[] }
  const result = await running.launch.shutdown()
  if (result.survivors.length === 0) await rm(running.attemptDir, { recursive: true, force: true })
  return result
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
    driver: { name: "opencode-desktop-driver", version: "1", sourceCommit, digestSha256: driverDigestSha256 },
    scenarios: ["app-start-v3", "session-switch-v3", "session-navigation-v1"],
    sourceEventFormats: ["opencode-event-v2"],
    materializationModes: ["native-opencode"],
    guiFramework: "electron",
  }),
  prepare: async (params) => {
    if (prepared) throw new Error("OpenCode driver is already prepared")
    const privateRoot = path.join(path.resolve(params.runDirectory), "driver-state", "opencode")
    const p0 = path.join(privateRoot, "P0")
    const p1 = path.join(privateRoot, "P1")
    const materialization = await materializeCorpus({
      repoRoot,
      corpusDirectory: params.corpusDirectory,
      corpusManifestPath: params.corpusManifestPath,
      expectedCorpusDigestSha256: params.corpusDigestSha256,
      expectedEventSchemaDigestSha256: params.eventSchemaDigestSha256,
      stateRoot: p0,
      workspaceRoot: path.join(privateRoot, "workspaces"),
      scratchRoot: path.join(privateRoot, "scratch"),
      log,
    })
    prepared = { materialization, privateRoot, stateHandles: { P0: p0, P1: p1 } }
    let workspaceFixtureDigestSha256: string | undefined
    if (params.workspaceFixtureManifest) {
      const manifest = fixtures.verifyWorkspaceFixtureManifest(params.workspaceFixtureManifest)
      if (manifest.manifestDigestSha256 !== params.workspaceFixtureDigestSha256) throw new Error("OpenCode received the wrong workspace fixture digest")
      const controlWorkspace = materialization.workspaces.get(resolveTarget("control").workspaceId)
      if (!controlWorkspace) throw new Error("OpenCode control workspace is missing")
      workspaceFixtureDigestSha256 = await materializeWorkspaceFixture(manifest, controlWorkspace)
    }
    try {
      await seedInitializedState(p0, p1)
    } catch (error) {
      log(`P1 unmeasured launch failed: ${error instanceof Error ? error.message : String(error)}; retrying once from a fresh P0 clone`)
      await seedInitializedState(p0, p1)
    }
    return {
      materializationMode: "native-opencode",
      corpusDigestSha256: materialization.manifest.corpusDigestSha256,
      eventSchemaDigestSha256: materialization.manifest.sourceEventFormat.schemaDigestSha256,
      mappingDigestSha256: materialization.mappingDigestSha256,
      ...(workspaceFixtureDigestSha256 ? { workspaceFixtureDigestSha256 } : {}),
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
    if (scenarioId === "app-start-v3") {
      if (current) throw new Error("OpenCode app-start requires no running application")
      const handle = requireStateHandle(params.stateHandle)
      const launch = await startFromHandle(handle)
      const clock: Clock = { kind: "single-monotonic-clock", clock: "bun-performance", start: launch.spawnAtMs, end: launch.readyAtMs }
      return execution(String(benchmarkCase.caseId), clock)
    }
    if (!current) throw new Error("OpenCode session activation requires a running application")
    const { launch } = current
    if (scenarioId === "session-navigation-v1") {
      const navigationType = String(benchmarkCase.navigationType)
      const destinationId = String(benchmarkCase.destinationSessionId)
      const destination = resolveTarget(destinationId)
      if (navigationType === "return-visited-panel-open") {
        throw new Error("OpenCode driver does not seed workspace panel loads; panel-open session returns are unsupported")
      }
      if (navigationType === "first-visit" && visitedDestinations.has(destinationId)) {
        throw new Error("OpenCode first-visit destination was already displayed in this process")
      }
      if (navigationType === "return-visited-panel-closed" && !visitedDestinations.has(destinationId)) {
        throw new Error("OpenCode return navigation requires a prior first-visit of the destination in this process")
      }
      const clock = await launch.activate(destination)
      visitedDestinations.add(destinationId)
      return {
        ...execution(String(benchmarkCase.caseId), clock),
        timingEvidence: { trustedInputAt: clock.start, trustedInputEvent: "pointerdown" },
      }
    }
    if (scenarioId === "session-switch-v3") {
      const destination = resolveTarget(String(benchmarkCase.destinationSessionId))
      const control = resolveTarget(String(benchmarkCase.sourceSessionId ?? "control"))
      if (benchmarkCase.workload !== "resource-control") {
        if (benchmarkCase.sessionState === "warm") await launch.activate(destination)
        await launch.activate(control)
      }
      const clock: ActivationClock = await launch.activate(destination)
      return execution(String(benchmarkCase.caseId), clock)
    }
    throw new Error(`OpenCode driver does not support scenario ${scenarioId}`)
  },
  shutdown: async () => closeCurrent(),
})
