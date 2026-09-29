import type { ReadinessTarget } from "./corpus"
import { sdk, type AppFacts, type FrameLog, type PageSettle } from "./driver-sdk"

/**
 * OpenCode's side of the framework's settle-31-frames page clock: the facts
 * that say which session the app shows and where its transcript is. The
 * framework samples them every frame, computes the gates and the signature,
 * and applies the settle rule.
 */

export type FactsTarget = Pick<ReadinessTarget, "sessionId" | "latestPartIds">

/** Serialized into the renderer: it may use only browser globals and `target`. */
export const openCodeFacts = (target: FactsTarget): AppFacts => {
  // OpenCode stamps a turn's assistant rows with the turn's user message id,
  // so only their part ids say which assistant message they show.
  const latestParts = new Set(target.latestPartIds)
  const partSelector = target.latestPartIds.map((id) => `[data-timeline-part-id="${CSS.escape(id)}"]`).join(", ")
  const transcript = () => document.querySelector<HTMLElement>(partSelector)?.closest<HTMLElement>("[data-scrollable]") ?? null
  const ownsLatestTurn = (row: HTMLElement) => {
    const parts = [...row.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
    return parts.length > 0 && parts.every((part) => latestParts.has(part.dataset.timelinePartId ?? ""))
  }
  return {
    displayed: () => {
      const activeTabs = [...document.querySelectorAll<HTMLElement>('[data-slot="titlebar-tab-item"][data-active="true"]')]
      if (activeTabs.length !== 1) return false
      const href = activeTabs[0]!.querySelector('a[data-slot="tab-link"]')?.getAttribute("href") ?? ""
      return href.endsWith(`/session/${target.sessionId}`)
    },
    // A row whose parts all belong to the latest assistant message. Its text is
    // not compared with the corpus: every app renders markdown its own way.
    latestTurnRows: () => [...(transcript()?.querySelectorAll<HTMLElement>('[data-timeline-row="AssistantPart"]') ?? [])].filter(ownsLatestTurn),
    composer: () => {
      const composer = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
      return composer?.getAttribute("contenteditable") === "true" ? composer : null
    },
    placeholder: () => !!transcript()?.querySelector('[data-slot="skeleton"], [data-component="skeleton"]'),
    transcript,
    rows: () => [...(transcript()?.querySelectorAll<HTMLElement>("[data-timeline-key]") ?? [])],
    rowKey: (row) => row.dataset.timelineKey ?? "",
  }
}

/** Arms the clock in the renderer; evaluated before the trusted click, which starts it. */
export function settleExpressionFor(target: ReadinessTarget, timeoutMs: number) {
  return sdk.settleExpression<FactsTarget>({
    facts: openCodeFacts,
    target: { sessionId: target.sessionId, latestPartIds: target.latestPartIds },
    timeoutMs,
    start: "trusted-pointerdown",
  })
}

export type ActivationClock = {
  kind: "single-monotonic-clock"
  clock: "performance.now"
  start: number
  end: number
}

/** A measured activation: its clock and the frames the clock was derived from. */
export type Activation = { clock: ActivationClock; frameLog: FrameLog }

/** A session switch is timed on the renderer clock, from the trusted pointerdown to the settle. */
export function sessionActivation(settle: PageSettle): Activation {
  return {
    clock: { kind: "single-monotonic-clock", clock: "performance.now", start: settle.startAt, end: settle.settledAt },
    frameLog: sdk.frameLogOf(settle),
  }
}

/**
 * App start is timed on the driver's clock, from process spawn to the control
 * session's settle; the renderer's frames are mapped onto it by the difference
 * of the two clocks' time origins.
 */
export function appStartReadiness(settle: PageSettle, spawnAtMs: number, driverTimeOrigin: number) {
  const offsetMs = settle.timeOrigin - driverTimeOrigin
  return {
    readyAtMs: settle.settledAt + offsetMs,
    readyFrameLog: sdk.frameLogOf(settle, { startAt: spawnAtMs - offsetMs, offsetMs }),
  }
}
