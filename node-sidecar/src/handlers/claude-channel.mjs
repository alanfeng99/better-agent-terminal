import { registerHandler } from '../lib/protocol.mjs'
import {
  getClaudeChannelCapabilities,
  getClaudeChannelStatus,
  sendClaudeChannelMessage,
  startClaudeChannelSession,
  stopClaudeChannelSession,
} from '../runtimes/claude-channel-runtime.mjs'

registerHandler('claudeChannel.getCapabilities', getClaudeChannelCapabilities)
registerHandler('claudeChannel.startSession', startClaudeChannelSession)
registerHandler('claudeChannel.sendMessage', sendClaudeChannelMessage)
registerHandler('claudeChannel.stopSession', stopClaudeChannelSession)
registerHandler('claudeChannel.getStatus', getClaudeChannelStatus)
