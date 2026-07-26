export interface AskUserOption {
  label: string
  description: string
  // Self-contained HTML preview fragment for this option, rendered in a
  // sandboxed iframe. The SDK emits this on `preview` (we request
  // previewFormat:'html' in the sidecar); `markdown` is accepted as a legacy alias.
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect: boolean
}

export interface PendingAskUser {
  toolUseId: string
  questions: AskUserQuestion[]
}

function normalizeAskUserOption(value: unknown, index: number): AskUserOption | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const label = typeof record.label === 'string' && record.label.trim()
    ? record.label.trim()
    : `Option ${index + 1}`
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  // Prefer the SDK's `preview` field; fall back to the legacy `markdown` alias.
  const preview = (typeof record.preview === 'string' && record.preview.trim())
    ? record.preview
    : (typeof record.markdown === 'string' && record.markdown.trim() ? record.markdown : undefined)
  return { label, description, preview }
}

function normalizeAskUserQuestion(value: unknown, index: number): AskUserQuestion | null {
  if (typeof value === 'string' && value.trim()) {
    return {
      header: `Question ${index + 1}`,
      question: value.trim(),
      options: [],
      multiSelect: false,
    }
  }
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const header = typeof record.header === 'string' && record.header.trim()
    ? record.header.trim()
    : `Question ${index + 1}`
  const question = typeof record.question === 'string' && record.question.trim()
    ? record.question.trim()
    : 'The agent requested input, but this question payload was incomplete.'
  const rawOptions = Array.isArray(record.options) ? record.options : []
  const options = rawOptions
    .map((option, optionIndex) => normalizeAskUserOption(option, optionIndex))
    .filter((option): option is AskUserOption => !!option)

  return {
    header,
    question,
    options,
    multiSelect: record.multiSelect === true,
  }
}

export function normalizePendingAskUser(data: unknown): PendingAskUser {
  const record = (data && typeof data === 'object') ? data as Record<string, unknown> : {}
  const rawQuestions = Array.isArray(record.questions) ? record.questions : []
  const questions = rawQuestions
    .map((question, index) => normalizeAskUserQuestion(question, index))
    .filter((question): question is AskUserQuestion => !!question)

  return {
    toolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : '',
    questions: questions.length > 0 ? questions : [{
      header: 'Question',
      question: 'The agent requested input, but no valid questions were provided.',
      options: [],
      multiSelect: false,
    }],
  }
}

// Wrap an option's HTML preview fragment in a minimal document with a strict
// Content-Security-Policy. The iframe is already sandboxed without allow-scripts,
// but the CSP additionally blocks all remote subresources (passive <img>/<link>/
// font fetches a sandbox can't stop), so the model-generated fragment renders as
// inert, self-contained markup only.
export function wrapPreviewHtml(inner: string): string {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'"
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;padding:8px;background:transparent;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;}</style></head><body>${inner}</body></html>`
}

// The SDK reports the picks back to the model as
// `Your questions have been answered: "<question>"="<answer>", …`, and that
// result string is the only durable record of what the user chose: the
// renderer stores the original `tool_use` input, and the `answers` the sidecar
// merges into `updatedInput` never reach it. Parsing the result therefore also
// survives a session replayed from a transcript.
export function parseAskUserAnswers(resultText: string): Map<string, string> {
  const answers = new Map<string, string>()
  // Questions and answers are quoted, so stop each capture at the quote that
  // is followed by `=` (question) or by `,` / `.` / end (answer).
  const pairs = /"([^"]*)"\s*=\s*"([^"]*)"/g
  for (const match of resultText.matchAll(pairs)) {
    answers.set(match[1], match[2])
  }
  return answers
}

// Renders an answered AskUserQuestion as prompt-history text. The user's picks
// steer the rest of the turn exactly like a typed prompt does, so the history
// lists them alongside real prompts. Returns null while the tool is still
// pending, since there is no answer to show yet.
export function formatAskUserPrompt(input: Record<string, unknown>, resultText: string): string | null {
  if (!resultText.trim()) return null
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const questions = rawQuestions
    .map((question, index) => normalizeAskUserQuestion(question, index))
    .filter((question): question is AskUserQuestion => !!question)
  const answers = parseAskUserAnswers(resultText)
  if (questions.length === 0 || answers.size === 0) return resultText.trim()

  const blocks = questions.map(question => {
    const answer = answers.get(question.question) ?? answers.get(question.header)
    return `Q: ${question.question}\nA: ${answer ?? '(no answer recorded)'}`
  })
  return blocks.join('\n\n')
}

export interface AskUserAnswerChip {
  label: string
  description: string
  // True when the user typed this into "Other..." instead of picking an offered
  // option, so the timeline can mark it as their own words.
  custom: boolean
}

export interface AskUserQnA {
  header: string
  question: string
  multiSelect: boolean
  options: AskUserOption[]
  // Empty while the tool is still pending — nothing was picked yet.
  answers: AskUserAnswerChip[]
}

// A multi-select answer comes back as its labels joined with ", ", so the picks
// cannot be recovered by splitting alone: a label may itself contain ", ".
// Match the offered labels longest-first instead, and keep whatever is left
// unmatched as the user's own text.
function splitAnswerLabels(answerText: string, options: AskUserOption[]): AskUserAnswerChip[] {
  const trimmed = answerText.trim()
  if (!trimmed) return []
  const byLabel = new Map(options.map(option => [option.label, option]))
  const whole = byLabel.get(trimmed)
  if (whole) return [{ label: whole.label, description: whole.description, custom: false }]

  const parts = trimmed.split(', ')
  const chips: AskUserAnswerChip[] = []
  let start = 0
  while (start < parts.length) {
    let matched: AskUserOption | null = null
    let end = start
    for (let candidateEnd = parts.length; candidateEnd > start; candidateEnd--) {
      const option = byLabel.get(parts.slice(start, candidateEnd).join(', '))
      if (option) {
        matched = option
        end = candidateEnd
        break
      }
    }
    if (matched) {
      chips.push({ label: matched.label, description: matched.description, custom: false })
      start = end
    } else {
      chips.push({ label: parts[start], description: '', custom: true })
      start += 1
    }
  }
  return chips
}

// Pairs each question with what the user picked, so the timeline can render the
// exchange as the Q&A it is instead of a JSON input next to the SDK's
// "Your questions have been answered: …" sentence. Pass an empty result while
// the tool is pending: every entry then carries no answers.
export function buildAskUserQnA(input: Record<string, unknown>, resultText: string): AskUserQnA[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const answers = parseAskUserAnswers(resultText)
  return rawQuestions
    .map((question, index) => normalizeAskUserQuestion(question, index))
    .filter((question): question is AskUserQuestion => !!question)
    .map(question => ({
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect,
      options: question.options,
      answers: splitAnswerLabels(
        answers.get(question.question) ?? answers.get(question.header) ?? '',
        question.options,
      ),
    }))
}

export function summarizeAskUserInput(input: Record<string, unknown>): string | null {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const questions = rawQuestions
    .map((question, index) => normalizeAskUserQuestion(question, index))
    .filter((question): question is AskUserQuestion => !!question)
  if (questions.length === 0) return null
  const names = questions.map(question => question.header || question.question).filter(Boolean)
  if (names.length === 1) return `1 question: ${names[0]}`
  return `${names.length} questions: ${names.slice(0, 2).join(', ')}`
}
