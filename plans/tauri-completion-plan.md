# Tauri 補完計畫

更新日期：2026-05-10

## 進度紀錄

- 2026-05-10：開始 M1/P0 補 adapter 斷線。已接上 `fs.resolvePathLinks` 與 `fs.watch/unwatch/onChanged` 的 Tauri 路徑：renderer `host.fs.*` → Rust command → Node sidecar handler；`fs:changed` 事件由 sidecar 經 Rust bridge emit 回 renderer。這讓 ChatMarkdown path link resolution 與 FileTree watcher 不再在 Tauri 下 throw/no-op。
- 2026-05-10：接上 `claude.stopTask` 的 Tauri 路徑：renderer `host.claude.stopTask()` → Rust `claude_stop_task` → Node sidecar `claude.stopTask`。Rust command 會把 sidecar `{ok:boolean}` 正規化成 Electron preload 相容的 `boolean`，讓 Agent/Task 停止按鈕不因 host kind 拿到不同回傳 shape。

## 目前判斷

Tauri 版已經超過 spike 階段，基礎 host runtime 大多有可用實作：

- Rust native commands 已涵蓋 settings、dialog、fs、PTY、workspace、git/github、snippet、notification、workerBuffer、profile MVP。
- Node sidecar 已經承接 Claude session/send/history/permission、fs sidecar handlers、remote/tunnel handlers、OpenAI/Worktree 部分能力。
- Claude `sendMessage` 已走 LiveQuery 類型的 long-lived stream，metadata 也已有 process cache，已經不是每次 UI mount 都重打多個 cold SDK query 的早期狀態。

但目前仍不建議把 Tauri 版升成正式主線。主要風險不是單一功能缺失，而是三個面向還沒收斂：

1. Renderer Tauri adapter 還有實作斷線點。
2. Codex/OpenAI agent runtime 尚未達 Electron parity。
3. macOS packaged bundle 仍帶 raw sidecar `node_modules` + Node runtime，啟動與資源掃描成本偏高。

## 已掃描到的缺口

### P0：Adapter 與 sidecar 斷線

這些是「能力在某層已存在，但 renderer 還不能可靠使用」的缺口，優先補。

- `fs.resolvePathLinks`：sidecar handler 已有，但 `src/host-api.ts` Tauri adapter 仍 throw `notImplemented`。
- `fs.watch / fs.unwatch / fs.onChanged`：sidecar 已有 `fs:changed` event，但 Tauri adapter 仍是 no-op。
- `claude.stopTask`：Node sidecar 已有 handler，Rust command 與 host-api route 尚未接完。
- `setCodexSandboxMode` / `setCodexApprovalPolicy`：Electron 有 handler，Tauri sidecar/Rust/adapter 還未形成完整通路。
- Agent panels 仍有部分直接呼叫 `window.batAppAPI`，需要統一收斂到 `host.*`，避免 Tauri shim 靜默回 no-op。

### P1：使用者會直接碰到的本機功能

- `settings.clearTerminalHistory`
- `image.saveDataUrl`
- `clipboard.saveImage / clipboard.writeImage`
- `pty.restart / pty.getCwd`
- Tauri native drag/drop folder path resolver。Electron 的 `shell.getPathForFile(File)` 在 Tauri WebView 沒等價 API，需要改用 Tauri drag/drop event 或自訂 resolver。

### P2：macOS 啟動與送訊息延遲

目前 `src-tauri/tauri.conf.json` bundle resources 仍包含：

- `../node-sidecar/src/`
- `../node-sidecar/package.json`
- `../node-sidecar/node_modules/`
- `../node-sidecar/runtime/`

這會導致 mac packaged app 首次啟動時掃描大量小檔與較大的 Node runtime。要把 Tauri 變成可發佈 preview，這一段需要先瘦身。

### P3：Agent parity

- Claude：基礎 session/send/event 已可用，但需要完整驗證 resume、permission、stopTask、worktree info、archive/history、rate-limit event 與 Electron 行為一致。
- Codex：Electron 版有完整 `CodexAgentManager`，Tauri sidecar 尚未等價搬完。這是正式切換前最大的 blocker。
- OpenAI：目前仍偏 API key/listSessions/compact 的薄層，正式 Agent runtime 尚未達 Electron parity。

### P4：多視窗、profile、remote

- Workspace detach/reattach/moveToWindow 仍是 single-window MVP 外的缺口。
- Profile 目前是 default profile MVP，不是完整 ProfileManager。
- Remote/tunnel 雖已有 sidecar handlers，但仍需用實機流程驗證 server/client/status/profile list。

## 里程碑

### M0：建立準確 coverage matrix

目標：避免之後靠記憶補洞。

- 產生 Electron preload API surface 與 Tauri host-api surface 對照表。
- 標記每個 method 狀態：native Rust、sidecar、stub、no-op、notImplemented。
- 對高風險 namespace 加測試，禁止 critical method 落入 permissive no-op。
- 將 `window.batAppAPI` 直接呼叫點列成清單，逐步改成 `host.*`。

驗收：

- 有一份可維護的 API coverage 表。
- `claude.stopTask`、Codex sandbox/approval、fs watch/resolve 不再能被 silent no-op 掩蓋。

### M1：補完 P0/P1 本機功能

目標：Tauri preview 的日常操作不再踩 obvious gap。

- 接上 `fs.resolvePathLinks`。
- 接上 `fs.watch/unwatch/onChanged` event bridge。
- 補 `claude.stopTask` Rust command + host-api route。
- 補 `setCodexSandboxMode` / `setCodexApprovalPolicy` route。
- 補 `settings.clearTerminalHistory`。
- 補 `image.saveDataUrl`。
- 補 `clipboard.saveImage/writeImage`。
- 補或替代 `pty.restart/getCwd`。
- 補 Tauri drag/drop folder path resolver。

驗收：

- `pnpm exec tsc --noEmit --pretty false`
- `pnpm run compile`
- `pnpm run test:sidecar`
- `pnpm run test:tauri-rust`
- 手動測：FolderPicker、FileTree watch refresh、image save/copy、terminal restart、Claude stop task。

### M2：macOS performance 與 bundle 瘦身

目標：處理目前 mac 啟動慢、第一次 folder picker 慢、首次送訊息慢。

- sidecar JS bundle 成單檔，減少 resources 小檔數。
- `node_modules` 做 platform prune，只保留目前平台必要套件與 native binary。
- Node runtime 只打包目前平台與 arch，不跨平台全帶。
- sidecar lazy warm-up：renderer first paint 後再啟動，不阻塞主畫面。
- auth/model/account metadata 改成背景刷新，UI 先顯示可互動狀態。
- 加性能 marker：app ready、renderer first paint、sidecar spawn、SDK init、FolderPicker first list、first sendMessage start/end。

驗收：

- mac cold launch 到可互動目標：小於 2 秒。
- FolderPicker 首次顯示目前目錄目標：小於 500ms。
- sidecar cold spawn 有明確 log，能分辨 Node 啟動、SDK import、CLI subprocess 哪段慢。
- packaged app resources 小檔數與大小有 CI/腳本可檢查。

### M3：Agent runtime parity

目標：Agent workflows 足以替代 Electron preview。

- Claude parity：resume、fork、rewind、permission/ask-user、stopTask、archive/history、rate-limit、worktree info。
- Codex parity：搬移或重建 `CodexAgentManager` 到 sidecar。
- OpenAI parity：API key storage、session start/send/resume/compact、event stream。
- Worktree parity：create/remove/status/rehydrate 與 Codex/Claude session 狀態整合。
- Account management：account switch/remove/import 不再是 stub。

驗收：

- Claude、Codex、OpenAI 三種 agent 都能 start/send/abort/resume。
- Codex sandbox/approval/model/effort 切換後行為與 Electron 一致。
- stop task 在 Claude/Codex/OpenAI UI 上不會變成無效按鈕。

### M4：發佈硬化

目標：Tauri 可作為 preview 發佈目標。

- mac signing/notarization 實測。
- Windows/mac packaged smoke test。
- app update.check、remote/tunnel、profile/workspace migration 驗證。
- sidecar crash/restart/backoff 策略。
- sidecar log 與 Rust log 整合到 bug-report 可取用位置。

驗收：

- packaged build 可在 clean macOS 使用者環境啟動。
- 無需安裝系統 Node 也能跑 sidecar。
- Claude/Codex/OpenAI 基本流程在 packaged app 可用。
- Electron 與 Tauri 的 user data migration 路徑明確。

## 建議切換門檻

不建議現在把 Electron 主線切到 Tauri。

建議策略：

- M1 完成後：Tauri 可作為 internal preview。
- M2 完成後：Tauri 可開始給少量 mac 使用者測啟動與日常操作。
- M3 完成後：Tauri 才適合當 public preview。
- M4 完成後：再評估是否正式取代 Electron。

若多視窗/profile/remote 是正式版必備，則 P4 也必須進入切換門檻；否則 Tauri 只能標成 single-window preview。
