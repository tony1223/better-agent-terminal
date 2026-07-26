// Recognises pseudo-user turns that the Claude harness injects into a session.
//
// The model reads these as input, so they are written to the transcript JSONL as
// `role: 'user'` records — but the human never typed them. Anything that
// reconstructs a timeline from that JSONL will otherwise render them as the
// user's own prompt: a "You" bubble full of raw XML. Worse, they then count as
// prompts everywhere downstream (pinned context, rewind targets, prompt
// indexes), shifting the positions of the messages the user actually sent.
//
// Three kinds show up today: background-task updates (<task-notification>),
// local slash-command caveats, and the tool-use interrupt marker.
//
// The session-list preview half of this logic is mirrored in Rust by
// normalize_session_hint_text in src-tauri/src/commands/claude.rs — keep both
// sides in step.

const TASK_NOTIFICATION_BLOCK = /<task-notification>[\s\S]*?<\/task-notification>/g
const TASK_NOTIFICATION_UNCLOSED = /<task-notification>[\s\S]*$/

const INTERRUPT_MARKER = '[Request interrupted by user for tool use]'
const CAVEAT_PREFIX = '<local-command-caveat>'

// Auto-compaction: when the context window fills up the SDK summarises the
// conversation and replays the summary as the next user turn, which is how the
// session keeps going. Unlike the markers above it is *not* noise — the model
// really was prompted with it, and dropping it would leave an unexplained gap
// where the history restarts — so it stays in the timeline, tagged, for the UI
// to fold. The transcript flags it with `isCompactSummary`; the preamble below
// is the fallback for records that predate the flag.
const COMPACT_SUMMARY_PREAMBLE = /^this session is being continued from a previous conversation/i

// Drops <task-notification> blocks while keeping whatever the human wrote around
// them, so a real prompt that happens to carry a notification still renders.
// An unterminated block — a truncated transcript, or a partial streaming write —
// swallows the rest of the text: leaking half an XML tag into the timeline is
// worse than dropping a notification whose end we cannot find.
export function stripTaskNotifications(text) {
  return String(text ?? '')
    .replace(TASK_NOTIFICATION_BLOCK, '')
    .replace(TASK_NOTIFICATION_UNCLOSED, '')
    .trim()
}

// True when a user-role record carries nothing the human typed, and so must not
// become a timeline row, a pinned-context entry, or a rewind target.
export function isHarnessNoiseUserText(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return true
  if (trimmed === INTERRUPT_MARKER) return true
  if (trimmed.startsWith(CAVEAT_PREFIX)) return true
  return stripTaskNotifications(trimmed) === ''
}

// True for the compaction summary the SDK replays as a user turn. `record` is
// the raw JSONL object when there is one: its own flag beats guessing from the
// text, which only exists for transcripts written before the flag did.
export function isCompactSummaryUserText(text, record) {
  if (record && record.isCompactSummary === true) return true
  return COMPACT_SUMMARY_PREAMBLE.test(String(text ?? '').trim())
}
