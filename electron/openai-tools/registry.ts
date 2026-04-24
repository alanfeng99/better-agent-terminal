import type { Tool } from 'ai'
import { bashTool } from './bash'
import { readTool } from './read'
import { writeTool } from './write'
import { editTool } from './edit'
import { grepTool } from './grep'
import { globTool } from './glob'
import { skillTool } from './skill'
import { enterPlanModeTool, exitPlanModeTool } from './plan'
import { todoWriteTool } from './todo'
import { askUserQuestionTool } from './ask-user'

export type ToolSet = Record<string, Tool>

export function buildBuiltinTools(opts: { skills?: boolean } = {}): ToolSet {
  const tools: ToolSet = {
    Bash: bashTool,
    Read: readTool,
    Write: writeTool,
    Edit: editTool,
    Grep: grepTool,
    Glob: globTool,
    EnterPlanMode: enterPlanModeTool,
    ExitPlanMode: exitPlanModeTool,
    TodoWrite: todoWriteTool,
    AskUserQuestion: askUserQuestionTool,
  }
  if (opts.skills) tools.Skill = skillTool
  return tools
}
