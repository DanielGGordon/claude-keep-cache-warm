# Design (design agent)

> From the multi-agent build workflow (2026-11-17), before the later changes listed in HANDOFF.md. Local paths are replaced with placeholders.

KEEP-CACHE-WARM MOD: DESIGN (Claude Code 2.1.325 mod API)

Paths used below:
T = <plugin-authoring skill>/types/claude-code.d.ts
MOD = <mod folder>

====================================================================
0. VERDICT: USE AN IN-MOD TIMER ($.clock.after + $.prompt.submit), NOT THE BACKGROUND-COMMAND FALLBACK
====================================================================
A mod can send a message into the session on its own timer.
- `$.clock.after/every` timers keep running between turns until they are cancelled or the module reloads (reference.md lines 253-261). A 55-minute delay (3.3e6 ms) is far below the timer ceiling (2^31-1 ms).
- `$.prompt.submit({ text, asUser })` (T:3151-3163) "queues a prompt that starts a turn of its own once the session is idle", so background work can wake a quiet session. It resolves to `{text,...}` or `{drop}` (T:10124-10160).
- The fallback is not needed. A model-run `Bash run_in_background sleep 3300` would cost a model turn to arm, needs permission, and cannot be started by the mod itself. `$.process.spawn` cannot wake the session.
- Contingency (section 12) if the live check fails: on the first `{drop}` caused by the engine, the band offers the heartbeat route. It is not built in v1.
- `$.model.fork` is also rejected. The spec says "send exactly this prompt" and to skip while a turn runs, which describes a real session turn. Also, the types never say whether a fork read refreshes the main entry's 1-hour TTL (T:6815-6851 warns that effort mismatches create a new entry). It is noted as a possible v2 "silent mode".

====================================================================
1. FILE LIST
====================================================================
MOD/.claude-plugin/plugin.json
  { "name": "keep-cache-warm", "version": "0.1.0",
    "description": "Keeps the Claude prompt cache warm: a band toggle, a status-line countdown, and a keep-alive ping about 5 minutes before the 1-hour cache expires.",
    "types": "./types/index.d.ts" }
MOD/hooks/hooks.json      { "modules": ["./register.tsx"] }
MOD/hooks/register.tsx    the hooks: events, timers, band. It registers NO command; `$.command.register` is never called.
MOD/hooks/logic.ts        pure logic: constants, cacheState(), formatRemaining(), statusText(), bandText(), isUserOrigin(). It has no `$` and is unit-testable. If `claude plugin validate` refuses a runtime relative import, inline it into register.tsx and export the pure functions from there.
MOD/types/index.d.ts      the PluginState contract (section 2).
MOD/tests/logic.test.ts   pure tests: formatting, state order, origin classification.
MOD/tests/register.test.tsx  harness tests with `mock.clock(on, {now})` from 'claude-code/testing' (T:17728-17830), observing the `ui.status`, `ui.toast` and `prompt.submit` events.

====================================================================
2. PLUGINSTATE CONTRACT (types/index.d.ts)
====================================================================
```ts
export type KeepWarm = {
  isEnabled: boolean            // per-session toggle; default false (t3code: null = off)
  lastOutputAt: number | null   // ANCHOR: epoch ms when the last main-thread model request that returned usage was SENT
  busyTurnId: string | null     // main turn running (turn.start .. turn.complete)
  isWaiting: boolean            // permission prompt / AskUserQuestion / ExitPlanMode / MCP elicitation pending
  isHeldByBackground: boolean   // classic.Stop listed background subagent/workflow tasks (t3code backgroundWorkHoldsCompletion)
  hasFailed: boolean            // last main turn ended reason 'error' (or classic.StopFailure)
  consecutivePings: number      // pings accepted since the user's last message (t3code nudgeCount)
  pausedAt: number | null       // set when consecutivePings reaches 8
  lastPingAnchor: number | null // the lastOutputAt a ping was already sent for: one ping per idle period
  pingFiredAt: number | null    // set when a ping is submitted; cleared when it is accepted or dropped (in-flight marker)
  pingAttempts: number          // submit attempts for the current anchor (only throws retry; max 3)
  lastUserAt: number | null     // when the user last submitted a message
  hasHeartbeat: boolean         // a background shell task matches /subagent[- ]heartbeat|subagent-status\.sh/i (band note only)
}
export type Kind = 'off'|'paused'|'waiting'|'busy'|'cold'|'scheduled'|'due'
export type View = { kind: Kind; status: string; band: string; remainingMs: number | null }

declare module 'claude-code' {
  interface PluginState {
    'keep-cache-warm': { s: Shaped<KeepWarm>; view: View | null }
  }
}
```
- All the logic state lives in ONE atom (`s`), so `update($, S, fn)` changes it atomically with ifVersion retry. A shape tag (`{shape:'kw-1'}`) declines the value stored by an older version after a reload.
- `view` is a derived display atom. Only refresh() writes it, and only when it changes, so the band redraws exactly when the text changes.
- `$.store` is not used, because the spec says the toggle is "for the current session".

====================================================================
3. STATE MACHINE (logic.ts cacheState(s, now)): first match wins, mirroring t3code section 3
====================================================================
```
expiresAt = lastOutputAt + TTL_MS (60 min);  pingAt = expiresAt - LEAD_MS (5 min) = lastOutputAt + 55 min
1 !isEnabled                                     -> off      status "Cache: off"
2 pausedAt !== null                              -> paused   status "Cache: paused"
3 isWaiting                                      -> waiting  status "Cache: waiting"
4 busyTurnId || pingFiredAt || isHeldByBackground -> busy    status "Cache: busy"
5 hasFailed                                      -> cold     status "Cache: cold"   (band: "last turn failed")
6 lastOutputAt === null                          -> cold     status "Cache: cold"   (band: "no model output yet")
7 now >= expiresAt                               -> cold     status "Cache: cold"   (band: "expired"; a lapsed cache is never pinged)
8 now >= pingAt                                  -> due       status "Cache: <N>m"
9 otherwise                                      -> scheduled status "Cache: <N>m"
```
- Countdown: `remaining = expiresAt - now; m = Math.floor(remaining/60_000); label = m < 1 ? "<1m" : `${m}m``. There is no hours format (t3code test cases: 55m->"55m", 54m59s->"54m", 1m->"1m", 59s->"<1m").
- Spec deviation: "waiting" is a state of its own for display. In t3code it is part of busy (pendingRuntimeRequest). Both skip the ping.
- The status line shows exactly one of: "Cache: 42m", "Cache: <1m", "Cache: off", "Cache: busy", "Cache: waiting", "Cache: paused", "Cache: cold".
- Off still keeps tracking the anchor, so the band can say "cache expires in 42m" even when off (t3code's countdown also counts with the toggle off). The status line itself says "Cache: off", as the spec requires.

====================================================================
4. WHICH EVENT UPDATES WHICH FIELD
====================================================================
Every hook filters to the main thread (`e.agentId === undefined` / `agent_id` absent), except where noted. Every observer returns `next(e)`.

| Event | Fields it updates |
|---|---|
| `turn.step` (streaming; `async function*`) | `sentAt = await $.clock.now()` BEFORE `yield* next(e)`. If `result.usage != null`, then `lastOutputAt = max(lastOutputAt ?? 0, sentAt)`. Request-send time is used, not response end, because the cache entry is read and refreshed when the request is processed. This is conservative and matches t3code's use of `startedAt`. Steps with a null usage (no response) do not count. Subagent steps are ignored (separate prefix and cache). |
| `turn.start` | `busyTurnId = e.turnId` |
| `turn.complete` | `busyTurnId = null`, `isWaiting = false`, `pingFiredAt = null`, `hasFailed = (e.reason === 'error')`. 'answer' and 'refusal' count as success. 'aborted' leaves hasFailed false and keeps whatever anchor the turn's own steps stamped; we know the exact step times, so unlike t3code there is nothing to guess. Then refresh + schedule. |
| `classic.StopFailure` | `hasFailed = true` (backstop for auth/billing/rate-limit failures). |
| `classic.Stop` | `isHeldByBackground = background_tasks.some(t => t.type === 'subagent' \|\| t.type === 'workflow')`; `hasHeartbeat = background_tasks.some(t => t.type === 'shell' && HEARTBEAT_RE.test(t.description \|\| t.command))`. Shell and monitor tasks do not hold, as in t3code. The next Stop recomputes both. |
| `tool.check` (all agents) | `r = await next(e)`. If `r.decision === 'ask' && e.approver !== 'host'`, set `isWaiting = true`. |
| `tool.call` (all agents) | For AskUserQuestion / ExitPlanMode, set `isWaiting = true` before `next`. Always `try { return await next(e) } finally { if (isWaiting) isWaiting = false }`. The `next` span covers the permission prompt. |
| `classic.Notification` | `notification_type` in {'permission_prompt','elicitation_dialog'} sets `isWaiting = true`. 'idle_prompt' is ignored. Verify the strings live. |
| `classic.ElicitationResult` | `isWaiting = false` |
| `prompt.submit`, own ping (origin.kind 'plugin' && name 'keep-cache-warm') | Dispatch-time guard (section 6). Never resets the counter. |
| `prompt.submit`, user (`isUserOrigin`) | `r = await next(e)`. If `!r.drop`: `consecutivePings = 0`, `pausedAt = null`, `lastPingAnchor = null`, `pingAttempts = 0`, `lastUserAt = now`. This is the t3code reset, and it also resumes a paused toggle. |
| `session.end` reason 'clear' | `lastOutputAt = null`, `hasFailed = false`, `busyTurnId = null`, `isWaiting = false`, `consecutivePings = 0`, `pausedAt = null`, `lastPingAnchor = null`. `isEnabled` is kept. The old prefix is dead (no `session.start` follows a /clear). |
| `session.end` (other reasons) | Cancel timers. |
| `session.start` | Capture `$`, clear a stale `pingFiredAt` (older than 2 min; its `.then` was lost in a reload), clear `busyTurnId` only if `lastOutputAt` is more than 2 h old (watchdog), then refresh + schedule. |

`isUserOrigin(origin, isMeta)`, the analogue of t3code's `isUserActivity`:
- true for: composer, bridge, sdk (the desktop Code tab may arrive as sdk), slack-ping, channel, auto-continuation, and unclassified when `!isMeta`.
- false for: plugin (any plugin, including ours and asUser ones), task-notification, scheduled-trigger, peer, peer-send-message, projects-relay, coordinator, observer, observer-activity.
- This matches t3code: `createdBy === "user"` and not scheduled and not server-created.

Why the mod's ping never resets the counter: its prompt.submit origin is `{kind:'plugin', name:'keep-cache-warm', asUser:true}`. The `asUser` flag only changes what the model reads; hooks still see the plugin origin (T:9862-9886). isUserOrigin returns false for every 'plugin' origin.

====================================================================
5. PING SCHEDULING
====================================================================
`schedule($)` is called after every state change: each event above, the toggle, session.start, and a ping result.
- It cancels the module-level `pingTimer`.
- It computes `cacheState`. If the kind is 'scheduled' or 'due' and `lastPingAnchor !== lastOutputAt`, it arms `pingTimer = $.clock.after(max(0, pingAt - now), () => firePing())`.
- Each new output moves lastOutputAt, so the ping re-arms at newAnchor + 55m. The ping turn's own output therefore chains the next ping one hour on.

`firePing()` uses the last captured `$`:
1. Re-read state, `now`, and `cacheState`.
2. Skip unless the kind is 'due' AND `lastPingAnchor !== lastOutputAt` AND `pingAttempts < 3`.
   The kind check covers every spec skip: off, paused, busy (turn running), waiting on the user, failed turn, already expired (cold), and no output.
3. Write `pingFiredAt = now`, `lastPingAnchor = lastOutputAt`, `pingAttempts += 1`.
4. Call `void $.prompt.submit({ text: PING_TEXT, asUser: true }).then(onResult, onThrow)`. NEVER await it inside a hook (deadlock, T:12714). The timer callback is not a hook; it is still fire-and-forget.
5. onResult, accepted (no drop):
   - `consecutivePings += 1`, `pingFiredAt = null`.
   - If `consecutivePings >= 8`: `pausedAt = now`, then toast PAUSE_TOAST (it already says the 8th ping went out). This pauses right on the 8th ping, whose cache stays warm for the hour, as in t3code.
   - Otherwise toast `Keep-alive ping sent to keep the prompt cache warm (${n} of 8).`
6. onResult, `{drop}`: `pingFiredAt = null`. Leave lastPingAnchor set: a refusal is final for this idle period, as in t3code. Toast `Keep-alive ping not sent: ${drop}`. The status then counts down to cold.
7. onThrow (infrastructure): `pingFiredAt = null`, `lastPingAnchor = null`. If `pingAttempts < 3`, re-arm `after(30_000)` (t3code MAX_ATTEMPTS = 3, retries only after infrastructure failures).

PING_TEXT, exactly as the user spec gives it (curly quotes; the user spec wins over t3code's straight quotes):
  `Keep-alive ping to keep the prompt cache warm. No action needed — just reply “ok”.`
`asUser: true` makes the model read the text bare ("send exactly this prompt"). Without it the model would read "The keep-cache-warm plugin sent a message: ...". The transcript shows it as a UserMessage row with `origin.name = 'keep-cache-warm'`.

The ping lands no earlier than anchor + 55m, plus timer jitter and queueing. t3code adds up to a 30 s sweep delay; this mod has none.

====================================================================
6. DISPATCH-TIME GUARD (analogue of t3code's Orchestrator guard)
====================================================================
The mod's own `prompt.submit` hook sees its own timer-sent submission ("every hook but the calling one"; a timer has no calling hook).
- When the origin is its own, it re-checks and returns `{ drop: 'keep-cache-warm: ping no longer needed' }` if any of these holds:
  - `!isEnabled`
  - `pausedAt !== null`
  - `hasFailed`
  - `lastUserAt > pingFiredAt` (the user wrote in the meantime)
  - `lastOutputAt !== lastPingAnchor` (newer output already refreshed the cache)
  - `now >= lastOutputAt + TTL` (expired)
- Otherwise it returns `next(e)`.
- The guard is best-effort. If the engine dispatches the hook at enqueue rather than dequeue, the race in section 10d remains. Pin this down in register.test.tsx and live.

====================================================================
7. STATUS REFRESH CADENCE AND FLOOR ROUNDING
====================================================================
`refresh($)` is called after every state write and by `tickTimer`.
- It computes the View. If `view.status` changed, it calls `$.ui.status(view.status)`. If the View changed, it writes the `view` atom (the band redraws; no `$.ui.invalidate` is needed).
- It re-arms `tickTimer` only while a live cache exists (`now < expiresAt`, including when the toggle is off, for the band):
  `delay = min(remainingMs % 60_000 || 60_000, remainingMs) + 100`.
  Each tick lands about 100 ms after the floored minute flips, so the label never overstates by more than about 100 ms plus jitter. That is better than t3code's whole-minute floor (up to 59 s over).
  The `min(..., remainingMs)` makes the expiry instant tick too, which turns the status to "Cache: cold".
- No tick runs in states without a countdown. Events drive those.
- No `Date` is used; time comes from `$.clock.now()`. The band shows relative times ("ping in 13m"), not wall-clock times.

====================================================================
8. TOGGLE UI (band, per session)
====================================================================
`on('ui.render', {component:'AbovePrompt'}, ...)`:
- If `e.props.hasSurvey` or `e.props.view.agentId !== undefined`, return `next(e)`.
- Read the `s` and `view` atoms, then `const {Box, Text, Button} = $.ui.resolve(e)`.
- Render one row: a `Text wrap="truncate-end"` sized to `bodyColumns`, then the buttons. Every Button has a `key`; there are no hotkeys.

Band text and buttons per state:

| State | Band text | Buttons |
|---|---|---|
| off | "Keep cache warm: off · cache expires in 42m" (or just "Keep cache warm: off" with no live cache) | [Keep cache warm] key="toggle" |
| scheduled / due | "Keeping cache warm · expires in 42m · ping in 37m (3 of 8 sent since your last message)" | [Stop] key="toggle" |
| busy | "Keeping cache warm · turn running" (or "· background subagents running") | [Stop] key="toggle" |
| waiting | "Keeping cache warm · waiting on you" | [Stop] key="toggle" |
| cold | "Keeping cache warm · cache cold (expired / no model output yet / last turn failed); your next message warms it" | [Stop] key="toggle" |
| paused | "Keep cache warm paused after 8 pings with no message from you" | [Resume] key="resume", [Turn off] key="off" |

- With a heartbeat, the band appends "· also kept warm by the subagent heartbeat". This is informational and does not change behaviour; the t3code server pinger ignores the heartbeat too.

Button actions (onPress; not a render, so state writes are allowed):
- Turn on (from off): `isEnabled = true`, `consecutivePings = 0`, `pausedAt = null`, `lastPingAnchor = null`, `pingAttempts = 0`. A fresh budget, matching t3code `nextCacheKeepAlive`. If the state is then cold, toast "Keep cache warm is on. The cache is cold; it will be kept warm after your next message."
- Stop / Turn off: `isEnabled = false`, and the counter fields are reset (t3code stores null when off).
- Resume: `pausedAt = null`, `consecutivePings = 0`, `lastPingAnchor = null`. A fresh budget, as in t3code re-enabling while paused.
- Every action is followed by `refresh($); schedule($)`.

Surfaces: the band draws on terminal, desktop and mobile, but not vscode (T:11383 notes). In VS Code the status line still shows but there is no toggle. A Pane can be added later if needed.

====================================================================
9. HOT RELOAD / WORKER RESPAWN
====================================================================
- A reload cancels the timers and resets module variables (`pingTimer`, `tickTimer`, `host`). `$.state` (`s`, `view`) survives.
- `session.start` runs again after a reload, enable or worker respawn (T:4658-4668). It recaptures `$`, clears a stale `pingFiredAt`, calls `$.ui.status(...)` again, and re-arms both timers from `$.state`. If pingAt has already passed and the cache is still live, the ping fires immediately.
- Defence against a refused `clock.after` period (another plugin can kill it, T:3710): every hook calls `ensureArmed($)`, which runs schedule() if `pingTimer === null`.
- After `/clear` there is no session.start; the session.end('clear') branch handles it.

====================================================================
10. EDGE CASES
====================================================================
a) Toggle on with no output yet: the state is cold ("Cache: cold", band "no model output yet") and there is no timer. The first main turn's step stamps lastOutputAt, then turn.complete schedules a ping at +55m.
b) Toggle on when the cache is already cold (expired or failed): status "Cache: cold", with a toast explaining it. No ping is ever sent to revive a lapsed cache, since that would be a full cache write (t3code). The next user turn re-arms it.
   Toggle on at 56-59 min (due, not expired) pings immediately. That is intended: t3code's sweep would too.
c) The ping turn itself fails (reason 'error' or StopFailure): `hasFailed = true`, so the state is cold and no further pings go out until a successful turn (normally the user's). The ping already counted when it was accepted.
   - A ping dropped by a hook or engine is final for that anchor, with a toast.
   - A ping whose submit throws retries at most twice, 30 s apart, while still 'due'.
   - A ping turn the user interrupts (Esc) is aborted, not failed. Its steps that returned usage still move the anchor. Esc is not a message, so the counter is not reset.
d) The user types while a ping is in flight.
   - The user's prompt goes through prompt.submit with a user origin, so it resets the counter on acceptance. That happens whether it folds into the running ping turn (turnId set) or queues behind it.
   - If the user submits between fire and the ping's turn start, the guard in section 6 drops the stale ping (lastUserAt > pingFiredAt).
   - A draft sitting in the composer does NOT stop the ping, since the cache would otherwise die. Verify live that a plugin submit leaves the draft intact (`$.prompt.read()` can confirm).
e) Background subagents running (classic.Stop listed them): the state is busy, with no ping, as in t3code. Their completion notification starts a turn, which re-anchors the cache.
   A subagent-heartbeat or any other wake that produces output moves the anchor, so pings defer naturally.
f) Headless `-p`/SDK runs (`session.start` `isInteractive` false): do not arm the ping timer, since nothing would draw and the process exits. Only track state.
g) Completion of a ping turn: Claude Code's own idle notification or sound may fire, and a mod cannot suppress the engine's notification. t3code's "quiet completion" is a known gap.
h) Spec limit: "8 pings in a row with no message from the user". Messages from scheduled tasks, task notifications or other plugins do not reset the counter. Their output still moves the anchor, which defers pings.

====================================================================
11. register.tsx PSEUDO-CODE
====================================================================
```tsx
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { KeepWarm, View } from '../types'
import { TTL_MS, LEAD_MS, MAX_PINGS, RETRY_MS, MAX_ATTEMPTS, PING_TEXT, HEARTBEAT_RE,
         INITIAL, cacheState, toView, isUserOrigin } from './logic'

const NAME = 'keep-cache-warm'
const S = atom({ plugin: 'keep-cache-warm', key: 's' } as const, INITIAL, { shape: 'kw-1' })
const V = atom({ plugin: 'keep-cache-warm', key: 'view' } as const, null)

export const register: Register = on => {
  let host: EngineInterface | null = null       // latest $, used by timer callbacks
  let pingTimer: { cancel(): void } | null = null
  let tickTimer: { cancel(): void } | null = null
  let lastStatus: string | undefined
  let isHeadless = false

  const set = async ($, fn: (s: KeepWarm) => KeepWarm) => {
    host = $
    await update($, S, fn)
    await refresh($)
    await schedule($)
  }

  async function refresh($) {
    const s = await read($, S); const now = await $.clock.now()
    const v: View = toView(s, now)                 // {kind,status,band,remainingMs}
    if (v.status !== lastStatus) { lastStatus = v.status; $.ui.status(v.status) }
    const old = await read($, V)
    if (JSON.stringify(old) !== JSON.stringify(v)) await update($, V, () => v)
    tickTimer?.cancel(); tickTimer = null
    if (v.remainingMs !== null && v.remainingMs > 0) {
      const d = Math.min(v.remainingMs % 60_000 || 60_000, v.remainingMs) + 100
      tickTimer = $.clock.after(d, () => { if (host) void refresh(host) })
    }
  }

  async function schedule($) {
    pingTimer?.cancel(); pingTimer = null
    if (isHeadless) return
    const s = await read($, S); const now = await $.clock.now()
    const st = cacheState(s, now)
    if ((st.kind === 'scheduled' || st.kind === 'due') && s.lastPingAnchor !== s.lastOutputAt) {
      pingTimer = $.clock.after(Math.max(0, st.pingAt - now), () => { pingTimer = null; if (host) void firePing(host) })
    }
  }
  const ensureArmed = ($) => { host = $; if (!pingTimer) void schedule($) }

  async function firePing($) {
    const now = await $.clock.now(); const s = await read($, S)
    const st = cacheState(s, now)
    if (st.kind !== 'due' || s.lastPingAnchor === s.lastOutputAt || s.pingAttempts >= MAX_ATTEMPTS) return
    await update($, S, v => ({ ...v, pingFiredAt: now, lastPingAnchor: v.lastOutputAt, pingAttempts: v.pingAttempts + 1 }))
    await refresh($)                                // shows "Cache: busy"
    void $.prompt.submit({ text: PING_TEXT, asUser: true }).then(async r => {
      const at = await $.clock.now()
      if (r.drop !== undefined) {
        await set($, v => ({ ...v, pingFiredAt: null }))
        $.ui.toast(`Keep-alive ping not sent: ${r.drop}`); return
      }
      let n = 0
      await set($, v => { n = v.consecutivePings + 1
        return { ...v, pingFiredAt: null, consecutivePings: n, pausedAt: n >= MAX_PINGS ? at : v.pausedAt } })
      $.ui.toast(n >= MAX_PINGS
        ? `Keep cache warm paused: ${MAX_PINGS} pings in a row with no message from you. The cache stays warm for about another hour; send a message or press Resume to continue.`
        : `Keep-alive ping sent to keep the prompt cache warm (${n} of ${MAX_PINGS}).`)
    }, async () => {
      await set($, v => ({ ...v, pingFiredAt: null, lastPingAnchor: null }))  // throw: retry (≤3 attempts)
      pingTimer?.cancel(); pingTimer = $.clock.after(RETRY_MS, () => { pingTimer = null; if (host) void firePing(host) })
    })
  }

  on('session.start', async ($, e, next) => {
    host = $; isHeadless = !e.isInteractive
    const now = await $.clock.now()
    await update($, S, v => ({ ...v,
      pingFiredAt: v.pingFiredAt !== null && now - v.pingFiredAt > 120_000 ? null : v.pingFiredAt,
      busyTurnId: v.busyTurnId && v.lastOutputAt !== null && now - v.lastOutputAt > 2 * TTL_MS ? null : v.busyTurnId }))
    lastStatus = undefined
    await refresh($); await schedule($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await set($, v => ({ ...INITIAL, isEnabled: v.isEnabled }))
    else { pingTimer?.cancel(); tickTimer?.cancel(); pingTimer = tickTimer = null }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    ensureArmed($)
    if (e.origin.kind === 'plugin' && e.origin.name === NAME) {      // our own ping: dispatch-time guard
      const s = await read($, S); const now = await $.clock.now()
      const stale = !s.isEnabled || s.pausedAt !== null || s.hasFailed
        || (s.lastUserAt ?? 0) > (s.pingFiredAt ?? Infinity)
        || s.lastOutputAt !== s.lastPingAnchor
        || s.lastOutputAt === null || now >= s.lastOutputAt + TTL_MS
      return stale ? { drop: 'keep-cache-warm: ping no longer needed' } : next(e)
    }
    const r = await next(e)
    if (r.drop === undefined && isUserOrigin(e.origin, e.isMeta)) {
      const now = await $.clock.now()
      await set($, v => ({ ...v, consecutivePings: 0, pausedAt: null, lastPingAnchor: null, pingAttempts: 0, lastUserAt: now }))
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await set($, v => ({ ...v, busyTurnId: e.turnId }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    const r = yield* next(e)
    if (r.usage != null) {
      await update($, S, v => ({ ...v, lastOutputAt: Math.max(v.lastOutputAt ?? 0, sentAt) }))
      void refresh($)          // no schedule here; turn.complete re-arms
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined)
      await set($, v => ({ ...v, busyTurnId: null, isWaiting: false, pingFiredAt: null, hasFailed: e.reason === 'error' }))
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (!e.agent_id) await set($, v => ({ ...v, hasFailed: true }))
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    if (!e.agent_id) {
      const t = e.background_tasks ?? []
      await set($, v => ({ ...v,
        isHeldByBackground: t.some(x => x.type === 'subagent' || x.type === 'workflow'),
        hasHeartbeat: t.some(x => x.type === 'shell' && HEARTBEAT_RE.test(x.description || x.command || '')) }))
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === 'ask' && e.approver !== 'host') await set($, v => ({ ...v, isWaiting: true }))
    return r
  })
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') await set($, v => ({ ...v, isWaiting: true }))
    try { return await next(e) }
    finally { const s = await read($, S); if (s.isWaiting) await set($, v => ({ ...v, isWaiting: false })) }
  })
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog')
      await set($, v => ({ ...v, isWaiting: true }))
    return next(e)
  })
  on('classic.ElicitationResult', async ($, e, next) => { await set($, v => ({ ...v, isWaiting: false })); return next(e) })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const view = await read($, V); const s = await read($, S)
    if (!view) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const press = (fn: (v: KeepWarm) => KeepWarm) => () => void set($, fn)
    const fresh = (v: KeepWarm) => ({ ...v, consecutivePings: 0, pausedAt: null, lastPingAnchor: null, pingAttempts: 0 })
    return (
      <Box>
        <Text dimColor wrap="truncate-end">{view.band} </Text>
        {view.kind === 'paused' ? (<>
          <Button key="resume" label="Resume" onPress={press(fresh)} />
          <Button key="off" label="Turn off" onPress={press(v => ({ ...fresh(v), isEnabled: false }))} />
        </>) : (
          <Button key="toggle" label={s.isEnabled ? 'Stop' : 'Keep cache warm'}
            onPress={press(v => ({ ...fresh(v), isEnabled: !v.isEnabled }))} />
        )}
      </Box>
    )
  })
}
```
Notes on the pseudo-code:
- Writes are never made inside the render hook; onPress runs outside the render.
- The "toggle on while cold" toast goes in the onPress, after `set`, by reading the new state.
- The `set()` helper also re-schedules, so every event re-arms the ping timer.
- Check the exact Text `wrap` values against T:1739, which lists 'wrap' | 'truncate-end'.

====================================================================
12. CONTINGENCY (ONLY IF THE LIVE CHECK SHOWS $.prompt.submit CANNOT WAKE AN IDLE SESSION)
====================================================================
If a timer-sent submit never starts a turn, or always comes back with an engine `{drop}`:
- The Turn-on button would instead submit a one-time instruction (while idle) asking the model to run a background Bash `sleep 3300` described as "Keep-cache-warm heartbeat". It reuses t3code's heartbeat pattern, but at 55 minutes rather than 15.
- Its task-notification wakes the session, which refreshes the cache and re-arms the next one.
- The countdown, counter and pause logic stay the same. The count would advance on each heartbeat-notification turn instead of on accepted pings.
- Not built in v1.

====================================================================
13. TESTS (claude plugin test MOD)
====================================================================
Pure tests (tests/logic.test.ts):
- formatRemaining, with t3code's five cases.
- cacheState order: paused beats busy; failed means cold; expired means cold; 55m means due.
- isUserOrigin: composer, sdk and bridge are user; plugin, task-notification and scheduled-trigger are not.

Harness tests (tests/register.test.tsx, using `mock.clock(on, {now: 0})`; record `ui.status`, `ui.toast` and `prompt.submit` via `on(...)`). Each scenario below is drive, then expect:

| Scenario | Expected |
|---|---|
| session.start, toggle on, then a main turn whose step returns usage at t0 | status "Cache: 60m", then "Cache: 42m" after 18m |
| Advance to t0 + 55m | exactly one prompt.submit, with text === PING_TEXT, origin plugin/keep-cache-warm, asUser; toast "(1 of 8)"; the counter is NOT reset by its own submit |
| Eight ping cycles | after the 8th: "Cache: paused" and the pause toast; no 9th submit |
| A composer prompt.submit while paused | counter 0, unpaused |
| turn.complete reason 'error' | "Cache: cold", no submit at +55m |
| Busy at +55m (turn.start without complete) | no submit |
| Expiry with no ping (lastPingAnchor already set) | "Cache: cold" at exactly +60m |
| Floor rounding | 54m59s left shows "54m" |

Then run `claude plugin validate MOD` and a tsc type-check. The validate output must list no command registration.

Unverified points to confirm live:
- (1) Whether the prompt.submit hook fires at enqueue or at dequeue for a plugin's own idle submit (this decides the strength of the guard).
- (2) The `notification_type` strings.
- (3) That a plugin submit leaves a composer draft intact.
- (4) That the band appears in the desktop app.
- (5) That `$` captured in session.start stays usable from timer callbacks. reference.md:253-261 implies it does.

