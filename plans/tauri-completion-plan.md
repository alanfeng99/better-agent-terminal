# Tauri 補完計畫

更新日期：2026-05-17

## 進度紀錄

- 2026-05-17：補 remote profile 的 Git/GitHub routing。Tauri `git:*` / `github:*` command 會在 remote profile window 下轉發到 remote server Rust bridge，讓 remote workspace 的 Git tab、GitHub PR/Issue list/view/comment 不再讀 client 本機 cwd；remote server 改呼叫 native helper 避免 command wrapper 需要 window context。`git status` 同步改用 `--untracked-files=all`，確保 untracked folder 內檔案會展開列出。
- 2026-05-16：補 remote profile 的 Claude/Codex metadata/history Rust routing。Tauri remote 視窗的 `listSessions`、archive page/clear、skills/MCP scan、CLI prepare/path、account list/switch/remove、session meta/state/context、worktree status/cleanup 與 Codex/Claude control metadata 會先透過 remote server Rust bridge 處理；本機已 Rust native 的路徑不再因 remote profile 落回 Node sidecar 或 client 本機空狀態，Claude SDK turn streaming 仍保留 sidecar ownership。
- 2026-05-16：補 remote profile 的 Files/FS routing。Tauri `host.fs.*` command 會在 remote profile window 下轉發到 Rust remote server 的 `fs:*` bridge，涵蓋 Files tab 的 `readdir/readFile/search`、FolderPicker 的 `home/listDirs/quickLocations/mkdir/delete`、path-link resolve 與 watcher；避免 remote workspace 路徑被拿到 client 本機讀取而顯示空白或錯誤。
- 2026-05-10：開始 M1/P0 補 adapter 斷線。已接上 `fs.resolvePathLinks` 與 `fs.watch/unwatch/onChanged` 的 Tauri 路徑；`fs.resolvePathLinks` 與 `fs.watch/unwatch` 後續已搬到 Rust native，`fs:changed` 事件由 Rust watcher emit 回 renderer。這讓 ChatMarkdown path link resolution 與 FileTree watcher 不再在 Tauri 下 throw/no-op。
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
- 2026-05-10：補上 Tauri resources 量測腳本。`pnpm run verify:tauri-resources` 會依 `src-tauri/tauri.conf.json` 統計 bundle resources 的檔案數與大小，並在 resource source 缺失時失敗，作為後續 mac cold-start 瘦身基準。
- 2026-05-10：收斂部分 renderer direct `window.batAppAPI` 呼叫。`AgentsPanel`、`SkillsPanel`、`TerminalThumbnail` 已改走 `host.claude.*`，讓 Tauri 的 supported agents/commands/skills 與 agent preview event adapter 不再旁路 host-api。
- 2026-05-10：收斂 `WorkerPanel` direct host calls。Procfile worker buffer init/read/append/clear 與 remote client status 已改走 `host.workerBuffer` / `host.remote`，對齊已 port 的 Tauri adapter。
- 2026-05-10：收斂 `ProfilePanel` remote direct calls。remote profile list/test connection 改走 `host.remote.*`，避免 Tauri profile UI 旁路 host-api。
- 2026-05-10：收斂 `SettingsPanel` direct host calls。OpenAI key、Claude account switching、remote/tunnel status/server、外部連結開啟已改走 `host.*`，讓設定頁在 Tauri 下使用同一層 adapter。
- 2026-05-10：收斂 dock badge direct host calls。settings/workspace store 的 dock badge 更新已改走 `host.app.setDockBadge`，保留失敗時不阻塞 store 更新的既有行為，避免 Tauri 下 pending action badge 繞過 host adapter。
- 2026-05-10：收斂 `App.tsx` direct host calls。啟動時 auth status、remote profile connect、remote client polling/resume refresh、Windows window-cycle platform 判斷、全域 send-to-agent 已改走 `host.*`，主 App shell 不再直接依賴 Electron preload。
- 2026-05-10：收斂 platform/systemVersion direct reads。`GitPanel` 的 path separator 與 `TerminalPanel` 的 Windows ConPTY build detection 已改讀 `host.platform` / `host.systemVersion`，renderer 同步平台資訊不再直接依賴 Electron preload。
- 2026-05-11：補 Tauri top-level platform parity。`createTauriHost()` 現在直接提供 `host.platform` 與 `host.systemVersion`，避免 App/GitPanel/SettingsPanel/TerminalPanel 透過 `host.*` 讀平台時拿到 missing-method proxy；host-api regression 已鎖住此同步值。
- 2026-05-11：修正 Tauri runtime detection。`installTauriShim()` 會在 Tauri 下建立 `window.batAppAPI`，因此 `getHostKind()` 改成 Tauri marker 優先，避免 shim 安裝後 `isTauri()` 誤判成 Electron，影響 native drag/drop、profile restore 與其他 Tauri-only 分支。
- 2026-05-10：收斂 `Sidebar` agent resting controls。workspace context menu 的 `isResting` / `restSession` / `wakeSession` 已改走 `host.claude.*`，對齊已存在的 Tauri sidecar route。
- 2026-05-10：收斂 `WorkspaceView` direct host calls。agent preset list、worktree create/remove、Claude CLI path、session start/stop/resume/send、cleanupWorktree 已改走 `host.*`，workspace shell 的新增、重啟、關閉與 send-to-agent 流程不再旁路 host adapter。
- 2026-05-10：收斂 `ClaudeAgentPanel` direct Claude calls。archive/history、session lifecycle、metadata、permission/ask-user、account、MCP、worktree/context usage 等 `window.batAppAPI.claude.*` 呼叫已改走 `host.claude.*`，保留既有 Electron 行為並讓 Tauri adapter 統一承接。
- 2026-05-10：收斂 `CodexAgentPanel` direct Claude calls。Codex panel 共用的 archive/history、session lifecycle、metadata、permission/ask-user、account、worktree/context usage 等 Claude bridge 呼叫已改走 `host.claude.*`，避免 Codex UI 旁路 Tauri adapter。
- 2026-05-10：收斂 `OpenAIAgentPanel` direct Claude calls。OpenAI panel 共用的 archive/history、session lifecycle、metadata、permission/ask-user、account、worktree/context usage 等 Claude bridge 呼叫已改走 `host.claude.*`，三個大型 agent panel 的 direct `window.batAppAPI.claude` 使用點已清完。
- 2026-05-10：補 Tauri dropped path cache。Tauri native drop event 若有提供 paths，renderer 會暫存 5 秒並讓 `host.shell.getPathForFile(File)` 以唯一檔名回填 absolute path；保留 `dragDropEnabled=false` 以避免破壞現有 HTML5 image drop，完整 native drop routing 仍列為 M1 待完成。
- 2026-05-10：開始接 Tauri native drop routing。`host-api` 會把 Tauri webview drag/drop event 轉成 renderer custom event，`Sidebar` 已可直接用 native paths 新增 workspace；HTML5 drop fallback 保留不變。Agent attachment 區仍待接同一個 native event。
- 2026-05-10：接上 `ClaudeAgentPanel` native attachment drop。Tauri native dropped paths 會依副檔名走 `addImageByPath` 或 `addFileByPath`，remote session 保留既有限制；HTML5 `File` drop fallback 仍保留。
- 2026-05-10：接上 `CodexAgentPanel` native attachment drop。行為對齊 Claude panel：Tauri native dropped paths 依副檔名轉成 image/file attachment，remote session 保留既有限制；HTML5 `File` drop fallback 仍保留。
- 2026-05-10：接上 `OpenAIAgentPanel` native attachment drop。三個 agent panel 都已能消費 Tauri native dropped paths；下一步需評估開啟 Tauri `dragDropEnabled` 後是否會影響非檔案的既有 HTML5 drag/drop。
- 2026-05-10：降低 Tauri Claude sendMessage UI 阻塞風險。`claude_send_message` Rust command 改成 async command，將既有 blocking sidecar bridge 放進 `spawn_blocking`，避免 sidecar cold start / SDK push 等待佔住 Tauri command handler 而讓 WebView 無法切換或更新。
- 2026-05-10：啟用 Tauri native drag/drop path events。`dragDropEnabled=true` 後，OS file/folder drops 由 Tauri webview event 提供 absolute paths，再由 renderer custom event 分派給 Sidebar / Claude / Codex / OpenAI attachment 區；M1 drag/drop folder path resolver 進入 code-complete，仍需 packaged/manual smoke 覆蓋 internal drag reorder。
- 2026-05-10：延後 Tauri 啟動早期 sidecar 喚醒。`App` 的 Claude auth title refresh 與 remote client status polling 在 Tauri 下改到 first paint 後 1 秒才啟動，避免非首屏必要的 `authStatus/clientStatus` 觸發 sidecar cold spawn 影響初始互動；Electron 保持原本立即查詢行為。
- 2026-05-10：修正 Tauri Claude 連續送訊息的 sidecar 狀態缺口。`claude.sendMessage` 不再因 `streaming` flag 直接回 `session already streaming`，改為 per-session FIFO 排隊並沿用同一個 LiveQuery；同時補 `sidecar.log` 的 send start/queued/completed/abort 訊息，方便比對第二輪 ping 是否有進 sidecar、是否有完成 result/turn-end。
- 2026-05-10：降低 FolderPicker / fs listing 對 Tauri runtime 的阻塞風險。`fs.readdir`、`fs.listDirs`、`fs.quickLocations` 的同步檔案列目錄工作改丟 Rust blocking worker，避免慢磁碟、網路磁碟、Windows drive probe 或 macOS `/Volumes` 掃描佔住 async command runtime；UI API 與 Electron 回傳 shape 不變。
- 2026-05-10：補 FolderPicker performance marker。renderer 會在 `home`、`listDirs/readdir`、`quickLocations` 任一步超過 50ms 時寫 debug log，包含 path、mode、hidden flag、entry count 與 outcome，用來定位首次 Choose Folder 慢在 home resolve、目錄 listing，還是 quick locations 掃描。
- 2026-05-10：補 Claude SDK import timing。Node sidecar 第一次 `loadAnthropicSdk()` 會在 `sidecar.log` 記錄 `claude.sdkLoad` 的 ok/failed/disabled 與 elapsedMs，讓 first send / metadata 慢可以拆成 Node spawn、SDK import、LiveQuery/CLI turn 三段觀察。
- 2026-05-10：Agent metadata 背景化第一步。Claude/Codex/OpenAI 三個 panel 在 Tauri 下收到 `sdkSessionId` 後，model/account/commands/agents metadata refresh 延後 1.5 秒背景執行；Electron 保持立即刷新。這讓 panel mount / first status 不會立刻與 sidecar warm-up、SDK import 或首輪 send 搶同一段時間。
- 2026-05-10：補 Tauri `claude.sendMessage` adapter start/end marker。renderer 送出時會記錄 prompt/image/autoCompactWindow 與 invoke elapsed/ok/error，可和 `sidecar:metric`、`claude.sdkLoad`、sidecar send lifecycle log 串起來定位按送出時 UI 卡頓是在 renderer 同步段、Tauri invoke、Node spawn、SDK import，還是 LiveQuery push。
- 2026-05-10：開始 M3 OpenAI parity。`openai.getApiKeyStatus/setApiKey/clearApiKey` sidecar handler 不再是 stub，會在 Tauri data dir 寫入/清除 `openai-api-key.bin`，並保留 `OPENAI_API_KEY` 與 Codex OAuth token fallback；Settings 的 OpenAI key 設定在 Tauri 下開始有實際持久化效果。
- 2026-05-10：Account management stub reduction。`claude.accountMarkWarningShown` sidecar handler 會持久化 `claude-accounts.json` 的 `switchWarningShown=true`，不再只是回傳成功；Tauri Settings 的帳號切換一次性警告不會因重開 app 重複出現。完整 account import/switch/remove 仍待安全憑證儲存方案。
- 2026-05-10：補 M0 regression guard。`tests/host-api.test.ts` 加入 critical Tauri command canary，明確要求 fs watch/resolve、Claude stopTask、Codex sandbox/approval、settings/image/clipboard/pty、OpenAI key 與 worktree create/rehydrate 等已 port 路徑必須走 Tauri invoke，避免未來退回 permissive no-op。
- 2026-05-10：補 OpenAI session list Electron parity。Tauri sidecar `openai.listSessions` 現在與 Electron `listAllSessions()` 一樣依 mtime 排序後最多回 50 筆，避免長期使用者歷史資料過多時讓 Settings/Agent session picker 一次載入過量項目；sidecar 測試已覆蓋排序與 50 筆上限。
- 2026-05-10：修正 Tauri `claude.resumeSession` adapter 參數截斷。Electron preload 會把 `agentPreset`、Codex sandbox/approval、permissionMode、effort 一起傳入 resume；Tauri host-api 先前只保留到 `agentPreset`，導致 Codex/OpenAI panel restore 後 sidecar state 可能退回 `bypassPermissions` 或遺失 effort。現在 Tauri route 會完整傳遞這些 options，host-api 測試鎖住 payload。
- 2026-05-10：補 Codex sandbox/approval 的 Tauri state-level parity。`claude.setCodexSandboxMode` / `claude.setCodexApprovalPolicy` 不再由 Rust 固定回 `false`，改走 sidecar handler；sidecar 會驗證合法值、既有 session 才回 `true`，並保存到 session state，讓 Codex/OpenAI panel 的切換與 resume/start options 在完整 Codex runtime 搬移前仍有一致狀態。
- 2026-05-10：補 Claude session worktree rehydrate parity。Tauri sidecar `claude.startSession/resumeSession` 現在遇到 `useWorktree + worktreePath` 且路徑存在時，會 rehydrate `activeWorktrees`、把 session effective cwd 切到 worktree path，並 emit `claude:worktree-info`；這讓 reload/resume 已有 worktree 的 Agent session 不再回到原始 repo cwd。
- 2026-05-10：補 Claude session worktree cleanup parity。Tauri sidecar `claude.cleanupWorktree` 現在會在移除 active worktree 後把 session cwd 從 worktree path 還原到 original cwd，清掉 worktree options，並 emit `claude:status` 與 `claude:worktree-info=null`；Workspace 關閉 worktree 後不再留下錯誤 cwd。
- 2026-05-10：降低 Tauri worktree command UI 阻塞風險。`worktree.create/remove/status/merge/rehydrate` Rust commands 改成 async command，將 blocking sidecar bridge 放進 `spawn_blocking`，避免 git worktree 建立/移除或 sidecar cold start 佔住 Tauri command handler。
- 2026-05-10：降低其他 Tauri sidecar bridge UI 阻塞風險。`openai.*`、`remote.*`、`tunnel.getConnection`、`agent.listPresets` Rust commands 改成 async command，將 blocking sidecar bridge 放進 `spawn_blocking`；設定頁、remote 狀態輪詢與 agent preset 查詢不再佔住 Tauri command handler。
- 2026-05-10：降低 Tauri fs command UI 阻塞風險。`fs.resolvePathLinks/watch/unwatch` 的 sidecar bridge 與 `fs.search` 的同步目錄 walk 改進 `spawn_blocking`，避免 markdown path link resolve、FileTree watcher 或搜尋慢路徑佔住 Tauri command handler。
- 2026-05-10：降低 Tauri Claude startup/metadata UI 阻塞風險。`claude.authStatus/accountList/startSession/listSessions/getSupported*/getAccountInfo/scanSkills/fetchSubagentMessages/resumeSession` Rust commands 改成 async command，將 blocking sidecar bridge 放進 `spawn_blocking`；panel mount、metadata refresh 與 session restore 不再佔住 Tauri command handler。
- 2026-05-10：降低 Tauri Claude control/worktree UI 阻塞風險。`claude.stopSession/abortSession/stopTask/getWorktreeStatus/cleanupWorktree/restSession/wakeSession/isResting` Rust commands 改成 async command，控制按鈕與 worktree action 不再因 sidecar bridge 等待佔住 Tauri command handler。
- 2026-05-10：完成 Tauri Claude sidecar bridge 背景化收斂。除測試用 `claude.ping` 外，帳號、session state、permission/model/effort setter、fork/rewind、archive/history 與 MCP commands 都改成 async command + `spawn_blocking`；Claude namespace 不再有 renderer 會直接碰到的同步 sidecar bridge。
- 2026-05-10：降低 Tauri PTY create/restart UI 阻塞風險。`pty.create` 與 `pty.restart` 會 spawn shell/ConPTY，已改成 async command + `spawn_blocking`；新增 terminal 與重啟 terminal 不再佔住 Tauri command handler，`pty.write/resize/kill/getCwd` 保持快速同步 metadata 操作。
- 2026-05-10：降低 Tauri update check UI 阻塞風險。`update.check` 會透過 sidecar 打 GitHub Releases API，已改成 async command + `spawn_blocking`，UpdateNotification 查詢不再佔住 Tauri command handler。
- 2026-05-10：降低 Tauri `settings.detectCx` UI 阻塞風險。`detectCx` 會讀 settings、查 PATH 並執行 `cx --version`，已改成 async command + `spawn_blocking`；設定頁偵測 semantic-navigation binary 不再佔住 Tauri command handler。
- 2026-05-10：降低 Tauri settings 檔案 I/O 阻塞風險。`settings.load/save/clearTerminalHistory` 已改成 async command + `spawn_blocking`；啟動讀設定、設定儲存與清 terminal history 不再佔住 Tauri command handler。
- 2026-05-10：修正 Tauri Claude 第二輪送訊息與 resume 歷史缺口。sidecar 在每個 Claude turn 完成後會關閉 LiveQuery，下一輪用已捕捉的 `sdkSessionId` 重建 `resume` query，避免第二次 prompt 卡在沒有 consumer 的 persistent stream；`claude.resumeSession/startSession` 也會載入 `.claude/projects/*.jsonl` 並 emit `claude:resume-loading` / `claude:history`，讓歷史討論回到 UI。
- 2026-05-10：降低 Tauri workspace state 檔案 I/O 阻塞風險。`workspace.load/save` 已改成 async command + `spawn_blocking`；啟動讀 `workspaces.json` 與工作區狀態儲存不再佔住 Tauri command handler，Electron/Tauri 回傳 shape 不變。
- 2026-05-10：降低 Tauri Git/GitHub panel shell-out 阻塞風險。`git.*` 與 `github.*` Rust commands 仍沿用 Electron 的 `git` / `gh` CLI 行為，但 shell-out 與 timeout polling 已移到 `spawn_blocking`；GitPanel/GitHubPanel refresh、diff、status、PR/issue 查詢不再佔住 Tauri command handler。
- 2026-05-10：降低 Tauri FolderPicker mutation UI 阻塞風險。`fs.mkdir` / `fs.deletePath` 行為仍對齊 Electron 的新資料夾與刪除資料夾流程，但 `create_dir`、`symlink_metadata`、`remove_dir_all` 已移到 `spawn_blocking`；慢磁碟或大量資料夾刪除不再佔住 Tauri command handler。
- 2026-05-10：開始把 Tauri Codex Agent 從 Claude SDK 路徑切出。sidecar 新增 `@openai/codex-sdk` backed Codex session manager，`agentPreset=codex-agent/codex-agent-worktree` 會透過既有 `claude:*` event contract 路由到 Codex SDK；Codex model 防呆避免沿用舊 Claude `claude-*` model，OpenAI Direct preset/API key 設定入口已停用。
- 2026-05-10：修正 Tauri Codex stale resume。sidecar 會用 `~/.codex/sessions/*.jsonl` 的 `session_meta.payload.id` 作為真正 Codex thread id，resume 前若找不到對應 rollout 會清掉舊 `sdkSessionId` 並 fresh start；Codex panel 收到 `sdkSessionId=null` 會同步清除 persisted terminal session id，避免舊 OpenAI/Claude id 造成 `no rollout found` 循環失敗。
- 2026-05-10：修正 Tauri Claude 首次開啟 resume history lookup。`claude.resumeSession/startSession` 仍優先讀 Electron 相容的 `<encoded cwd>/<sdkSessionId>.jsonl`，但 cwd/worktree/舊 terminal 狀態不一致時會 fallback 掃 `~/.claude/projects` 內同名 JSONL，避免首次開啟只拿到空 history；sidecar 測試新增 cwd mismatch resume 覆蓋。
- 2026-05-10：開始 Rust runtime pub-sub 中樞。Node sidecar 推來的 renderer event 現在先進 `RuntimeEventHub` 再 emit 給 renderer，`claude:*` event name/payload 保持不變；後續 Rust Codex app-server runtime 與 remote bridge 可作為 publisher 接入同一個 hub，fallback 仍藏在 renderer contract 之下。
- 2026-05-10：開始 Rust Codex app-server controller MVP。`agentPreset=codex-agent` 的 Tauri `start/resume/send/abort/stop` 會優先嘗試由 Rust 管理 persistent `codex app-server` JSON-RPC subprocess，將 `thread/*`、`turn/*`、`item/*` notifications 轉回既有 `claude:*` event contract；啟動或 request 失敗會退回 Node sidecar Codex SDK 路徑，UI 呼叫點不變。`codex-agent-worktree` 暫時留在 sidecar，避免 worktree parity 退化。
- 2026-05-10：補 Rust Codex app-server status metadata 與 UI statusline。Rust runtime 會回報 model、effort、sandbox、approval、turn count、token usage、首 token/turn duration 等 metadata；Claude/Codex/OpenAI panels 的內建 statusline 新增對應 renderer，並讓 Codex 在缺少 context window 時仍可用 input/output token fallback 顯示基本用量。
- 2026-05-10：修正舊 Codex session 永久落回 sidecar 的 routing。`agentPreset=codex-agent` 在 Rust app-server `thread/resume` 失敗時，會先打 `sidecar:metric` 記錄 stale `sdkSessionId` 與錯誤，再用 Rust app-server fresh start 新 thread；只有 fresh start 也失敗才 fallback Node sidecar，避免舊 rollout id 讓後續每輪 send 都停在 sidecar path。
- 2026-05-10：修正 Codex panel 復用舊 sidecar state 後未綁定 Rust runtime。Tauri + `codex-agent` mount 時若 `getSessionState` 讀到舊 state，現在只用來先補 UI，不再提前 return；仍會繼續 `resumeSession/startSession` 讓 Rust Codex app-server 成為 session owner，避免後續 send 因 `codex_state.is_owned=false` 落回 Node sidecar。
- 2026-05-10：修正 Rust Codex app-server sandbox protocol mapping。log 顯示 app-server 拒收 `dangerFullAccess`，實際 schema 需要 `danger-full-access` / `workspace-write` / `read-only`；已改回 kebab-case 並加 Rust regression test，避免 resume/fresh start 因 sandbox enum 失敗後 fallback Node sidecar。
- 2026-05-10：讓 Rust Codex sandbox/approval 切換可對下一輪 prompt 生效。`setCodexSandboxMode` / `setCodexApprovalPolicy` 在 Rust-owned Codex session 會更新本地 session state 後，用同一個 thread id 呼叫 app-server `thread/resume` 重送 sandbox/approval/model/cwd，避免 UI 顯示已切換但 app-server thread 仍沿用舊設定。
- 2026-05-10：調整 Tauri porting scope：OpenAI Direct / `openai-agent` 已判定為廢棄方向，不再列為 Tauri parity blocker。後續工作應移除或隱藏 OpenAI Direct 的 UI/route/setting 殘留，只保留 Codex 所需的 OpenAI/Codex auth fallback，不再實作 `OpenAIAgentManager` parity。
- 2026-05-11：把 Tauri `fs.resolvePathLinks` 從 Node sidecar 搬到 Rust native，支援 Electron 相容的 path/line/column parsing、text extension filter、absolute/relative cwd resolution 與 200 筆去重上限；Markdown path-link resolution 不再為了純檔案判斷喚醒 sidecar。
- 2026-05-10：開始 OpenAI Direct cleanup。`openai-agent` 從 renderer `AgentPresetId` 移除，`MainPanel` 不再 lazy import 或掛載 `OpenAIAgentPanel`，並刪除未被引用的 `OpenAIAgentPanel.tsx`；舊 workspace 若殘留 `openai-agent`，不會再啟動 OpenAI Direct runtime panel。
- 2026-05-10：補 OpenAI Direct 舊資料 migration。settings 載入時若 `defaultAgent=openai-agent` 會轉成 `codex-agent`；workspace 載入時若 workspace default 或 terminal preset 殘留 `openai-agent`，也會轉成 `codex-agent`，避免重開後建立無效 OpenAI Direct panel。
- 2026-05-10：補 OpenAI Direct cleanup regression test。`tests/openai-direct-cleanup.test.ts` 鎖住 `openai-agent` 不再註冊/顯示，並覆蓋 settings/workspace 舊資料 migration 到 `codex-agent`，避免後續重構把廢棄的 OpenAI Direct 入口帶回來。
- 2026-05-11：擴大 Rust Codex app-server routing 到已建立 worktree 的 `codex-agent-worktree`。若 options 內已有 `worktreePath`，Rust runtime 會使用該路徑作為 effective cwd 並 emit `claude:worktree-info`；若缺少 `worktreePath`，仍 fallback Node sidecar，保留 sidecar 自動建立 worktree 的既有行為。
- 2026-05-11：補 Rust-owned Codex worktree 的 sidecar rehydrate。`claude.startSession/resumeSession` 由 Rust app-server 接手 `codex-agent-worktree` 前，會 best-effort 呼叫 `worktree.rehydrate`，讓既有 Diff/close cleanup 等 worktree sidecar commands 在重開後仍有 activeWorktree state。
- 2026-05-11：補 Rust-owned Codex metadata read-only route。`getSupportedModels` 對 Rust-owned Codex session 直接回 Codex model list，`getSupportedCommands/getSupportedAgents/getAccountInfo` 直接回空值，避免 Codex panel metadata refresh 落到 sidecar Claude SDK 路徑而顯示 Claude models 或產生不必要的 metadata latency。
- 2026-05-11：補 Rust-owned Codex session controls。`resetSession` 會在 Rust app-server 建新 thread 並清空本地 turn/token/message state；`restSession` / `wakeSession` / `isResting` 由 Rust session state 直接處理，避免 Codex UI 控制落回 Node sidecar。
- 2026-05-11：繼續 OpenAI Direct cleanup。Tauri `host.openai.listSessions/compactNow` 保留 renderer 相容方法但改成 host-level no-op，不再註冊 Rust command 或 sidecar handler；`getApiKeyStatus/setApiKey/clearApiKey` 保留作為 Codex auth fallback。
- 2026-05-11：停用 Electron OpenAI Direct manager 初始化與 session routing。Electron main 不再建立 `OpenAIAgentManager`；server-core 遇到舊 `openai-agent` start/resume 會 normalize 到 Codex ownership，OpenAI list/compact IPC 回相容 no-op，API key handler 保留。
- 2026-05-11：移除 OpenAI Direct runtime implementation。刪除未引用的 `OpenAIAgentManager`、OpenAI tools、OpenAI session/model/compaction/skills runtime 檔案，並移除 direct dependencies `@ai-sdk/openai`、`ai`、`zod`；`electron/openai-agent/api-key.ts` 保留作為 Codex auth fallback。
- 2026-05-11：補 Rust-owned Codex read/control no-op parity。`getContextUsage`、`forkSession`、`fetchSubagentMessages`、`rewindToPrompt`、`resolvePermission`、`resolveAskUser` 對 Rust-owned Codex session 直接回 Electron Codex 相容值，不再落回 sidecar Claude-only handlers。
- 2026-05-11：補 Rust-owned Codex auto-continue / permission-mode no-op parity。`setAutoContinue`、`getAutoContinue`、`setPermissionMode` 對 Codex 直接回 Electron Codex 相容值，避免 Codex UI 控制寫進 sidecar Claude session state。
- 2026-05-11：補 Codex session listing 的 Electron/Tauri host API parity。`host.claude.listSessions(cwd, 'codex')` 在 Electron preload 不再丟掉 `agentKind`，server handler 會路由到 `CodexAgentManager.listSessions()`；Tauri host-api 測試也鎖住 `agentKind` payload，避免 Codex resume picker 讀到 Claude 歷史。
- 2026-05-11：清理 OpenAI Direct README 殘留。README 不再描述 `BAT_DEBUG` OpenAI Direct runtime、已刪除的 manager/panel，Tech Stack 也移除 `@ai-sdk/openai`；cleanup regression test 會防止這些廢棄入口重新出現在使用者文件。
- 2026-05-11：補 Rust-owned Codex setting feedback parity。Rust app-server runtime 的 model / effort / sandbox / approval 切換現在會和 Electron Codex 一樣 emit system message，並在 model/effort 變更時同步 emit status metadata；同值重設會直接回成功不插入重複訊息。
- 2026-05-11：修正 Codex `/resume` UI gate。`CodexAgentPanel` 原本已呼叫 `host.claude.listSessions(cwd, 'codex')`，但 resume list render 條件仍是 `!isCodexSession && showResumeList`，導致 Codex 歷史列表永遠不顯示；現在改為 `showResumeList` 並加 source-level regression test。
- 2026-05-11：補 agent panel auto-resume 參數完整性。Claude/Codex panel 的 saved-session auto-resume 會傳 `effectiveModel`、`permissionMode`、`effort`，Codex 也保留 sandbox/approval；這讓先前 Tauri host-api 補上的完整 resume payload 不再被 UI 呼叫端截斷。
- 2026-05-11：補手動 resume 參數完整性。Claude/Codex panel 從 resume list 選 session 時也會帶目前 model、permissionMode、effort；Codex 額外帶 sandbox/approval/worktree options，並把 renderer `console.log` 改成 `host.debug.log`。
- 2026-05-11：補 regression test scripts。新增 `pnpm run test:codex-panel` 與 `pnpm run test:openai-cleanup`，讓 Codex resume UI guard 與 OpenAI Direct cleanup guard 可被後續 milestone/CI 明確呼叫。
- 2026-05-11：補 Rust Codex resume history emit。Rust app-server `resume_session` 現在會從 `~/.codex/sessions/**/*.jsonl` 找 thread 對應 transcript，解析 user/assistant `event_msg` 並 emit `claude:history`，同時更新 Rust session message buffer；這補上先前只 resume thread 但 UI 沒歷史內容的缺口。
- 2026-05-11：補 Codex regression aggregate script。新增 `pnpm run test:codex-auto-continue` 與 `pnpm run test:codex`，一次覆蓋 stale resume fallback、Codex `/resume` UI gate/參數保留、timeout auto-continue guard，避免 Codex porting 後續只跑到部分 regression。
- 2026-05-11：收斂 agent panel renderer logging。Claude/Codex panel 的 IPC subscription debug logs 改走 `host.debug.log`，Codex tag 也從 `[Claude:*]` 修成 `[Codex:*]`；新增 `pnpm run test:renderer-logging` 防止 renderer `console.log` 回流。
- 2026-05-11：強化 Rust Codex resume history transcript lookup。`~/.codex/sessions/**/*.jsonl` 搜尋現在優先比對 `session_meta.payload.id`，只有沒有 session_meta id 的舊格式才用 path contains fallback，避免路徑誤命中 stale transcript；Rust test 已覆蓋 meta 優先行為。
- 2026-05-11：補 Tauri native drop DOM duplicate guard。Sidebar / Claude / Codex 的 DOM drop handler 在 Tauri + OS file drop 時會讓 native drop listener 負責處理，避免同一次 drop 被 DOM fallback 再處理一次並誤報「host needs to expose paths」。
- 2026-05-11：補 `worktree.merge` 實作。Electron WorktreeManager 與 Tauri sidecar handler 現在都支援保守的 merge / cherry-pick：先要求 host repo clean、切回 source branch，再合併 worktree branch；sidecar test 覆蓋實際 ephemeral git repo merge。
- 2026-05-11：補 remote profile listing 的 sidecar handler。sidecar 新增 minimal `profile.list/getActiveIds/load/loadSnapshot/activate/deactivate` default-profile surface，讓 remote server 內部 `profile:list` bridge 不再回 method-not-found；`remote.listProfiles` sidecar test 改為期待 default profile。
- 2026-05-11：補 Tauri profile metadata persistence。`profile.create/rename/update/delete/duplicate/activate/deactivate` 不再是 single-default stub，會寫入 `<app-data>/profiles/index.json`；remote token 會存到 `remote-tokens.enc.json` envelope 並於 list/get hydrate，避免 token 寫進 index。profile workspace snapshot save/load 仍沿用既有 workspace-store 路徑，待後續補 Electron ProfileManager snapshot parity。
- 2026-05-11：補 Tauri local profile snapshot persistence。local profile create 會建立 Electron v2 profile snapshot，`profile.save` 會把目前 `workspaces.json` 包成 `<app-data>/profiles/{id}.json`，`profile.load` 會讀 v1/v2 snapshot 並把第一個 window 寫回 `workspaces.json`；仍不等於完整多視窗 profile switching，因 Tauri `app.openNewInstance` 仍是 single-window MVP。
- 2026-05-11：補 sidecar remote profile snapshot bridge。sidecar `profile.list/getActiveIds/load/loadSnapshot/activate/deactivate` 會讀 `<data-dir>/profiles/index.json` 與 `{id}.json`，讓 remote server 透過 `profile:*` proxy 可取得真實 profile/snapshot；測試固定 `BAT_SIDECAR_DATA_DIR`，避免讀到開發機使用者資料。
- 2026-05-11：開始 Rust safe storage account management。新增 Rust `account_store`，用 OS credential store/keyring 保存 Claude account credential backup；Tauri `claude.accountImportCurrent/loginNew/switch/remove/markWarningShown` 不再回 sidecar stub，account index 仍寫 `<app-data>/claude-accounts.json`，Claude CLI login/status 仍借用 sidecar bundled CLI route。
- 2026-05-11：開始 Tauri Rust multi-window profile MVP。新增 Rust `WindowRegistryState` 與 `<app-data>/windows.json`，`workspace.load/save` 依目前 Tauri window label 讀寫 per-window state 並同步 profile snapshot；`app.openNewInstance(profileId)` 會讀 local profile snapshot 建立/focus Tauri windows，`getWindowId/getWindowProfile/getWindowIndex/newWindow/focusNextWindow` 不再是 single-window constants。
- 2026-05-11：補 Tauri Rust workspace 跨視窗搬移。`workspace.moveToWindow` 現在會在 Rust window registry 搬移 workspace 與其 terminals、修正 source/target active workspace/terminal、同步 windows/profile/global snapshot，並透過既有 `workspace:reload` event 把 serialized state 推回 renderer。
- 2026-05-11：補 Tauri Rust workspace detach/reattach。`workspace.detach` 會建立 transient detached webview window 並用 `?detached=<workspaceId>` 沿用既有 App detached mode；transient entry 不寫入 windows/profile snapshot，關窗或 `workspace.reattach` 會 emit 既有 `workspace:reattached`，主視窗隱藏/恢復 workspace 的 renderer 行為不需改 UI。
- 2026-05-11：補 Tauri notification 多視窗 parity。`notification.markWindowRead` 改為只標記目前 Tauri window 的 unread entries；`focusLatestUnread/focusEntry` 會聚焦目標 webview window 並 mark read，對齊 Electron notification center 行為。
- 2026-05-11：補 Tauri `system.onResume` best-effort adapter。Tauri 無 Electron `powerMonitor`，host-api 會用 visibility/focus/online 事件推估 resume，讓 App 的 remote/account refresh hook 不再完全 no-op。
- 2026-05-11：補 Tauri dock/app badge route。`app.setDockBadge` 不再是 Rust no-op，會對目前 live webview windows 呼叫 Tauri `set_badge_count`；非正數會清除 badge，不支援平台的錯誤維持 best-effort 忽略。
- 2026-05-11：補 Tauri remote profile token safe storage。profile `remoteToken` 新寫入會優先存 OS keyring，舊 `remote-tokens.enc.json` `{enc:false}` 只保留為 migration/fallback；`index.json` 仍不寫入 token。
- 2026-05-11：修正 Tauri 動態視窗白窗風險。Ctrl+N/profile window 與 workspace detach 不再在 dev 模式手動用 `External(http://127.0.0.1:5173)` 開 webview，改回 `WebviewUrl::App(...)` 交給 Tauri resolver 處理 devUrl/bundled asset 與 IPC 注入，避免新視窗缺少 Tauri bridge 後 renderer 白屏。
- 2026-05-11：補 Tauri 動態視窗 diagnostics。Rust 端會把 Ctrl+N/profile window 與 detach window 的 create/navigation/page-load/build-failed/destroyed 寫入 `logs/debug.log`；renderer 啟動時也會記錄 `location.href` 與 `windowId`，方便判斷白窗卡在 webview 載入、JS 啟動或 React render。
- 2026-05-11：修正 Tauri 動態視窗 build 卡住。實機 log 顯示 Ctrl+N 只有 `create`、沒有 `created/page-load`，代表 `WebviewWindowBuilder::build()` 在 command handler 內卡住並留下白色 webview shell；profile window 與 detached workspace window 現改由 `app.run_on_main_thread(...)` 排程建立，command 立即返回。
- 2026-05-11：補 Tauri dynamic window smoke test。新增 `pnpm run test:tauri-dynamic-window-smoke`，用 env hook 啟動真實 Tauri exe 後自動走 Ctrl+N/profile window 建立路徑，並要求 log 出現 `created` 與 `page-load Finished`，用來單獨重現/驗證白窗問題。
- 2026-05-11：收斂 Tauri remote profile token deletion。刪除 remote profile 時會同步清 OS keyring token；legacy fallback token store 也有 regression test 覆蓋 profile 移除後不殘留。
- 2026-05-11：收斂 Tauri profile window restore registry。`app.openNewInstance(profileId)` 依 profile snapshot 建立視窗前會清掉同 profile 的 stale non-detached registry entries，避免 profile 視窗關閉後再次開啟累積重複 window entry；detached entry 與其他 profile entry 會保留。
- 2026-05-11：補 Tauri `profile.load` 與 window registry 同步。profile load/fallback 不再只寫舊 `workspaces.json`，也會把 snapshot 第一個 window 載入目前 Tauri window entry，避免 workspace.load 從 registry 讀到切 profile 前的 stale workspace。
- 2026-05-11：補 Tauri `app.getLaunchProfile` CLI parity。Tauri 現在會讀 `--profile=<id>` / `--profile <id>`，讓外部以 profile 參數啟動時走與 Electron 相同的 profile selection path。
- 2026-05-11：補 Tauri window focus lifecycle。main 與 Rust 建立的新 webview window 會在 focus 時更新 `WindowRegistryState.last_active_at`，讓 `app.openNewInstance(profileId)` focus 已開啟 profile 時能選最近使用視窗，而不是只靠 workspace save 時間。
- 2026-05-11：修正 Tauri profile active semantics。`profile.activate` / `profile.load` / `app.openNewInstance` 現在會把 profile 加進 `activeProfileIds` 而不是替換整個 active list，對齊 Electron 多 profile restore 行為。
- 2026-05-11：補 Tauri profile window close lifecycle。非 detached profile window destroyed 時會檢查同 profile 是否仍有其他 live window；若沒有，會把該 profile deactivate，避免已關閉 profile 下次仍被 active restore。
- 2026-05-11：補 Tauri profile window bounds parity。Rust 建立 profile window 時會套用 snapshot bounds，window move/resize 會寫回 `WindowRegistryState` 與 profile snapshot，讓下次 restore 更接近 Electron。
- 2026-05-11：補 Rust-owned Codex context usage。Rust Codex app-server metadata 不再回 `contextWindow=0`，`claude.getContextUsage` 對 Rust-owned Codex session 會用 cached token usage 回 Electron-compatible popup shape，避免 statusline/context popup 走空值或落回 sidecar。
- 2026-05-11：把 Tauri `claude.archiveMessages/loadArchived/clearArchive` 搬到 Rust native filesystem 實作。行為保留 Electron tail paging、sessionId sanitization 與 clear idempotency，Claude/Codex 兩種 panel 的長對話 archive 不再需要 sidecar bridge。
- 2026-05-11：補 Tauri active profile restore。新增 Rust `app.restoreActiveProfiles` process-once command，啟動時會把 `activeProfileIds` 中除目前視窗 profile 外的 profile 開回來，並透過既有 `app.openNewInstance` focus/create 流程避免重複視窗。
- 2026-05-11：對齊 sidecar profile bridge 的 active profile semantics。`profile.load` / `profile.activate` 不再把 `activeProfileIds` 替換成單一 profile，而是 append 並去重，讓 remote server 透過 sidecar 查 profile list/active ids 時維持多 profile restore parity。
- 2026-05-11：接上 Tauri agent completion notifications。`claude.startSession/resumeSession` 會登記 session 的 cwd/window/profile/agentKind；Rust event hub 收到 `claude:turn-end completed` 時會寫入既有 `notification:update` store，讓 Claude/Codex 完成通知不再只是空 API。
- 2026-05-11：把 Tauri `openai.getApiKeyStatus/setApiKey/clearApiKey` 從 Node sidecar 搬到 Rust native。OpenAI Direct runtime 仍維持 retired；這三個 command 只作為 Codex auth fallback，優先 OS keyring，並保留 legacy `openai-api-key.bin`、Codex OAuth token、`OPENAI_API_KEY` status fallback；Rust Codex app-server spawn 也會把 configured key 注入 `OPENAI_API_KEY`。
- 2026-05-11：把 Tauri `agent.listPresets` 搬成 Rust native fixed capability list。New terminal preset picker 不再為了讀固定 preset id 啟動 Node sidecar，且清單明確排除 retired `openai-agent`。
- 2026-05-11：補 Tauri renderer debug log 持久化。`host.debug.log(...)` 會由 Rust 追加寫入 `<app-data>/logs/debug.log` 並保留 stderr 輸出，讓 packaged Tauri 的 Codex/Claude timing、sidecar metric 與 renderer debug 訊息可被 bug report 回收。
- 2026-05-11：把 Tauri `fs.watch/unwatch` 從 Node sidecar 搬到 Rust native `notify` watcher，保留原本 500ms debounce、原始 `dirPath` key idempotency、sensitive path guard 與 `fs:changed` event contract；FileTree/Markdown preview watch 不再喚醒 Node sidecar。
- 2026-05-11：補 Tauri `clipboard.onCopyShortcut` renderer adapter。Tauri 以 capture-phase `keydown` 模擬 Electron `app:copy-shortcut`，保留 Ctrl/Cmd+C、排除 Shift 與尊重 `defaultPrevented`，讓 WorkerPanel 等 listener-style copy shortcut 不再是 no-op。
- 2026-05-11：補 Tauri sidecar crash-loop backoff。Rust sidecar bridge 仍會在 child exit 後自動 respawn，但 30 秒內連續 3 次 spawn/exit failure 會短暫 backoff 5 秒，避免 packaged app 在壞 Node/script 狀態下每次 UI 輪詢都反覆重啟 sidecar。
- 2026-05-11：補 Tauri sidecar stderr log 持久化。Rust sidecar bridge 的 stderr reader 會把 Node sidecar stderr 追加寫入 `<app-data>/logs/sidecar.log`，同時保留既有 `sidecar:stderr` event 與 stderr tail error message，讓 packaged bug report 可同時取得 renderer debug 與 sidecar log。
- 2026-05-11：補 Tauri persisted log rotation。`debug.log` 與 `sidecar.log` 透過共用 Rust append helper 寫入，超過 5 MiB 時會輪替成 `debug.prev.log` / `sidecar.prev.log` 後再寫新內容，避免 preview 長跑或 sidecar crash spam 讓 bug-report log 無限制成長。
- 2026-05-11：補 additive `debug.openLogsFolder()` host API。Tauri 會建立並開啟 `<app-data>/logs`，Electron 開啟 userData log 位置；後續 bug-report / settings UI 可直接使用同一個 renderer contract，不需要再新增 IPC。
- 2026-05-11：把 logs folder 入口接到 Settings Advanced 的 Diagnostics 區塊。使用者可直接開啟 Tauri `debug.log` / `sidecar.log` 所在資料夾，降低 preview 回報問題時找 log 的成本。
- 2026-05-11：修正 renderer agent preset debug filter。`getVisiblePresets()` 原本讀不存在的 `window.electronAPI.debug.isDebugMode`，現在改讀實際 preload/shim contract `window.batAppAPI.debug.isDebugMode`，避免 debug-only preset/入口在 Electron/Tauri 都被錯誤隱藏；OpenAI cleanup regression 也補上此 guard。
- 2026-05-11：補 direct host call regression guard。新增 `pnpm run test:host-direct-calls`，掃描 `src/App.tsx`、`src/components`、`src/stores`，防止 renderer UI/store 重新直接呼叫 `window.batAppAPI` / `window.electronAPI` 而旁路 Tauri `host.*` adapter。
- 2026-05-11：補 Tauri `host.debug.isDebugMode` 同步判斷。Tauri host adapter 不再固定 `false`，會在 Vite dev mode、`?debug=1` / `?BAT_DEBUG=1`、或 `localStorage.BAT_DEBUG=1` 時啟用 debug-only UI；Electron 仍沿用 preload 的 `BAT_DEBUG`。
- 2026-05-11：補 renderer-used Claude host coverage guard。新增 `pnpm run test:host-claude-coverage`，掃描 UI/store 實際呼叫的 `host.claude.*`，要求 Tauri `host-api` 有明確 route，避免新增功能時落回 permissive no-op。
- 2026-05-11：補 Tauri PTY per-terminal history parity。Rust `pty.create` 現在會消費 `perTerminalHistory/historyKey`，建立 `<app-data>/terminal-history/*_history` 並設定 `HISTFILE`；zsh 會建立 `.zsh-wrapper` 並套用 `_BAT_HISTFILE`，對齊 Electron 的 terminal history 隔離行為。
- 2026-05-11：補 Tauri PTY output batching parity。Rust PTY reader 不再每個 read chunk 都直接 emit `pty:output`，改成與 Electron 一樣先即時送第一包、後續 8ms 內合併，降低大量 terminal 輸出時 renderer IPC/event churn 對 UI 的壓力。
- 2026-05-11：補 Tauri Claude/Codex event payload shape parity。`host.claude.onHistory/onResumeLoading` 現在同時接受 Claude sidecar 的 `{items/loading}` 與 Codex app-server/sidecar 的 `{payload}` shape，避免 Codex resume history 進 UI 時變成 `undefined`。
- 2026-05-11：把 Tauri `claude.accountList` 搬到 Rust native。帳號清單直接讀 Rust `account_store` 的 `<app-data>/claude-accounts.json`，不再為 Settings/Auth UI 的 account list 喚醒 Node sidecar；import/switch/remove 仍沿用同一個 Rust safe storage index。
- 2026-05-11：把 Tauri `claude.getCliPath` 搬到 Rust native。新增 Rust resolver 會優先找 bundled `node-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-*` 的 `claude` binary，再 fallback PATH / PATHEXT；建立 Claude CLI PTY 不再為查路徑喚醒 Node sidecar。
- 2026-05-11：把 Tauri `claude.scanSkills` 搬到 Rust native，並修正掃描範圍同時支援 Electron 的 `.claude/commands/*.md` 與 Tauri/新格式 `.claude/skills/**/SKILL.md` / top-level `.md`。project entries 優先於 global entries，Skills panel 不再為掃 skill/command 喚醒 sidecar。
- 2026-05-11：把 Tauri project MCP approval helpers 搬到 Rust native。`claude.checkMcpJsonStatus` 會讀 `.mcp.json`、user/project/local settings approval；`claude.enableAllProjectMcp` 會保留既有 settings key 並寫入 `enableAllProjectMcpServers=true`，Claude panel 不再為純檔案 MCP 檢查喚醒 sidecar。
- 2026-05-11：把 Tauri `claude.listSessions` 搬到 Rust native。Claude resume selector 直接讀 `~/.claude/projects/<encoded-cwd>/*.jsonl`，Codex resume selector 直接掃 `~/.codex/sessions/**/*.jsonl` 的 `session_meta` 與 prompt preview；打開歷史清單不再為純檔案掃描喚醒 Node sidecar。
- 2026-05-11：把 Tauri `claude.authStatus` 搬到 Rust native。Rust 會用既有 Claude CLI resolver 直接執行 `claude auth status` 並解析 JSON，timeout/failure 回 `null`；啟動後 auth refresh 與 account import/login verification 不再為單純 auth status 查詢喚醒 Node sidecar。
- 2026-05-16：修正 Tauri remote profile workspace hydrate。remote profile 視窗的 `workspace.load/save` 現在由 Rust 層依 window 綁定 profile 判斷是否為 remote，並把目標 `remoteProfileId` 透過 Rust remote client 轉送到 remote server；server 端新增 `workspace:load/save` Rust bridge，直接讀寫目標 local profile snapshot 的第一個 window workspace，renderer 仍維持既有 `host.workspace.*` contract。
- 2026-05-11：把 Tauri Claude `claude.getSupportedModels` 搬到 Rust native builtin list。Codex sessions 仍走 Rust Codex runtime model list；Claude panel 開 model picker 不再為固定 builtin models 啟動 sidecar 或載入 Claude SDK。
- 2026-05-11：把 Tauri `claude.authLogin/authLogout` 搬到 Rust native CLI spawn。互動登入與登出仍沿用 Claude CLI 行為與 timeout，但不再經過 Node sidecar；`accountLoginNew` 也改用同一路徑，帳號管理流程進一步脫離 sidecar stub。
- 2026-05-11：把 Tauri `claude.getAccountInfo` 搬到 Rust native auth metadata。非 Codex session 會用 `claude auth status` 的 email/subscriptionType 組成 Electron-compatible account info，避免 panel metadata refresh 為 account info 喚醒 sidecar；organization 缺值時維持 UI 既有不顯示行為。
- 2026-05-11：補 Tauri `claude.getSupportedCommands/getSupportedAgents` 的 Rust native cwd-aware path。若 Rust 已在 start/resume 記錄 session cwd，commands 會直接掃 project/global `.claude/commands/*.md`，agents 會直接掃 project/global `.claude/agents/*.md` frontmatter；缺 cwd 的舊/邊界 session 才 fallback sidecar live-query。
- 2026-05-11：補 Tauri `claude.getSessionMeta` 的 Rust native seed path。`startSession/resumeSession` 會在 Rust registry 記錄 cwd、model、permissionMode、effort、autoCompactWindow、sdkSessionId 與 Codex sandbox/approval，status line 初次載入可直接取得 Electron-compatible 19-field meta shape；live token/cost 後續仍由既有 runtime status event 更新。
- 2026-05-11：補 Rust session metadata registry 的 live status 同步。Rust event hub 收到 `claude:status` meta 後會更新同一份 session registry，讓後續 `claude.getSessionMeta` 回最新 sdkSessionId/token/turn/cost shape，而不是停留在 start/resume 初始 seed。
- 2026-05-11：補 Tauri `claude.getWorktreeStatus` 的 Rust native read path。session registry 會記錄 worktreePath/branch/original cwd，status 讀取可直接用 git 取得 diff/sourceBranch；worktree cleanup 仍委派既有 sidecar manager，但成功後會同步清掉 Rust registry 的 worktree 狀態。
- 2026-05-11：補 Tauri `claude.cleanupWorktree` 的 Rust native fast path。若 Rust registry 已有 worktreePath/branch，cleanup 會直接執行 `git worktree remove --force`、必要時刪目錄/prune、依選項刪 branch，並 emit 既有 `claude:status` / `claude:worktree-info` 事件；缺 registry 或 native cleanup 失敗才 fallback sidecar。
- 2026-05-11：補 Rust session registry 對 `claude:worktree-info` 的同步。sidecar 或 Rust Codex 發出 worktree info/null 時會更新 Rust 記錄的 cwd/worktreePath/branch/original cwd，讓後續 native `getWorktreeStatus` / `cleanupWorktree` 能接住由舊路徑 rehydrate 的 session。
- 2026-05-11：把 top-level Tauri `worktree.create/remove/status/merge/rehydrate` 搬到 Rust native。新增 Rust `WorktreeState` 保存 active worktree info，create/remove/status/merge/rehydrate 直接執行 git/fs 操作並保留 Electron-shaped result；worktree terminal 建立、關閉、狀態查詢與 merge 不再需要 Node sidecar。
- 2026-05-11：補 Tauri Claude per-session UI state 的 Rust registry。`setAutoContinue/getAutoContinue` 對已登記 session 直接讀寫 Rust 狀態，避免純 UI toggle 喚醒 sidecar；`setPermissionMode/setModel/setEffort` 成功後同步更新 Rust session metadata registry，讓 native `getSessionMeta` 不會回舊 model/effort/mode。
- 2026-05-11：把 Tauri `update.check` 搬到 Rust native HTTP。Rust 直接查 GitHub Releases latest、沿用 Electron/sidecar 的 version compare 與 `{hasUpdate,currentVersion,latestRelease}` shape，更新檢查不再為 Node fetch 喚醒 sidecar。
- 2026-05-11：補 Tauri Claude session state/resting 的 Rust registry read path。已登記 session 的 `getSessionState` / `isResting` 可直接回 Rust 快取，`sendMessage` / `restSession` / `wakeSession` 會同步 resting flag；實際 rest/wake 仍保留 sidecar 控制 live query，避免中斷/關閉 SDK stream 行為退化。
- 2026-05-11：補 Tauri Claude context usage 的 Rust registry read path。Rust event hub 已同步 `claude:status` meta，因此 `getContextUsage` 可直接用 cached token/contextWindow 算出 Electron-compatible popup shape；沒有 token 時才 fallback sidecar。
- 2026-05-11：補 Tauri preview preflight script。新增 `pnpm run verify:tauri-preview`，聚合 typecheck、compile、Rust tests、host API guards、Codex/OpenAI cleanup regression、renderer logging guard、resources 檢查與 Tauri launch smoke，作為發 preview 前的固定入口。
- 2026-05-11：補 Tauri resources regression gate。`verify:tauri-resources` 現在除了 strict missing，也會限制 resources 在 7000 files / 400 MB 內，避免 sidecar/runtime 打包體積在 preview 前無聲膨脹。
- 2026-05-11：修正 sidecar module prune 規則。`prune-node-sidecar-modules` 只刪 `@openai/codex-{platform}-{arch}` optional native package，不再誤刪 `@openai/codex` / `@openai/codex-sdk` 這類非 platform package；實測若把 `@openai/codex-sdk` 打進 packaged sidecar 會把 resources 拉到約 576 MB，暫不納入 preview bundle，Codex packaged 主路徑仍是 Rust app-server。
- 2026-05-11：補 Tauri preview preflight coverage。`verify:tauri-preview` 現在也會跑 `test:sidecar`、`test:node-resolver` 與 `test:tauri-bundle-prune`，避免 sidecar/runtime startup 或 bundle prune regression 被 preview 前檢查漏掉。
- 2026-05-11：補 Tauri preview preflight artifact freshness。`verify:tauri-preview` 會先跑 `build:tauri-sidecar` 重建 `node-sidecar/dist/server.mjs`，避免 sidecar source 已通過測試但 preview resources 仍打包舊 dist。
- 2026-05-11：修正 Tauri Ctrl+N 新視窗白畫面。`src-tauri/capabilities/default.json` 原本只授權 `main` window，動態建立的 `profile-*` / `detached-*` window 沒有 renderer IPC capability，會在初始化時被 Tauri ACL 擋掉；現在 default capability 覆蓋這些動態 window label，並加入 `test:tauri-capabilities` guard 到 preview preflight。
- 2026-05-11：補 Tauri preview release staging readiness。新增 `check-tauri-preview-readiness.mjs` 與 `verify:tauri-preview-readiness`，發 preview 前會檢查 Tauri resources 設定、`node-sidecar/dist/server.mjs`、`node-sidecar/node_modules` 與目前平台 bundled Node runtime 都已準備好，避免 source tests 綠但 packaged app 缺 release input。
- 2026-05-11：補 Tauri dynamic window dev URL。`Ctrl+N` 與 detached workspace 建立的動態 Tauri window 在 dev 模式明確載入 `http://127.0.0.1:5173/`，release 才載入 bundled `index.html`，避免動態 window 沒吃到 Vite dev server 時只顯示白畫面。
- 2026-05-11：同步 Tauri preview version metadata。`src-tauri/tauri.conf.json` 版本從舊的 `0.1.0` 對齊 `package.json` 的 `2.1.3`，並加入 `test:tauri-version-sync` 到 preview preflight，避免 Tauri artifact metadata 與 Electron/package version 漂移。
- 2026-05-11：補白畫面診斷。renderer startup log 現在會標出 host kind；Electron regular/detached window 會記錄 `did-fail-load`、renderer process gone、unresponsive 與 warning/error console message，方便確認白窗是 URL 載入、preload/renderer error，還是 renderer process crash。
- 2026-05-11：修正 release version script。`scripts/build-version.js` 發版改版號時現在會同步更新 `package.json` 與 `src-tauri/tauri.conf.json`，並加入 `test:build-version-script` 到 preview preflight，避免發 pre 版時 Tauri artifact 又回到舊 metadata。
- 2026-05-11：補強 Tauri dynamic window 白畫面回歸測試。`test:tauri-dynamic-window-smoke` 現在由主 renderer 透過 `host.app.newWindow()` 觸發，覆蓋 Ctrl+N 實際 IPC 路徑；Rust 端也將 dynamic window build 延後到 command return 後再排入 main thread，避免 renderer IPC reentrancy 造成 `WebviewWindowBuilder::build()` 卡住。
- 2026-05-11：修正 Tauri profile window label 跳號。`app.getWindowIndex` 現在只用目前 live profile windows 計算顯示序號，避免 `windows.json` 內舊的 Ctrl+N / smoke test 殘留 entry 讓第二個視窗顯示成 `Default:17`；profile snapshot 讀寫時也會忽略空 window snapshot，降低日後 restore 空視窗的風險。
- 2026-05-11：補 Tauri test profile data-dir override。新增 `BAT_TAURI_DATA_DIR`，Rust settings/workspace/profile/window registry/debug/snippet/pty/OpenAI/Claude/sidecar data dir 會一致改讀指定資料夾；`Procfile.tauri` 的 `tauri-dev` 已指到 `D:/workspaces/bat/bat-test-profile`，可用複製出的真實 settings/workspaces 測 Tauri 讀取。
- 2026-05-11：修正 Electron userData test profile 載入路徑。Tauri `main` window 若沒有既有 snapshot 或只有空 snapshot，會從 Electron `windows.json` 裡最近且有內容的 regular window seed workspace/profile snapshot，避免真實 Electron 設定只有 `windows.json`、沒有 `workspaces.json` 時看起來像沒讀到 workspaces。
- 2026-05-11：修正 Tauri active profile restore 誤開 remote profile。`restoreActiveProfiles` 現在會跳過缺 host/token/fingerprint 的 remote profile，避免 Electron test profile 的 `activeProfileIds=["bat","hyper"]` 在 Tauri 下自動開 `hyper`，又因 token 缺失 fallback 成第一個 local profile，造成兩個 `bat` 視窗。
- 2026-05-11：保護 Electron encrypted remote token store。Tauri profile index 寫入時若遇到無法解密的 Electron `remote-tokens.enc.json` (`enc:true`)，且本輪沒有新的 token 寫入，會保留原檔不覆蓋成空 `{tokens:{}}`；完整 Electron safeStorage → Rust/keyring migration 仍待補。
- 2026-05-11：補 Windows Electron safeStorage remote token migration。Tauri/Rust 現在可讀 Electron `Local State` 的 DPAPI-protected `os_crypt.encrypted_key`，再解 `remote-tokens.enc.json` 的 `v10` AES-256-GCM payload，讓 Windows 上從 Electron userData 複製過來的 remote token 可被 profile list rehydrate；macOS/Linux safeStorage migration 仍待分平台補。
- 2026-05-11：修正 Tauri `profile.listLocal` 語意。Electron 的 `profile:list-local` 是「本機 profile manager 清單」，仍包含 remote alias；Tauri 先前誤把 `type=remote` 過濾掉，導致 Profiles modal 只顯示 LOCAL。現在 Tauri `profile_list_local` 對齊 Electron，回本機 index 的全部 profile entries。
- 2026-05-11：修正 Tauri remote Claude 對話 history 路徑。remote profile 視窗的 `claude.startSession/sendMessage/stopSession/abortSession/listSessions/resumeSession` 會透過 sidecar `remote.invoke` 打回 Electron-compatible remote IPC；remote client 收到 `claude:history/resume-loading/message/status/...` event 時也會轉成 Tauri renderer 既有 `{sessionId, items/loading/...}` shape，避免舊版 remote history 到了但 UI 吃不到。
- 2026-05-11：修正 Tauri agent resume listener race。Claude/Codex panel 在 Tauri 下會等 agent event listener 完成一個短暫 settle window 後才觸發 `startSession/resumeSession`，避免 remote resume 很快 emit `claude:history` 時，history 被舊視窗 listener 看到但新 panel 尚未接上，造成啟動或 profile 重開後歷史空白。
- 2026-05-11：修正 Tauri local profile 被誤標 remote。Tauri sidecar remote client 目前是 process singleton，若另一個 remote profile 視窗已連線，單看 `remote.clientStatus.connected` 會讓 local `bat` 視窗也顯示 remote 圖示並套用 remote 限制；App 現在把 UI 用的 remote 狀態拆成「目前視窗 profile 是 remote」與「remote client connected」，local profile 不再被 singleton client 狀態污染。
- 2026-05-11：修正 agent 對話區右鍵選單。Claude/Codex 對話區右鍵不再顯示 `Close Window`，改為既有的「捲動至底部」動作；關閉 session/window 仍由 session thumbnail/外層控制負責，避免在閱讀歷史時誤關視窗。
- 2026-05-11：修正視窗 title 的 profile/auth 狀態同步。title 仍顯示 `profile:index | (account / plan) | Better Agent Terminal`，但 authStatus 無有效 email 或查詢失敗時會清掉舊帳號資料；`(Remote)` 標記改看目前 profile 類型而不是 remote client 是否 connected，避免 title 跟 profile name/remote 狀態不同步。
- 2026-05-11：修正 Tauri Settings account switching 失敗無回饋。Settings 載入帳號時會嘗試匯入/修補目前 Claude CLI 帳號到 Rust keyring；Rust `switch_account` 找不到 credential 時改回 `false` 而非 command error，UI 會顯示缺 credential、需要在 Tauri 重新加入帳號。此差異主要來自 Electron safeStorage 舊 credential 不能直接被 Rust keyring 讀取。
- 2026-05-11：補齊 Tauri Settings remote/account UI parity。Tauri 啟動時會讀 Electron-compatible `remoteServerAutoStart/Port/BindInterface` 並背景啟動 remote server；Settings 若偵測到 server 已在跑但沒有 token，會透過 `tunnel.getConnection` 補齊 token/host，讓 connection string 在 auto-start 或其他視窗啟動 server 後也能顯示；account switch/login 狀態文字改回 i18n，並在切換啟用狀態時重新載入帳號清單。
- 2026-05-11：修正 WorkerPanel Procfile log retention。Tauri/Rust `workerBuffer.init` 不再覆蓋既有 buffer，WorkerPanel mount 時會恢復同一 terminal 的 Procfile scrollback，unmount 前會 flush pending batch 且不再無條件 clear buffer；process name spotlight/highlight 行為保留，避免切換/重掛載後只剩後啟動 process 的 log。
- 2026-05-11：開始 Procfile runtime Rust 化。Tauri PTY reader 會辨識 `terminalId__w__processName` 的 Procfile worker PTY id，直接在 Rust 端把 PTY output append 到 `workerBuffer`；renderer 仍即時顯示與負責 header/exit/control 訊息，但 Tauri 下不再靠 renderer lifecycle 保存 process stdout/stderr，降低切換 UI 時掉 log 的風險。
- 2026-05-11：把 Procfile 讀取/解析接到 host workerBuffer contract。Tauri 使用 Rust `worker_procfile_load` 直接讀 Procfile 並套用 renderer-compatible parser 規則；Electron preload 提供同名 fallback。WorkerPanel 不再自行 `fs.readFile + parseProcfile`，為後續 start/stop supervisor 搬到 Rust 先收斂入口。
- 2026-05-11：把 Procfile worker start/stop 接到 Rust command。Tauri `worker_procfile_start/stop` 會建立 Procfile worker PTY、寫入 shell launch wrapper 並用 Rust workerBuffer 保存輸出；WorkerPanel 改走 `host.workerBuffer.startProcess/stopProcess`，Electron preload 保留相同行為 fallback。
- 2026-05-11：新增 Tauri pre-CI 入口。`verify:tauri-pre-ci` 會用 frozen lockfile 準備 sidecar/runtime 並跑 Tauri preview 的 type/build/Rust/sidecar/host/Codex/resources/readiness gates；`.github/workflows/tauri-pre-ci.yml` 在 PR/push/手動觸發時跑三平台 preflight，手動可加跑 debug bundle 與 smoke test。
- 2026-05-12：移除獨立 `.github/workflows/tauri-pre-ci.yml` GitHub Action。Release workflow 已在 tag build 內跑 `verify:tauri-pre-ci` 並產出正式 artifacts，獨立 pre-CI 對目前 release flow 屬重複 CI 噪音；保留 `verify:tauri-pre-ci` 腳本作為本地與 release gate。
- 2026-05-11：補 Tauri preview installer artifact path。原本手動觸發 Tauri pre-CI 時可開 `package_preview=true`，用 frozen bundle inputs 跑 `tauri build` 並上傳 Windows installer (`.exe`/`.msi`) 與 macOS `.dmg` artifacts；2026-05-12 起獨立 pre-CI workflow 已移除，preview artifacts 改由 tag release flow 產出。
- 2026-05-11：把正式 release flow 切到 Tauri。既有 tag `v*` workflow 不再跑 Electron Builder，改為三平台 `tauri build`、上傳 Tauri installer artifacts 並建立 GitHub Release；Chocolatey 會使用實際 Tauri `.exe` 檔名與 checksum 產生套件。
- 2026-05-11：接上 Tauri macOS 簽章/公證 secrets。Release workflow 會把既有 Electron `APPLE_CERTIFICATE_P12` / `APPLE_APP_SPECIFIC_PASSWORD` secrets 映射到 Tauri CLI 需要的 `APPLE_CERTIFICATE` / `APPLE_PASSWORD`，並在 macOS build 前檢查 certificate/password/team/notarization credentials。
- 2026-05-12：加速 Tauri release build。Release workflow 改成只更新版本 metadata、不在 `build-version.js` 內 compile；新增 `verify:tauri-release-ci` 避免 release preflight 重跑 frontend compile；Tauri bundle step 改用已準備好的 sidecar/runtime，不再重複 `prepare:tauri-bundle:ci`。
- 2026-05-12：修正 Windows prerelease bundle。Tauri/WiX MSI 不接受 `2.9.0-pre.N` 這類非純數字 prerelease identifier，release matrix 改為 Windows 只產 NSIS `.exe`、macOS 只產 `.dmg`、Linux 只產 `.AppImage`，同時減少不需要的 bundle 工作。
- 2026-05-12：拆分 macOS release artifacts。Release matrix 明確產出 Intel/x64 (`macos-15-intel`) 與 Apple Silicon/arm64 (`macos-14`) 兩個 DMG，避免 `macos-latest` label 漂移，也確保 bundled Node runtime 跟目標架構一致。
- 2026-05-12：修正 release bundle args 傳遞。`pnpm run <script> -- --bundles ...` 會把參數傳給 Tauri runner/cargo，導致 Linux `cargo build` 收到未知 `--bundles`；release workflow 改為直接 `pnpm exec tauri build --bundles <target>`。
- 2026-05-12：修正 Windows packaged app 子程序黑窗與安裝路徑。Tauri sidecar Node 與 Codex app-server spawn 在 Windows 下套用 `CREATE_NO_WINDOW`，避免 packaged app 啟動/重試時彈出 console；NSIS hook 會把 Tauri 預設 `%LOCALAPPDATA%\BetterAgentTerminal` 改回 Electron 既有 `%LOCALAPPDATA%\Programs\BetterAgentTerminal`，並加 regression test 鎖住設定。
- 2026-05-12：收斂 sidecar 打包結構。`dist/server.mjs` 會把 Claude SDK 與 JS dependencies bundle 成單檔，`prepare-tauri-sidecar-node-modules` 只複製目前平台的 `@anthropic-ai/claude-agent-sdk-*` native binary package 到 `dist-node_modules`，再由 Tauri resources 映射成 packaged `node-sidecar/node_modules`。Windows installer 不再需要解壓整包 sidecar `node_modules`。

## 目前判斷

Tauri 版已經超過 spike 階段，基礎 host runtime 大多有可用實作：

- Rust native commands 已涵蓋 settings、dialog、fs、PTY、workspace、git/github、snippet、notification、workerBuffer、profile / multi-window restore MVP。
- Node sidecar 已經承接 Claude session/send/history/permission、fs sidecar handlers、remote/tunnel handlers、OpenAI/Worktree 部分能力。
- Claude `sendMessage` 已走 LiveQuery 類型的 long-lived stream，metadata 也已有 process cache，已經不是每次 UI mount 都重打多個 cold SDK query 的早期狀態。

但目前仍不建議把 Tauri 版升成正式主線。主要風險不是單一功能缺失，而是三個面向還沒收斂：

1. Renderer Tauri adapter 還有實作斷線點。
2. Codex agent runtime 尚未達 Electron parity；OpenAI Direct 已不再列入 parity 目標。
3. macOS packaged bundle 仍帶 raw sidecar `node_modules` + Node runtime，啟動與資源掃描成本偏高。

## 已掃描到的缺口

### P0：Adapter 與 sidecar 斷線

這些是「能力在某層已存在，但 renderer 還不能可靠使用」的缺口，優先補。

- [x] `fs.resolvePathLinks`：sidecar handler 已有，已接上 `src/host-api.ts` Tauri adapter 與 Rust sidecar bridge。
- [x] `fs.watch / fs.unwatch / fs.onChanged`：sidecar 已有 `fs:changed` event，已接上 Tauri adapter 與 Rust event bridge。
- [x] `claude.stopTask`：Node sidecar 已有 handler，已補 Rust command 與 host-api route。
- [x] `setCodexSandboxMode` / `setCodexApprovalPolicy`：已補明確 Tauri route；完整 Codex runtime 生效仍歸 M3。
- [x] Agent panels 仍有部分直接呼叫 `window.batAppAPI`，需要統一收斂到 `host.*`，避免 Tauri shim 靜默回 no-op。

### P1：使用者會直接碰到的本機功能

- [x] `settings.clearTerminalHistory`
- [x] `image.saveDataUrl`
- [x] `clipboard.saveImage / clipboard.writeImage`
- [x] `pty.restart / pty.getCwd`
- [x] Tauri native drag/drop folder path resolver。Electron 的 `shell.getPathForFile(File)` 在 Tauri WebView 沒等價 API，需要改用 Tauri drag/drop event 或自訂 resolver。

### P2：macOS 啟動與送訊息延遲

目前 `src-tauri/tauri.conf.json` bundle resources 已收斂為：

- `../node-sidecar/dist/server.mjs`
- `../node-sidecar/package.json`
- `../node-sidecar/dist-node_modules/`（目前只保留 platform native Claude binary package，映射到 packaged `node-sidecar/node_modules/`）
- `../node-sidecar/runtime/`

platform native Claude binary 與 Node runtime 仍是體積主體。要把 Tauri 變成可發佈 preview，這一段需要持續瘦身並量測 packaged resources。

### P3：Agent parity

- Claude：基礎 session/send/event 已可用，但需要完整驗證 resume、permission、stopTask、worktree info、archive/history、rate-limit event 與 Electron 行為一致。
- Codex：Electron 版有完整 `CodexAgentManager`，Tauri sidecar 尚未等價搬完。這是正式切換前最大的 blocker。
- OpenAI Direct / `openai-agent`：廢棄，不再追 Electron parity。待辦改為移除或隱藏 UI/route/setting 殘留，避免使用者誤以為仍是支援中的 agent；Codex auth fallback 可保留。

### P4：多視窗、profile、remote

- Workspace moveToWindow / detach / reattach 已有 Tauri Rust MVP；仍需實機驗證關窗、profile restore 與 packaged window lifecycle。
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
- [x] 補 Tauri drag/drop folder path resolver。

驗收：

- `pnpm exec tsc --noEmit --pretty false`
- `pnpm run compile`
- `pnpm run test:sidecar`
- `pnpm run check:tauri-rust`
- 手動測：FolderPicker、FileTree watch refresh、image save/copy、terminal restart、Claude stop task。

### M2：macOS performance 與 bundle 瘦身

目標：處理目前 mac 啟動慢、第一次 folder picker 慢、首次送訊息慢。

- [x] sidecar JS bundle 成單檔，減少 resources 小檔數。
- [x] `node_modules` 做 platform prune，只保留目前平台必要套件與 native binary。
- [x] Node runtime 只打包目前平台與 arch，不跨平台全帶。
- [x] sidecar lazy warm-up：renderer first paint 後再啟動，不阻塞主畫面。
- [x] auth/model/account metadata 改成背景刷新，UI 先顯示可互動狀態。
- [x] 加性能 marker：app ready、renderer first paint、sidecar spawn、SDK init、FolderPicker first list、first sendMessage start/end。
- [x] packaged app resources 小檔數與大小有 CI/腳本可檢查。

驗收：

- mac cold launch 到可互動目標：小於 2 秒。
- FolderPicker 首次顯示目前目錄目標：小於 500ms。
- sidecar cold spawn 有明確 log，能分辨 Node 啟動、SDK import、CLI subprocess 哪段慢。
- `pnpm run verify:tauri-resources` 可量測 resources 小檔數與大小，並可加 `-- --max-files=N --max-mb=N` 作為門檻。

### M3：Agent runtime parity

目標：Agent workflows 足以替代 Electron preview。

- Claude parity：resume、fork、rewind、permission/ask-user、stopTask、archive/history、rate-limit、worktree info。
- Codex parity：以 Rust Codex app-server runtime 為主，保留 sidecar fallback；補齊 start/send/abort/resume、history、statusline、sandbox/approval/model/effort、worktree 與 stale resume 行為。
- OpenAI Direct cleanup：移除或隱藏 `openai-agent` preset、OpenAI Direct panel 入口、OpenAI Direct runtime route 與不再使用的 compact/session UI；不再搬移 `OpenAIAgentManager`。
- Worktree parity：create/remove/status/rehydrate 與 Codex/Claude session 狀態整合。
- Account management：account switch/remove/import 不再是 stub。

驗收：

- Claude、Codex 兩種保留 agent 都能 start/send/abort/resume。
- Codex sandbox/approval/model/effort 切換後行為與 Electron 一致。
- stop task 在 Claude/Codex UI 上不會變成無效按鈕。

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
- Claude/Codex 基本流程在 packaged app 可用；OpenAI Direct 入口不應再出現在可用 agent 清單。
- Electron 與 Tauri 的 user data migration 路徑明確。

## 建議切換門檻

不建議現在把 Electron 主線切到 Tauri。

建議策略：

- M1 完成後：Tauri 可作為 internal preview。
- M2 完成後：Tauri 可開始給少量 mac 使用者測啟動與日常操作。
- M3 完成後：Tauri 才適合當 public preview。
- M4 完成後：再評估是否正式取代 Electron。

若多視窗/profile/remote 是正式版必備，則 P4 也必須進入切換門檻；否則 Tauri 只能標成 single-window preview。
