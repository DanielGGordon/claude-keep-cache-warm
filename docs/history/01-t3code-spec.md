# t3code keep-alive spec (research agent)

> From the multi-agent build workflow (2026-11-17), before the later changes listed in HANDOFF.md. Local paths are replaced with placeholders.

SPEC: t3code fork prompt-cache keep-alive (DanielGGordon/t3code@main)

I couldn't run curl (TLS error 60) or WebFetch (it only summarises), so I downloaded the file and a zip of the repo with PowerShell Invoke-WebRequest and grepped it locally. The main file is saved at <scratchpad>\t3\cacheKeepAlive.ts and the extracted repo is in <scratchpad>\repozip\x\t3code-main.

Files covered:
- packages/shared/src/cacheKeepAlive.ts (pure logic) and its .test.ts
- apps/server/src/orchestration-v2/CacheKeepAliveWorker.ts (the sweep)
- Orchestrator.ts (guard, counters, reset)
- ProjectionStore.ts (anchor and candidate SQL)
- apps/web/.../CacheKeepAliveToggle.tsx (UI, tooltips, toast)
- cacheExpiryBanners.logic.ts and CacheExpiryBanners.tsx (separate expiry toasts)
- ThreadNotificationCoordinator.tsx and Sidebar.logic.ts (quiet completion)
- packages/contracts (mode schema, IDLE_COMPACTION_TEXT)

== 1. CONSTANTS ==
- `PROMPT_CACHE_TTL_MS = 60 * 60_000` (1 h). Duplicated in apps/web/src/cacheExpiryBanners.logic.ts.
- `CACHE_KEEP_ALIVE_LEAD_MS = 5 * 60_000`. The ping fires at anchor + 55 min. The doc comment says pings land "55–57 minutes after the anchor".
  - Why the lead is generous: T3 releases a Claude session after 30 idle minutes, so a ping restarts Claude Code and its MCP servers first. Measured request-to-first-response was p50 8 s, p90 40 s, sometimes over 1 min. A ping that lands after expiry is "the costliest outcome (a full cache write)".
- `CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES = 8`: pings in a row without a user message before keep-alive pauses (about 8 h).
- `CACHE_KEEP_ALIVE_NUDGE_TEXT = 'Keep-alive ping to keep the prompt cache warm. No action needed — just reply "ok".'`
  - Uses an em dash and straight double quotes around ok.
  - Comment: "Shared verbatim with Alfred's manual nudge button."
- `CACHE_KEEP_ALIVE_MESSAGE_ID_PREFIX = "cache-keep-alive:"`.
- `IDLE_COMPACTION_TEXT = "/compact"` (contracts). This is the text sent in compact modes.
- `CACHE_KEEP_ALIVE_DRIVER_KINDS = ["claudeAgent"]`: only Claude has the hour-long cache. Codex and other providers cache for minutes.
- `BUSY_RUN_STATUSES = {preparing, queued, starting, running, waiting}`.
- `CACHE_KEEP_ALIVE_PROVIDER_ITEM_TYPES` (items that count as model output): assistant_message, reasoning, proposed_plan, todo_list, user_input_request, approval_request, secret_request, file_change, command_execution, file_search, web_search, dynamic_tool, subagent.
- Worker:
  - `SWEEP_INTERVAL_MS = 30_000`. The Scheduler ticks every 5 s and the sweep throttles itself via a `nextSweepAtMs` Ref.
  - `MAX_ATTEMPTS = 3`: the first try plus 2 retries per idle period, only after infrastructure failures.
- Web banners:
  - `CACHE_EXPIRY_BANNER_LEAD_MS = 10 * 60_000`, `RECHECK_MS = 30_000`, `KEEP_DISMISSED_MS = 2 days`.
  - Minimum tokens setting: default 100_000, range 10_000–2_000_000.
  - localStorage key `"t3code:cache-expiry-banners:v1"`.

== 2. MODES AND TOGGLE STATE ==
- The mode is a Schema literal: `"warm" | "compact" | "warm-then-compact"`. `cacheKeepAliveMode(k) = k?.mode ?? "warm"`, so toggles saved before modes existed count as warm.
- Pings happen when `mode !== "compact"`. Compaction happens when `mode !== "warm"`.
- Persisted toggle `thread.cacheKeepAlive` is null when off. Fields:
  - `mode?`
  - `lastCompactRunId?`
  - `enabledAt`
  - `nudgeCount`: pings since the user last wrote
  - `pausedAt`: set when nudgeCount reaches the cap
  - `lastNudgeRunId`: the run the latest ping started
  - `lastNudgeAfterRead`
- `cacheKeepAliveActive(k) = k != null && (k.pausedAt === null || compacts(mode))`. A spent budget only ends a mode that never compacts.
- `nextCacheKeepAlive(current, {enabled, mode?}, now)` handles the `thread.cache-keep-alive.set` command:
  - Disabled: returns null.
  - Current exists and is not paused: keeps it as is. A mode change keeps nudgeCount, so a running budget survives.
  - Otherwise: a fresh budget `{mode, lastCompactRunId: current?.lastCompactRunId ?? null, enabledAt: current?.enabledAt ?? now, nudgeCount: 0, pausedAt: null, lastNudgeRunId: current?.lastNudgeRunId ?? null, lastNudgeAfterRead: current?.lastNudgeAfterRead ?? false}`.
- UI click cycle: off → warm → compact → warm-then-compact → off. On servers without the `threadCacheKeepAliveCompact` capability it only flips between off and warm.

== 3. STATE MACHINE (`cacheKeepAliveState({thread, nowMs})`) ==
Checks run in this order:
1. `cacheKeepAlive === null` → `{kind:"off"}`
2. `!cacheKeepAliveActive` → `{kind:"paused", nudgeCount}`
3. `cacheKeepAliveContext === null` → `"cold"`. The server adds the context together with the toggle; clients wait until they see it.
4. Driver not claudeAgent → `"unsupported"`
5. `archivedAt` or `deletedAt` set, `settledOverride === "settled"`, or `snoozedUntil > now` → `"parked"`
6. → `"busy"` if any of these holds:
   - `activeRunId !== null`
   - `activityRunStatus != null`
   - `thread.status` is in BUSY
   - `context.hasQueuedRun`
   - `context.run.status` is in BUSY
   - `pendingRuntimeRequest !== null` (waiting on the user)
   - `backgroundWorkHoldsCompletion(pendingBackgroundTasks)`: true if any task has `awaited === true`, or its kind is subagent or background_task. Command and monitor tasks hold only when awaited.
7. The anchor is null (no run, or not datable) → `"cold"`
8. `expiresAtMs = anchor + TTL`. If `now >= expiresAtMs` → `"cold"`. A lapsed cache is never pinged.
9. If the mode compacts:
   - `context.run.id === lastCompactRunId` → `"compacted"` (terminal until the user writes and a new run takes over).
   - If the mode doesn't ping, or `pausedAt !== null`: `compactAtMs = expires - LEAD`. Kind is `"compact-due"` when `now >= compactAtMs`, else `"compact-scheduled"`. The result carries `{runId, compactAtMs, expiresAtMs}`.
10. Otherwise `nudgeAtMs = expires - LEAD`. Kind is `"due"` when `now >= nudgeAtMs`, else `"scheduled"`. The result carries `{runId, nudgeAtMs, expiresAtMs, nudgeCount}`.

So warm-then-compact pings until the budget runs out (pausedAt set), then compacts the cache the last ping left.

== 4. TRACKING "LAST MODEL OUTPUT" (THE ANCHOR) ==
The server computes `cacheKeepAliveContext = {driver, run:{id,status,completedAt,lastProviderActivityAt}|null, hasQueuedRun}`.
- It is in-memory in `cacheKeepAliveContextForShell` and mirrored in SQL as `cache_keep_alive_context_json`.
- It exists only when the toggle is on or the active provider thread's driver is claudeAgent.
- The driver is null when the active provider thread's instance doesn't match the thread's providerInstanceId.

Which run is used (`latestExecutedRun`):
- Excludes queued runs, and cancelled runs that never started.
- Orders unfinished runs first, then by `completed_at DESC`, then `ordinal DESC`, then `run_id DESC`.

`lastProviderActivityAt` = MAX(`startedAt`) over that run's turn items where:
- `node_id === run.rootNodeId` (root node only), and
- the type is in PROVIDER_ITEM_TYPES.

Notes on this choice:
- startedAt is used, not completedAt.
- Checkpoints, errors, notices and bookkeeping items don't count; the server writes them, often minutes later.
- The Claude adapter puts assistant messages and most tools on child nodes, and subagents are child nodes. In practice the anchor is the last root `reasoning` item, measured within about 9 s of the true last request.

`cacheKeepAliveAnchorMs(run)`:
```ts
if (run.status !== "completed" && run.status !== "interrupted") return null;
if (run.lastProviderActivityAt !== null) return toEpochMillis(run.lastProviderActivityAt);
return run.status === "completed" && run.completedAt !== null ? toEpochMillis(run.completedAt) : null;
```
- A failed or cancelled run means "cold". It may not have refreshed the cache (usage limit, auth error), so the logic waits for a real turn.
- An interrupted run with no item times is not guessed at. It may have sat in a long tool call.

`promptCacheExpiresAtMs` (countdown only; counts down even with the toggle off):
- Uses the same anchor.
- While a run is BUSY, it uses `lastProviderActivityAt`, or `nowMs` if the status is "running" and there are no items yet (mid-request, so the cache is fresh). It returns null for other busy statuses with no items.
- Returns null when `now >= expires` or the driver is unsupported.

== 5. SKIP AND REFUSAL CONDITIONS ==
Candidate SQL (`getCacheKeepAliveCandidates`) selects threads where all of these hold:
- not deleted and not archived
- `cacheKeepAlive` is not null
- `pausedAt` is null OR `mode = 'warm-then-compact'`
- no run in preparing, queued, starting, running or waiting

Edge case: a paused thread in "compact" mode is excluded by the SQL. That is moot, since a compact-only mode never sets pausedAt.

Sweep, per thread:
- Builds the command only when the state is `due` or `compact-due`.
- Tracks `PingAttempts{runId, attempts, settled}` per thread and drops entries for threads that are no longer candidates.
- Skips when the same runId is already settled, or has used `attempts >= 3`.
- A successful dispatch records `settled: true`.
- An `OrchestratorCacheKeepAliveRefusal` also records `settled: true` and is logged at debug as `orchestration-v2.cache-keep-alive.refused`. A refusal is final for that idle period.
- Any other failure records `settled: false`, logs a warning `...dispatch-failed` with `willRetry`, and retries on the next sweep with attempt+1.

Command:
- identity = `${compact ? "compact:" : ""}${threadId}:${runId}:${attempt}`
- `commandId = "cache-keep-alive:" + identity`, `messageId = "cache-keep-alive:" + identity`. Note the compact prefix comes after `cache-keep-alive:`.
- `cacheKeepAliveOfRunId = runId`
- Compact adds `cacheKeepAliveAction: "compact"` and `idleCompaction: "beforeCacheExpires"`, with text `"/compact"`.
- Otherwise the text is NUDGE_TEXT.
- `dispatchMode: start_immediately`, `createdBy: "system"`, `creationSource: "server"`, no attachments.

Orchestrator guard (inside `dispatchMessage`) re-evaluates `cacheKeepAliveState` on the committed shell at dispatch time. It refuses when any of these holds:
- `createdBy !== "system"`, `creationSource !== "server"`, or the dispatch mode is not start_immediately
- the expected kind (`due`, or `compact-due` when compacting) is no longer current, or its runId differs from `cacheKeepAliveOfRunId`
- when compacting, the kept-warm run's user message was itself a compaction command (no compacting a compaction)

Side effects that a ping or compaction does NOT trigger:
- clearing settledOverride (unsettling)
- ending a snooze
- refining the thread title

== 6. CONSECUTIVE-PING COUNTER ==
After an accepted ping, `recordCacheKeepAliveNudge` sets:
- `nudgeCount + 1`
- `pausedAt = now` when `nudgeCount >= 8`. It pauses right on the 8th ping, whose own cache then stays warm for the hour.
- `lastNudgeRunId` = the run whose userMessageId is the ping's messageId
- `lastNudgeAfterRead` = readBeforePing, true when any of:
  - `lastVisitedAt` is null
  - `lastVisitedAt >= keptWarmRun.completedAt`
  - the kept-warm run was itself the last ping and `lastNudgeAfterRead` was already true (carried forward)

It then emits `thread.cache-keep-alive-updated`.

An accepted compaction runs `recordCacheKeepAliveCompaction`, which sets `lastCompactRunId` to the new run.

Reset: in `dispatchMessage`, when `isUserActivity(command)` is true and any of nudgeCount>0, pausedAt, lastNudgeRunId or lastNudgeAfterRead is set:
- sets nudgeCount 0, pausedAt null, lastNudgeRunId null, lastNudgeAfterRead false
- this also resumes a paused toggle

`isUserActivity` means:
- `createdBy === "user"`, and
- no `scheduledTaskId`, and
- `creationSource !== "server"`, OR the messageId starts with `ASYNC_ANSWER_MESSAGE_ID_PREFIX`

Other ways the counter resets:
- Re-enabling while paused starts a fresh budget (section 2).
- `thread.mark-unread` clears `lastNudgeAfterRead` only.

== 7. TOASTS, NOTIFICATIONS AND UI TEXT ==
Toggle (header or composer):
- Icons: Flame for warm (orange), FoldVertical for compact (blue), FlameKindling for warm-then-compact (violet), CirclePause when paused.
- Paused renders as not pressed.
- aria-label = `"<mode label | Resume keeping the prompt cache warm>[, cache expires in <label>]"`.
- Mode labels: "Keep cache warm", "Compact before the cache expires", "Keep cache warm, then compact".
- The tooltip has a per-state body; for example scheduled: "Next ping around <time> (<n> of 8 sent since your last message)."
- When there's a live cache the tooltip prefixes "Prompt cache expires around <time>.".

The only keep-alive toast (type info), shown when the heartbeat is armed and a click would turn the toggle off or the toggle is inactive:
- Title: "Cache is being kept warm by the subagent heartbeat"
- Description: HEARTBEAT_EXPLANATION, plus " Keep cache warm is now off, so pings won't continue after that." if the toggle was on.
- It turns the toggle off if it was on and does not turn it on.

Timeline: a message from createdBy system with the prefixed id gets attribution "cache-keep-alive" and the caption "Sent automatically to keep the prompt cache warm".

Quiet completion:
- ThreadNotificationCoordinator marks a status change quiet (no sound, toast or OS notification) when `latestRun.runId === cacheKeepAlive.lastNudgeRunId`.
- Sidebar `hasUnseenCompletion` returns false when `latestRun.runId === quietCacheKeepAliveRunId`, so an "ok" reply doesn't mark the thread unread.

Separate cache-expiry banners (web only, for threads where keep-alive is not active):
- Conditions:
  - not deleted, archived or settled, and not snoozed
  - `cacheKeepAliveActive` is false (a spent warm toggle brings the banner back)
  - `idleContextTokens >= minTokens`
  - driver is claudeAgent
  - `latestRun.completedAt` exists and `requestedAt` is not after it
  - `expires - 10min <= now < expires`, where expires = completedAt + 1h. This is completion time, not the provider-item anchor.
- Toast (warning, timeout 0, persistent across reloads, shown once per key `env:thread@completedAt`):
  - Title "Prompt cache expiring"
  - Description `“<title>” has <Nk|N.NM> tokens of context. Its cache expires at <time>; send a message before then to keep it warm.`
  - Action "Open conversation"
- With 2 or more open, an extra toast "<n> prompt caches expiring" with a "Dismiss all" action.

== 8. COUNTDOWN FORMAT ==
```ts
const minutes = Math.floor(remainingMs / 60_000);
return minutes < 1 ? "<1m" : `${minutes}m`;
```
- Tests: 55min → "55m", 54m59s → "54m", 1min → "1m", 59s → "<1m", 0 → "<1m".
- The UI ticks once a minute. `nowMs = Date.parse(\`${nowMinute}:00Z\`)`, where nowMinute is the ISO time truncated to `YYYY-MM-DDTHH:mm`.
- There is no hours format. The label shows nothing (null) when no live cache exists.

== 9. SUBAGENT HEARTBEAT ==
- `SUBAGENT_HEARTBEAT_PATTERN = /subagent[- ]heartbeat|subagent-status\.sh/i`.
- `cacheKeptWarmByHeartbeat(thread)` is true when any `pendingBackgroundTasks` entry has `kind === "command"` and a defined `description` matching the pattern.
- The description is the Bash tool description, or the command text when there is none.
- Subagent-kind tasks never match, even when described "Subagent heartbeat review".
- Test examples that match: "Subagent heartbeat", "Arm the subagent heartbeat", "bash ~/dotfiles/claude/bin/subagent-status.sh --wait 900".
- The mechanism, per the code comments: the maintainer's Claude Code setup runs a background `subagent-status.sh --wait` command (from dotfiles `claude/bin/subagent-status.sh`). It wakes the agent every 15 minutes (`--wait 900`) until the background subagents finish. Each wake is a request, so it refreshes the cache. A dotfiles hook asks for the Bash description "Subagent heartbeat".
- HEARTBEAT_EXPLANATION: "The agent is babysitting background subagents and checks in on them every 15 minutes. Each check-in refreshes the prompt cache, and they stop on their own once the subagents finish."
- Effect in the UI: the toggle reads as pressed and the tooltip title becomes "Kept warm by the subagent heartbeat". The countdown label is still computed, but the tooltip omits the "expires around" line.
- The server-side pinger does NOT look at the heartbeat. Background command tasks don't make a thread busy unless they are awaited.

== 10. AMBIGUITIES AND NOTES ==
- The task's "~55 min later" heartbeat claim isn't in this repo. The heartbeat here is every 15 min (`--wait 900`). The only 55-minute figure is the ping time (anchor + 60 − 5 min). The dotfiles script isn't public: `raw.githubusercontent.com/DanielGGordon/dotfiles/{main,master}/claude/bin/subagent-status.sh` returns 404, so its exact behaviour is unverified.
- "Rounded down, so it never overpromises" holds for `formatCacheExpiry` itself. But the UI's nowMs is floored to the start of the current minute, so the label can overstate the remaining time by up to about 59 s.
- The banner logic uses `completedAt + 1h` while keep-alive uses the provider-item anchor, so the two expiry times can disagree by minutes (checkpoint capture delays completion).
- The ping lands no earlier than 55 min, plus up to a 30 s sweep delay and dispatch time. The "55–57" range in the comments is an empirical estimate.
- A guard refusal is final for the idle period; only infrastructure failures retry, up to 3 attempts total. The attempt map is in memory, so after a server restart it is rebuilt from scratch. Attempt 1's command id is deterministic, so a resent attempt 1 would hit the existing command receipt.
