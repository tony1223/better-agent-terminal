import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { redactTransferSecrets } from '../../../shared/transfer-redaction.mjs'
import { isCompactSummaryUserText, isHarnessNoiseUserText } from './harness-noise.mjs'

// Export from provider records, never the renderer history (which truncates
// tool results and can contain only a small, currently loaded archive window).
export function portableTranscript(raw) {
  const records = []
  let skippedLines = 0
  let omittedBlocks = 0
  let redactionCount = 0
  let latestUserMessage = ''
  const redact = value => {
    if (typeof value === 'string') {
      const result = redactTransferSecrets(value)
      redactionCount += result.count
      return result.text
    }
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (/^(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|cookie|authorization)$/i.test(key)) {
          redactionCount += 1
          return [key, '[REDACTED]']
        }
        return [key, redact(item)]
      }))
    }
    return value
  }
  const blocks = content => {
    if (typeof content === 'string') return [{ type: 'text', text: redact(content) }]
    if (!Array.isArray(content)) return []
    return content.flatMap(block => {
      if (block?.type === 'text' && typeof block.text === 'string') {
        return [{ type: 'text', text: redact(block.text) }]
      }
      if (block?.type === 'tool_use') {
        return [{ type: 'tool_use', id: block.id, name: block.name, input: redact(block.input) }]
      }
      if (block?.type === 'tool_result') {
        return [{ type: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error === true, content: blocks(block.content) }]
      }
      omittedBlocks += 1
      // Keep attachment omissions visible at their original location; do not
      // copy thinking, signatures, images, or runtime-only content blocks.
      return block?.type === 'image' || block?.type === 'document'
        ? [{ type: 'text', text: `[BAT omitted ${block.type} attachment]` }]
        : []
    })
  }

  for (const line of raw.replace(/^\uFEFF/, '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { skippedLines += 1; continue }
    if (!row || !['user', 'assistant'].includes(row.type) || row.message?.role !== row.type) continue
    const content = blocks(row.message.content)
    if (!content.length) continue
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const compactSummary = isCompactSummaryUserText(text, row)
    const hasUserText = typeof row.message.content === 'string'
      || row.message.content?.some?.(block => block?.type === 'text' && block.text?.trim())
    if (row.type === 'user' && hasUserText && text.trim() && !compactSummary && !isHarnessNoiseUserText(text)) {
      latestUserMessage = text
    }
    records.push({
      type: row.type,
      uuid: row.uuid,
      parentUuid: row.parentUuid,
      timestamp: row.timestamp,
      ...(compactSummary ? { isCompactSummary: true } : {}),
      message: { role: row.type, content },
    })
  }
  return {
    jsonl: records.map(record => JSON.stringify(record)).join('\n') + '\n',
    recordCount: records.length,
    skippedLines,
    omittedBlocks,
    redactionCount,
    latestUserMessage: latestUserMessage.slice(0, 4000),
    latestUserMessageTruncated: latestUserMessage.length > 4000,
  }
}

export async function writeTranscriptSnapshot(raw, metadata, dataDir) {
  const { jsonl, ...details } = portableTranscript(raw)
  if (!details.recordCount) throw new Error('No readable user/assistant records in the Claude transcript.')
  const root = resolve(dataDir, 'transcript-handoffs')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, 'claude-'))
  const path = join(directory, 'transcript.jsonl')
  try {
    await writeFile(path, jsonl, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    // Verify the published file can actually be read, and persist the metadata
    // alongside it so the snapshot remains identifiable after BAT restarts.
    const bytes = (await readFile(path)).length
    const result = { ...metadata, ...details, path, bytes, exportedAt: new Date().toISOString() }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
    return result
  } catch (error) {
    if (dirname(resolve(directory)) === root) await rm(directory, { recursive: true, force: true })
    throw error
  }
}
