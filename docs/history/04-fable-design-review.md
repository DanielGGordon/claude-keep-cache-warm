# Fable 5.2 review of the design

> From the multi-agent build workflow (2026-11-17), before the later changes listed in HANDOFF.md. Local paths are replaced with placeholders.

```json
{
  "verdict": "approve-with-changes",
  "summary": "The core decision is sound and matches the types: an in-mod `$.clock.after` plus `$.prompt.submit({text, asUser: true})` can wake an idle session, so the background-command fallback is not the primary route. I confirmed the cited APIs exist as described (clock timers surviving between turns, submit queueing once idle, `asUser?: true`, `SiteView.agentId`, `BackgroundTaskSummary`, `ToolCheckApprover`, `session.end` 'clear' with no `session.start`).\n\nThe design should not be built as written, mainly because of cost and \"never pings\" risks:\n\n- **Wasted or duplicate pings:** `schedule()`/`firePing()` are re-entrant and can double-submit. The stale-ping guard may run at enqueue or not at all. Nothing detects a session whose cache does not last an hour.\n- **Never pings:** the `isInteractive` gate may disable the mod in the desktop app. `isWaiting`, `isHeldByBackground` and `busyTurnId` can stick and block pings silently.\n- **Spec gap:** the spec says to check first whether a timer-sent message works; the design decides this from the docs and leaves the fallback unbuilt.\n- **Churn:** every tool call triggers a state write, a status refresh, a timer re-arm and a band redraw.\n\nFixing the serialisation, moving the guard and ping count onto the ping turn's own `turn.start`/`turn.step`, adding the cache-read check, and dropping the headless gate would make it ready to build. Nothing here was run live; all findings come from reading the design against claude-code.d.ts and reference.md.",
  "issues": [
    {
      "severity": "high",
      "issue": "Double ping from re-entrant async code. `set()` runs update, refresh, then schedule from every hook, and hooks run concurrently (tool.call for parallel tools, turn.step, prompt.submit). Two overlapping `schedule()` calls both cancel the old timer, both await, and both arm a new one; the first handle is overwritten and can never be cancelled. `firePing()` then checks `lastPingAnchor` with a read and claims it in a separate update, so two firings can both pass the check and both submit. Each extra ping is a billed turn and counts toward the 8.",
      "fix": "Run schedule/refresh/firePing through one promise-chain mutex. Make the claim atomic: inside a single `update($, S, fn)`, decide due-and-unclaimed and set `lastPingAnchor`/`pingFiredAt`, and only submit if that updater claimed it. Add a harness test that fires two timers at the same mock time and expects exactly one prompt.submit."
    },
    {
      "severity": "high",
      "issue": "The stale-ping guard in section 6 is unreliable, so a ping can run straight after a fresh user turn. The types say `next(e)` resolves when the turn starts \"or it was queued behind the running one\", and origin is \"set by the engine where it was queued\", which suggests the prompt.submit hook runs at enqueue. A ping that races a turn start then queues and runs after that turn, on a cache that is already warm. Separately, `set()` and `ensureArmed()` overwrite `host` with the `$` of whichever hook ran last. If that is the prompt.submit hook's `$`, the submit may skip that hook entirely (\"every hook but the calling one\").",
      "fix": "Capture `host` only in session.start. Move the authoritative guard to dequeue time: record a pending-ping marker at submit, recognise the ping turn in main-thread `turn.start` (`e.text === PING_TEXT` plus the marker), and in `turn.step` for that turnId re-check staleness. If stale, answer without calling `next` (the types say this sends no request) so it costs nothing. Keep the prompt.submit guard only as an early exit. Confirm live that turn.start/turn.step hooks hear a turn started by the mod's own timer submit."
    },
    {
      "severity": "high",
      "issue": "Nothing verifies the one-hour TTL. The types never state the main thread's cache TTL; it may be 5 minutes for some accounts, providers or gateways. A model or effort switch, or a compaction, also replaces the cached prefix. In those cases every ping at +55 minutes rewrites the whole conversation to the cache at the write price, up to 8 times, which is the opposite of the feature's purpose.",
      "fix": "In `turn.step` for the ping turn's first request, read `usage.cache_read_input_tokens` and `cache_creation_input_tokens`. If the read is near zero and the creation is large, the cache was already cold: set a pause state such as 'not-caching', stop pinging, and toast that the cache is not lasting an hour here. Add a harness test for it."
    },
    {
      "severity": "high",
      "issue": "The headless gate may disable pinging in the desktop app. `schedule()` returns early when `session.start`'s `isInteractive` is false, and the types define that as \"true under the REPL, false for a -p run or the SDK\" with `surface` null \"which draw nowhere yet\". A desktop Code-tab session may well be SDK-hosted and attach its surface later, in which case the mod shows a countdown but never pings.",
      "fix": "Remove the `isHeadless` gate. The toggle can only be turned on from the band, so `isEnabled === true` already proves a surface and a person. If a gate is still wanted, check `(await $.session.surfaces()).length > 0` at fire time. Verify in the desktop app."
    },
    {
      "severity": "medium",
      "issue": "The spec's first step is skipped. It says to check first whether a mod can send a message on its own timer and, if not, to build the background-command fallback. The design answers from the docs, lists the live behaviour as unverified, and marks the fallback \"not built in v1\". If the live check fails, v1 does not meet the spec.",
      "fix": "Make a live probe the first build step: a throwaway mod that calls `$.clock.after(60_000)` then `$.prompt.submit` in an idle session on the target surface, confirming a turn starts and which hooks see it. Record the result in the README. Either implement the section 12 fallback behind a flag or state plainly that it will be built only if the probe fails."
    },
    {
      "severity": "medium",
      "issue": "Sticky flags can block pings indefinitely with no visible cause. (a) `isWaiting` is one boolean written by all agents: a background subagent's `tool.check` 'ask' that is denied or settled by the classifier may never reach `tool.call`, so it stays true while main is idle, and parallel tool calls clear it for each other. (b) `isHeldByBackground` is only recomputed at the next classic.Stop, so a subagent that ends or is killed without a notification turn leaves the state 'busy' forever. (c) `busyTurnId` after a worker respawn mid-turn may never be cleared, because the new copy did not hear the start; the watchdog needs `lastOutputAt` to be 2 hours old and never fires when it is null.",
      "fix": "Waiting only happens inside a turn, which is already skipped as busy, so make it display-only: track a set of pending `tool_use_id`s for the main agent and clear it on turn.complete. Replace the sticky background flag with a fresh `$.agent.list()` check inside firePing. Clear `busyTurnId` when a user prompt.submit arrives with `e.turnId === undefined`, and in session.start when no turn is evidently running."
    },
    {
      "severity": "medium",
      "issue": "Too much work on hot paths. Every `tool.call` (all agents) does a read plus a possible `set`, and every `set` does an update, a refresh (clock.now, two reads, status, a view write) and a schedule (cancel, read, clock.now, arm). The `view` atom includes `remainingMs`, which changes every millisecond, so the JSON comparison always differs and the band redraws on every event. The render hook also reads `S`, so it is subscribed to every logic write, contrary to the claim that the band redraws only when the text changes.",
      "fix": "Remove `remainingMs` from the stored View (or store whole minutes) and put `isEnabled` into View so the render reads only `V`. In hooks, skip the write when the value would not change. Skip schedule/refresh while a main turn is running and do one at turn.complete. Drop the tool.check and tool.call hooks if waiting becomes display-only via the cheaper route above."
    },
    {
      "severity": "medium",
      "issue": "Process-continuing session changes other than /clear are not handled. `session.end` for other reasons only cancels timers, but the types say \"after a /clear or a resume the process goes on under another\" session id. After an in-process resume the timers are dead with nothing to re-arm them, and `lastOutputAt`/`isEnabled` may carry into a different conversation, timing pings against the wrong cache. On a fresh-process `--resume`, `$.state` is empty, so the status says cold while the cache may still be live.",
      "fix": "Treat every session.end where the process continues like 'clear': reset the anchor and counters, and decide explicitly whether `isEnabled` survives. Hook `classic.SessionStart` (source 'resume'|'fork'|'clear'|'compact') to re-arm, and on resume or fork seed `lastOutputAt = now - seconds_since_last_response * 1000` unless `prompt_cache_likely_expired`."
    },
    {
      "severity": "medium",
      "issue": "The ping count depends on a closure that a reload can lose. `consecutivePings` and the toasts are updated only in the `.then` of `$.prompt.submit`. A hot reload or worker respawn between submit and turn start drops that continuation, so the ping runs uncounted with no toast, and a 9th ping becomes possible. `pingAttempts` is also only reset by a user message, so three thrown submits across different anchors disable retries permanently.",
      "fix": "Count from state, not the closure: increment `consecutivePings`, set `pausedAt` and show the toast in the main-thread `turn.start` handler when it recognises the ping turn. Use `.then` only for drop/throw handling. Reset `pingAttempts` whenever the anchor changes."
    },
    {
      "severity": "medium",
      "issue": "`isUserOrigin` is too generous for a cost cap. It counts 'auto-continuation' and 'unclassified' (and 'sdk' wholesale) as user messages. An autonomous continuation would reset the 8-ping budget and unpause the toggle without the person present, defeating the limit.",
      "fix": "Count only composer, bridge, sdk, slack-ping and channel, and only when `!e.isMeta`. Exclude auto-continuation and unclassified; an unneeded pause is cheaper than unbounded pings. Add test rows for these origins."
    },
    {
      "severity": "low",
      "issue": "`ensureArmed` cannot detect a refused timer and is mostly redundant. A refused `clock.after` never runs `fn`, so `pingTimer` stays non-null and `ensureArmed` never re-arms. Conversely `pingTimer` is null in every non-scheduled state, so it calls `schedule()` needlessly. It is also only wired into prompt.submit, not \"every hook\" as section 9 says.",
      "fix": "Store the armed deadline next to the handle. Any event that sees `now > deadline + slack` with a ping still due re-arms. Otherwise delete `ensureArmed` and rely on the serialised `schedule()`."
    },
    {
      "severity": "low",
      "issue": "`hasFailed` depends on hook ordering. `turn.complete` writes `hasFailed = (reason === 'error')` and `classic.StopFailure` writes true; depending on which fires last, a failure such as max_output_tokens or rate_limit can be overwritten to false.",
      "fix": "Reset `hasFailed` only at main `turn.start`. Within a turn, only ever set it to true (from either event), so the result does not depend on order."
    },
    {
      "severity": "low",
      "issue": "Several UX rough edges. (1) A drop by the mod's own guard produces the toast \"Keep-alive ping not sent: keep-cache-warm: ping no longer needed\" for a benign case. (2) The paused and failed states hide the countdown although the cache is live; after the 8th ping it is warm for a full hour. (3) The band row and \"Cache: off\" status are permanent in every session even when the feature is unused, and `isCollapsed` is ignored. (4) The band returns its own tree without composing `next(e)`. (5) Keeping `isEnabled` across /clear conflicts with \"for the current session\".",
      "fix": "Suppress the toast for own-guard drops. Show the remaining time in the band for paused and failed states. Keep the off band to a short label plus button and honour `isCollapsed`. Check against examples/band.tsx how a band coexists with other mods' rows. Reset `isEnabled` on /clear, or document why it is kept."
    },
    {
      "severity": "low",
      "issue": "The anchor is the request send time, and only `turn.step` requests are tracked. The spec says the hour counts \"from the model's last output\"; send time under-reports by the length of the last step, so the ping fires slightly early. Other main-thread requests that touch the cache (compaction, another mod's `$.model.fork`) are not seen. After a compaction the old prefix is gone, so the countdown overstates what is cached.",
      "fix": "Document the conservative choice, or stamp at step end to match the spec wording; the 5-minute lead covers either. On `session.compact`, re-anchor to now. The cache-read check on the ping turn is the backstop for the rest."
    },
    {
      "severity": "low",
      "issue": "The test plan misses the risky paths: concurrent schedule/fire, reload between submit and turn start, a ping queued behind a turn that just started, a cold-cache ping (zero cache read), in-process resume, and the non-user origins.",
      "fix": "Add harness scenarios for each. Assert exactly one prompt.submit per anchor, no model request for a stale ping turn, and a pause after a ping whose cache read is zero."
    }
  ]
}
```
