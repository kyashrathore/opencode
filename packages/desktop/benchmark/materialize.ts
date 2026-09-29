import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { partPayloadBytes, readManifest, readSession, type CorpusManifest, type ReadinessTarget } from "./corpus"

/**
 * Materializes the public corpus through OpenCode's shipped history path:
 * every logical session is written as the `opencode export` JSON shape and
 * imported with `opencode import` inside its workspace directory, so the
 * session, message, and part rows are produced by the production import code
 * of the exact source revision that the packaged app runs. The database is
 * then read back and compared with the manifest.
 */

export type MaterializedCorpus = {
  manifest: CorpusManifest
  targets: Map<string, ReadinessTarget>
  workspaces: Map<string, string>
  sessionMapping: Record<string, string>
  mappingDigestSha256: string
  messageCount: number
  transcriptBytes: number
}

export function stateEnv(stateRoot: string): Record<string, string> {
  return {
    // The database name otherwise depends on the installation channel (`local`
    // when the CLI runs from source, `dev` for the packaged app); one absolute
    // path keeps the import and the app on the same file.
    OPENCODE_DB: path.join(stateRoot, "xdg", "data", "opencode", "opencode.db"),
    HOME: path.join(stateRoot, "home"),
    XDG_DATA_HOME: path.join(stateRoot, "xdg", "data"),
    XDG_CONFIG_HOME: path.join(stateRoot, "xdg", "config"),
    XDG_CACHE_HOME: path.join(stateRoot, "xdg", "cache"),
    XDG_STATE_HOME: path.join(stateRoot, "xdg", "state"),
  }
}

export function statePaths(stateRoot: string) {
  return {
    profile: path.join(stateRoot, "profile"),
    database: path.join(stateRoot, "xdg", "data", "opencode", "opencode.db"),
    appStdout: path.join(stateRoot, "app-stdout.log"),
    appStderr: path.join(stateRoot, "app-stderr.log"),
  }
}

/** The ambient environment the app and the CLI see: no operator config, keys, or plugins. */
export function isolatedEnvironment(stateRoot: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("OPENCODE_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  return { ...env, ...stateEnv(stateRoot) }
}

/**
 * Registers the corpus workspaces in the app's own persisted project list
 * (`opencode.global.dat`, the store the desktop app keeps per profile), the way
 * a user's profile remembers folders they have opened. The home page then lists
 * every workspace's sessions on first launch without navigating into a
 * workspace, which would otherwise open its most recent session unasked.
 */
async function seedProfileProjects(stateRoot: string, workspaces: Map<string, string>) {
  const projects = [...workspaces.keys()].sort().map((workspaceId) => ({ worktree: workspaces.get(workspaceId)!, expanded: true }))
  const store = {
    server: JSON.stringify({ list: [], projects: { local: projects }, lastProject: { local: projects[0]?.worktree }, recentlyClosed: {} }),
  }
  await writeFile(path.join(statePaths(stateRoot).profile, "opencode.global.dat"), JSON.stringify(store, null, "\t"))
}

export async function prepareStateRoot(stateRoot: string) {
  const env = stateEnv(stateRoot)
  const directories = [
    env.HOME!,
    env.XDG_DATA_HOME!,
    env.XDG_CONFIG_HOME!,
    env.XDG_CACHE_HOME!,
    env.XDG_STATE_HOME!,
    path.dirname(statePaths(stateRoot).database),
    statePaths(stateRoot).profile,
  ]
  await Promise.all(directories.map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })))
}

async function run(cmd: string[], options: { cwd: string; env: Record<string, string>; label: string }) {
  const child = Bun.spawn({ cmd, cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${options.label} failed (${String(code)}): ${stderr.trim().slice(-2000)}\n${stdout.trim().slice(-500)}`)
  return { stdout, stderr }
}

async function ensureWorkspaceRepository(directory: string, env: Record<string, string>) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const gitEnv = {
    ...env,
    GIT_AUTHOR_NAME: "Agent App Benchmark",
    GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
    GIT_COMMITTER_NAME: "Agent App Benchmark",
    GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
  }
  const exists = await Bun.file(path.join(directory, ".git", "HEAD")).exists()
  if (exists) return
  await writeFile(path.join(directory, "README.md"), `# Benchmark ${path.basename(directory)}\n`)
  await run(["git", "init", "-q"], { cwd: directory, env: gitEnv, label: "git init" })
  await run(["git", "add", "README.md"], { cwd: directory, env: gitEnv, label: "git add" })
  await run(["git", "commit", "-q", "-m", "benchmark workspace"], { cwd: directory, env: gitEnv, label: "git commit" })
}

export async function materializeCorpus(input: {
  repoRoot: string
  corpusDirectory: string
  corpusManifestPath: string
  expectedCorpusDigestSha256: string
  expectedEventSchemaDigestSha256: string
  stateRoot: string
  workspaceRoot: string
  scratchRoot: string
  log?: (line: string) => void
}): Promise<MaterializedCorpus> {
  const log = input.log ?? (() => undefined)
  const manifest = await readManifest(input.corpusManifestPath, {
    corpusDigestSha256: input.expectedCorpusDigestSha256,
    eventSchemaDigestSha256: input.expectedEventSchemaDigestSha256,
  })
  await prepareStateRoot(input.stateRoot)
  await mkdir(input.scratchRoot, { recursive: true, mode: 0o700 })
  const env = isolatedEnvironment(input.stateRoot)
  const workspaces = new Map<string, string>()
  for (const workspaceId of [...new Set(manifest.sessions.map((session) => session.workspaceId))].sort()) {
    const directory = path.join(input.workspaceRoot, workspaceId)
    await ensureWorkspaceRepository(directory, env)
    workspaces.set(workspaceId, directory)
  }
  await seedProfileProjects(input.stateRoot, workspaces)

  const cli = path.join(input.repoRoot, "packages", "opencode", "src", "index.ts")
  const targets = new Map<string, ReadinessTarget>()
  let expectedMessages = 0
  let expectedBytes = 0
  const startedAt = performance.now()
  for (const session of manifest.sessions) {
    const workspace = workspaces.get(session.workspaceId)
    if (!workspace) throw new Error(`OpenCode has no workspace for ${session.logicalSessionId}`)
    const parsed = await readSession(input.corpusDirectory, session)
    const file = path.join(input.scratchRoot, `${session.logicalSessionId}.json`)
    await writeFile(file, JSON.stringify(parsed.exported))
    await run(["bun", cli, "import", file], { cwd: workspace, env, label: `opencode import ${session.logicalSessionId}` })
    await rm(file, { force: true })
    targets.set(session.logicalSessionId, parsed.target)
    expectedMessages += parsed.messageCount
    expectedBytes += parsed.transcriptBytes
    log(`imported ${session.logicalSessionId} (${String(Math.round((performance.now() - startedAt) / 1000))}s)`)
  }

  // Read-write open: a read-only connection cannot create the WAL shm sidecar the
  // CLI removed on its clean close. Only SELECT statements run here.
  const database = new Database(statePaths(input.stateRoot).database)
  try {
    const sessionCount = Number((database.query("SELECT COUNT(*) AS count FROM session").get() as { count: number }).count)
    const messageCount = Number((database.query("SELECT COUNT(*) AS count FROM message").get() as { count: number }).count)
    let transcriptBytes = 0
    for (const row of database.query("SELECT data FROM part").iterate() as Iterable<{ data: string }>) {
      transcriptBytes += partPayloadBytes(JSON.parse(row.data))
    }
    if (sessionCount !== manifest.sessions.length || messageCount !== expectedMessages || transcriptBytes !== expectedBytes) {
      throw new Error(
        `OpenCode database readback does not match the public corpus (sessions ${String(sessionCount)}/${String(manifest.sessions.length)}, messages ${String(messageCount)}/${String(expectedMessages)}, bytes ${String(transcriptBytes)}/${String(expectedBytes)})`,
      )
    }
    const sessionMapping = Object.fromEntries([...targets.values()].map((target) => [target.logicalSessionId, target.sessionId]))
    return {
      manifest,
      targets,
      workspaces,
      sessionMapping,
      mappingDigestSha256: createHash("sha256").update(JSON.stringify(sessionMapping, Object.keys(sessionMapping).sort())).digest("hex"),
      messageCount,
      transcriptBytes,
    }
  } finally {
    database.close()
  }
}
