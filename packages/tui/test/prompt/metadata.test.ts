import { describe, expect, test } from "bun:test"
import { promptFooterPolicy, promptMetadataPolicy } from "../../src/prompt/metadata"
import { stringWidth } from "../../src/util/string-width"

const input = {
  agent: "Build",
  model: "Claude Fable 5.1",
  provider: "Anomaly / OpenCode",
  variant: "medium",
}

describe("prompt metadata width", () => {
  test("keeps every top-row field until the full row no longer fits", () => {
    const full = promptMetadataPolicy({ ...input, width: Infinity })
    expect(promptMetadataPolicy({ ...input, width: stringWidth(full.text) })).toEqual(full)
    expect(promptMetadataPolicy({ ...input, width: stringWidth(full.text) - 1 })).toMatchObject({
      agent: input.agent,
      model: input.model,
      provider: "OpenCode",
      variant: input.variant,
    })
  })

  test("keeps the agent until the row cannot fit without removing it", () => {
    const withAgent = promptMetadataPolicy({ ...input, provider: "", width: Infinity })
    const withoutAgent = promptMetadataPolicy({ ...input, agent: "", provider: "", width: Infinity })
    expect(promptMetadataPolicy({ ...input, width: stringWidth(withAgent.text) })).toMatchObject({ agent: input.agent })
    const narrow = promptMetadataPolicy({ ...input, width: stringWidth(withoutAgent.text) })
    expect(narrow.agent).toBeUndefined()
    expect(narrow).toMatchObject({
      model: input.model,
      variant: input.variant,
    })
  })

  test("always preserves model and variant, truncating only when required", () => {
    const identity = promptMetadataPolicy({ ...input, agent: "", provider: "", width: Infinity })
    expect(promptMetadataPolicy({ ...input, width: stringWidth(identity.text) })).toMatchObject({
      model: input.model,
      variant: input.variant,
    })
    expect(promptMetadataPolicy({ ...input, width: 0 })).toMatchObject({ model: "Claude F…", variant: "medium" })
  })
})

describe("prompt footer width", () => {
  test("hides shortcuts before usage without flickering", () => {
    const usage = ["31.3K (3%)", "$0.40"]
    const shortcuts = ["ctrl+p commands"]
    const layouts = Array.from({ length: 121 }, (_, width) => promptFooterPolicy({ width, usage, shortcuts }))
    const usageStart = layouts.findIndex((item) => item.usage)
    const shortcutsStart = layouts.findIndex((item) => item.shortcuts)
    expect(usageStart).toBeGreaterThan(0)
    expect(shortcutsStart).toBeGreaterThan(usageStart)
    expect(layouts.slice(usageStart).every((item) => item.usage)).toBeTrue()
    expect(layouts.slice(shortcutsStart).every((item) => item.shortcuts)).toBeTrue()
  })

  test("does not hide footer facts while they fit beside reserved location space", () => {
    const usage = ["31.3K (3%)", "$0.40"]
    const shortcuts = ["ctrl+p commands"]
    const width = 100
    expect(promptFooterPolicy({ width, usage, shortcuts })).toEqual({ usage: true, shortcuts: true })
  })
})
