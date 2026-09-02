import { createServer } from "node:net"
import path from "node:path"
import { connectCdpPage, type BenchmarkPage } from "./cdp-page"
import { textSha256, type ReadinessTarget } from "./corpus"
import { isolatedEnvironment, statePaths } from "./materialize"
import { processFamily, readProcessTable, sameProcessIdentity, type ProcessSnapshot } from "./process-family"

/**
 * Launches the packaged OpenCode desktop app from an isolated state root and
 * drives it over the Chrome DevTools Protocol: a trusted pointer click on a
 * session row, then an in-page requestAnimationFrame observer that resolves
 * when the canonical transcript is painted, the first fold is complete, the
 * composer accepts input, and two consecutive frames after the input agree.
 */

export type OwnedProcess = {
  pid: number
  startTimeMs: number
  owner: "application"
  category: string
  role?: "main" | "renderer" | "gpu" | "utility" | "external-helper"
}

export type ActivationClock = {
  kind: "single-monotonic-clock"
  clock: "performance.now"
  start: number
  end: number
}

type ActivationResult = {
  trustedInputAt: number
  paintedAt: number
  timeOrigin: number
  partId: string
  text: string
}

export type AppLaunch = {
  process: OwnedProcess
  page: BenchmarkPage
  /** Bun performance.now() immediately before process spawn. */
  spawnAtMs: number
  /** Control-session readiness in the same Bun clock. */
  readyAtMs: number
  activate(target: ReadinessTarget): Promise<ActivationClock>
  shutdown(): Promise<{ terminated: OwnedProcess[]; survivors: OwnedProcess[] }>
}

const DEFAULT_TIMEOUT_MS = 60_000

function keychainArgs() {
  return process.platform === "darwin" ? ["--use-mock-keychain"] : []
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address !== "object") return reject(new Error("no port"))
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

export async function launchOpenCode(input: {
  executable: string
  stateRoot: string
  workspaces: Map<string, string>
  control: ReadinessTarget
  timeoutMs?: number
  log?: (line: string) => void
}): Promise<AppLaunch> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = input.log ?? (() => undefined)
  const paths = statePaths(input.stateRoot)
  const debugPort = await freePort()
  const spawnAtMs = performance.now()
  const controlDirectory = input.workspaces.get(input.control.workspaceId)
  if (!controlDirectory) throw new Error("OpenCode control workspace directory is missing")
  // The desktop app opens the directory it was launched from, the way a user
  // launching it from a project (or the CLI's open-in-desktop) gets that project.
  const application = Bun.spawn({
    // --use-mock-keychain: the isolated HOME has no login keychain; without it
    // macOS blocks the app on a "Keychain Not Found" dialog for its safe-storage key.
    cmd: [input.executable, `--remote-debugging-port=${String(debugPort)}`, ...keychainArgs()],
    cwd: controlDirectory,
    // Electron derives userData from the system home, not $HOME, so the app
    // honours OPENCODE_DESKTOP_USER_DATA_DIR (benchmark branch hook) to keep
    // the profile inside the sealed state root.
    env: { ...isolatedEnvironment(input.stateRoot), OPENCODE_DESKTOP_USER_DATA_DIR: paths.profile, PWD: controlDirectory },
    stdout: Bun.file(paths.appStdout),
    stderr: Bun.file(paths.appStderr),
  })
  let page: BenchmarkPage | undefined
  try {
    page = await connectCdpPage({ port: debugPort, process: application, timeoutMs })
    const connected = page
    await installInputRecorder(connected)
    // Projects are opened the way the CLI and OS open them: an
    // `opencode://open-project` deep link handed to the running instance
    // through Electron's second-instance argv (same user-data-dir, same lock).
    const openProject = async (directory: string) => {
      log(`open-project ${path.basename(directory)}`)
      const second = Bun.spawn({
        cmd: [input.executable, ...keychainArgs(), `opencode://open-project?directory=${encodeURIComponent(directory)}`],
        env: { ...isolatedEnvironment(input.stateRoot), OPENCODE_DESKTOP_USER_DATA_DIR: paths.profile },
        stdout: "ignore",
        stderr: "ignore",
      })
      await Promise.race([second.exited, Bun.sleep(8_000)])
      if (second.exitCode === null) second.kill("SIGKILL")
    }
    const ready = await activateSession(connected, input.control, input.workspaces, timeoutMs, log, openProject)
    const readyAtMs = ready.timeOrigin + ready.paintedAt - performance.timeOrigin

    const table = await readProcessTable()
    const root = table.find((item) => item.pid === application.pid)
    if (!root) throw new Error(`Unable to resolve OpenCode root process ${String(application.pid)}`)
    const known = new Map<string, ProcessSnapshot>()
    const refreshKnown = async () => {
      for (const item of processFamily(await readProcessTable(), application.pid)) known.set(`${String(item.pid)}:${String(item.startTimeMs)}`, item)
    }
    await refreshKnown()
    const ownershipTimer = setInterval(() => void refreshKnown().catch(() => undefined), 100)
    ownershipTimer.unref()
    const owned = (item: Pick<ProcessSnapshot, "pid" | "startTimeMs">): OwnedProcess => ({
      pid: item.pid,
      startTimeMs: item.startTimeMs,
      owner: "application",
      category: item.pid === application.pid ? "opencode-root" : "opencode-descendant",
    })

    return {
      process: { ...owned(root), role: "main" },
      page: connected,
      spawnAtMs,
      readyAtMs,
      async activate(target) {
        const result = await activateSession(connected, target, input.workspaces, timeoutMs, log, openProject)
        return { kind: "single-monotonic-clock", clock: "performance.now", start: result.trustedInputAt, end: result.paintedAt }
      },
      async shutdown() {
        clearInterval(ownershipTimer)
        await refreshKnown().catch(() => undefined)
        await connected.rawCommand("Browser.close").catch(() => undefined)
        await Promise.race([application.exited, Bun.sleep(5_000)])
        if (application.exitCode === null) application.kill("SIGTERM")
        await Promise.race([application.exited, Bun.sleep(3_000)])
        if (application.exitCode === null) {
          application.kill("SIGKILL")
          await Promise.race([application.exited, Bun.sleep(3_000)])
        }
        connected.close()
        await Bun.sleep(300)
        const alive = (table: ProcessSnapshot[]) => [...known.values()].filter((item) => table.some((candidate) => sameProcessIdentity(candidate, item)))
        let remaining = alive(await readProcessTable())
        if (remaining.length > 0) {
          for (const item of remaining) {
            try { process.kill(item.pid, "SIGTERM") } catch {}
          }
          await Bun.sleep(1_000)
          remaining = alive(await readProcessTable())
          for (const item of remaining) {
            try { process.kill(item.pid, "SIGKILL") } catch {}
          }
          await Bun.sleep(500)
          remaining = alive(await readProcessTable())
        }
        const survivors = remaining.map(owned)
        const survivorKeys = new Set(survivors.map((item) => `${String(item.pid)}:${String(item.startTimeMs)}`))
        const terminated = [...known.values()].filter((item) => !survivorKeys.has(`${String(item.pid)}:${String(item.startTimeMs)}`)).map(owned)
        return { terminated, survivors }
      },
    }
  } catch (error) {
    page?.close()
    if (application.exitCode === null) application.kill("SIGKILL")
    throw error
  }
}

async function installInputRecorder(page: BenchmarkPage) {
  const install = () => {
    const carrier = window as Window & { __benchInput?: { lastTrustedAt?: number } }
    if (carrier.__benchInput) return
    carrier.__benchInput = {}
    addEventListener(
      "pointerdown",
      (event) => {
        if (event.isTrusted) carrier.__benchInput!.lastTrustedAt = performance.now()
      },
      true,
    )
  }
  await page.addInitScript(install)
  await page.evaluate(install)
}

/**
 * Untimed navigation until the target session row is laid out: opens the
 * workspace from the home project list, switches the sidebar project, and
 * pages the workspace's session list, the same controls a user would use.
 */
async function revealSessionRow(
  page: BenchmarkPage,
  target: ReadinessTarget,
  workspaces: Map<string, string>,
  timeoutMs: number,
  log: (line: string) => void,
  openProject: (directory: string) => Promise<void>,
) {
  const directory = workspaces.get(target.workspaceId)
  if (!directory) throw new Error(`OpenCode has no workspace directory for ${target.workspaceId}`)
  const deadline = performance.now() + timeoutMs
  let lastAction = ""
  let opened = false
  let switchedAt = 0
  while (performance.now() < deadline) {
    const step = await page.evaluate(
      (arg: { sessionId: string; directory: string; base: string }) => {
        const visible = (element: Element | null): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        }
        const center = (element: HTMLElement) => {
          element.scrollIntoView({ block: "center", inline: "nearest" })
          const rect = element.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        }
        const row = document.querySelector(`[data-session-id="${CSS.escape(arg.sessionId)}"]`)
        if (visible(row)) return { done: true as const }
        // Project rail: one button per opened project keyed by its base64 worktree.
        const decode = (value: string) => {
          try {
            return decodeURIComponent(escape(atob(value.replace(/-/gu, "+").replace(/_/gu, "/"))))
          } catch {
            return ""
          }
        }
        const projectButton = [...document.querySelectorAll<HTMLElement>('[data-action="project-switch"][data-project]')].find(
          (button) => visible(button) && decode(button.getAttribute("data-project") ?? "") === arg.directory,
        )
        if (projectButton) return { action: "project-switch" as const, point: center(projectButton) }
        const clickable = (element: HTMLElement) => element.closest<HTMLElement>("a, button, [role='button'], [role='link'], [tabindex]") ?? element
        // Home: the project list names each workspace by its directory.
        const home = document.querySelector('[data-slot="home-projects-scroll"]')
        if (home) {
          const candidates = [...home.querySelectorAll<HTMLElement>("*")].filter((element) => {
            if (!visible(element) || element.children.length > 0 && element.textContent!.trim() !== arg.base) return false
            const text = element.textContent?.trim() ?? ""
            return text === arg.base || text === arg.directory
          })
          const item = candidates[0]
          if (item) return { action: "home-project", point: center(clickable(item)) }
        }
        // Sidebar: a project entry for another directory.
        const project = document.querySelector<HTMLElement>(`[data-directory-path="${CSS.escape(arg.directory)}"]`)
        if (visible(project)) return { action: "sidebar-project", point: center(clickable(project)) }
        const projectByText = [...document.querySelectorAll<HTMLElement>("[data-project]")].find((element) => visible(element) && (element.textContent ?? "").includes(arg.base))
        if (projectByText) return { action: "sidebar-project-text", point: center(clickable(projectByText)) }
        // Sidebar: page the session list.
        const more = [...document.querySelectorAll<HTMLElement>("button")].find((button) => visible(button) && /\bmore\b/iu.test(button.textContent ?? "") && !/options/iu.test(button.getAttribute("aria-label") ?? ""))
        if (more) return { action: "show-more", point: center(more) }
        const railHasProjects = document.querySelector('[data-action="project-switch"]') !== null
        return { action: railHasProjects ? ("unopened" as const) : ("wait" as const) }
      },
      { sessionId: target.sessionId, directory, base: path.basename(directory) },
    )
    if ("done" in step) return
    if (step.action === "wait" || step.action === "unopened") {
      if (!opened) {
        opened = true
        await openProject(directory)
      }
      await Bun.sleep(150)
      continue
    }
    if (step.action === "project-switch") {
      // One switch, then give the session list a moment before switching again.
      if (performance.now() - switchedAt < 3_000) {
        await Bun.sleep(150)
        continue
      }
      switchedAt = performance.now()
    }
    if (step.action !== lastAction) log(`reveal ${target.logicalSessionId}: ${step.action}`)
    lastAction = step.action
    await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: step.point.x, y: step.point.y })
    await page.rawCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: step.point.x, y: step.point.y, button: "left", clickCount: 1 })
    await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: step.point.x, y: step.point.y, button: "left", clickCount: 1 })
    await Bun.sleep(250)
  }
  const snapshot = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 400),
    sessionRows: [...document.querySelectorAll("[data-session-id]")].map((element) => element.getAttribute("data-session-id")).slice(0, 12),
  }))
  throw new Error(`OpenCode session row for ${target.logicalSessionId} never became visible: ${JSON.stringify(snapshot)}`)
}

async function activateSession(
  page: BenchmarkPage,
  target: ReadinessTarget,
  workspaces: Map<string, string>,
  timeoutMs: number,
  log: (line: string) => void,
  openProject: (directory: string) => Promise<void>,
): Promise<ActivationResult> {
  await revealSessionRow(page, target, workspaces, timeoutMs, log, openProject)
  const armed = page.evaluate(
    (arg: { sessionId: string; firstPartId: string; finalPartId: string; timeoutMs: number }) =>
      new Promise<ActivationResult>((resolve, reject) => {
        const carrier = window as Window & { __benchInput?: { lastTrustedAt?: number } }
        const input = carrier.__benchInput
        if (!input) return reject(new Error("OpenCode trusted-input recorder is not installed"))
        input.lastTrustedAt = undefined
        const deadline = performance.now() + arg.timeoutMs
        const visible = (element: Element | null | undefined): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        }
        const scrollParent = (element: HTMLElement | null): HTMLElement => {
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node
          }
          return document.scrollingElement as HTMLElement
        }
        const partSelector = (id: string) => `[data-component="text-part"][data-timeline-part-id="${CSS.escape(id)}"] [data-slot="text-part-body"], [data-component="user-message"][data-timeline-part-id="${CSS.escape(id)}"]`
        let previous: string | undefined
        let stable = 0
        let diagnostic: Record<string, unknown> = {}
        const frame = (at: number) => {
          if (performance.now() >= deadline) return reject(new Error(`OpenCode session readiness timed out: ${JSON.stringify(diagnostic)}`))
          const trusted = input.lastTrustedAt
          if (trusted === undefined || at < trusted) {
            previous = undefined
            stable = 0
            requestAnimationFrame(frame)
            return
          }
          const candidates = [
            { id: arg.finalPartId, element: document.querySelector<HTMLElement>(partSelector(arg.finalPartId)) },
            { id: arg.firstPartId, element: document.querySelector<HTMLElement>(partSelector(arg.firstPartId)) },
          ]
          const painted = candidates.find((candidate) => visible(candidate.element))
          const part = painted?.element ?? null
          const row = part?.closest<HTMLElement>("[data-timeline-row]") ?? null
          const text = part?.innerText ?? ""
          const container = row ? scrollParent(row) : null
          const containerRect = container?.getBoundingClientRect()
          const rows = container && containerRect
            ? [...container.querySelectorAll<HTMLElement>("[data-timeline-row]")].filter((item) => {
                if (!visible(item)) return false
                const rect = item.getBoundingClientRect()
                return rect.bottom > containerRect.top && rect.top < containerRect.bottom
              })
            : []
          const overflow = container ? Math.max(0, container.scrollHeight - container.clientHeight) : 0
          const topGap = rows.length > 0 && containerRect ? Math.max(0, rows[0]!.getBoundingClientRect().top - containerRect.top) : Number.POSITIVE_INFINITY
          const completeFold = overflow <= 100 || (rows.length > 0 && topGap <= 96)
          const composer = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
          const composerReady = visible(composer) && composer.getAttribute("aria-disabled") !== "true" && !composer.hasAttribute("disabled")
          const skeleton = !!row?.querySelector('[data-slot="skeleton"], [data-component="skeleton"]')
          const ready = !!part && text.trim().length > 0 && !skeleton && completeFold && composerReady
          diagnostic = {
            url: location.href,
            trusted,
            painted: painted?.id,
            textLength: text.length,
            rows: rows.length,
            overflow,
            topGap,
            composer: !!composer,
            composerReady,
            skeleton,
          }
          const signature = ready
            ? JSON.stringify([
                painted?.id,
                text.length,
                Math.round((container?.scrollTop ?? 0) * 10),
                rows.map((item) => [item.getAttribute("data-message-id"), Math.round(item.getBoundingClientRect().top * 10), Math.round(item.getBoundingClientRect().height * 10)]),
              ])
            : ""
          stable = ready && signature === previous ? stable + 1 : ready ? 1 : 0
          previous = signature
          if (stable >= 2) {
            resolve({ trustedInputAt: trusted, paintedAt: performance.now(), timeOrigin: performance.timeOrigin, partId: painted!.id, text })
            return
          }
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
    { sessionId: target.sessionId, firstPartId: target.firstPartId, finalPartId: target.finalPartId, timeoutMs },
  )
  void armed.catch(() => undefined)
  await page.locator(`[data-session-id="${target.sessionId.replaceAll('"', '\\"')}"]`).click()
  const result = await armed
  const expected = result.partId === target.finalPartId ? target.finalTextSha256 : target.firstTextSha256
  if (textSha256(result.text) !== expected) {
    throw new Error(`OpenCode painted content does not match the corpus for ${target.logicalSessionId} (${result.partId})`)
  }
  return result
}
