import path from "node:path"
import { pathToFileURL } from "node:url"

/** The framework checkout the driver runs under, a sibling of this repository unless AGENT_APP_BENCHMARK_ROOT names another. */
export const benchmarkRoot = process.env.AGENT_APP_BENCHMARK_ROOT ?? path.resolve(import.meta.dir, "..", "..", "..", "..", "agent-app-benchmark")

/** What the driver knows about OpenCode, evaluated in the renderer for the session being opened. */
export type AppFacts = {
  displayed(): boolean
  latestTurnRows(): HTMLElement[]
  composer(): HTMLElement | null
  placeholder(): boolean
  transcript(): HTMLElement | null
  rows(): HTMLElement[]
  rowKey(row: HTMLElement): string
}

export type ReadyGates = {
  displayedDestination: boolean
  latestTurnPainted: boolean
  noPlaceholder: boolean
  firstFoldComplete: boolean
  composerEditable: boolean
  windowVisibleFocused: boolean
}

export type ClockFrame = { at: number; gates: ReadyGates; signature: string | null; mutated: boolean }

/** A resolved settle, stamped on the renderer's performance.now() clock. */
export type PageSettle = { startAt: number; settledAt: number; timeOrigin: number; frames: ClockFrame[] }

export type FrameLog = { startAt: number; offsetMs: number; frames: ClockFrame[] }

export const sdk = (await import(pathToFileURL(path.join(benchmarkRoot, "src", "driver-sdk.mjs")).href)) as {
  serveDriver(handlers: Record<string, (params: any) => unknown>): Promise<void>
  settleExpression<Target>(input: {
    facts: (target: Target) => AppFacts
    target: Target
    timeoutMs: number
    start: "trusted-pointerdown" | "now"
  }): string
  frameLogOf(settle: PageSettle, options?: { startAt?: number; offsetMs?: number }): FrameLog
}
