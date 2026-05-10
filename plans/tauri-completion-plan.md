# Tauri 補完計畫

更新日期：2026-05-10

## 進度紀錄

- 2026-05-10：開始 M1/P0 補 adapter 斷線。已接上 `fs.resolvePathLinks` 與 `fs.watch/unwatch/onChanged` 的 Tauri 路徑：renderer `host.fs.*` → Rust command → Node sidecar handler；`fs:changed` 事件由 sidecar 經 Rust bridge emit 回 renderer。這讓 ChatMarkdown path link resolution 與 FileTree watcher 不再在 Tauri 下 throw/no-op。
- 2026-05-10：接上 `claude.stopTask` 的 Tauri 路徑：renderer `host.claude.stopTask()` → Rust `claude_stop_task` → Node sidecar `claude.stopTask`。Rust command 會把 sidecar `{ok:boolean}` 正規化成 Electron preload 相容的 `boolean`，讓 Agent/Task 停止按鈕不因 host kind 拿到不同回傳 shape。
- 2026-05-10：把 `setCodexSandboxMode` / `setCodexApprovalPolicy` 從 Tauri permissive `null` shim 拉成明確 Rust command route；目前因 CodexAgentManager 尚未 port 到 sidecar，兩者回 Electron-shaped `false` 表示 unsupported。完整 Codex sandbox/approval 生效仍歸 M3 Codex parity。
- 2026-05-10：port `settings.clearTerminalHistory` 到 Tauri Rust。行為對齊 Electron：清 `<app-data>/terminal-history` 內所有項目但保留 `.zsh-wrapper`，目錄不存在也回 `true`。SettingsPanel 的清除歷史按鈕在 Tauri 下不再 throw。
- 2026-05-10：port `image.saveDataUrl` 到 Tauri Rust。行為對齊 Electron：只接受 `data:image/*;base64,...`、依 MIME 決定預設副檔名、清理非法檔名字元、使用 native save dialog，取消回 `null`、成功寫入 bytes 並回檔案路徑。Codex/OpenAI/Claude 圖片附件另存流程不再打到 Tauri `notImplemented`。
- 2026-05-10：port `clipboard.saveImage/writeImage` 到 Tauri Rust。`saveImage` 從 OS clipboard 讀圖並寫入 temp `bat-clipboard-*.png`，無圖片時回 `null`；`writeImage` 從檔案載入圖片並寫回 OS clipboard，失敗回 `false`。Terminal/PromptBox/AgentPanel 的本機圖片貼上路徑不再打到 Tauri `notImplemented`。
- 2026-05-10：port `pty.restart/getCwd` 到 Tauri Rust。行為對齊 Electron 的 instance metadata：`getCwd` 回建立/重啟時記錄的 cwd，session 不存在回 `null`；`restart` 會沿用既有 terminal type、kill 舊 session，再用指定 cwd/shell 建新 session，不存在回 `false`。WorkspaceView restart terminal 與 WorkerPanel cwd probe 不再打到 Tauri `notImplemented`。
- 2026-05-10：Agent panels critical direct-call 收斂第一步。Claude/Codex/OpenAI 三個 panel 的 `stopTask`、`setCodexSandboxMode`、`setCodexApprovalPolicy` 已改走 `host.claude.*`，讓前面補好的 Tauri route 不再被 `window.batAppAPI` shim 旁路；其餘 direct calls 仍列在 M0/M3 持續收斂。
- 2026-05-10：Tauri drag/drop path resolver 先補 best-effort adapter。`host.shell.getPathForFile(file)` 會讀 dropped `File` 上可能存在的非標準 absolute `path` / `mozFullPath` 欄位；沒有 absolute path 時仍回 `null`，保留 image dataURL / picker fallback。完整 native drag/drop event routing 仍未完成。
- 2026-05-10：開始 M2 performance instrumentation。Rust sidecar bridge 會 emit `sidecar:metric` event，紀錄 `spawnProcess`、`ensureSpawned`、單次 method `call` 的 `elapsedMs` 與 `ok`，用來定位 mac cold start / first sendMessage 慢在 Node spawn、bridge ensure，還是 SDK method call。
- 2026-05-10：把 `sidecar:metric` 接進 Tauri shim 的 renderer debug log。Tauri runtime 安裝 shim 時會 listen metric event 並寫入 `host.debug.log('[sidecar:metric]', payload)`，實機 debug.log 可直接看到 sidecar spawn/call timing。
- 2026-05-10：收斂 Tauri bundle 的 Node runtime target。`scripts/fetch-node-runtime.mjs` 預設會 prune 其他已知平台/arch runtime 目錄，避免 stale 多平台 Node runtime 被 `../node-sidecar/runtime/` 一起打包；需要保留多平台 cache 時可明確傳 `--keep-other-targets`。
- 2026-05-10：開始 sidecar JS bundle 瘦身。新增 `scripts/build-node-sidecar.mjs` 產生 `node-sidecar/dist/server.mjs`，Tauri resources 改優先打包 dist 單檔；Rust resolver 保留 `src/server.mjs` fallback，避免 dev/test 流程被迫先 build。
- 2026-05-10：補上 sidecar `node_modules` native package prune。`prepare:tauri-bundle` 會在 sidecar install 後移除非目前 platform/arch 的 `@anthropic-ai/claude-agent-sdk-*` 與 `@openai/codex-*` 目錄，避免 stale optional binary 被 resources 帶進 release。

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

- [x] `fs.resolvePathLinks`：sidecar handler 已有，已接上 `src/host-api.ts` Tauri adapter 與 Rust sidecar bridge。
- [x] `fs.watch / fs.unwatch / fs.onChanged`：sidecar 已有 `fs:changed` event，已接上 Tauri adapter 與 Rust event bridge。
- [x] `claude.stopTask`：Node sidecar 已有 handler，已補 Rust command 與 host-api route。
- [x] `setCodexSandboxMode` / `setCodexApprovalPolicy`：已補明確 Tauri route；完整 Codex runtime 生效仍歸 M3。
- [ ] Agent panels 仍有部分直接呼叫 `window.batAppAPI`，需要統一收斂到 `host.*`，避免 Tauri shim 靜默回 no-op。

### P1：使用者會直接碰到的本機功能

- [x] `settings.clearTerminalHistory`
- [x] `image.saveDataUrl`
- [x] `clipboard.saveImage / clipboard.writeImage`
- [x] `pty.restart / pty.getCwd`
- [ ] Tauri native drag/drop folder path resolver。Electron 的 `shell.getPathForFile(File)` 在 Tauri WebView 沒等價 API，需要改用 Tauri drag/drop event 或自訂 resolver。

### P2：macOS 啟動與送訊息延遲

目前 `src-tauri/tauri.conf.json` bundle resources 已收斂為：

- `../node-sidecar/dist/server.mjs`
- `../node-sidecar/package.json`
- `../node-sidecar/node_modules/`
- `../node-sidecar/runtime/`

`node_modules` 與 Node runtime 仍是啟動/掃描成本主體。要把 Tauri 變成可發佈 preview，這一段需要持續瘦身並量測 packaged resources。

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

- [x] 接上 `fs.resolvePathLinks`。
- [x] 接上 `fs.watch/unwatch/onChanged` event bridge。
- [x] 補 `claude.stopTask` Rust command + host-api route。
- [x] 補 `setCodexSandboxMode` / `setCodexApprovalPolicy` route。
- [x] 補 `settings.clearTerminalHistory`。
- [x] 補 `image.saveDataUrl`。
- [x] 補 `clipboard.saveImage/writeImage`。
- [x] 補或替代 `pty.restart/getCwd`。
- [ ] 補 Tauri drag/drop folder path resolver。

驗收：

- `pnpm exec tsc --noEmit --pretty false`
- `pnpm run compile`
- `pnpm run test:sidecar`
- `pnpm run test:tauri-rust`
- 手動測：FolderPicker、FileTree watch refresh、image save/copy、terminal restart、Claude stop task。

### M2：macOS performance 與 bundle 瘦身

目標：處理目前 mac 啟動慢、第一次 folder picker 慢、首次送訊息慢。

- [x] sidecar JS bundle 成單檔，減少 resources 小檔數。
- [x] `node_modules` 做 platform prune，只保留目前平台必要套件與 native binary。
- [x] Node runtime 只打包目前平台與 arch，不跨平台全帶。
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
