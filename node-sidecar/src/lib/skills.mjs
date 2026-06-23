// Walks <cwd>/.claude/skills and ~/.claude/skills, picks up
// SKILL.md inside subdirs and *.md files at the top level, parses YAML
// frontmatter (name, description) and falls back to the first heading.

import { readdir, stat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function parseSkillFrontmatter(content) {
  const out = {}
  if (!content.startsWith('---')) return out
  const end = content.indexOf('\n---', 3)
  if (end < 0) return out
  const block = content.slice(3, end).trim()
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.+?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

export function firstHeading(content) {
  const body = content.replace(/^---[\s\S]*?\n---\n/, '')
  const line = body.split('\n').find(l => l.trim().length > 0) || ''
  return line.replace(/^#+\s*/, '').trim().slice(0, 200)
}

export async function scanSkillsDir(dir, scope) {
  const out = []
  let entries
  try { entries = await readdir(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = await stat(full) } catch { continue }
    if (st.isDirectory()) {
      const skillMd = join(full, 'SKILL.md')
      try {
        const content = await readFile(skillMd, 'utf-8')
        const fm = parseSkillFrontmatter(content)
        out.push({
          name: fm.name || name,
          description: fm.description || firstHeading(content),
          path: skillMd,
          scope,
        })
      } catch { /* no SKILL.md, skip */ }
    } else if (st.isFile() && name.endsWith('.md')) {
      const skillName = name.replace(/\.md$/, '')
      try {
        const content = await readFile(full, 'utf-8')
        const fm = parseSkillFrontmatter(content)
        out.push({
          name: fm.name || skillName,
          description: fm.description || firstHeading(content),
          path: full,
          scope,
        })
      } catch { /* skip */ }
    }
  }
  return out
}

export async function scanSkills(cwd) {
  const projectSkills = join(cwd, '.claude', 'skills')
  const globalSkills = join(homedir(), '.claude', 'skills')
  const [a, b] = await Promise.all([
    scanSkillsDir(projectSkills, 'project'),
    scanSkillsDir(globalSkills, 'global'),
  ])
  const seen = new Set()
  const out = []
  for (const s of [...a, ...b]) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}
