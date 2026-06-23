import { registerHandler } from '../lib/protocol.mjs'
import {
  getClaudeCliCapabilities,
  getClaudeCliStatus,
  startClaudeCliSession,
  stopClaudeCliSession,
} from '../runtimes/claude-cli-runtime.mjs'

registerHandler('claudeCli.getCapabilities', getClaudeCliCapabilities)
registerHandler('claudeCli.startSession', startClaudeCliSession)
registerHandler('claudeCli.stopSession', stopClaudeCliSession)
registerHandler('claudeCli.getStatus', getClaudeCliStatus)
