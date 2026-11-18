# Claude Code mod API findings (research agent)

> From the multi-agent build workflow (2026-11-17), before the later changes listed in HANDOFF.md. Local paths are replaced with placeholders.

KEEP-CACHE-WARM: MOD API FINDINGS (Claude Code 2.1.325)
T = <plugin-authoring skill>/types/claude-code.d.ts
R = <plugin-authoring skill>/reference.md
Examples: .../plugin-authoring/examples/band.tsx (an atom-backed band toggle) and pane.tsx (a Shaped atom).

=== 1. Can a mod send a prompt on its own timer while the session is idle? Yes.

Timers:
- `$.clock` is at T:3671-3717.
  - `now(): Promise<number>` (epoch ms).
  - `sleep(ms, {signal})`.
  - `after: TimerCall` ("Calls fn once after ms").
  - `every: TimerCall` ("Calls fn every ms milliseconds (at least 1) until cancel()").
- `TimerCall = (ms: number, fn: () => void) => Timer` (T:14598).
- `Timer = { cancel(): void }` (T:14585-14596).
- The argument is `ClockWait { ms: number }`, "a non-negative number of milliseconds" (T:1677).
- Maximum duration: there is no explicit cap on `after`/`every`. Elsewhere the file says "held to what a timer holds (2147483647)" (T:6654, about `model.complete` `timeoutMs`). Treat about 24.8 days as the ceiling. 55 or 60 minutes (3,300,000-3,600,000 ms) is fine.
- Timers keep running between turns. R:253-261 says to start background work "from a `session.start` hook ... and keep it going with `$.clock.every` and `$.clock.after`, whose timers run until cancelled or until the module reloads."
- Each period is a hookable dispatch: events `'clock.after'` / `'clock.every'` (T:7726-7734). "a refused period ends the interval" (T:3710). Another plugin can therefore kill your interval. Re-arm defensively, for example by re-checking on `turn.complete`.
- A hot reload cancels pending timers (T:3674-3676; R:120). Module variables reset.
- `register(on, options)` has no `$`, so timers must be started from a hook. `session.start` fires "once per process for each loaded plugin, before the first prompt, then once per fresh load of one (never /clear) ... A later one runs its hooks alone: an enable, a worker respawn, or a reload" (T:4658-4668). Arm the timer in `session.start`; it runs again after a reload or a worker respawn.
- If the hooks worker is lost, the plugin's copy is replaced and its timers are gone. `session.start` runs again (R:261).

`$.prompt.submit`:
- Doc at T:3151-3163. Signature `submit(input: PromptSubmitArgs) => Promise<PromptSubmitResult>` (T:5086).
- `PromptSubmitArgs` = `{ text, attachments?, asUser?: true }`. It omits origin, turnId, wait, context, command and isMeta (T:9980-9997).
- "a turn of its own, once the session is idle." R:261: "`$.prompt.submit` queues a prompt that starts a turn of its own once the session is idle (never folded into a running turn; the call resolves as that turn starts, not when it ends), so background work can wake a quiet session."
- If a turn is running, the prompt is QUEUED, not rejected. `turnId` is "Absent ... for a plugin's own ($.prompt.submit), which runs once it is idle" (T:10091-10096). `wait` is "False for a prompt a plugin submitted" (T:10097-10106).
- It can come back DROPPED: `PromptSubmitResult` is `{text, context?, origin?}` or `{ drop: string }` (T:10124-10160). The causes are "a hook's refusal, a settings hook's block beneath, or the engine's own (a Stop stands, a host's limit reached)". Always check `result.drop`.
- Deadlock hazard: never `await $.prompt.submit` inside a hook that the running turn waits on. It resolves only when its own turn starts, and T:12714 notes "a hook awaiting its own $.prompt.submit hangs". From a timer callback, use `void $.prompt.submit(...)` or `.then(...)`.
- How the model reads it: by default the model reads "The <name> plugin sent a message: ..." (T:9862-9880). With `asUser: true` it reads the text bare, but every hook still sees origin `{kind:'plugin', name, asUser:true}`.
- The prompt does show as a `UserMessage` transcript row, with `origin.name` set to the plugin (T:10846-10851). It is a real visible turn that adds to the transcript.
- `@file` mentions and pasted images are not expanded (T:9987-9992).
- It passes "through every hook but the calling one (the plugin's others see it)" (T:3156). A call from a timer has no calling hook, so the mod's own `prompt.submit` hook sees its own submission. Filter on origin.
- Suggestion (not in the docs): before submitting from the timer, check `await $.prompt.read()` (T:3164-3175, returns `{text, cursor}`, `''` when headless) so the mod does not fire while the person has a draft.

A better alternative, with no visible turn: `$.model.fork({ prompt, effort? })` (T:2791-2817; R:262; `ModelForkRequest` T:6801; `ModelForkResult` T:6866-6881).
- "Runs one tool-less completion over the session's OWN transcript as the main thread last sent it, so the API serves that prefix from its cache. The main thread's last request again (its model, system prompt, tools, messages) with prompt after it."
- It adds nothing to the transcript.
- The result's `usage.cache_read_input_tokens` / `cache_creation_input_tokens` show whether the cache was hit (`ModelUsage` T:6927-6950).
- Reasons it may not answer: `nothing-to-fork` (before the first turn finishes, after /clear, or after a fresh resume), `api-error {status, error}`, `empty-reply`, `aborted`.
- Do NOT pass `effort` unless it equals the session's level. A different level on a model without per-message effort rewrites the whole conversation into a new cache entry and does not refresh the main entry. Ask for haste in the prompt text instead (T:6815-6851).
- The cost is billed and counted in the session's cost (R:262).
- The types never state the main thread's cache TTL (5m vs 1h). The only TTL hints are `SessionStartHookInput.prompt_cache_likely_expired` / `seconds_since_last_response` / `estimated_cache_write_usd` on resume/fork (T:12994-13018) and the `model.complete` "within five minutes" note (T:6900). The designer must supply the TTL as a setting or assumption.

Fallback, documented for completeness (not needed):
- `$.process`, "CLI only" (T:3741-3800).
  - `run(argv, {cwd, env, stdin, timeoutMs})`: the timeout defaults to 30 s, maximum 10 minutes. Returns `{exitCode, stdout, stderr}` (4 MiB each, with `isStdoutTruncated`/`isStderrTruncated`). It rejects if the command cannot start or times out. There is no shell.
  - `spawn({argv, cwd, env, input})` streams `{stream, text}` pieces, then `{code, signal}`. The child dies when the loop ends, on `next.signal`, or on module unload.
  - Neither can inject a prompt into this session.
- `$.command.run` is also "queued and run once the session is idle" (T:3313-3324), but the mod must not register commands.

=== 2. Events (all `on(event, matcher?, ($, e, next) => ...)`, `On` at T:7302)

Model produced output (use this for the cache clock):
- `turn.step` (doc T:4785-4792). It fires for each model request and is a streaming event, so the hook must be an `async function*`.
  - Input `TurnStepInput { turnId, index, model, effort?, messageCount, agentId? }` (T:15561-15610).
  - `const r = yield* next(e)` returns `TurnStepResult { turnId, index, answer, toolUses, serverToolUses?, stopReason, usage: TurnUsage|null }` (T:15628-15680).
  - `TurnUsage = ModelUsage & {model}` (T:15794). `ModelUsage { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`.
  - `stopReason` is `'end_turn'|'max_tokens'|'stop_sequence'|'tool_use'|'pause_turn'|'compaction'|'refusal'|'model_context_window_exceeded'|null` (T:15786). A null value means no response arrived.
  - Stamp `await $.clock.now()` after each step that has `usage != null` and `agentId === undefined`. Each main-thread request reads or writes the cache.
- Simpler and coarser: `turn.complete` (doc T:4794-4804) with `e.usage` (summed) and `durationMs`.
- Row-level alternative: `session.append` with `e.door === 'response'` and `e.origin.kind === 'model'` (R:224; doors listed at T:11844).

Turn started:
- `turn.start` (doc T:4776-4783). Input `TurnStartInput { text, turnId, agentId? }` (T:15492-15520). It is observe-only, and the hook must `return next(e)`.
- Filter to `agentId === undefined` for the main loop.
- It carries no origin. Pair it with the latest `prompt.submit` origin.

Turn ended, failed or succeeded:
- `turn.complete`. Input `TurnCompleteInput = TurnCompleteFields & ({reason:'refusal', refusal:{category, explanation}} | {reason:'answer'|'aborted'|'error'})` (T:15383-15475).
  - `TurnCompleteFields { answer, durationMs, isAborted, turnId, agentId?, usage? }`.
  - `TurnCompleteReason = 'answer' | 'aborted' | 'refusal' | 'error'` (T:15441). 'error' means "an API error ended it (retries exhausted, the context limit)". 'aborted' means the user interrupted.
  - `usage` is absent "when nothing counted (an interrupt, an API error)".
  - The hook must return `next(e)`. Fires for subagents too, so filter on `agentId`.
- Classic equivalents:
  - `classic.Stop`: `{stop_hook_active, last_assistant_message?, background_tasks?, ...}` (T:13647).
  - `classic.StopFailure`: `{ error: 'authentication_failed'|'oauth_org_not_allowed'|'account_on_hold'|'verification_required'|'billing_error'|'rate_limit'|'overloaded'|'invalid_request'|'model_not_found'|'server_error'|'unknown'|'max_output_tokens'|'cloud_credential_error', error_details?, last_assistant_message? }` (T:13640, T:11736).
  - Base fields on classic events: `session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?, agent_type?, effort?` (T:873-898).

Session waiting on the user. The session is mid-turn here, so a `$.prompt.submit` would only queue.
- Permission dialog:
  - "The permission dialog is drawn by the engine alone" (T:10371-10383). There is no render hook for it.
  - Signals:
    - (a) `classic.PermissionRequest { tool_name, tool_input, permission_suggestions?, mcp_server? }` (T:8157-8163).
    - (b) `tool.check`: `next(e)` gives `ToolCheckResult { decision: 'allow'|'ask'|'deny', reason?, rule?, hook?, setting?, plugin?, ceiling? }`. Input `{ tool, input, tool_use_id?, agentId?, ceiling?, approver?: 'host'|'person', isReadOnly? }` (T:14784-14920). An 'ask' with approver 'person' means a person will be asked, unless auto mode's classifier settles it.
    - (c) `tool.call`: the `next(e)` span covers "the permission prompt, the tool itself" (T:4262-4274).
    - (d) `classic.Notification { message, title?, notification_type: string }` (T:7200-7205). `notification_type` is an untyped string. The values are not listed in the types; Claude Code's documented ones are permission_prompt, idle_prompt, auth_success and elicitation_dialog. Verify them in a session.
- AskUserQuestion: `tool.call` with matcher `{tool:'AskUserQuestion'}` (`next` resolves when answered), and `ui.render` component `'AskUserQuestion'` (props `{tool, questions, metadataSource?}`, T:10820-10843). ExitPlanMode is similarly a tool that requires the person (T:14866-14868).
- MCP elicitation: `classic.Elicitation { mcp_server_name, message, mode?: 'form'|'url', url?, elicitation_id?, requested_schema? }` (T:4199-4207). `classic.ElicitationResult { ..., action: 'accept'|'decline'|'cancel', content? }` (T:4212-4219).
- Band prop `AbovePrompt.isWorking` is "True while a model turn is running" (T:11396-11400).
- Spinner props `mode: 'requesting'|'responding'|'thinking'|'tool-input'|'tool-use'` (T:11203-11228).

User submitted a message:
- `prompt.submit`. Input `PromptSubmitInput { text, command?, isMeta?, attachments?, context?, turnId?, wait: boolean, origin: PromptOrigin }` (T:10046-10114). `turnId` is set when typed mid-turn and absent when the session was idle.
- `PromptOrigin.kind` (T:9772-9880) is one of: `'composer'` (Enter at the terminal), `'bridge'` (Remote Control phone/web), `'sdk'` (`claude -p` / Agent SDK host), `'task-notification'`, `'scheduled-trigger'`, `'peer'`, `'peer-send-message'`, `'projects-relay'`, `'channel'` (+`server`), `'coordinator'`, `'observer'`, `'observer-activity'`, `'auto-continuation'`, `'unclassified'`, `'slack-ping'`, `'plugin'` (+`name`, `asUser?`).
- This mod's own prompt is `e.origin.kind === 'plugin' && e.origin.name === '<mod name>'`.
- Caveat: a prompt typed in the desktop app's Code tab may arrive as `'sdk'` rather than `'composer'`; this is not stated. Treat "not my own plugin origin" as user or other activity rather than whitelisting `'composer'`.
- The hook must return `next(e)`. It resolves when the turn starts or the prompt is queued (T:10117-10123).
- `classic.UserPromptSubmit { prompt, source?: 'user'|'sdk'|'system'|'loop_wakeup'|'schedule_wakeup'|'poll_event', session_title? }` (T:16890-16898).
- Rendered rows: `ui.render` `UserMessage` `e.props.origin` (T:10844-10870).

Other useful events:
- `session.end { reason, sessionId, resume }`. Reason `'clear'` means /clear, with no `session.start` after it (T:12338-12356; R:27). Reset the "last output" timestamp on clear, because the cache is dead and fork returns nothing-to-fork.
- `session.measure { context, rateLimits, cost?, changed }`: after each main-thread turn (T:4738-4748, T:12444-12470).
- Every hook that observes must return `next(e)`.

=== 3. State that survives hot reload, and a band toggle

- Module variables are lost on reload (R:202).
- `$.state` holds "Named values held by the host for the session, each with a version: plain data that survives a hot reload" (T:3628-3669).
  - `get(ref) -> {value, version}`: unwritten values read `undefined` at version 0.
  - `set(ref, value, {ifVersion}) -> {isSet, version}`.
  - Writes are refused while a `ui.render` hook draws.
  - `plugin` and `key` must be literals in source.
- `$.store` persists across sessions: `get/set/delete/keys`, JSON, 4 MiB total (T:3602-3627). Use it for a cross-session default of the on/off toggle.
- Declare the state in types/index.d.ts (plugin.json `"types": "./types/index.d.ts"`):
  `declare module 'claude-code' { interface PluginState { 'keep-cache-warm': { isEnabled: boolean; lastOutputAt: number | null; ... } } }`
  - `PluginState` is at T:8440.
  - `Shaped<T>` plus `atom(..., {shape:'v1'})` lets new code decline a value with an old shape (T:767-770, T:13267; pane.tsx:9).
- Helpers: `import { atom, read, update } from 'claude-code'`.
  - `atom(ref, initial)` (T:755).
  - `read($, atom)` (T:16990). Inside a render hook it subscribes the drawing.
  - `update($, atom, fn)`: read, apply, write with ifVersion, retry (T:16814, T:16999).
  - `derive`, `memberOf`.
- Band (example band.tsx:6-59):
  - `const isEnabled = atom({ plugin: 'keep-cache-warm', key: 'isEnabled' } as const, true)`
  - In `on('ui.render', {component:'AbovePrompt'}, async ($, e, next) => {...})`:
    - if `e.props.hasSurvey`, `return next(e)`;
    - `const on = await read($, isEnabled)`;
    - `const {Box, Text, Button} = $.ui.resolve(e)`;
    - return `<Box><Text dimColor>...</Text><Button key="toggle" label={on?'Pause':'Resume'} onPress={() => update($, isEnabled, v => !v)} /></Box>`.
  - The write in `onPress` redraws the readers automatically, with no `$.ui.invalidate` needed (R:202).
  - Size the tree to `e.props.bodyColumns`.
- `AbovePrompt` props (T:11383-11450): `hasSurvey, isCollapsed, isWorking, maxRows, bodyColumns, scroll, view`.
  - Raised on the terminal, desktop and mobile surfaces only, NOT vscode.
  - Give every Button a `key`. A `hotkey` is optional.
- Render answers are cached: "A repaint reuses the answer; a clock invalidates" (T:4286-4296). A countdown in the band will not move by itself. Either write a 'tick' or 'lastOutputAt' atom on each timer tick (only readers redraw) or call `$.ui.invalidate('ui.render')`, capped at 10 per second (30 in the terminal) (T:2424-2438).

=== 4. $.ui.status and $.ui.toast

- `status(text: string | undefined): void` (T:2562-2572).
  - "Pins text as this plugin's status line under the prompt, beside the engine's own pinned notices, until the next call replaces it. One per plugin; undefined removes it."
  - Draws the first 2000 characters on the terminal and 10000 remotely.
  - Event `'ui.status' { text }` (T:7545-7549); other plugins can hook it.
- `toast(text: string, options?: { timeoutMs?: number }): void` (T:2510-2525; ToastOptions T:14601-14609, default 4000 ms).
  - A small box on the plugin-toast stack at the transcript's top right. A click dismisses it and hovering holds it.
  - Where the transcript prints into scrollback, it is one line on the notification bar.
  - While a pane opened with `holdToasts` is shown, toasts wait undrawn (T:8050-8060).
  - Each plugin's newer toast replaces its own. The stack holds 50 (R:215).
  - Event `'ui.toast' { text, timeoutMs? }` (T:7538-7543).
- Surface caveats:
  - Neither doc names a surface restriction; both mention the "remote surface" limit, which implies desktop and mobile draw them. The exact desktop look is not specified.
  - `$.ui.notify(text, {title, key, delayMs, at, untilBack})` gives a native OS notification (T:2527-2548, T:7612-7628). It resolves `{isSent, channel}` or `{isSent:false, reason:'disabled'|'no-channel'|'no-surface'|'refused'}`. In the desktop app it is handed to the host.
  - `$.ui.log(text, {to:'transcript'|'debug'})` writes a dim transcript line (T:2475-2492).

=== 5. What could stop a 30-60 s status refresh

- Hook budget `HookBudget` (T:5466-5495): `ms: 10_000` of the hook's own time per dispatch, with time in `$` calls and `next` excluded except `$.clock.sleep`. `catchMs: 1_000`; `lingerMs: 5_000`. A timer callback is not a hook dispatch. Keep it short and never `sleep` inside hooks.
- `clock.every`: minimum 1 ms. No stated maximum and no stated rate limit.
- `clock.every` can be killed by a refused period, from another plugin's `clock.every` hook (T:3710).
- `clock.every` is cancelled on hot reload and lost on a worker respawn. Re-arm in `session.start`, which re-fires after a reload (T:4658-4668). Cancel the old timer before arming, since module variables reset anyway.
- `$.ui.status`: no stated call-rate limit. `$.ui.invalidate`: 10 redraws per second, more calls fold.
- In headless `-p`/SDK runs, `isInteractive` is false and `session.start` `surface` is null (T:13023-13037). Status and band may draw nowhere. Consider skipping warming when `!e.isInteractive`.
- A failed or throwing hook is skipped. While hot-reloading, the transcript names it once and the debug log names it every time (R:126-129). A render tree that does not validate draws nothing for that band row.
- Remember to `void` any `$.prompt.submit` from inside turn hooks (deadlock, T:12714).
