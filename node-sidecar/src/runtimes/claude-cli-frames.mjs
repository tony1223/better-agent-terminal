// Transcript classifier for the Claude CLI (subscription) agent path.
//
// Turns one Claude Code session-transcript JSONL line into zero or more
// normalized frames the renderer can classify as: you / message / tool /
// thinking (+ usage). The transcript is the source of truth for CONTENT;
// hooks/PTY handle live control and rendering (see
// plans/claude-cli-transcript-agent-plan.md).
//
// Schema confirmed empirically against real transcripts (2026-06):
//   envelope.type ∈ {assistant, user, ai-title, last-prompt,
//                    queue-operation, attachment, system, summary}
//   message.content: string | Array<block>
//   block.type ∈ {text, thinking, tool_use, tool_result, image}
//   thinking:     { type, thinking, signature }
//   tool_use:     { type, id, name, input, caller }
//   tool_result:  { type, tool_use_id, content, is_error }
//   text:         { type, text }
//   image:        { type, source }
//   message.usage present on every assistant line.
//
// This module is intentionally self-contained (no dependency on the channel
// path), so the channel experiment can be removed/replaced without touching it.

import { stripTaskNotifications, isHarnessNoiseUserText } from '../lib/harness-noise.mjs'

export const FRAME_KINDS = Object.freeze({
  USER: 'user',          // category: you
  ASSISTANT: 'assistant', // category: message
  THINKING: 'thinking',  // category: thinking
  TOOL_USE: 'tool_use',  // category: tool (call)
  TOOL_RESULT: 'tool_result', // category: tool (result)
  USAGE: 'usage',
})

// Maps a frame kind to the renderer-facing category (the four buckets).
export const FRAME_CATEGORY = Object.freeze({
  [FRAME_KINDS.USER]: 'you',
  [FRAME_KINDS.ASSISTANT]: 'message',
  [FRAME_KINDS.THINKING]: 'thinking',
  [FRAME_KINDS.TOOL_USE]: 'tool',
  [FRAME_KINDS.TOOL_RESULT]: 'tool',
  [FRAME_KINDS.USAGE]: 'usage',
})

const CLASSIFIABLE_ENVELOPES = new Set(['assistant', 'user'])

function asString(v) {
  return typeof v === 'string' ? v : ''
}
function asOptString(v) {
  return typeof v === 'string' ? v : undefined
}
function asOptNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function metaFromEnvelope(obj) {
  return {
    uuid: asOptString(obj.uuid),
    parentUuid: asOptString(obj.parentUuid),
    sessionId: asOptString(obj.sessionId),
    timestamp: asOptString(obj.timestamp),
    isSidechain: obj.isSidechain === true,
  }
}

function usageFrame(msg, meta) {
  const u = msg.usage
  if (!isObject(u)) return null
  return {
    kind: FRAME_KINDS.USAGE,
    payload: {
      input_tokens: asOptNumber(u.input_tokens),
      output_tokens: asOptNumber(u.output_tokens),
      cache_read_input_tokens: asOptNumber(u.cache_read_input_tokens),
      cache_creation_input_tokens: asOptNumber(u.cache_creation_input_tokens),
      model: asOptString(msg.model),
      service_tier: asOptString(u.service_tier),
    },
    meta,
  }
}

function frameForBlock(block, role, msgId, meta) {
  if (!isObject(block)) return null
  switch (block.type) {
    case 'thinking': {
      const text = asString(block.thinking)
      if (!text) return null
      return { kind: FRAME_KINDS.THINKING, payload: { id: msgId, text }, meta }
    }
    case 'tool_use': {
      const id = asString(block.id)
      const name = asString(block.name)
      if (!id || !name) return null
      return {
        kind: FRAME_KINDS.TOOL_USE,
        payload: { id, name, input: block.input ?? null, caller: asOptString(block.caller) },
        meta,
      }
    }
    case 'tool_result': {
      const toolUseId = asString(block.tool_use_id)
      if (!toolUseId) return null
      return {
        kind: FRAME_KINDS.TOOL_RESULT,
        payload: { tool_use_id: toolUseId, content: block.content ?? null, is_error: block.is_error === true },
        meta,
      }
    }
    case 'text': {
      const text = asString(block.text)
      // A 'text' block under role=user is the human's message (you); under
      // role=assistant it is the assistant's reply (message).
      const kind = role === 'user' ? FRAME_KINDS.USER : FRAME_KINDS.ASSISTANT
      if (kind !== FRAME_KINDS.USER) return { kind, payload: { id: msgId, text }, meta }
      // Harness-injected pseudo-user turns share the transcript's role=user
      // shape, so without this they render as a "you" bubble of raw XML.
      if (isHarnessNoiseUserText(text)) return null
      return { kind, payload: { id: msgId, text: stripTaskNotifications(text) }, meta }
    }
    case 'image': {
      // Image input from the human → "you" (no text). Marked so the UI can
      // render an image chip rather than empty text.
      return { kind: FRAME_KINDS.USER, payload: { id: msgId, text: '', image: true }, meta }
    }
    default:
      return null
  }
}

// Turn a parsed transcript object into normalized frames. Pure; no logging.
export function framesFromTranscriptObject(obj) {
  if (!isObject(obj)) return []
  if (!CLASSIFIABLE_ENVELOPES.has(obj.type)) return [] // skip bookkeeping rows
  const msg = obj.message
  if (!isObject(msg)) return []
  const role = asString(msg.role) || obj.type
  const msgId = asOptString(msg.id)
  const meta = metaFromEnvelope(obj)
  const frames = []

  const content = msg.content
  if (typeof content === 'string') {
    const kind = role === 'user' ? FRAME_KINDS.USER : FRAME_KINDS.ASSISTANT
    const isNoise = kind === FRAME_KINDS.USER && isHarnessNoiseUserText(content)
    const text = kind === FRAME_KINDS.USER ? stripTaskNotifications(content) : content
    if (text.length > 0 && !isNoise) {
      frames.push({ kind, payload: { id: msgId, text }, meta: { ...meta, blockIndex: 0 } })
    }
  } else if (Array.isArray(content)) {
    // Give each frame its own meta carrying the block index. Multiple blocks
    // of one API message share message.id (verified on real transcripts:
    // thinking + text + tool_use lines reuse the same msg id), so consumers
    // need (line uuid, block index) to build collision-free entry ids.
    for (let i = 0; i < content.length; i += 1) {
      const f = frameForBlock(content[i], role, msgId, { ...meta, blockIndex: i })
      if (f) frames.push(f)
    }
  }

  if (role === 'assistant') {
    const uf = usageFrame(msg, meta)
    if (uf) frames.push(uf)
  }
  return frames
}

// Parse one raw JSONL line into frames. Returns [] for blank/invalid lines.
export function parseTranscriptLine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : ''
  if (!trimmed) return []
  let obj
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return []
  }
  return framesFromTranscriptObject(obj)
}
