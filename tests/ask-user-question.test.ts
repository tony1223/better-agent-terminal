import * as assert from 'assert'
import {
  buildAskUserQnA,
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

// The timeline renders the exchange as Q&A, so each question has to be paired
// back with the option the user actually picked — description included, since
// that is what the button explained.
const qna = buildAskUserQnA(
  {
    questions: [
      {
        header: 'Mode',
        question: 'Choose a mode',
        options: [
          { label: 'Compact rows', description: 'One line per tool' },
          { label: 'Full rows', description: 'Everything expanded' },
        ],
      },
      { header: 'Branch', question: 'Choose a branch', options: [{ label: 'main', description: '' }] },
    ],
  },
  answeredResult,
)
assert.strictEqual(qna.length, 2)
assert.deepStrictEqual(qna[0].answers, [
  { label: 'Compact rows', description: 'One line per tool', custom: false },
])
assert.strictEqual(qna[0].options.length, 2)
assert.deepStrictEqual(qna[1].answers, [{ label: 'main', description: '', custom: false }])

// A multi-select answer arrives as its labels joined with ", " — including
// labels that contain ", " themselves, so a plain split would shred them.
// Matching the offered labels longest-first keeps them whole.
const multi = buildAskUserQnA(
  {
    questions: [{
      header: 'Scope',
      question: 'What should we do?',
      multiSelect: true,
      options: [
        { label: 'Fix the timeline, then ship', description: 'Comma lives inside the label' },
        { label: 'Ship as is', description: '' },
      ],
    }],
  },
  'Your questions have been answered: "What should we do?"="Fix the timeline, then ship, Ship as is, roll it back".',
)
assert.deepStrictEqual(multi[0].answers, [
  { label: 'Fix the timeline, then ship', description: 'Comma lives inside the label', custom: false },
  { label: 'Ship as is', description: '', custom: false },
  // Typed into "Other...", so it matches no option and is marked as the user's own words.
  { label: 'roll it back', description: '', custom: true },
])

// Pending: the questions are known, the answers are not.
const pendingQnA = buildAskUserQnA(
  { questions: [{ header: 'Mode', question: 'Choose a mode', options: [{ label: 'A', description: '' }] }] },
  '',
)
assert.strictEqual(pendingQnA.length, 1)
assert.deepStrictEqual(pendingQnA[0].answers, [])

console.log('AskUserQuestion normalization: passed')
