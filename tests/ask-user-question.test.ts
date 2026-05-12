import * as assert from 'assert'
import { normalizePendingAskUser, summarizeAskUserInput } from '../renderer/src/components/AskUserQuestion.helpers.ts'

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

console.log('AskUserQuestion normalization: passed')
