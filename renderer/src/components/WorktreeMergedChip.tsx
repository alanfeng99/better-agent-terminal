import type { TerminalInstance } from '../types'

type Kind = NonNullable<TerminalInstance['worktreeMergedKind']>

const LABELS: Record<Kind, { text: string; tone: 'merged' | 'ahead' | 'diverged' | 'muted'; title: string }> = {
  ancestor: { text: 'merged', tone: 'merged', title: 'Worktree branch is fully merged into the source branch.' },
  'patch-equivalent': { text: 'merged', tone: 'merged', title: 'Worktree changes are patch-equivalent in the source branch (squash/rebase).' },
  ahead: { text: 'ahead', tone: 'ahead', title: 'Worktree branch has commits not yet merged into the source branch.' },
  diverged: { text: 'diverged', tone: 'diverged', title: 'Worktree branch has diverged from the source branch.' },
  unknown: { text: '', tone: 'muted', title: '' },
}

interface Props {
  kind: Kind
}

export function WorktreeMergedChip({ kind }: Readonly<Props>) {
  const meta = LABELS[kind]
  if (!meta.text) return null
  return (
    <span className={`worktree-merged-chip worktree-merged-chip-${meta.tone}`} title={meta.title}>
      · {meta.text}
    </span>
  )
}
