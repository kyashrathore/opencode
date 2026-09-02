import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"

/**
 * Reads the public `opencode-completed-sessions-v3` corpus exactly as the
 * framework wrote it: one NDJSON file per logical session in the pinned
 * OpenCode `EventV2.SerializedEvent` envelope. Every file digest, event
 * sequence, and transcript byte count is verified against the manifest before
 * a session is handed to the production import path.
 */

export type ManifestSession = {
  logicalSessionId: string
  nativeSessionId: string
  workspaceId: string
  role: string
  transcriptBytes: number
  messageCount: number
  partCount: number
  eventCount: number
  file: string
  fileDigestSha256: string
}

export type CorpusManifest = {
  schemaVersion: number
  corpusId: string
  definitionDigestSha256: string
  seed: string
  sourceEventFormat: { id: string; schemaDigestSha256: string; sourceRevision: string }
  sessions: ManifestSession[]
  corpusDigestSha256: string
}

type SerializedEvent = {
  id: string
  type: string
  seq: number
  aggregateID: string
  data: Record<string, any>
}

export type ReadinessTarget = {
  logicalSessionId: string
  sessionId: string
  workspaceId: string
  title: string
  messageCount: number
  /** First text part painted at the top of the transcript (user prompt). */
  firstPartId: string
  firstTextSha256: string
  /** Latest assistant text part painted at the bottom of the transcript. */
  finalPartId: string
  finalMessageId: string
  finalTextSha256: string
}

export type ExportSession = {
  info: Record<string, unknown>
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
}

export async function readManifest(
  manifestPath: string,
  expected: { corpusDigestSha256: string; eventSchemaDigestSha256: string },
): Promise<CorpusManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CorpusManifest
  if (manifest.schemaVersion !== 1 || manifest.corpusDigestSha256 !== expected.corpusDigestSha256) {
    throw new Error("OpenCode received a corpus manifest with the wrong digest")
  }
  if (manifest.sourceEventFormat.schemaDigestSha256 !== expected.eventSchemaDigestSha256) {
    throw new Error("OpenCode received an OpenCode event schema with the wrong digest")
  }
  return manifest
}

/** UTF-8 bytes of completed text, reasoning, serialized tool input, and tool output. */
export function partPayloadBytes(part: any): number {
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    return Buffer.byteLength(part.text, "utf8")
  }
  if (part.type === "tool") {
    return (
      Buffer.byteLength(JSON.stringify(part.state?.input ?? null), "utf8") +
      Buffer.byteLength(part.state?.output ?? "", "utf8")
    )
  }
  return 0
}

export function normalizeSemanticText(value: string): string {
  return value.trim().replace(/\s+/gu, " ")
}

export function textSha256(value: string): string {
  return createHash("sha256").update(normalizeSemanticText(value)).digest("hex")
}

export async function readSession(corpusDirectory: string, session: ManifestSession) {
  const root = path.resolve(corpusDirectory)
  const file = path.resolve(root, session.file)
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("OpenCode corpus path escapes its root")
  const fileHash = createHash("sha256")
  let expectedSequence = 0
  let transcriptBytes = 0
  let sessionInfo: Record<string, any> | undefined
  const messages: ExportSession["messages"] = []
  let current: { info: Record<string, any>; parts: Array<Record<string, unknown>> } | undefined
  let first: { partId: string; text: string } | undefined
  let final: { messageId: string; partId: string; text: string } | undefined
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.length === 0) continue
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("OpenCode rejected an oversized corpus event")
    fileHash.update(`${line}\n`)
    const event = JSON.parse(line) as SerializedEvent
    if (event.seq !== expectedSequence || event.aggregateID !== session.nativeSessionId) {
      throw new Error(`OpenCode rejected invalid event order for ${session.logicalSessionId}`)
    }
    if (event.type === "session.created.1") {
      if (expectedSequence !== 0) throw new Error("OpenCode received a late session.created event")
      sessionInfo = event.data.info
      if (sessionInfo?.id !== session.nativeSessionId) throw new Error("OpenCode received the wrong native session id")
    } else if (event.type === "message.updated.1") {
      if (!sessionInfo) throw new Error("OpenCode received a message before its session")
      const info = event.data.info as Record<string, any>
      if (info.sessionID !== sessionInfo.id) throw new Error("OpenCode received a message for another session")
      current = { info, parts: [] }
      messages.push(current)
    } else if (event.type === "message.part.updated.1") {
      if (!sessionInfo || !current) throw new Error("OpenCode received a part before its message")
      const part = event.data.part as Record<string, any>
      if (
        !["text", "reasoning", "tool", "patch", "step-start", "step-finish"].includes(part.type) ||
        part.sessionID !== sessionInfo.id ||
        part.messageID !== current.info.id
      ) {
        throw new Error("OpenCode received an invalid completed part")
      }
      current.parts.push(part)
      transcriptBytes += partPayloadBytes(part)
      if (part.type === "text" && typeof part.text === "string") {
        if (!first) first = { partId: part.id, text: part.text }
        if (current.info.role === "assistant") final = { messageId: current.info.id, partId: part.id, text: part.text }
      }
    } else {
      throw new Error(`OpenCode rejected unknown OpenCode event type ${String(event.type)}`)
    }
    expectedSequence += 1
  }
  if (fileHash.digest("hex") !== session.fileDigestSha256 || expectedSequence !== session.eventCount) {
    throw new Error(`OpenCode corpus file integrity failed for ${session.logicalSessionId}`)
  }
  if (!sessionInfo || !first || !final || transcriptBytes !== session.transcriptBytes || messages.length !== session.messageCount) {
    throw new Error(`OpenCode corpus semantics failed for ${session.logicalSessionId}`)
  }
  // `workspaceID` is a corpus-only field; `opencode import` derives project,
  // directory, and path from the directory it runs in.
  const { workspaceID: _workspaceID, projectID: _projectID, directory: _directory, ...info } = sessionInfo
  const exported: ExportSession = { info, messages }
  const target: ReadinessTarget = {
    logicalSessionId: session.logicalSessionId,
    sessionId: sessionInfo.id,
    workspaceId: session.workspaceId,
    title: String(sessionInfo.title),
    messageCount: messages.length,
    firstPartId: first.partId,
    firstTextSha256: textSha256(first.text),
    finalPartId: final.partId,
    finalMessageId: final.messageId,
    finalTextSha256: textSha256(final.text),
  }
  return { exported, target, transcriptBytes, messageCount: messages.length }
}
