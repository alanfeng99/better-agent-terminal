# Tauri 遷移短中長期計劃

## 進度紀錄（持續更新）

最近一次更新：2026-05-09。

### 已完成

- [x] **Host API adapter** — `src/host-api.ts` 提供 `host` proxy，由 `getHostKind()` 判斷 Electron/Tauri/unknown，全部命名空間預設 throw 「not yet implemented」避免靜默失敗。
- [x] **Renamed `window.electronAPI` → `window.batAppAPI`** — preload 和 31 個 callsite 一起改名，TS type 由 `BatAppAPI = Window['batAppAPI']` 取得，不再依賴跨 project reference 編譯。`AboutPanel`、`UpdateNotification` 兩個 callsite 已切到 adapter 作為示範。
- [x] **Tauri 2 scaffolding** — `src-tauri/`、`vite.tauri.config.ts`、`pnpm tauri:dev|build` 指令。
- [x] **首批 Rust commands** — `settings_load` / `settings_save`（讀寫 `<app-data>/settings.json`）、`settings_get_shell_path`（純函式 + 平台分支，可單元測試 `exists` 注入）、`shell_open_external`（透過 `tauri-plugin-opener`，拒絕 `file://`）、`shell_open_path`（同樣走 opener，拒絕空字串）、`dialog_confirm`（透過 `tauri-plugin-dialog`，OK/Cancel modal）、`fs_read_file`（512 KiB 上限 + `path_guard::is_sensitive_path` 的 deny-list）。
- [x] **Adapter Tauri routing** — `host.settings.{load,save,getShellPath}`、`host.shell.{openExternal,openPath}`、`host.dialog.confirm`、`host.fs.readFile` 在 Tauri 下走 `invoke`；其餘命名空間仍 throw。
- [x] **Tests**
  - `tests/host-api.test.ts`：8 個情境涵蓋偵測、Electron 委派、Tauri invoke routing（含 `shell_open_path`、`dialog_confirm`、`fs_read_file`、`settings_get_shell_path`、optional title）、legacy `__TAURI__` marker、衝突優先序、permissive shim。
  - `tests/tauri-launch.test.ts`：啟動 release exe 3 秒，斷言沒提前崩。
  - `cargo test`（17 tests）：`settings::tests`（路徑 + `resolve_shell_path` 的 unix/windows 分支）、`shell::tests::{file_urls_are_rejected,empty_paths_are_rejected}`、`dialog::tests::defaults_title_to_confirm`、`fs::tests`（讀檔、>512 KiB cap、不存在路徑）、`path_guard::tests`（deny-list 命中、目錄包含、白名單）。
- [x] **Release build verified on Windows** — `pnpm exec tauri build` 產生 12.8 MB exe + 5.2 MB MSI + 3.7 MB NSIS installer，smoke test 通過。
- [x] npm scripts：`test:host-api`、`test:tauri-launch`、`test:tauri-rust`、`tauri:*`。

### 進行中 / 下一步

- [ ] 把更多 Electron preload 命名空間 port 到 Rust（依風險排序：~~`shell.openPath`~~ ✅、~~`dialog.confirm`~~ ✅、~~`fs.readFile`~~ ✅、~~`settings.getShellPath`~~ ✅、`dialog.selectFolder`/`selectFiles`/`selectImages`、`clipboard.*`、`fs.home`/`fs.readdir`、`image:read-as-data-url`）。
- [ ] 規劃 PTY 路線（Phase 2）：Rust PTY vs Node sidecar prototype。
- [ ] Agent SDK Node sidecar 設計（Phase 2）。
- [ ] 把全部 `window.batAppAPI.*` 直呼換成 `host.*`，讓 renderer 完全不直讀全域。

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
