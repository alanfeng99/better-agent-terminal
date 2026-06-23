import * as assert from 'node:assert/strict'
import { buildSnippetContextPrompt, parseSnippetSlashCommand } from '../renderer/src/utils/snippet-command'

const plain = parseSnippetSlashCommand('/snippet could you read snippets?')
assert.deepEqual(plain, {
  instruction: 'could you read snippets?',
})

const search = parseSnippetSlashCommand('/snippet search tail -- summarize it')
assert.deepEqual(search, {
  searchQuery: 'tail',
  instruction: 'summarize it',
})

const prompt = buildSnippetContextPrompt([
  {
    id: 1,
    title: 'tail logs',
    content: 'tail -f /tmp/qbopomofo.log',
    format: 'plaintext',
    action: 'terminal',
  },
], plain!, 'ws-1')

assert.match(prompt, /Loaded snippets: current workspace plus global snippets\./)
assert.match(prompt, /tail -f \/tmp\/qbopomofo\.log/)
assert.match(prompt, /\[User request\]\ncould you read snippets\?/)
assert.doesNotMatch(prompt, /snippets\.json/)

console.log('snippet-command: passed')
