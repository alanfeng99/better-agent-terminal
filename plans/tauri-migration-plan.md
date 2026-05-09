# Tauri 遷移短中長期計劃

## 進度紀錄（持續更新）

最近一次更新：2026-05-09 (#36)。（同上 + **新 #36 — claude.restSession / wakeSession / isResting + claude:status full meta hotfix**：(A) **status hotfix**：使用者反映 `ClaudeAgentPanel.tsx` 的 status line 在第一輪對話結束後仍 crash 在 `inputTokens.toLocaleString`。Root cause #35 只修了 `getSessionMeta` RPC reply，但 renderer 的 `setSessionMeta` 主要是被 `claude:status` event 觸發，而 status 事件在 sidecar 兩處（`rewindToPrompt` + `system:init` 進來時）emit 的是 4 個 sparse 欄位的 meta，覆寫掉之前的完整 shape → renderer 拿到 `{sdkSessionId,cwd,model,permissionMode}` 沒 inputTokens → crash。修法：抽出 `buildSessionMeta(session)` helper，`getSessionMeta` RPC + 兩個 status emit 全部走它，render 永遠拿到 19-key 完整 shape；測試加 status event 的 19-key + 13-numeric 鎖（跟 RPC reply 同一份契約），任何未來 sparse status 立刻紅。(B) **rest/wake/isResting**：sidecar port `electron/claude-agent-manager.ts:2481+` — 三條面板 lifecycle ops 從 permissive null fallback 拉出顯式 route。`restSession`：abort 任何 in-flight query、清 streaming flag、emit 一條 `claude:message{role:'system', content:'Session is resting...'}` 給 panel 顯示「tap to wake」hint、把 `session.isResting=true`。`wakeSession`：把 flag 翻回 false。`isResting`：return `session?.isResting === true`。`sendMessage` 在進入點補 line 581-582 的 auto-wake — 任何 incoming user input 都會把 `isResting` 翻回 false。session record 加 `isResting: false` 預設。新 Tauri commands `claude_rest_session/wake_session/is_resting` + adapter `host.claude.{restSession,wakeSession,isResting}`。**Test**（in-process）：(a) 把 session pre-flag 成 streaming + 塞 abortController，call restSession、斷言 `isResting=true`、`streaming=false`、`abortController=null`、`ac.signal.aborted=true`、emit 1 條 system message 含 'resting' 字樣；(b) wakeSession 翻 false、isResting 跟著 false；(c) 再 set isResting=true、call sendMessage、斷言 sendMessage 一進場就把 isResting 翻 false（auto-wake contract）；(d) defensive — missing/unknown sessionId 在三條都回 false 不 throw。仍綠：sidecar (新增 ~40 條斷言 — rest/wake + status meta 雙鎖) / host-api / cargo 112 / tsc。**結果**：使用者 `pnpm tauri:dev` 點開 ClaudeAgentPanel 第一輪對話結束後 status line tokens/turns/duration 不再 crash；rest/wake UX 正常運作。剩下：(1) `claude.stopTask` 需要 streaming-input mode、(2) `archiveMessages` / `loadArchived` / `clearArchive`（壓縮對話歷史）、(3) multi-account safeStorage 替代、(4) MCP tools list categories、(5) sidecar log persisted to file。）

歷史紀錄(本次合併進 #36)：~~2026-05-09 (#36 first cut — rest/wake/isResting only)~~。：sidecar port `electron/claude-agent-manager.ts:2481+` — 三條面板 lifecycle ops 從 permissive null fallback 拉出顯式 route。`restSession`：abort 任何 in-flight query、清 streaming flag、emit 一條 `claude:message{role:'system', content:'Session is resting...'}` 給 panel 顯示「tap to wake」hint、把 `session.isResting=true`。`wakeSession`：把 flag 翻回 false。`isResting`：return `session?.isResting === true`。`sendMessage` 在進入點補 line 581-582 的 auto-wake — 任何 incoming user input 都會把 `isResting` 翻回 false（user 都打字了，當然不算 resting）。session record 加 `isResting: false` 預設。新 Tauri commands `claude_rest_session/wake_session/is_resting` + adapter `host.claude.{restSession,wakeSession,isResting}`。**Test**（in-process）：(a) 把 session pre-flag 成 streaming + 塞 abortController，call restSession、斷言 `isResting=true`、`streaming=false`、`abortController=null`、`ac.signal.aborted=true`、emit 1 條 system message 含 'resting' 字樣；(b) wakeSession 翻 false、isResting 跟著 false；(c) 再 set isResting=true、call sendMessage、斷言 sendMessage 一進場就把 isResting 翻 false（auto-wake contract）；(d) defensive — missing/unknown sessionId 在三條都回 false 不 throw。仍綠：sidecar (新增 ~12 條斷言) / host-api / cargo 112 / tsc。**結果**：使用者可以在 Tauri release 把 Claude session 「放著休息」，下次回來打字自動喚醒，跟 Electron 行為一致。剩下：(1) `claude.stopTask` 需要 streaming-input mode、(2) `archiveMessages` / `loadArchived` / `clearArchive`（壓縮對話歷史）、(3) multi-account safeStorage 替代、(4) MCP tools list categories、(5) sidecar log persisted to file。）

歷史紀錄：2026-05-09 (#35)。（同上 + **新 #35 — claude.fetchSubagentMessages + getSessionMeta full shape + onReload blank-screen hotfix**：(A) **fetchSubagentMessages**：sidecar port `electron/claude-agent-manager.ts:2558` — call `sdk.getSubagentMessages(sdkSessionId, agentToolUseId, {dir: cwd})` 拿 SDK 寫的 subagent transcript shard，normalise 成 `(ClaudeMessage|ClaudeToolCall)[]`。tool_result 訊息 fold 回對應的 tool_use entry（`status:'completed'|'error'`、result 截 2000 字），noise 訊息（empty / `[Request interrupted...]` / `<local-command-caveat>` 開頭）丟掉，每個 item 都 stamp `parentToolUseId` = agent。任何錯誤路徑（missing params / unknown sessionId / no sdkSessionId / SDK throw / 無 helper）graceful 回 `[]` — renderer 行為跟 Electron 一致。新 Tauri command `claude_fetch_subagent_messages(sessionId, agentToolUseId)` 30s timeout（cold SDK load + slow disk safe margin）+ adapter `host.claude.fetchSubagentMessages`。**Test**（in-process via fake SDK）：(1) happy path — 4-msg synthetic（user kickoff + assistant text+thinking+tool_use Bash + user tool_result success + noise + assistant final）→ 4 items（noise 被丟）、tool_use 的 status 升級 completed、result 從 tool_result 折回；(2) is_error:true 路徑 → status:'error'、result text 進去；(3) 5 條 defensive：missing sessionId / missing agentToolUseId / unknown sessionId / no sdkSessionId / SDK throw / SDK without helper → 都回 `[]`、不 throw。(B) **getSessionMeta full shape**：使用者開 dev 後 `ClaudeAgentPanel` line 4430 直接 `sessionMeta.inputTokens.toLocaleString()`（沒 optional chaining），sidecar 之前只回 4 個欄位（permissionMode/model/effort/autoCompactWindow），導致 panel mount 即崩。本 slice 把 getSessionMeta 擴成完整 SessionMetadata 鏡射 `electron/claude-agent-manager.ts:181`：19 個欄位（permissionMode/model/effort/autoCompactWindow/sdkSessionId/cwd/totalCost/inputTokens/outputTokens/durationMs/numTurns/contextWindow/maxOutputTokens/contextTokens/cacheReadTokens/cacheCreationTokens/callCacheRead/callCacheWrite/lastQueryCalls），數值欄位 default 0、字串/可選 default null。tokens 從 `s.lastUsage`（snake_case）翻譯到 camelCase shape，contextWindow 透 `expectedContextWindowForModel` 算。**Test**：sidecar test 加 19-key existence + 13 個數值欄位 typeof === 'number' 的 lock，確保任何欄位漏掉立刻紅。(C) **onReload blank-screen hotfix**（先單獨 commit `d2b28c5`）：renderer dev 一啟動就空白，root cause 是 `host.workspace.onReload` 在 createTauriHost 缺實作 → workspace-store init 階段 throw → 整個 React tree 被 React 錯誤邊界吃掉、splash rAF 移除後就空白。補 no-op unsub（單視窗無 cross-window/remote sync），同時把 `fs.{watch,unwatch,onChanged}` / `clipboard.onCopyShortcut` 從 `notImplemented()` throw 改成 listener-style no-op，避免 FileTree/MarkdownPreviewPanel/WorkerPanel mount 連鎖崩。仍綠：sidecar (新增 fetchSubagent + meta shape lock 約 30 條斷言) / host-api / cargo 112 / tsc。**結果**：使用者 `pnpm tauri:dev` 不再空白、ClaudeAgentPanel status line tokens/turns/duration/contextPct 全顯示 0 而非 NaN/crash、Agent/Task subagent 卡片展開可拿到 per-message 流。剩下：(1) `claude.stopTask` 需要 streaming-input mode、(2) `archiveMessages` / `loadArchived` / `clearArchive`、(3) `restSession` / `wakeSession` / `isResting` 等 lifecycle、(4) multi-account safeStorage 替代、(5) MCP tools list categories、(6) sidecar log persisted to file。）

歷史紀錄：2026-05-09 (#34)。（同上 + **新 #34 — claude.forkSession**：sidecar port `electron/claude-agent-manager.ts:2733` 的 fork 邏輯 — 把當前 SDK 對話 transcript 完整複製出一個新的 sdkSessionId，讓 renderer 可以從某個歷史對話分支出去而不丟掉原 thread。實作走 SDK 的 `forkSession: true` query option：spawn 一個 one-turn query（`prompt:' '`、`resume: currentSdkId`、`forkSession: true`、`maxTurns: 1`），等 `system:init` 噴出新的 `session_id` 撈起來，**繼續等到 `result` 訊息再 break** — CLI 是在 result 訊息之後才把 forked transcript 落盤成 `<newId>.jsonl`，太早 break 會拿到 unresumable id。60 秒 safety timeout（FORK_TIMEOUT_MS）阻止 runaway fork hang 死整個 session。fork 不 mutate 原 session record 的 sdkSessionId — renderer 那邊會自己創一個新 session entry 用回傳的 newSdkSessionId 當入口。新 Tauri command `claude_fork_session(sessionId)` 用 90 秒 timeout（內 60+slack）+ adapter `host.claude.forkSession`。**Test**（in-process via fake SDK）：(a) 注 fake SDK 噴 `system:init{session_id:'forked-sdk-id'}` + `result`、call forkSession、斷言 `reply.result.newSdkSessionId === 'forked-sdk-id'`、原 session.sdkSessionId 不變、captured queryOptions 帶 `forkSession:true`/`resume:<orig>`/`maxTurns:1`/`abortController`/`prompt:' '`/`cwd`；(b) missing sessionId → null；(c) unknown sessionId → null；(d) 沒 sdkSessionId 的 session（startSession 後沒實打過 query）→ null；(e) 噴 result 但**沒先噴 system:init** → null（鎖住「捕捉不到新 id 就拒絕回 fork id」）。仍綠：sidecar / host-api / cargo 112 / Tauri release build 重產 / launch smoke。**結果**：使用者在 Tauri release 點 ChatHistoryItem 的 fork 按鈕時，sidecar 真的複製出 forked SDK transcript、回新 id、renderer 開新 panel 從那個分支點 sendMessage 不影響原 thread — UX 與 Electron 對齊。剩下：(1) `claude.stopTask` / `fetchSubagentMessages` / `archiveMessages` 等進階面板 UX、(2) streaming-input mode mid-stream control（mid-turn interrupt/setPermissionMode/setModel）、(3) multi-account safeStorage 替代、(4) MCP tools list categories、(5) sidecar log persisted to file under app_data_dir。）

歷史紀錄：2026-05-09 (#33)。（同上 + **新 #33 — claude.rewindToPrompt**：sidecar port `electron/claude-agent-manager.ts:2647` 的 rewind 邏輯 — 切 SDK transcript JSONL 到指定 user-prompt index、寫一個新的 transcript 檔到新的 sdkSessionId、把 in-memory session record 的 sdkSessionId 換掉、emit `claude:status` 通知 renderer metadata 變了。流程是純 fs+JSON 操作（沒打 SDK 也沒打網路）：(1) 找 `<projectsDir>/<encode(cwd)>/<currentSdkId>.jsonl`，cwd 用 `[^a-zA-Z0-9]` → `-` 編碼跟 Claude CLI 對齊；(2) walk lines 找第 N 個有 text 的 user prompt（注意 tool_result 雖然 type='user' 但不算）；(3) randomUUID 出新 sdkSessionId、把 keptLines 內所有 sessionId 欄位 rewrite 到新 id、寫到新 .jsonl；(4) abort 任何 in-flight query、`session.sdkSessionId = newSdkSessionId`；(5) 回 `{newSdkSessionId, removedPromptCount}` 配 renderer 的 SaveAndRetry UX。Test-only override `__setProjectsDirOverrideForTests(path)` 讓測試把 `~/.claude/projects` 換成 mkdtemp，rewind 不會碰使用者真實 history。新 Tauri command `claude_rewind_to_prompt(sessionId, promptIndex)` + adapter `host.claude.rewindToPrompt`。**Test**（in-process via tmp transcript）：合成 7 行 transcript（3 個 text user prompt + 1 個 tool_result user prompt + 3 個 assistant），call rewindToPrompt(promptIndex=1) → 斷言 (a) `removedPromptCount=4`、(b) 新 .jsonl 寫進磁碟且只有 3 行、(c) 每行的 sessionId 都被 rewrite 到新 id、(d) `mod.sessions.get('rw-1').sdkSessionId === newSdkSessionId`、(e) tool_result user 訊息不算 prompt（如果算成第 1 個 prompt cutoff 會跑到第 3 行而不是第 4 行）；另加 5 條 error path：promptIndex 超過範圍、streaming 中拒絕、missing sessionId、negative promptIndex、unknown sessionId。仍綠：sidecar / host-api / cargo 112 / Tauri release build / launch smoke。**結果**：使用者在 Tauri release 點某個 user prompt 的 retry/rewind 按鈕時，sidecar 真的把 transcript 切到該 prompt 之前、產生新 sdk session id、下一輪 sendMessage `resume:` 拿新 id 從那個切點繼續對話 — UX 與 Electron 對齊。剩下：(1) `claude.forkSession`（要打 SDK + 等 result，較重）、(2) `claude.stopTask` / `fetchSubagentMessages` / `archiveMessages` 等進階面板 UX、(3) streaming-input mode mid-stream control、(4) multi-account safeStorage 替代、(5) MCP tools list categories、(6) sidecar log persisted to file under app_data_dir。）

歷史紀錄：2026-05-09 (#32)。（同上 + **新 #32 — claude.resumeSession**：sidecar 之前沒實作 `claude.resumeSession`，所以 renderer 在 ClaudeAgentPanel mount 時若有 `savedSdkSessionId` 走 resume 路徑，permissive proxy 會回 null/`Promise.resolve(null)`、session 不會接上歷史 SDK id、下一輪 sendMessage 會開全新對話。本 slice port 的 `claude.resumeSession(sessionId, sdkSessionId, options)` 鏡射 `electron/claude-agent-manager.ts:2461`：(1) abort 任何 in-flight query、(2) 砍掉舊的 session record、(3) `ensureSession()` 重建並把 `sdkSessionId` pre-populate 到新 record、(4) 把 cwd/model/effort/permissionMode/autoCompactWindow 從 options 收進 session state、(5) `permissionMode` 預設 `bypassPermissions`（鏡射 Electron — resumed 對話不再 re-prompt 已批准過的 tool）但 options.permissionMode 可覆寫。`startSession` 也補一條：若 options.sdkSessionId 有給就直接寫進 session record，下次 sendMessage 自然帶 `resume:`。新 Tauri command `claude_resume_session` + adapter `host.claude.resumeSession(sessionId, sdkSessionId, cwd, model?, apiVersion?, useWorktree?, worktreePath?, worktreeBranch?, agentPreset?)` 把 9 個參數打包成 options。**Test**（in-process via fake SDK）：(a) call resumeSession、斷言 reply.ok + sdkSessionId echo、session.permissionMode='bypassPermissions'、session.sdkSessionId/model 都對；(b) 接著 sendMessage、斷言 queryOptions.resume 等於 historic SDK id（鎖死「resume → 下次 query 帶 resume:」契約）；(c) missing sdkSessionId / sessionId 各回 missing 錯誤；(d) options.permissionMode='plan' 覆寫 session 預設。仍綠：sidecar / host-api / cargo 112 / Tauri release build 重產 / launch smoke。**結果**：使用者在 Tauri release 重啟 app 後，舊 session 從 history 點開能正確接到 SDK conversation context、下一輪 sendMessage 不會丟掉前文。剩下：(1) `claude.forkSession` / `rewindToPrompt`（rewind 進階 UX）、(2) streaming-input mode mid-stream control、(3) multi-account safeStorage 替代、(4) MCP tools list categories、(5) sidecar log persisted to file under app_data_dir。）

歷史紀錄：2026-05-09 (#31)。（同上 + **新 #31 — sidecar stderr tail capture + emit**：先前 sidecar 的 `child.stderr` 在 Rust 端是 `Stdio::piped()` 但**從來沒人讀** — 後果有兩個：(1) OS pipe buffer 滿了會反壓住 Node 進程，(2) sidecar 真的 die 時使用者只看到一句 `sidecar: child exited`，看不到 Node 的真正錯誤訊息（例如 `Cannot find module '@anthropic-ai/claude-agent-sdk'`、parse error、import 失敗等）。Slice #30 那個 verbatim-path bug 之所以難 debug 就是因為 stderr 沒人接、Node 又 silently exit(0)。本 slice 補完 stderr pipeline：spawn 後另起一條 reader thread 讀 child.stderr line-by-line，把每一行 push 到 `Arc<Mutex<VecDeque<String>>>` 的 ring buffer（cap 100 行），同時 emit `sidecar:stderr` event 給 renderer / DevTools 即時看。當 stdout reader 偵測到 child exit（stdout pipe close）時，用 `snapshot_stderr_tail()` 把 ring buffer join 成多行字串，塞進 pending caller 的 error message：`sidecar: child exited; stderr tail:\n<...>`。STDERR_TAIL_LIMIT=100 行夠抓 Node 啟動 trace，又不會無上限佔記憶體。**Test**：cargo `end_to_end_stderr_tail_surfaces_in_child_exited_error` — mkdtemp 寫一個 `crash.mjs`（`process.stderr.write('SYNTHETIC_STDERR_LINE_FOR_TEST\n'); process.exit(1)`），用真 Node spawn 後 call `ping`、斷言 error message 同時包含 `'SYNTHETIC_STDERR_LINE_FOR_TEST'` 與 `'child exited'` — 鎖死「stderr → user-facing error message」這條診斷契約，未來再有 spawn 失敗一定看得到 Node 自己噴的 trace。仍綠：sidecar / host-api / cargo 112 / Tauri release build 重產 / launch smoke。**結果**：Tauri release 將來只要 sidecar 啟動失敗，使用者直接看到 Node 報的 module/syntax/import 錯誤，不必再像 #30 那樣靠手動 PowerShell spawn 才推得出根因。剩下：(1) custom subagents `agents` option、(2) streaming-input mode mid-stream control、(3) multi-account safeStorage 替代、(4) MCP tools list categories、(5) sidecar log persisted to file under app_data_dir 給 release reproduction。）

歷史紀錄：2026-05-09 (#30)。（同上 + **新 #30 — canUseTool round-trip + Windows verbatim-path spawn fix**：(A) **canUseTool callback**：sidecar 在 `sendMessage` 的 queryOptions 加 `canUseTool` callback，鏡射 `electron/claude-agent-manager.ts:745` 的 permission flow。`canUseTool` 依 session.permissionMode 分流：(1) `AskUserQuestion` 永遠 emit `claude:ask-user` event 等使用者回答；(2) `bypassPlan` auto-allow 全部，但 `ExitPlanMode` 要 prompt（按 allow 自動切到 `bypassPermissions` 並 emit `claude:modeChange`）；(3) `bypassPermissions` 同步 auto-allow 全部、不 emit UI；(4) `acceptEdits` auto-allow `Write/Edit/NotebookEdit/Read/Glob/Grep`、其他工具仍 prompt；(5) `default` / 落非 auto-approval 的工具 emit `claude:permission-request` 等使用者裁示。`ExitPlanMode` 加另一條切換邏輯：`dontAskAgain` → `acceptEdits`、否則 `default`。session record 加 `pendingPermissions / pendingAskUser` 兩個 Map 存 toolUseId→resolve fn。新 handler `claude.resolvePermission(sessionId, toolUseId, result)` / `claude.resolveAskUser(sessionId, toolUseId, answers)` 對應 renderer 的 Allow/Deny / 答題 click。Resolve 後 emit `claude:permission-resolved` / `claude:ask-user-resolved` notification 讓其他 panel 清狀態。Tauri 加 `claude_resolve_permission` / `claude_resolve_ask_user` commands、host-api adapter 加 `resolvePermission` / `resolveAskUser` invoke + 4 個新事件 listener (`onPermissionRequest`/`onAskUser`/`onPermissionResolved`/`onAskUserResolved`，payload key 分別 `data` / `data` / `toolUseId` / `toolUseId`)。**Test**（in-process via fake SDK 攔 canUseTool）：(1) Bash round-trip — fake SDK 接住 canUseTool ref、test trigger `Bash` request、斷言 emit `claude:permission-request`、call `claude.resolvePermission` 之後 SDK promise 拿到 `{behavior:'allow', updatedInput:{command:'ls'}}`、emit `claude:permission-resolved`；(2) `bypassPermissions` mode — `Bash` 同步回 allow、無 UI event；(3) `acceptEdits` — `Edit` 自動 allow、`Bash` 仍 prompt；(4) `AskUserQuestion` — emit `claude:ask-user` data 含 questions、`claude.resolveAskUser` 把 `{q1:'option-A'}` 帶回 SDK promise、emit ask-user-resolved。(B) **Windows `\\?\` verbatim-path bug**：使用者測試 release exe 撞到 `Win32 ERROR_NO_DATA (232) 0x800700E8` — Tauri 的 `app.path().resource_dir()` 在 Windows 回 `\\?\C:\...` (extended-length / verbatim) prefix 路徑，`spawn_sidecar` 把它當 script_path 傳給 bundled Node，**Node 啟動但 sidecar 的 `isMain` 自我偵測掛掉**：原 code `new URL(`file://${argv[1].replace(/\\/g,'/')}`).href === import.meta.url` 在 verbatim path 下變 `file:////?/C:/...` vs `file:///C:/...`，never matches，導致 main() 不跑、process.exit(0) 立刻退場、Rust 那邊看到 stdin pipe close 噴 232。修法：把 isMain 改成正規化兩端 fs path 比對，新 helper `__normalizeMainPath()` 在 Windows 平台 strip `\\?\` prefix + lowercase（NTFS case-insensitive）+ 統一斜線方向，匯出給 test。**Regression test**：用 fake `\\?\C:\foo\BAR\server.mjs` 與 `C:\foo\BAR\server.mjs` 跑 normalize 後 `assert.equal`，再加 case-insensitive 與 empty/null edge cases。**手動驗證**：直接用 PowerShell `Process.Start` 用 `\\?\` script path spawn bundled Node + sidecar，修前 exit code 0 / 無 output → 修後拿到 `{"jsonrpc":"2.0","id":1,"result":{"ok":true,"echo":...,"pid":...}}` 正常 ping reply。仍綠：sidecar / host-api / cargo 111 / Tauri release build 重產 / launch smoke。**結果**：使用者裝 MSI/NSIS 開 Tauri release 第一次按 Claude tool（Bash/Edit 等）會看到正常的 permission dialog；canUseTool round-trip 跨 Rust↔sidecar 走得通；Windows release 不再因 verbatim path 在啟動時靜默 die。剩下：(1) custom subagents `agents` option、(2) streaming-input mode mid-stream control、(3) multi-account safeStorage 替代、(4) MCP tools list categories。）

歷史紀錄：2026-05-09 (#29)。（同上 + **新 #29 — installed plugins → queryOptions.plugins**：sidecar 加 `loadInstalledPlugins()` 鏡射 `electron/claude-agent-manager.ts:828` 的邏輯：read `~/.claude/plugins/installed_plugins.json` (`{plugins: { <bucket>: [{ installPath, ... }] }}` shape，每個 bucket 是個 array)，flatten 出所有 `installPath` 字串、轉成 `[{type:'local', path}]` 餵給 SDK 的 `queryOptions.plugins`。`sendMessage` 在 install plugin 不存在/parse 失敗時 graceful 跳過（跟 Electron 一樣 `installedPlugins.length > 0 ? {plugins} : {}` 條件 spread，不在 queryOptions 裡放空陣列）。新加 test-only override hook `__setPluginsPathOverrideForTests(path)` 讓測試端 mkdtemp 寫 fixture json 不打到使用者真實 `~/.claude`。**Test**（in-process via fake SDK + tmp file）：(1) missing file → `[]`、(2) malformed JSON → `[]`、(3) good json with 3 valid + 3 malformed entries（無 installPath / 字串 / null）→ 拿到 3 個 plugins，都 `type:'local'`、(4) sendMessage 真的把 plugins 串到 queryOptions、(5) 切換到 missing path 後第二輪 sendMessage 的 queryOptions.plugins 必須是 `undefined`（鎖住 conditional spread 的契約）。仍綠：sidecar / host-api / cargo 111。**結果**：使用者透過 Claude CLI 安裝過的 plugin（如 official、community plugins）在 Tauri release 下會被自動 load，跟 Electron 行為一致。剩下：(1) `canUseTool` 權限 callback round-trip（`default` mode 的 tool-use prompt UI）、(2) custom subagents `agents` option、(3) streaming-input mode mid-stream control、(4) multi-account safeStorage 替代。）

歷史紀錄：2026-05-09 (#28)。（同上 + **新 #28 — sidecar sendMessage queryOptions parity with Electron**：sidecar 之前送進 `sdk.query` 的 options 只有 `cwd / model / permissionMode / resume / abortController` — 不夠 Electron 起 Claude Code session 用，缺了 `systemPrompt:{type:'preset',preset:'claude_code'}` + `tools:{type:'preset',preset:'claude_code'}` 兩個 preset 的話 SDK 跑出來是純 Anthropic chat、**沒有 Bash/Read/Edit/Glob/Grep 等 built-in tools**，等同把 Tauri 版降級成 Anthropic console。本 slice 把 queryOptions 一次補齊到跟 `electron/claude-agent-manager.ts:856` 同步：(a) `systemPrompt` + `tools` claude_code preset、(b) `includePartialMessages: true`（partial assistant streaming 開關）、(c) `promptSuggestions: true`、(d) `settingSources: ['user','project','local']`（讓 SDK 讀 `~/.claude/settings.json` + `.claude/settings.json` + `.claude/settings.local.json`）、(e) `agentProgressSummaries: true`、(f) `toolConfig: { askUserQuestion: { previewFormat: 'html' } }`、(g) `effort` 從 session state 透傳、(h) `permissionMode` 多了 `bypassPlan→plan` 映射（SDK 不認 `bypassPlan`）、(i) `bypassPermissions` 同時設 `allowDangerouslySkipPermissions: true`、(j) `pathToClaudeCodeExecutable` 用既有 `resolveClaudeCliBinary()` 抓 sidecar bundle 內的 Claude CLI（release 不依賴 system claude）、(k) `model` 透 sidecar mirror `sdkModelForClaudeSelection()` 把 4 個 auto-compact preset id 轉回 base `claude-opus-4-7`、(l) `autoCompactWindow` 透 `queryOptions.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` 注入給 spawn 的 claude binary、(m) `resume + continue:true` 當 sdkSessionId 存在 + prompt 為空時，鏡射 Electron 的「resume context but process new input vs. continue autonomous」分支、(n) **images 支援**：把 `params.images` (`data:image/...;base64,...` 陣列) 透 `dataUrlToContentBlock()` 轉 SDK image block、跟 prompt 包成單一 `SDKUserMessage`、用 async generator yield 給 SDK（`prompt: AsyncIterable<SDKUserMessage>` shape）。**Test**（in-process via fake SDK 攔 query() 的 options）：(1) parity 13 條 — `systemPrompt`/`tools`/`includePartialMessages`/`promptSuggestions`/`settingSources`/`agentProgressSummaries`/`toolConfig`/`effort`/`permissionMode`/`allowDangerouslySkipPermissions`/`model`(auto-compact preset → 'claude-opus-4-7')/`env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`/`abortController`；(2) `resume`+`continue` 在 empty prompt 第二輪自動加上；(3) `bypassPlan→plan` 映射；(4) image 流 — 1×1 PNG data URL → 斷言 `prompt` 是 async iterable、drain 後拿到 1 個 user message、content blocks 是 `[image, text]`、image source.media_type=`image/png`、text 內容對；(5) `sdkModelForClaudeSelection` + `dataUrlToContentBlock` 各 5/4 條斷言。仍綠：sidecar / host-api / cargo 111 / Tauri release build 55 秒 / launch smoke。**結果**：Tauri release 下 Claude session 第一次 `sendMessage` 真的能用 Bash/Read/Edit 等 built-in tools，跟 Electron 行為對齊；image 附件、auto-compact、effort、permission bypass 全條件可用；不再依賴 system PATH 上的 claude binary。剩下：(1) `canUseTool` 權限 callback（renderer 互動式同意 UI 的 round-trip）、(2) plugins list、(3) custom subagents `agents` option、(4) streaming-input mode mid-stream control、(5) multi-account safeStorage 替代。）

歷史紀錄：2026-05-09 (#27)。（同上 + **新 #27 — drift guard for `CLAUDE_MODEL_CONTEXT_WINDOWS`**：sidecar 在 #26 為了 `getContextUsage` 的 `maxTokens` 計算而新增的 `CLAUDE_MODEL_CONTEXT_WINDOWS` map 是 TS-side `CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS` 的 value-level 鏡射 + 4 個 `OPUS_47_PRESET_AUTO_COMPACT` 衍生 preset entry。#17 已有 keys 級 sorted-equal drift guard（`CLAUDE_BUILTIN_DEDUP_KEYS`），但 values + preset entries 缺保護 — TS 改 `CLAUDE_OPUS_47_BASE_CONTEXT` 從 1M 到別的值、或新增 preset id，sidecar 不會自動察覺。**新測試**：(a) value-level drift — 把 TS map literal 用 regex 抽出 `[key, number]` pair list，逐個斷言 sidecar `CLAUDE_MODEL_CONTEXT_WINDOWS.get(key)` 等於 TS value；(b) preset entry 存在性 — 4 個 hand-derived preset id（`auto-compact-200k/300k/400k`、`:1m`）必須在 sidecar map 裡且值是 positive number。重用 #17 已 locate 的 `ctxMatch[1]` map literal scope 避免重 read 檔案。**結果**：sidecar / host-api / cargo 111 全綠。剩下：(1) MCP tools list 整合到 categories、(2) memory files / agent skills tokens 分類、(3) streaming-input mode、(4) multi-account safeStorage 替代。）

歷史紀錄：2026-05-09 (#26)。（同上 + **新 #26 — usage tracking + cached getContextUsage**：sidecar 在 `claude.sendMessage` 的 stream_event 處理裡多攔 `message_start` / `message_delta` 抽出 usage（input/cache_creation/cache_read tokens），存到 `session.lastUsage`；result message 進來時用 `msg.usage` 蓋掉 mid-stream 估算（result 是該 turn 的 authoritative usage）並補上 `total_cost_usd` + `num_turns`。**`claude.getContextUsage` 從 stub `null` 換成讀 `session.lastUsage` 並組成 renderer ContextUsagePopup 期待的 shape**：`{categories:[{name:'Context',tokens,color}], totalTokens, maxTokens, percentage, model, apiUsage:{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}}`。`maxTokens` 透 `expectedContextWindowForModel(model)` 從 sidecar 新加的 `CLAUDE_MODEL_CONTEXT_WINDOWS` map 拿（鏡射 TS-side `CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS` + 加 4 個 auto-compact preset 條目：`auto-compact-200k=200K`、`-300k=300K`、`-400k=400K`、`:1m=1M`）。**Test**：(a) `expectedContextWindowForModel` 7 條斷言 — base id、`[1m]` 變體、preset 變體、unknown→null、undefined→null；(b) fake SDK 噴 message_start usage + 不同 result.usage、call sendMessage、call getContextUsage 斷言 totalTokens=150+50+250、maxTokens=1M（claude-sonnet-4-6）、percentage 正確、apiUsage 4 個欄位都進來；(c) pre-turn 沒 usage cache 回 null、unknown sessionId 也 null（renderer 解讀為「沒資料」）。仍綠：sidecar / host-api / cargo 111 / Tauri release build / launch smoke。**結果**：Tauri release 下 ContextUsagePopup 點開能看到真實 token 數 + 跟模型 context window 比例的進度 bar，而不是空白。剩下：(1) MCP tools list 整合到 categories（renderer 也吃 mcpTools 欄位）、(2) memory files / agent skills tokens 分類、(3) streaming-input mode、(4) multi-account safeStorage 替代。）

歷史紀錄：2026-05-09 (#25)。（同上 + **新 #25 — stream_event → claude:stream 即時 delta**：sidecar 在 SDK 訊息處理迴圈裡多解 `type: 'stream_event'`（SDKPartialAssistantMessage） — 只處理 `event.type === 'content_block_delta'` 含 `delta.text` 或 `delta.thinking` 的 case，emit `claude:stream` payload `{data: {text|thinking, parentToolUseId}}`，跟 Electron 同樣 filter。其他 stream event 變體（`message_start`/`message_delta` usage tracking、`ping`、其他 control event）這層丟掉 — usage tracking 等 metadata 拓展再做。**Test**（in-process via fake SDK）：噴出 `message_start` + 2 個 text delta + 1 個 thinking delta + 1 個 ping，斷言剛好 3 個 `claude:stream` event、payload.data.text/thinking 內容對、`parentToolUseId: null`、`message_start`/`ping` 沒誤 forward。renderer 在 Tauri 下能即時看到字逐個跳出來，不是等整段 assistant message 才一次顯示。仍綠：sidecar / host-api / cargo 111 / Tauri release build / launch smoke。剩下：(1) `claude:stream` 帶的 metadata tracking（usage update → claude:status emit，要 patch session.metadata）、(2) `getContextUsage` 從 result.usage 快取、(3) streaming-input mode mid-stream control、(4) multi-account safeStorage 替代。）

歷史紀錄：2026-05-09 (#24)。（同上 + **新 #24 — abort path lock + 三條 SDK-augmented read APIs**：(1) **abortSession 中段 stream 必須立刻終止**：注入 fake SDK 慢 stream（25ms 一個 chunk × 50 個），sendMessage 跑到 80ms 後拿到 ≥2 個 event 再 abortSession，斷言 sendMessage 在 1 秒內 settle、abort signal 真的傳到 SDK iterator（fake SDK 看到 `signal.aborted=true` 主動 throw）、最終 `claude:turn-end{reason:'aborted'}` event 有 emit — 鎖住 renderer 停止鈕的真正可用性、不只是 fire-and-forget。(2) **`claude.getSupportedCommands` / `getSupportedAgents` / `getAccountInfo`** 從 stub `[]` / `null` 換成跟 `getSupportedModels` 同樣的 SDK augmentation pattern：lazy SDK load → 起 Query instance call read API → catch fall back 空陣列 / null。test 覆蓋三組：fake SDK 注入回真實資料、fake SDK 強制 null fallback、fake SDK throw 仍要 graceful return — 三條都鎖 dual-mode contract，dev 通過不會掩蓋 release fall back regression。**結果**：renderer 在 Tauri 下能拿到真實 slash commands list（之前空陣列導致 `/` 選單沒選項）、subagents list、目前帳號的 email + subscription type。仍綠：sidecar (新增 5 條斷言) / host-api / cargo 111 / Tauri release build / launch smoke。剩下：(1) streaming-input mode mid-stream control（abort 已驗證可用、setPermissionMode/setModel mid-turn 是 nice-to-have）、(2) multi-account 切換 + safeStorage 替代、(3) `getContextUsage`（SDK 有 control method 但要 active session）。）

歷史紀錄：2026-05-09 (#23)。（同上 + **新 #23 — wire claude.authLogin + bundled CLI for auth ops**：sidecar 加 `resolveClaudeCliBinary()` 走訪 `node-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-<triple>/claude[.exe]`（rotate 6 個 platform/arch triple 嘗試找對應 host 的）拿到 SDK bundle 內附的 Claude Code CLI binary path，第一次找到後 cache（測試可透 `__resetClaudeCliCacheForTests()` 清掉）；`authStatus` / `authLogin` / `authLogout` 全部改成統一透 `spawnClaudeCli()` helper 走「bundled CLI 優先 → fall back 系統 PATH」的解析。**`claude.authLogin` 從 stub `STUB_AUTH_ERR` 換成真實 spawn `claude auth login`** —180s timeout 包住 browser-based OAuth flow，CLI 跑 callback 後自然 exit 我們就 resolve `{success: true}`，不論 dev/release 第一次裝 MSI 沒 system claude 的使用者都能透 sidecar 完成 OAuth 拿到 ~/.claude credentials。`BAT_SIDECAR_CLAUDE_BIN` env override 給測試 inject 任意 binary path 跳過 cache + 不打網路。**Test**：(a) `resolveClaudeCliBinary()` round-trip — 若 sidecar/node_modules 已裝就斷言路徑落在 `@anthropic-ai/claude-agent-sdk-<triple>/claude[.exe]`，否則 graceful skip；(b) env override 注入 `process.execPath`、call `claude.authLogin` / `authLogout` 透 dispatch、斷言不再回 stub error 字串（鎖住「拉出 stub 換真實 spawn」的 contract）；(c) cache 重置 hook 確保 env override 即時生效。仍綠：sidecar / host-api / cargo 111 / Tauri release build / launch smoke。**結果**：fresh MSI 安裝者第一次點「登入」就能完成 OAuth、claude credentials 落到 ~/.claude、後續 sendMessage 真的能跟 Claude 對話 — release end-to-end UX 從「需要先用系統 claude 登入」變成「裝完 MSI 開即用」。剩下：(1) streaming-input mode mid-stream control、(2) multi-account 切換要 Tauri 端 keychain 替代 Electron safeStorage（`accountSwitch/accountRemove/accountLoginNew/accountImportCurrent` 仍 stub）。）

歷史紀錄：2026-05-09 (#22)。（同上 + **新 #22 — tool_use / tool_result event mapping**：sidecar 在 `claude.sendMessage` 的 SDK 訊息處理器裡多解析 content blocks — assistant 訊息裡的 `tool_use` block 額外 emit `claude:tool-use` event（payload `toolCall: {id, sessionId, toolName, input, status:'running', parentToolUseId, timestamp}`），user 訊息裡的 `tool_result` block 額外 emit `claude:tool-result` event（payload `result: {id: tool_use_id, status: is_error ? 'error' : 'success', result: content}`）。映射跟 Electron `addToolCall/updateToolCall` 對齊，renderer 的 ToolCall panel 在 Tauri 下能正常顯示工具執行流程（之前只有 `claude:message` 拿到原始 BetaMessage，UI 要自己 parse blocks，現在跟 Electron 一樣有 dedicated event）。**新增測試**：fake SDK 噴出兩段「assistant tool_use → user tool_result」（一次 success Bash、一次 error Read），斷言 2 個 tool-use + 2 個 tool-result event、每個 payload key 與欄位、`is_error: true` 對應 `status: 'error'`、`is_error: false` 對應 `'success'`。所有 sidecar / host-api / cargo 111 / tsc / Tauri release build / launch smoke 全綠。剩下：(1) streaming-input mode（mid-stream interrupt / setPermissionMode / setModel control）、(2) MCP server config、(3) 完整 metadata + cost tracking、(4) 真實 account auth flow（login + safeStorage 替代）。前三項是 SDK 進階用法、第四項要等 Tauri 端有 keychain 介面才能做。）

歷史紀錄：2026-05-09 (#21)。（同上 + **新 #21 — real claude.sendMessage via SDK**：sidecar 的 `claude.sendMessage` 從 stub `(stub reply)` 換成真實 `@anthropic-ai/claude-agent-sdk` 驅動 — 每次 sendMessage 用 `query({prompt, options})` 起 single-shot stream、捕捉 SDK 回的 `session_id` 存進 session record 當下次 `resume`，達成 multi-turn context。SDKMessage→event 映射：`system/init` → `claude:status`（含 sdkSessionId/cwd/model/permissionMode 的 metadata 對齊 Electron contract）、`assistant` → `claude:message`（原 BetaMessage 透傳，renderer 已知道怎麼解 text/tool_use blocks）、`result/success` → `claude:result` + `claude:turn-end{reason:'completed', sdkSessionId}`、`result/error` → `claude:error` + `claude:turn-end{reason:'error'}`、throw/abort → `claude:error`（非 abort 時）+ `claude:turn-end`。新增 per-session `sdkSessionId/abortController/streaming` 欄位；`stopSession`/`abortSession` 都呼叫 abortController.abort()；concurrent send 在 streaming 期間直接 reject。**保留 stub fallback**：SDK 載入失敗（release 沒 bundle / dev 沒 install）回原本 stub 回覆 + log 到 stderr，讓 renderer 不會 hang。**新增 `BAT_SIDECAR_DISABLE_SDK=1` env 開關**強制走 stub path，給 sidecar e2e + cargo 測試用（不能讓測試實打 Claude API）。SpawnConfig 加 `extra_env: Vec<(String,String)>` 把 env 從 Rust 注入給 Node。**Test 設計**：(a) sidecar in-process — 注入 fake SDK、call sendMessage、斷言 4 個 event 順序與 payload key（status.meta.sdkSessionId / message.message.content / result.result / turn-end.payload.reason+sdkSessionId）；(b) 同上 — 第二次 sendMessage 必帶 `resume: <sdkSessionId>`，鎖住 multi-turn context preservation；(c) concurrent send 衝突 — pre-flag streaming 後 send 必回 `{ok:false, error:/streaming/}`；(d) stub fallback — `__setSdkOverrideForTests(null)` 後 sendMessage 回 `{ok:true, stub:true}` 並 emit message+turn-end，鎖住 release-without-bundle UX。原 cargo `end_to_end_session_lifecycle_emits_events` 改用 SpawnConfig.extra_env 帶 `BAT_SIDECAR_DISABLE_SDK=1` 走 stub path。**結果**：sidecar tests 全綠（多新增 4 條 in-process 斷言）、cargo 111 全綠、host-api 8 情境綠、tsc noEmit 綠、tauri release build 49.x 秒、smoke 綠。renderer 在 dev/release 都能透過 sidecar 真的跟 Claude 對話一輪 multi-turn 對話（前提：使用者已 `claude auth login` 過、機器有 NETWORK + SDK 內 bundled CLI 能跑）。剩下：(1) tool_use / tool_result event 細節（renderer 解析從 BetaMessage content blocks 抽出，但若需要 Electron-equivalent metadata tracking 還要再 port）、(2) streaming-input mode（mid-stream interrupt/setPermissionMode/setModel control 方法）、(3) MCP server 設定、(4) 完整 metadata + 成本追蹤 — 都是 nice-to-have，不擋 release 基本可用。）

歷史紀錄：2026-05-09 (#20)。（同上 + **新 #20 — bundled SDK node_modules**：把 `@anthropic-ai/claude-agent-sdk` + 它的 transitive deps 也 bundle 進 release，sidecar 在 release 不再需要 host project 的 node_modules。新建 `node-sidecar/package.json`（only deps：`@anthropic-ai/claude-agent-sdk@0.2.128` + `zod@^4.3.6`）+ `node-sidecar/.npmrc`（`node-linker=hoisted` 強制 flat layout，避免 pnpm 預設 symlink 樹被 Tauri bundle 破壞）。`pnpm --dir node-sidecar install` 拿到 274MB 樹（其中 243MB 是 `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` — SDK 內建的 Claude Code CLI binary，跟原本 `@anthropic-ai/claude-code` 等價但是 platform-specific optional dep）。tauri.conf.json `bundle.resources` 加 `node-sidecar/package.json` + `node-sidecar/node_modules/`。新增 root-level helper script `pnpm run prepare:tauri-bundle`：先 fetch Node runtime、再 install sidecar deps，release pipeline 一行就能備齊 bundle inputs。**End-to-end 驗證**（cargo `end_to_end_bundled_sdk_loads_through_bundled_node`）：用 bundled Node 起 sidecar、call `claude.getSupportedModels`、斷言結果 ≥7 個 + 至少一個 `source: 'sdk'` — bundled SDK 沒被 sidecar reach 到的話這條會炸；node_modules 沒裝時 graceful skip。release MSI 從 31MB → 112MB，NSIS 從 22MB → 73MB（含 ~310MB raw payload，兩種 installer 各自壓縮）。launch smoke 綠。cargo 111、sidecar、host-api、tsc 全綠。**現在 release 真的 self-contained**：使用者不用裝 Node、也不用裝 Claude Code CLI（SDK 內建 win32-x64 native binding 會被走，未來 macOS/Linux build 跑 `pnpm run prepare:tauri-bundle` 在那台 host 上就會 install 對應 platform 的 optional dep）。剩下：(1) 把 sidecar `claude.startSession`/`sendMessage` 從 stub 換成真實 SDK 呼叫（bundle 已備好），(2) macOS/Linux 上實機驗證 prepare 步驟產出對的 platform binding。）

歷史紀錄：2026-05-09 (#18+#19)。（同上 + **新 #18+#19 — bundled Node runtime**：把 Node interpreter 直接 bundle 進 Tauri release exe，release 不再依賴使用者機器上的 Node。**Resolver 邏輯**（#18）：sidecar.rs `find_bundled_node()` 先在 `<resource_dir>/node-runtime/<plat>-<arch>/[bin/]node[.exe]` 找 binary，再退到 `<resource_dir>/node-runtime/node[.exe]` 平層 fallback，再退到 PATH lookup（`tauri dev` + 單元測試保留無痛路徑）。triple 用 Rust-style arch 名（windows-x86_64 / darwin-aarch64 / linux-x86_64）跟 std::env::consts::ARCH 對齊不轉譯。加 4 條 cargo unit test：missing dir、platform-arch with bin/、flat fallback、prefer-platform-over-flat。**Bundle 流程**（#19）：`scripts/fetch-node-runtime.mjs` 從 nodejs.org 下載 portable archive（Node v20.18.1 LTS 預設）並萃取到 `node-sidecar/runtime/<plat>-<arch>/`，prune 到只保留 node binary + LICENSE 把單一 platform size 從 150MB 砍到 67MB（windows-x64）。Windows 用 `C:\Windows\System32\tar.exe`（bsdtar 內建處理 zip）— 比 PowerShell `Expand-Archive` 在 Node.org zip 上的路徑解析更穩。tauri.conf.json `bundle.resources` 加 `"../node-sidecar/runtime/": "node-runtime/"` 把整個 runtime 樹搬進 bundle。`.gitignore` 把實際 binaries 排除掉但保留 `.gitkeep` + `README.md` 確保 dir 存在以滿足 Tauri bundle.resources 不可空源 path 的要求。`pnpm run fetch:node-runtime` script 預設 host platform、`--all` 跑所有 triple、`--target=` 單一指定、`--force` 重抓。**End-to-end 驗證**（cargo `end_to_end_bundled_node_runs_sidecar`）：直接用 `node-sidecar/runtime/<plat>-<arch>/` 的 binary 起 sidecar、ping 一輪、斷言 ok+echo — 無 binary 時 graceful skip 不阻 CI。Tauri release build 49.58 秒，MSI 31MB / NSIS 22MB（已含 67MB raw Node，installer 壓縮過）、smoke 綠。cargo 110、sidecar、host-api、ts noEmit 全綠。剩下：(1) 把 `@anthropic-ai/claude-agent-sdk` 跟它的 transitive deps 也 bundle 進 sidecar runtime（裝到 `node-sidecar/node_modules/`，這樣 release 真的 self-contained），(2) 真實 startSession/sendMessage SDK 串流。）

歷史紀錄：2026-05-09 (#17)。（同上 + **新 #17**：sidecar 加 lazy `loadAnthropicSdk()` loader（一次性 import + cache，失敗 cache null），並把 `claude.getSupportedModels` 從純 builtin 改成 builtin + SDK augmentation — SDK 載入失敗（release 沒 bundled node_modules）就回純 builtin、跟 Electron 在 SDK 失敗時的 fallback 完全一致。dedup 用新 mirror 常數 `CLAUDE_BUILTIN_DEDUP_KEYS`（鏡射 `CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS` 的 keys，含 base id 與 `[1m]` 變體），SDK 結果若是 builtin 的 base 或 [1m] 變體就 filter 掉，剩下的 tag `source: 'sdk'` append 到 builtin 後面。同步把 `claude.authLogout` 從固定 `{success:true}` stub 換成 execFile `claude auth logout`（10s timeout，error 回 `{success:false, error}`）。**Test 設計**：(a) 主測試放寬 — accept ≥ builtins.length，斷言每個 builtin 都在結果裡且 tag 正確、SDK extras 都 tag `'sdk'`，這樣 dev/release 兩邊都通過；(b) 加 `__setSdkOverrideForTests(null)` test-only hook 強制走 SDK-unavailable 路徑、斷言結果剛好等於 builtin 數量、全部 tag `'builtin'` — 把 release fallback 鎖住，dev 通過不會掩蓋 release regression；(c) 加正向 augmentation 測試：注入 fake SDK 回 3 個 model（一個 dup base、一個 base[1m]、一個全新）、斷言 dedup 後只剩全新那個被 augment 上來；(d) 加第二條 drift guard：sidecar `CLAUDE_BUILTIN_DEDUP_KEYS` 與 TS `CLAUDE_BUILTIN_MODEL_CONTEXT_WINDOWS` keys 直接 sorted-equal。所有測試仍綠（sidecar 4 個 model 相關斷言全 + host-api + cargo 105 + ts noEmit），Tauri release build 41.98 秒、smoke 綠、MSI/NSIS bundle 都產出。）

歷史紀錄：2026-05-09 (#16)。（同上 + **新 #16**：把 6 個 per-session state setter（`setAutoContinue/setPermissionMode/setModel/setEffort/resetSession` + `getAutoContinue`）從 permissive fallback 拉出來顯式 route，sidecar 加 per-session state map（model/effort/permissionMode/autoCompactWindow/autoContinue），由 `startSession` 從 options 預先填入、setter 各自 patch、`getSessionState/getSessionMeta` 讀回。`setPermissionMode` 還會 emit `claude:modeChange` event 跟 Electron 一致。`getWorktreeStatus(sessionId)` 也接到剛才 port 的 worktreeStatus（之前回 null）。新增 6 條 Tauri commands + adapter 顯式 routes + host-api 測試 + sidecar in-process round-trip 測試 + 一條 cargo end-to-end 測試（透 spawn Node 跑完整 startSession→setters→getters→reset 流程）。cargo 測試 105 條全綠。Tauri release build 跑中。）

歷史紀錄：2026-05-09 (#15)。（同上 + **新 #15**：把 `claude.getSupportedModels` 從 stub `[]` 換成真實 `CLAUDE_BUILTIN_MODELS` 鏡射列表（每個 entry 加 `source: 'builtin'`）。renderer 的模型選單在 Tauri 下會看到 7 個內建選項：Opus 4.7 200K/300K/400K/1M、Opus 4.6、Sonnet 4.6、Haiku 4.5。SDK augmentation（從 `@anthropic-ai/claude-agent-sdk` 拿動態 model list）等真實 SDK port 完才接，目前 fall back 跟 Electron 在 SDK 載入失敗時的行為相同。新增 drift guard test：sidecar 直接 read `src/utils/claude-model-presets.ts`，regex 解析 array literal 內的 `value:` 與 `CLAUDE_OPUS_47_*` 符號常數，斷言 sorted-equal — 漏改 sidecar 鏡射會立刻 fail。所有測試仍綠。）

歷史紀錄：2026-05-09 (#14)。（同上 + **新 #14**：把 `claude.cleanupWorktree` 從 permissive fallback 拉出來顯式 route — sidecar handler 呼叫剛才 port 的 `worktreeRemove(sessionId, deleteBranch)` 並 emit `claude:worktree-info` event 通知 renderer 重置 UI。session-state mutation（cwd 切回 originalCwd）那部分仍要等 agent SDK port 完才有意義 — 目前 session 在 Electron 那邊管。新增 `claude_cleanup_worktree` Tauri command + adapter 顯式 route + host-api 測試。Tauri release build #13 後重跑：49.5 秒、smoke test 綠、release exe 一樣 ~12 MB + MSI/NSIS bundle 都產出。所有 sidecar / host-api / cargo / ts / smoke 全綠。）

歷史紀錄：2026-05-09 (#13)。（同上 + **新 #13**：把整個 worktree manager port 進 sidecar — `worktree.create/remove/status/rehydrate` 從 stub 換成真實 git execFile + fs 實作，鏡射 `electron/worktree-manager.ts` 約 250 LOC，包含 `.bat-worktrees/` 目錄管理、自動加 `.git/info/exclude`、untracked `.claude/` symlink/junction、衝突分支自動加 timestamp 後綴、worktree 強制移除回退手動 `rm -rf` + `git worktree prune`、source branch async 解析。`worktree.merge` 維持 stub（Electron 那邊也叫了不存在的 `mergeWorktree` 方法，feature 在 Electron 也是壞的，先不偽造）。新增 fixture-driven test：跑 `git init` 建臨時 repo + commit + worktreeCreate + status + remove，斷言 `.bat-worktrees/<shortId>` 真的在硬碟上、`.git/info/exclude` 被更新、source branch 抓到 `main`、remove 後路徑消失。Windows EBUSY 用 retry-with-delay 處理。所有測試仍綠，Tauri release build 跑中。）

歷史紀錄：2026-05-09 (#12)。（同上 + **新 #12**：sidecar 的 `agent.listPresets` 從 stub `[]` 換成真實 preset id 列表，鏡射 `src/types/agent-presets.ts::AGENT_PRESETS`。NewTerminalQuickPick 的 preset 卡片在 Tauri 下會全部亮起（之前 sidecar 回 [] 會把所有非 'none' 的卡片視為 unsupported 而 disable）。新增 drift guard 測試：sidecar 直接 read renderer-side TS 檔，regex 抓所有 `id: '...'` literals，斷言 sorted-equal — 若日後新增 preset 沒同步更新 sidecar，測試立即 fail。所有測試仍綠。）

歷史紀錄：2026-05-09 (#11)。（同上 + **新 #11**：再 port `claude.scanSkills` — 走訪 `<cwd>/.claude/skills/` 與 `~/.claude/skills/`，吃 SKILL.md（subdir）與 *.md（top-level），parse YAML frontmatter 抓 name/description，沒有 frontmatter 就退回首條 heading。新增 `claude_scan_skills` Tauri command + adapter 顯式路由（從 permissive fallback 拉出）。renderer 的 SkillsPanel 在 Tauri 下會直接拿到掃描結果，不再走 warn-once null。新增 host-api 測試 + sidecar fixture-driven 測試。所有測試仍綠。）

歷史紀錄：2026-05-09 (#10)。（同上 + **新 #10**：把 `openai.listSessions` 從 stub 換成真實實作 — 走訪 `~/.better-agent-terminal/openai-sessions/<yyyy>/<mm>/<dd>/*.jsonl`，每檔 parse JSONL 抓首條 user message 當 preview，mtime desc 排序，與 `electron/openai-agent/persistence.ts::listAllSessions` 行為一致。renderer 切到 OpenAI panel 時 resume list 會直接拿到 Electron 累積的 session 紀錄，不需要等 OpenAI 真實 manager port 完。所有 sidecar e2e + cargo + host-api + ts 仍綠。）

歷史紀錄：2026-05-09 (#9)。（Phase 1 + Phase 2 全綠 + Phase 3 半完成：(a) sidecar 透過 `bundle.resources` 進 NSIS/MSI release exe；(b) `host.update.check` 透 sidecar fetch 拿 GitHub Releases；(c) remote/tunnel namespaces 全 stub-routed；(d) tauri-launch smoke test 看到 `thread '...' panicked` 直接 fail；(e) #8：`claude.getCliPath` + `claude.listSessions` 從 sidecar stub 換成真實實作；(f) **新 #9**：再 port 兩條 — `claude.authStatus`（execFile `claude auth status`，10s timeout，parse JSON or null）與 `claude.accountList`（讀 `<data-dir>/claude-accounts.json`，sanitize 出 id/email/subscriptionType/isDefault/createdAt 公開欄位，credential blob 從不碰），同時把 `data_dir` 加進 `SpawnConfig`，Rust spawn 時透 `BAT_SIDECAR_DATA_DIR` env 注入給 sidecar，sidecar 在 env 沒設時退回 platform-default（`%APPDATA%/BetterAgentTerminal/`、`~/Library/Application Support/better-agent-terminal/`、`~/.config/better-agent-terminal/`）。Electron-side AccountManager 寫的 index 檔可以被 Tauri sidecar 直接讀，不必雙寫。剩下 Phase 3 expensive 的工作：(1) bundle Node runtime（pkg / bun --compile / Node SEA）；(2) 實打 `@anthropic-ai/claude-agent-sdk` 進 sidecar 把 stub 的 startSession/sendMessage 換成真實 Anthropic call；(3) 同樣對 OpenAI / worktree-manager / remote / tunnel 走真實實作；(4) accountSwitch / accountRemove 真實寫入（需要對應的 safeStorage 替代品 — 暫時 keep stub）。cargo test 104、host-api 8 情境、sidecar 測試（findClaudeCliPath + listSessionsFallback + readAccountIndex 的 fixture-driven 測試 + resolveDataDir branches）、Tauri release build & smoke 全綠。）

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
  - `claude_auth_login` / `claude_auth_logout` / `claude_account_import_current` / `claude_account_login_new` / `claude_account_switch` / `claude_account_remove` / `claude_account_mark_warning_shown`（Phase 2 slice 3；auth/account 7 條，其中 login 系列目前回 `{success:false, error: 'sidecar stub'}` 等真實 SDK 接管，其餘按 Electron 簽章塞 sensible defaults）。
  - `claude_get_cli_path` / `claude_list_sessions` / `claude_get_supported_models` / `claude_get_supported_commands` / `claude_get_supported_agents` / `claude_get_account_info` / `claude_get_session_state` / `claude_get_session_meta` / `claude_get_context_usage` / `claude_get_worktree_status`（Phase 2 slice 3；10 條 read-only metadata。`getCliPath` 與 `listSessions` 已在 Phase 3 #8 改成真實實作（前者掃 PATH，後者讀 `~/.claude/projects/<encoded>/*.jsonl`），其餘 8 條仍回 null/[]/'' 直到 Anthropic SDK 上線。讓 renderer 每個 panel mount 都不會崩）。
  - `openai_get_api_key_status` / `openai_set_api_key` / `openai_clear_api_key` / `openai_list_sessions` / `openai_compact_now`（Phase 2 slice 4；OpenAI agent manager 整體還在 Electron 端，sidecar handler 全部回 sensible defaults）。
  - `worktree_create` / `worktree_remove` / `worktree_status` / `worktree_merge` / `worktree_rehydrate`（Phase 2 slice 4 起 stub-routed；#13 把 create/remove/status/rehydrate 換成真實 port，鏡射 `electron/worktree-manager.ts`：sessionId 對應 `.bat-worktrees/<shortId>` 子資料夾、auto exclude、衝突分支加 timestamp、untracked `.claude/` symlink/junction、status 跑 `git diff <source>...<branch>`。state 用 sidecar 模組 scope `Map<sessionId, WorktreeInfo>`。`worktree_merge` 維持 stub — Electron 端 register-handlers 呼叫不存在的 `mergeWorktree` 方法，feature 在 Electron 也是壞的）。
  - `agent_list_presets`（Phase 2 slice 4；單一 read-only，回空陣列直到 preset registry 進 sidecar）。
  - `worker_buffer_init` / `worker_buffer_append` / `worker_buffer_read_all` / `worker_buffer_clear`（Phase 2 slice 4；Rust 端用 `Mutex<HashMap<String,String>>` 撐 panel 暫存區，1 MiB cap + line-aligned trim，不走 sidecar — 寫入率高於 stdio 線適合直接 Rust 化）。
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
- [~] **Phase 2：Agent SDK Node sidecar**（見下方 [Phase 2 設計筆記] 章節）。已切完四刀，covers `host.{claude,openai,worktree,agent,workerBuffer}.*`：claude 顯式 port 29 條 + permissive 預設兜底 ~15 條剩餘方法、openai 5 條、worktree 5 條、agent.listPresets、workerBuffer 4 條（Rust 直管）。剩下 remote/tunnel 兩個 namespace 與真實 agent SDK 實作邏輯（startSession/sendMessage 真要打 `@anthropic-ai/claude-agent-sdk`）綁定 Phase 3 / 之後。
- [~] **Phase 3：packaging + remote/tunnel + update.check**：sidecar 已透過 `bundle.resources` 進 NSIS/MSI 包；`update.check`、`remote.*`、`tunnel.*` 全部 stub-routed（`update.check` 是真實 fetch，其他兩個是 stub 等真正實作）。剩下：自帶 Node runtime（pkg / bun --compile / Node SEA）、把 stub 換成真實 SDK / mDNS / TLS 實作。
- [~] 把全部 `window.batAppAPI.*` 直呼換成 `host.*`：Phase 1 已 port 命名空間（settings、shell、dialog、fs、clipboard、image、pty、workspace、update、debug、git、app、notification、system、github、snippet、profile）都已切到 `host.*`；Phase 2 後 host.{claude, openai, worktree, agent, workerBuffer}.* 也都路由到 sidecar / Rust。剩下純 Phase 3 的 remote / tunnel namespace 仍走 `window.batAppAPI`，受 `installTauriShim()` 保護回 `Promise.resolve(null)`，等該命名空間有 Rust 對應或 Node sidecar 接管再切換。

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
