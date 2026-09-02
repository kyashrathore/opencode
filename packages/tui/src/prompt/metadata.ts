import { Locale } from "../util/locale"
import { stringWidth } from "../util/string-width"

export type PromptMetadata = {
  agent?: string
  auto?: boolean
  model?: string
  provider?: string
  variant?: string
  text: string
}

export function promptMetadataPolicy(input: {
  width: number
  agent: string
  auto?: boolean
  model: string
  provider: string
  variant?: string
}) {
  const compactProvider = input.provider.split(" / ").at(-1) ?? input.provider
  const candidates: Omit<PromptMetadata, "text">[] = [
    { agent: input.agent, auto: input.auto, model: input.model, provider: input.provider, variant: input.variant },
    { agent: input.agent, model: input.model, provider: input.provider, variant: input.variant },
    { agent: input.agent, model: input.model, provider: compactProvider, variant: input.variant },
    { agent: input.agent, model: input.model, variant: input.variant },
    { model: input.model, variant: input.variant },
  ]
  const fit = candidates.find((candidate) => stringWidth(text(candidate)) <= input.width)
  if (fit) return { ...fit, text: text(fit) }

  const suffix = input.variant ? ` · ${input.variant}` : ""
  const cells = Math.max(8, input.width - stringWidth(suffix) - 1)
  const model =
    stringWidth(input.model) > cells + 1 ? Locale.takeWidth(input.model, cells).trimEnd() + "…" : input.model
  return { model, variant: input.variant, text: `${model}${suffix}` }
}

export function promptFooterPolicy(input: { width: number; usage: string[]; shortcuts: string[] }) {
  const usage = input.usage.join(" · ")
  const shortcuts = input.shortcuts.join(" · ")
  const reserved = Math.min(28, Math.floor(input.width / 2))
  const available = Math.max(0, input.width - reserved)
  if (usage && shortcuts && stringWidth(`${usage} · ${shortcuts}`) <= available) {
    return { usage: true, shortcuts: true }
  }
  if (usage && stringWidth(usage) <= available) return { usage: true, shortcuts: false }
  if (!usage && shortcuts && stringWidth(shortcuts) <= available) return { usage: false, shortcuts: true }
  return { usage: false, shortcuts: false }
}

function text(input: Omit<PromptMetadata, "text">) {
  return [
    ...(input.agent ? [input.agent] : []),
    ...(input.auto ? ["auto"] : []),
    ...(input.model ? [...(input.agent ? ["·"] : []), input.model] : []),
    ...(input.provider ? [input.provider] : []),
    ...(input.variant ? ["·", input.variant] : []),
  ].join(" ")
}
