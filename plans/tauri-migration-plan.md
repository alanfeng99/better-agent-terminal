# Tauri 遷移短中長期計劃

## 進度紀錄（持續更新）

最近一次更新：2026-05-09 (#3)。（Phase 1 完成 17 個命名空間。Phase 2 已切兩刀：(slice 1) JSON-RPC sidecar foundation + claude.{authStatus,accountList}；(slice 2) claude session lifecycle + event forwarding：sidecar 加 startSession/sendMessage/stopSession/abortSession 四個 stub handlers + sendMessage 時主動推 `event:claude:message` / `event:claude:turn-end` 兩個 notifications；Rust bridge 把 id-less notifications 經 `EventSink` （production = `app.emit`，tests = Vec collector）轉發；adapter 把六個 listener (`onMessage` / `onToolUse` / `onToolResult` / `onResult` / `onTurnEnd` / `onError`) 接到 `claude:message` / `claude:tool-use` / ... Tauri events 並還原 Electron preload 的 `(sessionId, payload)` 簽章。cargo test 100 例 (+1 event-forwarding e2e)、host-api 8 情境（含 lifecycle 五條新 invoke）、`pnpm test:sidecar` 端到端涵蓋 startSession/sendMessage 含 events、Tauri release build & smoke 全綠。）

### 已完成

- [x] **Host API adapter** — `src/host-api.ts` 提供 `host` proxy，由 `getHostKind()` 判斷 Electron/Tauri/unknown，全部命名空間預設 throw 「not yet implemented」避免靜默失敗。
- [x] **Renamed `window.electronAPI` → `window.batAppAPI`** — preload 和 31 個 callsite 一起改名，TS type 由 `BatAppAPI = Window['batAppAPI']` 取得，不再依賴跨 project reference 編譯。`AboutPanel`、`UpdateNotification` 兩個 callsite 已切到 adapter 作為示範。
- [x] **Tauri 2 scaffolding** — `src-tauri/`、`vite.tauri.config.ts`、`pnpm tauri:dev|build` 指令。
- [x] **首批 Rust commands**
  - `settings_load` / `settings_save`（讀寫 `<app-data>/settings.json`）。
  - `settings_get_shell_path`（純函式 + 平台分支，可單元測試 `exists` 注入）。
  - `shell_open_external`（透過 `tauri-plugin-opener`，拒絕 `file://`）。
  - `shell_open_path`（同樣走 opener，拒絕空字串）。
  - `dialog_confirm`（OK/Cancel modal，spawn_blocking 包覆）。
  - `dialog_select_folder` / `dialog_select_files` / `dialog_select_images`（native picker + 預設 home 目錄 + 圖片副檔名 filter）。
  - `fs_read_file`（512 KiB 上限 + `path_guard::is_sensitive_path` 的 deny-list）。
  - `fs_home` / `fs_readdir` / `fs_list_dirs` / `fs_mkdir` / `fs_delete_path` / `fs_quick_locations` / `fs_search`（含 `~` 擴展、IGNORED 名單、目錄優先排序、深度 8 / 最多 100 結果限制）。
  - `clipboard_write_text`（透過 `tauri-plugin-clipboard-manager`）。
  - `image_read_as_data_url`（10 MiB cap + 副檔名 → mime 對應 + base64 編碼，沿用 `path_guard`）。
  - `pty_create` / `pty_write` / `pty_resize` / `pty_kill`（`portable-pty` 0.8 + reader thread + exit watcher，事件透過 `Emitter::emit("pty:output"|"pty:exit")`）。
  - `workspace_load` / `workspace_save`（`<app-data>/workspaces.json`，single-window MVP）。
  - `update_get_version`（讀 `PackageInfo.version`，`update.check` 留給 Phase 3 packaging）。
  - `debug_log`（renderer 端 log 寫到 stderr，未來改接 Rust file logger）。
  - `git_get_github_url` / `git_get_branch` / `git_get_log` / `git_get_diff` / `git_get_diff_files` / `git_get_root` / `git_get_status`（shell-out 到系統 `git` binary，cwd 校驗 + 25ms-poll timeout + 5 MiB stdout cap，git 失敗一律塞 None / 空集合，與 Electron handler 行為一致）。
  - `app_get_window_id` / `app_get_window_index` / `app_get_launch_profile` / `app_get_window_profile` / `app_new_window` / `app_focus_next_window` / `app_open_new_instance` / `app_set_dock_badge`（single-window MVP；全部回常數 / None / `alreadyOpen=true`，讓 App.tsx 不會在啟動時 throw）。
  - `notification_list` / `notification_mark_read` / `notification_mark_all_read` / `notification_mark_window_read` / `notification_clear` / `notification_focus_latest_unread` / `notification_focus_entry`（記憶體內 `Mutex<Vec<NotificationEntry>>`，更新一律 emit `notification:update`；MVP 沒有 producer 所以開機就是空集合，等 agent sidecar 上線再呼叫內部 helper `add_entry()`）。
  - `github_check_cli` / `github_pr_list` / `github_issue_list` / `github_pr_view` / `github_issue_view` / `github_pr_comment` / `github_issue_comment`（shell-out 到 `gh` CLI，read 命令直接吐 `serde_json::Value`，write 命令回 `{success}` / `{error}`，與 Electron handler 對齊；checkCli 用 `gh auth token` 而非 `gh auth status` 避免次帳號異常拖垮主帳號的判讀）。
  - `snippet_get_all` / `snippet_get_by_id` / `snippet_get_favorites` / `snippet_search` / `snippet_get_by_workspace` / `snippet_get_categories` / `snippet_create` / `snippet_update` / `snippet_delete` / `snippet_toggle_favorite`（JSON 檔 `<app-data>/snippets.json`，schema 與 Electron 一致，包含 `action` 欄位的 backfill migration；存檔走 tempfile+rename，讀檔失敗就回空集合並 `next_id=1`）。
  - `profile_*`（13 個 commands；single-window MVP stub：永遠回一個固定 `default` local profile；mutation 命令接收參數但只有 default slot 真實存在；等 multi-window / remote profile 重建時換成真正的 on-disk index，目前 workspace 狀態已透過 `host.workspace.{load,save}` 落盤所以 stub 就夠跑）。
  - `claude_ping` / `claude_auth_status` / `claude_account_list`（Phase 2 起手；皆轉發 `SidecarState::call` 到 Node sidecar 的 JSON-RPC handler。`claude_ping` 只給 cargo 整合測試用，renderer 端不暴露；renderer 看到的是 `host.claude.authStatus()` / `host.claude.accountList()`，shape 與 Electron preload 對齊（authStatus 回 null = 未登入；accountList 目前 Node stub 回 [] 直到實際把 `@anthropic-ai/claude-agent-sdk` 搬進 sidecar）。`SpawnConfig` 解析順序：`BAT_SIDECAR_SCRIPT` env → `<resource_dir>/node-sidecar/src/server.mjs` → `<cwd>/node-sidecar/src/server.mjs`，dev / test / release 各有歸位。預設 timeout 15 秒。
  - `claude_start_session` / `claude_send_message` / `claude_stop_session` / `claude_abort_session`（Phase 2 slice 2；transmit `(sessionId, options/prompt/images/autoCompactWindow)` 透 JSON-RPC，timeout 5 分鐘，因為真實 sendMessage stream 可能跑很久。abort/stop 用標準 15 秒 timeout）。
  - `SidecarState` 加 `EventSink` 機制：reader thread 看到 id-less `event:foo:bar` notification 就把 `event:` 前綴脫掉，把 params 透 sink 推出去。production code 用 `app_handle_emit_sink(app)` 把 sink 包成 `app.emit("foo:bar", params)`，測試端塞 `Arc<Mutex<Vec>>` collector，因此事件流可以在 cargo unit test 中用真 spawn Node 跑出端到端驗證。
- [x] **Adapter Tauri routing**
  - 已 port：`host.settings.{load,save,getShellPath}`、`host.shell.{openExternal,openPath}`、`host.dialog.{confirm,selectFolder,selectFiles,selectImages}`、`host.fs.{readFile,home,readdir,listDirs,mkdir,deletePath,quickLocations,search}`、`host.clipboard.writeText`、`host.image.readAsDataUrl`、`host.pty.{create,write,resize,kill,onOutput,onExit}`、`host.workspace.{load,save,getDetachedId}`、`host.update.getVersion`、`host.debug.log`、`host.git.{getGithubUrl,getBranch,getLog,getDiff,getDiffFiles,getRoot,getStatus}`、`host.app.{getWindowId,getWindowIndex,getLaunchProfile,getWindowProfile,newWindow,focusNextWindow,openNewInstance,setDockBadge}`、`host.notification.*`、`host.system.onResume`（Tauri 下回 no-op unsub）、`host.github.{checkCli,listPRs,listIssues,viewPR,viewIssue,commentPR,commentIssue}`、`host.snippet.{getAll,getById,getFavorites,search,getByWorkspace,getCategories,create,update,delete,toggleFavorite}`、`host.profile.*`、`host.claude.{authStatus,accountList,startSession,sendMessage,stopSession,abortSession,onMessage,onToolUse,onToolResult,onResult,onTurnEnd,onError}`（其餘 20+ 個 claude 方法走 namespace-level proxy，每個方法都丟 per-method `not yet implemented`）。
  - 仍 throw `not implemented`：`host.shell.getPathForFile`、`host.settings.{clearTerminalHistory,detectCx}`、`host.clipboard.{saveImage,writeImage,onCopyShortcut}`、`host.image.saveDataUrl`、`host.fs.{resolvePathLinks,watch,unwatch,onChanged}`、`host.pty.{restart,getCwd}`、`host.update.check`、`host.claude.*`（已 port 12 個之外的 20+ 個方法 — setAutoContinue / getAutoContinue / setPermissionMode / setModel / setEffort / resetSession / getSupportedModels/Commands/Agents / getAccountInfo / scanSkills / getSessionState / getSessionMeta / getContextUsage / getWorktreeStatus / cleanupWorktree 等）、worktree/openai/agent/worker/remote/tunnel 等 Phase 2 / Phase 3 命名空間。
- [x] **Tests**
  - `tests/host-api.test.ts`：8 個情境，第 3 個 invoke 情境涵蓋 70+ 條 cmd（settings、shell、dialog、fs、clipboard、image、pty、workspace、update、debug、git、app、notification、github、snippet、profile、claude），含 optional title、camelCase 參數、undefined args（picker no-arg invokes）、optional 參數的 undefined 透傳（`commit_hash`、`workspaceId` 等）。情境 4 加上 claude 半 port 的 per-method canary（`claude.startSession` throw）。
  - `tests/tauri-launch.test.ts`：啟動 release exe 3 秒，斷言沒提前崩。
  - `node-sidecar/tests/server.test.mjs`：(a) in-process dispatch — ping/authStatus/accountList/unknown method/notification/throwing handler/duplicate registration 等 7 條斷言，(b) end-to-end — `spawn(node, server.mjs)` 跑 stdio 線程化 JSON-RPC，回放 3 條請求並用 `byId` map 對齊（伺服器 dispatch async 不保證 in-order，這是預期行為）。
  - `cargo test`（99 tests）：每個 commands::* 子模組 + 新加 `sidecar::tests`。新增 10 例 sidecar 測試包含：alloc_id 起點 + 增量、PendingTable insert/take/drain、SidecarReply 三種 shape parsing（result / error / event no-id），以及 4 條真正 spawn Node 的 end-to-end：ping round-trip、unknown method 回 -32601、claude.authStatus + claude.accountList stub、8 thread 併發 ping by-id correlation。沒有 node 或 sidecar script 時自動跳過。
- [x] **Release build verified on Windows** — `pnpm exec tauri build` 產生 ~12 MB exe + ~5 MB MSI + ~3.5 MB NSIS installer，smoke test 通過。Phase 2 加入 sidecar 後 release exe 體積無變動（sidecar 是執行期 spawn 不打進 exe）。
- [x] npm scripts：`test:host-api`、`test:tauri-launch`、`test:tauri-rust`、`test:sidecar`、`tauri:*`。

### 進行中 / 下一步

- [x] **Phase 1 完成** — 17 個非-agent 命名空間（settings、shell、dialog、fs、clipboard、image、pty、workspace、update、debug、git、app、notification、system、github、snippet、profile）全 port 到 Rust，renderer 對應 callsite 全切到 `host.*`。Tauri release build green、cargo test 89 例綠、host-api.test.ts 8 情境綠、tauri-launch smoke test 綠。
- [x] **PTY 路線決定**：採用 Rust PTY（`portable-pty` 0.8）而非 Node sidecar，理由：(1) Tauri release 不需要再帶一個 Node runtime，bundle 體積維持在 12.x MB 等級；(2) `portable-pty` 同時支援 Unix forkpty / Windows ConPTY，單一介面；(3) 事件通道直接走 Tauri `Emitter::emit("pty:output"|"pty:exit")`，跟 Electron 的 `webContents.send` 對應，renderer adapter 用 `@tauri-apps/api/event::listen` 包成同步 unsubscribe 風格 → 與 preload 完全相容。**首批 commands**：`pty_create` / `pty_write` / `pty_resize` / `pty_kill`；reader thread 推 `pty:output`；exit watcher polling `try_wait()` 推 `pty:exit`。MVP 暫不 port `pty_restart` / `pty_get_cwd`（需要跨平台 child process tracking，下一個迭代再做）。
- [~] **Phase 2：Agent SDK Node sidecar**（見下方 [Phase 2 設計筆記] 章節）。已落地：`node-sidecar/src/server.mjs` (line-delimited JSON-RPC 2.0 stdio server) + `src-tauri/src/sidecar.rs` (`SidecarState` + `SpawnConfig` + lazy spawn + reader thread + by-id correlation + 15s timeout) + `commands::claude::{ping,auth_status,account_list}` + `host.claude.{authStatus,accountList}`。下一步切片：(slice 2) claude.{startSession,sendMessage,stopSession,abortSession} 含 turn-end / message / tool-use 事件流（用 `Emitter::emit("claude:..."`） + 對應 listenAdapter；(slice 3) account 相關剩下 7 個 + listSessions/resumeSession + readonly metadata；(slice 4) openai/agent/worker/worktree 沿用同一個 sidecar process。
- [ ] **Phase 3：packaging + remote/tunnel + update.check**（見下方原 Phase 3 章節 + Phase 2 章節末端關於 remote/tunnel 共用 sidecar 的討論）。
- [~] 把全部 `window.batAppAPI.*` 直呼換成 `host.*`：已 port 命名空間（settings、shell、dialog、fs、clipboard、image、pty、workspace、update、debug、git、app、notification、system、github、snippet、profile）都已切到 `host.*`；剩下未 port 的命名空間（claude、openai、worktree、agent、claudeCli、claudeAccount、remote、tunnel、worker）仍走 `window.batAppAPI`，受 `installTauriShim()` 保護回 `Promise.resolve(null)`，等該命名空間有 Rust 對應或 Node sidecar 接管再切換。

### 計畫調整

1. **路徑保守化**：原計畫提到 `dialog.confirm` 是低風險首選，實際看下來 `dialog.confirm` 只剩 1 處（rewind 確認）。`settings.{load,save}` 涵蓋面更大，因此先 port 它。
2. **檔名固定**：`settings.json` 路徑刻意對齊 Electron `userData/settings.json`，未來 Electron→Tauri 用戶遷移就只是搬一個檔案。
3. **bundle output 分離**：renderer 走 `dist-tauri/`，避免和 `dist/`、`dist-electron/` 互卡。
4. **棄用 `tauri-plugin-shell`**：第一輪先用 deprecated `Shell::open` 跑通 build，之後馬上換成 `tauri-plugin-opener`，避免之後升級被綁住。

---

## 背景判斷

目前 BetterAgentTerminal 的 React/Vite renderer 可以保留，但 Electron main process 不只是開視窗，而是承擔完整 host runtime：PTY、agent SDK、IPC、遠端 server、設定、profile、通知、更新與安全儲存。

遷移策略不建議一次全 Rust 化。較務實的方向是：

```text
React / TypeScript renderer
        |
        | host API adapter
        v
Tauri Rust host
        |
        | JSON-RPC / stdio / WebSocket
        v
Node sidecar for agent SDKs
```

核心原則：

1. React UI 保留。
2. Agent SDK 與高變動 npm ecosystem 先保留 JS/Node。
3. 穩定 OS 整合與 process/runtime core 逐步搬到 Rust。
4. 先用 spike 驗證風險，再決定是否全面替換 Electron。

## Preview 版切換目標

預估在 10 個 preview 版內完成從 Electron 到 Tauri 的主要切換。這裡的「切換」定義為：Tauri build 取代 Electron build 成為 preview 發佈目標；切換完成後不保留 Electron build，也不做 Electron/Tauri 雙軌維護。必要 rollback 依賴前一個可用 release/tag，而不是保留 Electron runtime。

建議節奏：

1. Preview 1-2：完成 host API adapter 與最小 Tauri shell。
2. Preview 3-4：完成 PTY prototype，決定 Rust PTY 或 Node sidecar 路線。
3. Preview 5-6：讓 workspace、settings、fs、git、worktree 等穩定 host 能力在 Tauri 版可用。
4. Preview 7-8：整合 agent Node sidecar、packaging、macOS notarization 與 Windows installer。
5. Preview 9-10：以 Tauri build 作為 preview 發佈目標，移除 Electron 發佈流程與 runtime 依賴。

---

## 短期計劃：1-3 天

### 目標

確認 React 層能從 Electron API 切出來，並證明同一份 UI 可以跑在 Tauri shell 中。

### 工作項目

1. 新增 `src/host-api.ts` 或同等 adapter 層。
   - 將目前 `window.electronAPI.*` 包成專案自己的 host API。
   - React component 不再直接依賴 Electron preload API。
2. 先挑低風險 API 做 adapter。
   - `shell.openExternal`
   - `dialog.confirm`
   - `fs.readFile`
   - `settings.load`
   - `settings.save`
3. 建立最小 Tauri shell。
   - 使用現有 Vite/React build。
   - 不碰 PTY、agent、remote server。
4. 實作 1-2 個 Tauri Rust command。
   - 例如 `fs_read_file`、`settings_load`。
   - 驗證 `invoke` 與 event model。
5. 先在 macOS 驗證，不急著做完整跨平台。

### 完成標準

1. Electron 版仍可透過 adapter 正常跑。
2. Tauri shell 可載入現有 React UI。
3. 至少一組 host API 在 Electron/Tauri 兩邊都可工作。

---

## 中期計劃：1-3 週

### 目標

決定核心 runtime 要 Rust 化到什麼程度，並讓 Tauri 版具備基本可用的 terminal 與 workspace 能力。

### 工作項目

1. 做 PTY prototype。
   - 路線 A：Rust PTY 實作。
   - 路線 B：保留 Node PTY sidecar。
   - 必測：create/write/resize/kill、process tree、Windows PowerShell、macOS zsh、Linux shell。
2. 保留 agent managers 在 Node sidecar。
   - Claude Agent SDK
   - OpenAI/Codex SDK
   - stream parsing
   - permission / ask-user flow
   - session archive
3. 設計 Rust host 與 Node sidecar 通訊。
   - 優先考慮 JSON-RPC over stdio。
   - 若要沿用現有 remote protocol，可評估 WebSocket。
4. 逐步搬穩定 handler 到 Rust。
   - `fs:*`
   - `git:*`
   - `worktree:*`
   - `settings:*`
   - `profile:*`
   - `snippet:*`
5. 建立 Tauri event 對應。
   - `pty:output`
   - `pty:exit`
   - `claude:message`
   - `claude:stream`
   - `notification:update`
   - `workspace:reload`
6. 建立基本 regression checklist。
   - 開 workspace。
   - 建 terminal。
   - terminal resize。
   - workspace save/load。
   - 啟動 agent session。
   - agent streaming。
   - 停止 agent。
   - file tree read/search。

### 完成標準

1. Tauri 版可以開 workspace 並啟動 terminal。
2. Agent 可以透過 Node sidecar 正常 streaming。
3. 核心資料流不再直接依賴 Electron `ipcMain` / `webContents.send`。
4. 可以判斷 PTY 應該 Rust 化或先保留 Node sidecar。

---

## 長期計劃：1-2 個月以上

### 目標

讓 Tauri build 成為正式版候選，而不是 demo。
短期發佈節奏上，目標是在 10 個 preview 版內讓 Tauri build 取代 Electron build 成為 preview 發佈目標，切換後不保留 Electron build。

### 工作項目

1. 重建 packaging pipeline。
   - macOS dmg/sign/notarize。
   - Windows installer。
   - Linux AppImage 或其他發佈格式。
   - 移除 Electron `asarUnpack` 假設。
2. 重做 update flow。
   - 取代目前 Electron release check/update 邏輯。
   - 確認 GitHub Release artifact 命名與更新 metadata。
3. 設計 secrets migration。
   - Electron `safeStorage` 到 Tauri/Rust keyring。
   - Claude account。
   - OpenAI API key。
   - remote server token/certificate。
4. 移除 Electron-only API。
   - `BrowserWindow`
   - `webContents.send`
   - `ipcMain`
   - `ipcRenderer`
   - `preload.ts`
   - Electron menu/clipboard/dialog/shell wrappers
5. 做跨平台 WebView 驗證。
   - xterm rendering。
   - keyboard shortcuts。
   - drag/drop file path。
   - clipboard image paste。
   - Markdown/Mermaid rendering。
   - context menu。
   - high-output terminal performance。
6. 評估 Node sidecar 收斂範圍。
   - Agent SDK 保留 Node。
   - 可穩定搬 Rust 的工具逐步移除 JS 實作。
   - 不追求短期全 Rust。
7. 發佈候選驗證。
   - `pnpm exec tsc --noEmit --pretty false`
   - `pnpm run compile`
   - Tauri build。
   - macOS 安裝測試。
   - Windows terminal / PowerShell 測試。
   - Linux shell 測試。

### 完成標準

1. Tauri build 功能等價於 Electron 版主要流程。
2. installer 與 updater 可用。
3. secrets migration 有回滾或 fallback。
4. Tauri 版完成主要平台驗證後，Electron 發佈流程與 runtime 依賴會被移除；不維持 Electron fallback。

---

## Phase 2 設計筆記（Agent SDK Node sidecar）

剩下未 port 的命名空間幾乎全綁在 agent runtime：`claude`、`codex`（已從 preload 移除）、`openai`、`agent`、`worker`、`worktree`（agent-tied）。它們呼叫 `@anthropic-ai/claude-agent-sdk`、OpenAI SDK、以及自家 `claude-agent-manager.ts` / `codex-agent-manager.ts` / `openai-agent-manager.ts` 等 Node-only 模組。Rust 端沒有等價物，且這些 SDK 變動頻繁（每兩週一輪），用 Rust 重寫的 ROI 太低。

**選項 A：Node sidecar process（推薦）**
- 在 `src-tauri` 包一個 Node binary（透過 `pkg` 或 `bun build --compile`），啟動時由 Tauri spawn 並維持 lifetime。
- Tauri ↔ sidecar 走 stdio 或 unix socket / named pipe + JSON-RPC（沿用 `claude-agent-manager` 既有的 message bus）。
- Rust 端做：(a) 啟動/關閉/重啟 sidecar、(b) 把 invoke 轉 JSON-RPC、(c) 收 sidecar event 後 emit 到 renderer。
- 成本：~1 MB sidecar 二進位，加 spawn 一個 Node process。對 12.x MB 的 Tauri exe 來說可接受。
- 好處：agent SDK 升級只動 sidecar，不動 Rust；維持與 Electron 版本同步成本最低。

**選項 B：把 Agent SDK rewrite 到 Rust**
- 工作量大且 SDK 跟不上，每次 upstream 改都要 chase。否決。

**選項 C：Tauri command 直接 spawn `node` + IPC**
- 不打包 Node，要求使用者已安裝。對終端 / agent 工具的目標族群可能 OK，但部署 / cold-start 時間都不利。次佳。

**首批 sidecar 命令**
1. `claude.startSession` / `sendMessage` / `stopSession` / `abortSession`（最常用，22 + 6 + 6 + 6 個 callsite）。
2. `claude.authStatus` / `accountList` / `accountSwitch`（auth UI 需要）。
3. `claude.listSessions` / `resumeSession`（session 切換）。
4. `claude.{getSupportedModels,getSupportedAgents,getSupportedCommands,getContextUsage,getAccountInfo}`（單純 read-only metadata）。
5. `worktree.*`（沿用 sidecar 內部的 worktree-manager.ts）。
6. `openai.*`（API key 管理 + session list / compact）。
7. `agent.*` / `worker.*`（小量輔助命令）。

**Phase 3 額外項目（remote/tunnel）**
- `remote.*`（startServer / connect / listProfiles 等）綁定 mDNS + TLS pin，sidecar 也是合理的家。可以與 agent sidecar 共用 process，或拆成獨立 sidecar，但前期建議先共用。
- `tunnel.getConnection` 同上。

---

## 建議遷移順序

1. Host API adapter。
2. 最小 Tauri shell。
3. 低風險 Rust commands。
4. PTY prototype。
5. Node sidecar for agents。
6. Workspace/settings/fs/git/worktree Rust 化。
7. Packaging/updater/secrets。
8. Electron cleanup。

---

## 不建議的路線

1. 一開始全 Rust 重寫 agent managers。
   - Claude/OpenAI/Codex SDK 變動快，JS 保留較務實。
2. Tauri 只包一個完整 Node backend。
   - 這會增加 process 複雜度，但體積與架構收益有限。
3. 先碰 packaging。
   - 應先證明 runtime 可行，再投入 release pipeline。

## 初步結論

可行方向是混合式架構：React 保留，Agent JS 保留，host core 逐步 Rust 化。第一階段只需要證明 React 能透過 adapter 同時支援 Electron 與 Tauri；第二階段再用 PTY prototype 決定遷移成本是否值得投入。
