import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

const questionSchema = z.object({
  header: z.string().min(1).max(24).describe('Short label shown above the question'),
  question: z.string().min(1).describe('Concrete question for the user'),
  options: z.array(z.object({
    label: z.string().min(1).max(40).describe('Short user-facing option label'),
    description: z.string().min(1).describe('One sentence explaining the tradeoff'),
    markdown: z.string().optional().describe('Optional preview HTML/markdown for this option'),
  })).min(2).max(4).describe('Mutually exclusive choices; put the recommended choice first and mark it in the label when appropriate'),
  multiSelect: z.boolean().optional().describe('Currently rendered as single-choice; leave false unless UI support is added'),
})

export const askUserQuestionTool = tool({
  description: 'Ask the user one to three concrete blocking questions with 2-4 explicit options each. Use instead of ending with vague “if you want” offers when user input is genuinely needed.',
  inputSchema: z.object({
    questions: z.array(questionSchema).min(1).max(3).describe('Blocking questions needed to continue'),
  }),
  execute: async ({ questions }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const normalized = questions.map(question => ({
      header: question.header,
      question: question.question,
      options: question.options,
      multiSelect: false,
    }))
    const answers = await ctx.askUser(normalized, options.toolCallId)
    return { answers }
  },
})
