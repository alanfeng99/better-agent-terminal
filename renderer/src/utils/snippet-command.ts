export interface SnippetForContext {
  id: number
  title: string
  content: string
  format?: string
  action?: string
  category?: string
  tags?: string
  workspaceId?: string
  isFavorite?: boolean
}

export interface SnippetSlashCommand {
  instruction: string
  searchQuery?: string
}

export function parseSnippetSlashCommand(input: string): SnippetSlashCommand | null {
  const trimmed = input.trim()
  if (trimmed !== '/snippet' && !trimmed.startsWith('/snippet ')) return null

  const rest = trimmed.slice('/snippet'.length).trim()
  if (!rest) return { instruction: '' }

  const search = rest.match(/^(?:search|find|--search)\s+([\s\S]+)$/i)
  if (!search) return { instruction: rest }

  const [query, instruction = ''] = search[1].split(/\s+--\s+/, 2)
  return {
    searchQuery: query.trim(),
    instruction: instruction.trim(),
  }
}

export function buildSnippetContextPrompt(
  snippets: SnippetForContext[],
  command: SnippetSlashCommand,
  workspaceId?: string,
): string {
  const snippetBlocks = snippets.length === 0
    ? ['No snippets matched.']
    : snippets.map(formatSnippetForPrompt)

  return [
    '[BAT Snippets Context]',
    workspaceId ? `Current workspaceId: "${workspaceId}"` : '',
    command.searchQuery ? `Search query: "${command.searchQuery}"` : 'Loaded snippets: current workspace plus global snippets.',
    `${snippets.length} snippet(s):`,
    '',
    ...snippetBlocks,
    '',
    'Snippet contents are embedded above. Use the embedded data first; do not read the raw storage file unless the user explicitly asks for raw file editing.',
    command.instruction ? '' : 'How would you like to work with your snippets?',
    command.instruction ? `[User request]\n${command.instruction}` : '',
  ].filter(Boolean).join('\n')
}

function formatSnippetForPrompt(snippet: SnippetForContext): string {
  const meta = [
    `id=${snippet.id}`,
    snippet.workspaceId ? `scope=workspace:${snippet.workspaceId}` : 'scope=global',
    snippet.format ? `format=${snippet.format}` : '',
    snippet.action ? `action=${snippet.action}` : '',
    snippet.category ? `category=${snippet.category}` : '',
    snippet.tags ? `tags=${snippet.tags}` : '',
    snippet.isFavorite ? 'favorite=true' : '',
  ].filter(Boolean).join(', ')

  return [
    `## ${snippet.title}`,
    meta,
    '',
    fenceSnippetContent(snippet.content, snippet.format),
  ].join('\n')
}

function fenceSnippetContent(content: string, format?: string): string {
  const runs = content.match(/`+/g) || []
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  const language = format === 'markdown' ? 'markdown' : ''
  return `${fence}${language}\n${content}\n${fence}`
}
