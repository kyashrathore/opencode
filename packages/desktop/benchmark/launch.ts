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
  /** True when the app has already shown this session in this process (an open tab was observed). */
  wasDisplayed(target: ReadinessTarget): Promise<boolean>
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
    // Route only once the app shell (and its router) is mounted; an earlier
    // anchor click becomes a real page load at a deep path with no assets.
    await connected.waitForFunction(() => !!document.querySelector('[data-slot="titlebar-v2"], [data-slot="home-projects-scroll"], [data-component="prompt-input"]'), undefined, { polling: "raf", timeout: timeoutMs })
    // The control session is reached the way a user reaches it: the workspace
    // is opened, the home page lists its sessions, and the row is clicked. The
    // app-start clock runs from process spawn to that session being painted.
    // Projects are opened the way the CLI and OS open them: an
    // `opencode://open-project` deep link handed to the running instance through
    // Electron's second-instance argv (same profile, same lock). The app drains
    // it when a workspace route mounts, so the opener is followed by a route.
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
      async wasDisplayed(target) {
        // Opening a project makes the app show that project's most recent
        // session, so a scheduled cold destination can already have a tab.
        return connected.evaluate(
          (title: string) => [...document.querySelectorAll('[data-slot="titlebar-tab-item"]')].some((tab) => (tab.textContent ?? "").replace(/\s+/gu, " ").includes(title)),
          target.title,
        )
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


function workspaceSlug(directory: string) {
  return Buffer.from(directory, "utf8").toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "")
}

/**
 * Follows an in-app route the way the app's own links do: a router-handled
 * anchor click. The router only intercepts clicks once the app is idle, so the
 * home page must have rendered first; if the click still became a real page
 * load (a deep path with no assets), reload the renderer document and retry.
 */
async function followRoute(page: BenchmarkPage, href: string, timeoutMs = 30_000) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForFunction(
      () => !!document.querySelector('[data-slot="home-projects-scroll"], [data-slot="titlebar-tabs"]') && document.readyState === "complete",
      undefined,
      { polling: "raf", timeout: timeoutMs },
    )
    await page.evaluate<void>(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.evaluate((target: string) => {
      const anchor = document.createElement("a")
      anchor.href = target
      anchor.textContent = "benchmark-route"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }, href)
    await Bun.sleep(300)
    const url = await page.evaluate(() => location.href).catch(() => "")
    if (url === "" || /\/index\.html(?:[#?]|$)/u.test(url)) return
    // A real navigation happened: recover the renderer document and retry.
    await page.evaluate(() => location.replace("oc://renderer/index.html")).catch(() => undefined)
    await Bun.sleep(1_000)
  }
  throw new Error(`OpenCode route ${href} kept leaving the renderer document`)
}

type ActivationTarget = { kind: "tab" | "row"; point: { x: number; y: number } }

/**
 * Untimed setup that leaves exactly one trusted click between the driver and
 * the destination: an open titlebar tab (the app's warm path), or a session row
 * on the home page, revealed by opening the workspace route, the home page,
 * and the home session search — the same controls a user has.
 */
async function revealActivationTarget(
  page: BenchmarkPage,
  target: ReadinessTarget,
  workspaces: Map<string, string>,
  timeoutMs: number,
  log: (line: string) => void,
  openProject: (directory: string) => Promise<void>,
): Promise<ActivationTarget> {
  const directory = workspaces.get(target.workspaceId)
  if (!directory) throw new Error(`OpenCode has no workspace directory for ${target.workspaceId}`)
  const deadline = performance.now() + timeoutMs
  let lastAction = ""
  let searched = false
  let openedRoute = false
  while (performance.now() < deadline) {
    const step = await page.evaluate(
      (arg: { title: string; base: string; searchQuery: string }) => {
        const visible = (element: Element | null | undefined): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        }
        const center = (element: HTMLElement) => {
          element.scrollIntoView({ block: "center", inline: "center" })
          const rect = element.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        }
        const titled = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/gu, " ").includes(arg.title)
        const tab = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"]')].find((item) => visible(item) && titled(item))
        if (tab) return { kind: "tab" as const, point: center(tab) }
        const home = document.querySelector('[data-slot="home-projects-scroll"]')
        if (!home) return { action: "go-home" as const }
        const row = [...document.querySelectorAll<HTMLElement>('[data-component="home-session-row"]')].find((item) => visible(item) && titled(item))
        if (row) return { kind: "row" as const, point: center(row) }
        const projectKnown = [...document.querySelectorAll<HTMLElement>('[data-component="home-project-row"]')].some((item) => (item.textContent ?? "").includes(arg.base))
        if (!projectKnown) return { action: "open-project" as const }
        const search = document.querySelector<HTMLInputElement>('[data-component="home-session-search"] input, input[data-component="home-session-search"]')
        if (search && visible(search) && search.value !== arg.searchQuery) return { action: "search" as const }
        return { action: "wait" as const }
      },
      { title: target.title, base: path.basename(directory), searchQuery: target.logicalSessionId },
    )
    if ("kind" in step) return step
    if (step.action !== lastAction) log(`reveal ${target.logicalSessionId}: ${step.action}`)
    lastAction = step.action
    if (step.action === "go-home") {
      await followRoute(page, "/")
    } else if (step.action === "open-project") {
      if (openedRoute) {
        await Bun.sleep(200)
        continue
      }
      openedRoute = true
      await openProject(directory)
      await followRoute(page, `/${workspaceSlug(directory)}/session`)
      await Bun.sleep(1_000)
      // Opening a workspace by route lands on a draft; close that draft tab so no
      // empty "New session" tab is left behind, then return to the home page.
      await closeDraftTabs(page)
      await followRoute(page, "/")
    } else if (step.action === "search") {
      if (searched) {
        await Bun.sleep(200)
        continue
      }
      searched = true
      const input = page.locator('[data-component="home-session-search"] input, input[data-component="home-session-search"]')
      await input.click()
      await page.keyboard.press("Meta+A")
      await page.keyboard.type(target.logicalSessionId)
    } else {
      await Bun.sleep(150)
      continue
    }
    await Bun.sleep(300)
  }
  const snapshot = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 400),
    tabs: [...document.querySelectorAll('[data-slot="titlebar-tab-item"]')].map((element) => (element as HTMLElement).innerText.slice(0, 40)).slice(0, 12),
    rows: document.querySelectorAll('[data-component="home-session-row"]').length,
  }))
  throw new Error(`OpenCode never revealed ${target.logicalSessionId}: ${JSON.stringify(snapshot)}`)
}

async function activateSession(
  page: BenchmarkPage,
  target: ReadinessTarget,
  workspaces: Map<string, string>,
  timeoutMs: number,
  log: (line: string) => void,
  openProject: (directory: string) => Promise<void>,
): Promise<ActivationResult> {
  const activation = await revealActivationTarget(page, target, workspaces, timeoutMs, log, openProject)
  const armed = observeSessionReady(page, target, timeoutMs, { requireTrustedInput: true })
  void armed.catch(() => undefined)
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: activation.point.x, y: activation.point.y })
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: activation.point.x, y: activation.point.y, button: "left", clickCount: 1 })
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: activation.point.x, y: activation.point.y, button: "left", clickCount: 1 })
  const result = await armed
  const expected = result.partId === target.finalPartId ? target.finalTextSha256 : target.firstTextSha256
  if (textSha256(result.text) !== expected) {
    throw new Error(`OpenCode painted content does not match the corpus for ${target.logicalSessionId} (${result.partId})`)
  }
  return result
}

/**
 * In-page readiness: the canonical text part painted, first fold complete,
 * composer accepting input, and two identical frames after the trusted input
 * (or after arming, for the click-less launch). Resolves at observation time.
 */
function observeSessionReady(page: BenchmarkPage, target: ReadinessTarget, timeoutMs: number, options: { requireTrustedInput: boolean }): Promise<ActivationResult> {
  return page.evaluate(
    (arg: { firstPartId: string; finalPartId: string; timeoutMs: number; requireTrustedInput: boolean }) =>
      new Promise<ActivationResult>((resolve, reject) => {
        const carrier = window as Window & { __benchInput?: { lastTrustedAt?: number } }
        const input = carrier.__benchInput
        if (!input) return reject(new Error("OpenCode trusted-input recorder is not installed"))
        input.lastTrustedAt = arg.requireTrustedInput ? undefined : performance.now()
        const deadline = performance.now() + Math.max(5_000, arg.timeoutMs - 10_000)
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
        const partSelector = (id: string) =>
          `[data-component="text-part"][data-timeline-part-id="${CSS.escape(id)}"] [data-slot="text-part-body"], [data-component="user-message"][data-timeline-part-id="${CSS.escape(id)}"]`
        const rowSelector = '[data-component="session-turn"], [data-timeline-row]'
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
          const row = part?.closest<HTMLElement>(rowSelector) ?? null
          const text = part?.innerText ?? ""
          const container = row ? scrollParent(row) : null
          const containerRect = container?.getBoundingClientRect()
          const rows = container && containerRect
            ? [...container.querySelectorAll<HTMLElement>(rowSelector)].filter((item) => {
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
          const skeleton = !!row?.querySelector('[data-slot="skeleton"], [data-component="skeleton"], [data-component="text-shimmer"]')
          const ready = !!part && text.trim().length > 0 && !skeleton && completeFold && composerReady
          diagnostic = { url: location.href, trusted, painted: painted?.id, textLength: text.length, rows: rows.length, overflow, topGap, composer: !!composer, composerReady, skeleton }
          const signature = ready
            ? JSON.stringify([
                painted?.id,
                text.length,
                Math.round((container?.scrollTop ?? 0) * 10),
                rows.map((item) => [Math.round(item.getBoundingClientRect().top * 10), Math.round(item.getBoundingClientRect().height * 10)]),
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
    { firstPartId: target.firstPartId, finalPartId: target.finalPartId, timeoutMs, requireTrustedInput: options.requireTrustedInput },
  )
}

/** Closes empty "New session" draft tabs that opening a workspace by route leaves behind. */
async function closeDraftTabs(page: BenchmarkPage) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const closed = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"]')]
      const draft = tabs.find((tab) => /^\s*new session\s*$/iu.test((tab.querySelector('[data-slot="tab-title"]') as HTMLElement | null)?.innerText ?? tab.innerText))
      const close = draft?.querySelector<HTMLElement>('[data-slot="tab-close"]')
      if (!close) return false
      close.click()
      return true
    })
    if (!closed) return
    await Bun.sleep(200)
  }
}
