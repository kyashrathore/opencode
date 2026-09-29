import { createServer } from "node:net"
import { connectCdpPage, type BenchmarkPage } from "./cdp-page"
import type { ReadinessTarget } from "./corpus"
import { isolatedEnvironment, statePaths } from "./materialize"
import { processFamily, readProcessTable, sameProcessIdentity, type ProcessSnapshot } from "./process-family"
import type { FrameLog, PageSettle } from "./driver-sdk"
import { appStartReadiness, sessionActivation, settleExpressionFor, type Activation } from "./settle"

/**
 * Launches the packaged OpenCode desktop app from an isolated state root and
 * drives it over the Chrome DevTools Protocol: one trusted pointer click on the
 * control that opens a session, timed by the framework's page clock from that
 * click to the session's settle (see settle.ts).
 */

export type OwnedProcess = {
  pid: number
  startTimeMs: number
  owner: "application"
  category: string
  role?: "main" | "renderer" | "gpu" | "utility" | "external-helper"
}

export type AppLaunch = {
  process: OwnedProcess
  page: BenchmarkPage
  /** Bun performance.now() immediately before process spawn. */
  spawnAtMs: number
  /** Control-session readiness in the same Bun clock. */
  readyAtMs: number
  /** The control session's frames, mapped onto the Bun clock by their offset. */
  readyFrameLog: FrameLog
  activate(target: ReadinessTarget): Promise<Activation>
  /** True when the app has already shown this session in this process (an open tab was observed). */
  wasDisplayed(target: ReadinessTarget): Promise<boolean>
  /** Untimed: closes every tab except the kept session's so the strip never overflows across cases. */
  resetTabs(keep: ReadinessTarget): Promise<void>
  /** Native session ids of the open tabs, left to right. */
  tabSessionIds(): Promise<string[]>
  shutdown(): Promise<{ terminated: OwnedProcess[]; survivors: OwnedProcess[] }>
}

const DEFAULT_TIMEOUT_MS = 60_000
/** The readiness ceiling the Claxedo and T3 drivers use for one activation. */
const READINESS_TIMEOUT_MS = 30_000

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
    env: {
      ...isolatedEnvironment(input.stateRoot),
      OPENCODE_DESKTOP_USER_DATA_DIR: paths.profile,
      OPENCODE_DESKTOP_WINDOW_MAXIMIZED: "1",
      PWD: controlDirectory,
    },
    stdout: Bun.file(paths.appStdout),
    stderr: Bun.file(paths.appStderr),
  })
  let page: BenchmarkPage | undefined
  try {
    page = await connectCdpPage({ port: debugPort, process: application, timeoutMs })
    const connected = page
    await activateApplication(application.pid, connected)
    // Wait for the app shell before touching any control.
    await connected.waitForFunction(() => !!document.querySelector('[data-slot="titlebar-v2"], [data-slot="home-projects-scroll"], [data-component="prompt-input"]'), undefined, { polling: "raf", timeout: timeoutMs })
    // The control session is reached the way a user reaches it: the home page
    // lists the workspace's sessions and the row is clicked (or its open tab).
    // The app-start clock runs from process spawn to that session being painted.
    const displayed = new Set<string>()
    const ready = await activateSession(connected, input.control, READINESS_TIMEOUT_MS, log)
    displayed.add(input.control.sessionId)
    const { readyAtMs, readyFrameLog } = appStartReadiness(ready, spawnAtMs, performance.timeOrigin)
    await dismissAnnouncements(connected, log)

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
      readyFrameLog,
      async activate(target) {
        await dismissAnnouncements(connected, log)
        const settle = await activateSession(connected, target, READINESS_TIMEOUT_MS, log)
        displayed.add(target.sessionId)
        return sessionActivation(settle)
      },
      async wasDisplayed(target) {
        // A session shown earlier in this process (activated by the driver or
        // restored as a tab at launch) is no longer cold for the app.
        if (displayed.has(target.sessionId)) return true
        return connected.evaluate(
          (sessionId: string) =>
            [...document.querySelectorAll('[data-slot="titlebar-tab-item"] a[data-slot="tab-link"]')].some((link) =>
              link.getAttribute("href")?.endsWith(`/session/${sessionId}`),
            ),
          target.sessionId,
        )
      },
      async resetTabs(keep) {
        await closeTabsExcept(connected, keep, log)
      },
      async tabSessionIds() {
        return connected.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"] a[data-slot="tab-link"]')].map(
            (link) => link.getAttribute("href")?.match(/\/session\/([^/?#]+)/u)?.[1] ?? "",
          ),
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
    // The app's own server and helpers keep writing into the state root after
    // the root process dies; a retry that recreates that root would collide
    // with them (EEXIST), so the whole family is gone before this returns.
    const family = await readProcessTable()
      .then((table) => processFamily(table, application.pid))
      .catch(() => [] as ProcessSnapshot[])
    if (application.exitCode === null) application.kill("SIGKILL")
    for (const item of family) {
      if (item.pid === application.pid) continue
      try { process.kill(item.pid, "SIGKILL") } catch {}
    }
    await Promise.race([application.exited, Bun.sleep(3_000)])
    throw error
  }
}

/**
 * Returns to the home page through the titlebar's Home button. The renderer
 * runs a memory router, so the window location never drives navigation.
 */
async function goHome(page: BenchmarkPage, log: (line: string) => void, timeoutMs = 30_000) {
  await page.waitForFunction(
    () => !!document.querySelector('[data-slot="titlebar-v2"] button[aria-label="Home"]'),
    undefined,
    { polling: "raf", timeout: timeoutMs },
  )
  let attempt = 0
  while (attempt < 3) {
    const state = await page.evaluate(() => {
      if (document.querySelector('[data-slot="home-projects-scroll"]')) return "home"
      const button = document.querySelector<HTMLElement>('[data-slot="titlebar-v2"] button[aria-label="Home"]')
      if (!button) return "no-button"
      button.click()
      return "clicked"
    })
    if (state === "home") return
    attempt += 1
    log(`go-home: ${state} (attempt ${String(attempt)})`)
    const shown = await page
      .waitForFunction(() => !!document.querySelector('[data-slot="home-projects-scroll"]'), undefined, { polling: "raf", timeout: 3_000 })
      .then(() => true, () => false)
    if (shown) return
  }
  const snapshot = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"]')].map((tab) => tab.innerText.replace(/\s+/gu, " ").trim()),
    tabSample: document.querySelector<HTMLElement>('[data-slot="titlebar-tab-item"]')?.outerHTML.slice(0, 600),
    homeButton: document.querySelector<HTMLElement>('[data-slot="titlebar-v2"] button[aria-label="Home"]')?.outerHTML.slice(0, 300),
    rows: document.querySelectorAll('[data-component="home-session-row"]').length,
    text: document.body.innerText.slice(0, 300),
  }))
  throw new Error(`OpenCode never showed the home page: ${JSON.stringify(snapshot)}`)
}

/**
 * Makes the app the frontmost application, as the other drivers do for their
 * apps before timing frames. Chromium's `Page.bringToFront` only raises the
 * window inside the app. The process is picked by its pid: activating by the
 * name "OpenCode" lets Launch Services pick any app bundle of that name, and a
 * second copy on disk left this one in the background.
 */
async function activateApplication(pid: number | undefined, page: BenchmarkPage) {
  await page.rawCommand("Page.bringToFront", {})
  const target = pid ?? applicationPid
  if (target === undefined) return
  applicationPid = target
  const child = Bun.spawn({
    cmd: ["osascript", "-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${String(target)}) to true`],
    stdout: "ignore",
    stderr: "ignore",
  })
  await Promise.race([child.exited, Bun.sleep(5_000)])
}
let applicationPid: number | undefined

/** Names the application in front when a settle fails, so a hidden window's cause is on record. */
async function frontmostApplication() {
  const child = Bun.spawn({
    cmd: [
      "osascript",
      "-e",
      'tell application "System Events" to set frontApp to first application process whose frontmost is true',
      "-e",
      'tell application "System Events" to return (name of frontApp) & " (pid " & (unix id of frontApp) & ")"',
    ],
    stdout: "pipe",
    stderr: "ignore",
  })
  const answered = await Promise.race([new Response(child.stdout).text(), Bun.sleep(5_000).then(() => undefined)])
  if (answered === undefined) child.kill()
  return answered?.trim() || "unknown"
}

/**
 * Frame timing needs a visible window: rAF stops while the document is hidden
 * or the window is fully occluded, so every frame-based wait would starve. The
 * settle also requires focus, as the other drivers' readiness does.
 */
async function requireVisibleDocument(page: BenchmarkPage) {
  const front = () => page.evaluate(() => document.visibilityState === "visible" && document.hasFocus())
  if (await front()) return
  // Another app took focus or covers the window; raise this one (untimed) and
  // give the compositor a moment before giving up.
  await activateApplication(undefined, page)
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    await Bun.sleep(100)
    if (await front()) return
  }
  const state = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() }))
  throw new Error(`OpenCode window is not visible and focused (${JSON.stringify(state)}); keep the app frontmost during the run`)
}

type ActivationTarget = { kind: "tab" | "row"; point: { x: number; y: number } }

/**
 * Untimed setup that leaves exactly one trusted click between the driver and
 * the destination, through the control a user has for it. OpenCode has no
 * session sidebar: a session open in a titlebar tab is reached by its tab, and
 * any other session by its row in the Home page's recent sessions, after the
 * Home button, the same path the recorded video takes. Tabs are matched by
 * their session link and rows by their exact title.
 */
async function revealActivationTarget(
  page: BenchmarkPage,
  target: ReadinessTarget,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<ActivationTarget> {
  await requireVisibleDocument(page)
  const deadline = performance.now() + timeoutMs
  let lastAction = ""
  while (performance.now() < deadline) {
    const step = await page.evaluate(
      (arg: { title: string; sessionId: string }) => {
        const visible = (element: Element | null | undefined): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        }
        // Instant: the tab strip and the Home list scroll smoothly by default,
        // and a click at a mid-animation rectangle lands on a neighbour.
        const reveal = (element: HTMLElement) => element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
        const tab = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"]')].find(
          (item) => visible(item) && item.querySelector('a[data-slot="tab-link"]')?.getAttribute("href")?.endsWith(`/session/${arg.sessionId}`),
        )
        if (tab) {
          reveal(tab)
          // A crowded strip shrinks tabs to their avatar, and the tab's close
          // button, invisible until hover, still covers the middle; a click
          // there closes the tab. The point nearest the centre that hits the
          // tab's link is the one a user's click opens the session from.
          const rect = tab.getBoundingClientRect()
          const x = rect.left + rect.width / 2
          const y = rect.top + rect.height / 2
          const opens = (px: number) => {
            const hit = document.elementFromPoint(px, y)
            return !!hit && !hit.closest("button") && !!hit.closest('a[data-slot="tab-link"]') && tab.contains(hit)
          }
          const candidates = Array.from({ length: Math.floor(rect.width) }, (_, offset) => rect.left + offset + 0.5)
            .filter(opens)
            .sort((left, right) => Math.abs(left - x) - Math.abs(right - x))
          if (candidates[0] === undefined) return { action: "wait" as const }
          return { kind: "tab" as const, point: { x: candidates[0], y } }
        }
        if (!document.querySelector('[data-slot="home-projects-scroll"]')) return { action: "go-home" as const }
        const rows = [...document.querySelectorAll<HTMLElement>('[data-component="home-session-row"]')].filter((item) =>
          [...item.querySelectorAll("span")].some((span) => span.childElementCount === 0 && (span.textContent ?? "").trim() === arg.title),
        )
        if (rows.length > 1) return { action: "ambiguous" as const, count: rows.length }
        const row = rows[0]
        if (!row) return { action: "wait" as const }
        reveal(row)
        const rect = row.getBoundingClientRect()
        const point = { x: rect.left + Math.min(rect.width / 2, 160), y: rect.top + rect.height / 2 }
        const hit = document.elementFromPoint(point.x, point.y)
        if (!hit || !row.contains(hit) || !visible(row)) return { action: "wait" as const }
        return { kind: "row" as const, point }
      },
      { title: target.title, sessionId: target.sessionId },
    )
    if (step.kind && step.point) {
      // Two frames with the target where it was measured: a list still
      // settling would move the row out from under the click.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      return { kind: step.kind, point: step.point }
    }
    if (step.action !== lastAction) log(`reveal ${target.logicalSessionId}: ${step.action}`)
    lastAction = step.action
    if (step.action === "ambiguous") throw new Error(`OpenCode's Home lists ${String(step.count)} sessions titled ${JSON.stringify(target.title)}`)
    if (step.action === "go-home") await goHome(page, log)
    else await Bun.sleep(50)
  }
  const snapshot = await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 400),
    tabs: [...document.querySelectorAll('[data-slot="titlebar-tab-item"] a[data-slot="tab-link"]')].map((element) => element.getAttribute("href")).slice(0, 30),
    rows: [...document.querySelectorAll('[data-component="home-session-row"]')].map((element) => (element as HTMLElement).innerText.slice(0, 60)).slice(0, 30),
  }))
  throw new Error(`OpenCode never revealed ${target.logicalSessionId}: ${JSON.stringify(snapshot)}`)
}

async function activateSession(
  page: BenchmarkPage,
  target: ReadinessTarget,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<PageSettle> {
  const revealStartedAt = performance.now()
  const activation = await revealActivationTarget(page, target, timeoutMs, log)
  const revealMs = performance.now() - revealStartedAt
  const armed = page.evaluateExpression<PageSettle>(settleExpressionFor(target, timeoutMs))
  void armed.catch(() => undefined)
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: activation.point.x, y: activation.point.y })
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: activation.point.x, y: activation.point.y, button: "left", clickCount: 1 })
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: activation.point.x, y: activation.point.y, button: "left", clickCount: 1 })
  const result = await armed.catch(async (error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; frontmost application: ${await frontmostApplication()}`, { cause: error })
  })
  const readyMs = performance.now() - revealStartedAt - revealMs
  // Untimed: with a real session open, drop the empty draft tab the app opens
  // at startup so the tab strip holds only sessions.
  const draftsStartedAt = performance.now()
  await closeDraftTabs(page)
  log(`activated ${target.logicalSessionId} via ${activation.kind}: reveal ${revealMs.toFixed(0)} ms, click→confirmed ${readyMs.toFixed(0)} ms (timed ${(result.settledAt - result.startAt).toFixed(0)} ms), drafts ${(performance.now() - draftsStartedAt).toFixed(0)} ms`)
  return result
}

const ANNOUNCEMENT_CLOSE = 'button[aria-label="Dismiss Tabs information"]'

/**
 * Closes the "Introducing Tabs" card with a trusted click on its own close
 * button, the way a user clears it, and fails unless it is gone. The dismissal
 * persists in the profile, so a launch from the prepared state never shows it.
 */
async function dismissAnnouncements(page: BenchmarkPage, log: (line: string) => void) {
  const point = await page.evaluate((selector: string) => {
    const button = document.querySelector<HTMLElement>(selector)
    if (!button) return undefined
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, ANNOUNCEMENT_CLOSE)
  if (!point) return
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
  await page.rawCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
  await page
    .waitForFunction((selector: string) => !document.querySelector(selector), ANNOUNCEMENT_CLOSE, { polling: "raf", timeout: 5_000 })
    .catch(() => {
      throw new Error("OpenCode kept the Introducing Tabs card after its close button was clicked")
    })
  log("dismissed the Introducing Tabs card")
}

/**
 * Closes every tab except the kept session's. Between switch cases the strip
 * would otherwise grow by one tab per destination until it overflows into
 * icon-only tabs, a state the app handles poorly and a user rarely reaches.
 * Warm destinations are reopened by the warm visit itself before measurement.
 */
async function closeTabsExcept(page: BenchmarkPage, keep: ReadinessTarget, log: (line: string) => void) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const state = await page.evaluate((sessionId: string) => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"]')]
      const titles = tabs.map((tab) => (tab.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 40))
      const other = tabs.find((tab) => !tab.querySelector('a[data-slot="tab-link"]')?.getAttribute("href")?.endsWith(`/session/${sessionId}`))
      const close = other?.querySelector<HTMLElement>('[data-slot="titlebar-tab-close"], button[aria-label="Close tab"]')
      if (!other) return { done: true, titles }
      if (!close) return { done: true, titles, stuck: true }
      close.click()
      return { done: false, titles }
    }, keep.sessionId)
    if (state.done) {
      if (state.stuck) log(`reset tabs: a tab has no close control; tabs ${JSON.stringify(state.titles)}`)
      return
    }
    await Bun.sleep(60)
  }
  log(`reset tabs: gave up after 64 attempts`)
}

/** Closes empty "New session" draft tabs (the app opens one at startup while nothing else is open). */
async function closeDraftTabs(page: BenchmarkPage) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const closed = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"]')]
      const titleOf = (tab: HTMLElement) => {
        const title = tab.querySelector<HTMLElement>('[data-slot="tab-title"]')
        const text = (title ?? tab).innerText.trim().split("\n")
        return text[text.length - 1]?.trim() ?? ""
      }
      const drafts = tabs.filter((tab) => /^(?:new session)?$/iu.test(titleOf(tab)))
      // The app keeps one draft tab while nothing else is open; closing it only
      // makes the app create another. Only drafts beside a real session tab go.
      if (drafts.length === 0 || drafts.length === tabs.length) return false
      const close = drafts[0]?.querySelector<HTMLElement>('[data-slot="titlebar-tab-close"], button[aria-label="Close tab"]')
      if (!close) return false
      close.click()
      return true
    })
    if (!closed) return
    await Bun.sleep(200)
  }
}
