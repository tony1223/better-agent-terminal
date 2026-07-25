import * as assert from 'assert'
import {
  formatAskUserPrompt,
  normalizePendingAskUser,
  parseAskUserAnswers,
  summarizeAskUserInput,
} from '../renderer/src/components/AskUserQuestion.helpers.ts'

const normalized = normalizePendingAskUser({
  toolUseId: 'tool-1',
  questions: [
    {
      header: 'Choice',
      question: 'Pick one',
      options: [
        { label: 'A', description: 'Option A' },
        { description: 'Missing label still normalizes' },
      ],
    },
    {
      question: 'Missing header and options should not crash',
    },
  ],
})

assert.strictEqual(normalized.toolUseId, 'tool-1')
assert.strictEqual(normalized.questions.length, 2)
assert.strictEqual(normalized.questions[0].options.length, 2)
assert.strictEqual(normalized.questions[0].options[1].label, 'Option 2')
assert.strictEqual(normalized.questions[1].header, 'Question 2')
assert.strictEqual(normalized.questions[1].options.length, 0)

assert.strictEqual(
  summarizeAskUserInput({
    questions: [{ header: 'Sandbox', question: 'Choose a mode', options: [] }],
  }),
  '1 question: Sandbox'
)

assert.strictEqual(
  summarizeAskUserInput({
    questions: [
      { header: 'Sandbox', question: 'Choose a mode', options: [] },
      { header: 'Branch', question: 'Choose a branch', options: [] },
    ],
  }),
  '2 questions: Sandbox, Branch'
)

// An answered AskUserQuestion is prompt history: the picks steered the turn the
// same way a typed prompt would, and the SDK's result string is the only place
// they survive a transcript replay.
const answeredResult =
  'Your questions have been answered: "Choose a mode"="Compact rows", "Choose a branch"="main". '
  + 'You can now continue with these answers in mind.'

const parsed = parseAskUserAnswers(answeredResult)
assert.strictEqual(parsed.get('Choose a mode'), 'Compact rows')
assert.strictEqual(parsed.get('Choose a branch'), 'main')

assert.strictEqual(
  formatAskUserPrompt(
    {
      questions: [
        { header: 'Mode', question: 'Choose a mode', options: [] },
        { header: 'Branch', question: 'Choose a branch', options: [] },
      ],
    },
    answeredResult,
  ),
  'Q: Choose a mode\nA: Compact rows\n\nQ: Choose a branch\nA: main',
)

// Still pending — nothing was answered yet, so it is not prompt history.
assert.strictEqual(
  formatAskUserPrompt({ questions: [{ header: 'Mode', question: 'Choose a mode', options: [] }] }, '   '),
  null,
)

// Unrecognized result shape falls back to the raw text rather than dropping the
// entry, so an SDK wording change cannot silently lose history.
assert.strictEqual(
  formatAskUserPrompt(
    { questions: [{ header: 'Mode', question: 'Choose a mode', options: [] }] },
    'answers recorded',
  ),
  'answers recorded',
)

console.log('AskUserQuestion normalization: passed')
