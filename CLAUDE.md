# CLAUDE.md - Project Guidelines

## No Regressions Policy

- **NEVER** break existing features when implementing new ones.
- Before committing, verify ALL existing features still work — not just the new changes.
- Run the build (`pnpm run compile`) to confirm compilation succeeds.
- When modifying shared code (stores, IPC handlers, types), trace all consumers to ensure nothing breaks.

## Package Management

- This repository uses **pnpm**. Do not use `npm install`, `npm ci`, or `npx` for project workflows.
- The pinned package manager is declared in `package.json` (`packageManager`: `pnpm@10.33.2`).
- Use `pnpm install --frozen-lockfile` for reproducible installs.
- Use `pnpm exec <tool>` instead of `npx <tool>`.
- Keep `pnpm-lock.yaml` committed and do not reintroduce `package-lock.json`.
- pnpm v10 blocks dependency lifecycle scripts unless explicitly allowed; required build-script packages are listed under `pnpm.onlyBuiltDependencies` in `package.json`.
- Standard verification commands:
  - `pnpm exec tsc --noEmit --pretty false`
  - `pnpm run compile`
  - `pnpm run test:node-resolver`
  - For local packaging verification without macOS signing/notarization: `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --dir --config.mac.notarize=false --config.mac.identity=null`

## Logging

- **Frontend (renderer)**: Use `window.electronAPI.debug.log(...)` instead of `console.log()`. This sends logs to the electron main process logger, which writes to disk.
- **Backend (electron)**: Use `logger.log(...)` / `logger.error(...)` from `./logger`.
- Do NOT use `console.log()` for debugging — use the logger so logs are persisted and visible in the log file.
- **Log file location** (`debug.log` inside the userData directory):
  - macOS: `~/Library/Application Support/better-agent-terminal/debug.log`
  - Windows: `%APPDATA%\better-agent-terminal\debug.log`
  - Linux: `~/.config/better-agent-terminal/debug.log`

## Sub-agent / Active Tasks Tracking

- The Claude Agent SDK does **NOT** reliably emit `task_started` / `task_progress` / `task_notification` system messages.
- We track Agent/Task tools from `tool_use` blocks directly in `session.activeTasks` (in `claude-agent-manager.ts`).
- `stopTask()` falls back to using `toolUseId` as `task_id` when no mapping exists.
- Tool results for Agent/Task must clean up `activeTasks` entries.

## React Rendering

- Use `flushSync` from `react-dom` for Agent/Task tool state changes (`setMessages` in `onToolUse` and `onToolResult`) to prevent rendering delays from React 18 batching during streaming.
- Do NOT use `flushSync` for regular tool calls — only for state changes that affect the active tasks bar visibility.

## Status Line

- Our status line implementation is superior to external alternatives (e.g., ccstatusline). Do not replace it.
- 15 configurable items (see `STATUSLINE_ITEMS` in `src/types/index.ts`) with custom colors, zone alignment, and template-based config.
- Usage polling: Chrome session key (primary, lenient rate limits) → OAuth fallback (strict rate limits).

## Release

- **正式版**: `release new tag version` → 基於最新 tag 遞增 patch 版號，建立 tag 並 push
  - 例：目前 `v2.2.27` → 建立 `v2.2.28` tag
- **預覽版**: `release new pre tag version` → 基於最新 tag 遞增 patch 版號，加 `-pre.1` 後綴
  - 例：目前 `v2.2.27` → 建立 `v2.2.28-pre.1`
  - 若已有 `v2.2.28-pre.1` → 建立 `v2.2.28-pre.2`
- Tag 含 `-pre` 時 GitHub Release 自動標為 Pre-release，不更新 Homebrew tap
- Tag 不含 `-pre` 時為正式版，更新 Homebrew tap
