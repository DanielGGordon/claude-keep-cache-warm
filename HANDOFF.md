# Handoff: keep-cache-warm

Notes for whoever picks this up next, human or agent. `README.md` is the user-facing doc; this file is the working state.

## What this is

A Claude Code **mod** (a plugin with a hooks module, `hooks/hooks.json` → `hooks/register.tsx`) that keeps the 1-hour prompt cache warm. It's a port of `packages/shared/src/cacheKeepAlive.ts` from [DanielGGordon/t3code](https://github.com/DanielGGordon/t3code). The same mod runs in the Claude Code CLI and the Claude desktop app: both draw its bar above the prompt (`ui.render` on `AbovePrompt`) and its status line (`$.ui.status`).

Requirements it was built against (from the original ask):

- GUI only, **no slash commands**.
- A toggle for the current session; a status-line countdown `Cache: 42m` (floored minutes) plus states (off, busy, paused, cold, …). The cache lasts an hour from the model's last output.
- Ping text, exactly: `Keep-alive ping to keep the prompt cache warm. No action needed — just reply “ok”.` about 5 minutes before expiry. Skip while a turn runs or waits on the user, after a failed turn, or once the cache has expired.
- Stop after 8 pings in a row with no user message; toast when it pauses or a ping goes out.
- First check whether a mod can send a message on its own timer; if not, fall back to a background command that wakes the session (~55 min). **It can** (`$.clock.after` + `$.prompt.submit`), so the fallback was not built.
- Added later at the user's request: t3code's three modes (**Keep warm**, **Compact**, **Warm → compact**), color, and terminal keyboard shortcuts.

## Current state (2026-11-18)

Done and passing: `claude plugin validate .` (warnings only), `claude plugin test .` (35 of 35), type-check clean.

| Area | State |
|---|---|
| Bar above the prompt | `[Keep warm] [Compact] [Warm → compact] [Off]`, `[Resume]` when paused; the running mode is highlighted and marked `●`. Hotkeys w/c/t/o/r after ctrl+x tab. |
| Status line | `Cache: Nm`, or `off`/`busy`/`waiting`/`paused`/`cold`/`compacted` |
| Ping | `$.clock.after` at anchor + 55 min → `$.prompt.submit({ text, asUser: true })` |
| Compaction | `$.session.compact()` at anchor + 55 min in Compact mode, or in Warm → compact once 8 pings are spent |
| Colors | explicit hex in `hooks/logic.ts` (`MODE_COLOR`, `STATE_COLOR`) |
| Side panel | **removed** on purpose (the user found it extra). Don't add it back. |

### Verified live

- Desktop app (after a full app restart): the bar and the status line render; toggling works.
- CLI 2.1.325 in a Windows Command Prompt: the bar, all three modes, Off, the `●` marker and the status line work by mouse click.
- An earlier build agent confirmed in a scripted `claude -p --input-format stream-json` session that a timer-sent `$.prompt.submit` starts a turn by itself in an idle session (model call stubbed).

### Not yet verified live

1. A real ping turn with a real model reply, and the countdown ticking in a real session (the test machine's CLI login had no API credit; the desktop session wasn't left idle for 55 minutes).
2. A real compaction triggered by the mod.
3. The w/c/t/o/r hotkeys by actual keypress (computer use can only click in terminals).
4. Whether hex colors render in the desktop app. The Windows Command Prompt used for testing drew no color at all (not even Claude Code's own logo), which is why the `●` marker exists.

### Known small issues (from the Fable 5.2 code review, all low severity)

- The 60 s count-fallback timer isn't cancelled on `/clear`; its claim check makes it harmless.
- At an exact minute boundary the status line can lag up to a minute (`refresh` uses `remainingMs % 60_000 || 60_000`).
- A ping judged stale because a turn failed between claim and start resets `hasFailed` at `turn.start`.
- The anchor is the time the last request was *sent*, not when its output ended, so the countdown runs slightly early (conservative).

## Layout

- `hooks/register.tsx`: hooks, timers, the serial queue, ping and compaction firing, the bar.
- `hooks/logic.ts`: pure state machine (`cacheState`, `nextPingAt`, `isHalted`, `nextAction`, `toView`), constants and texts. No `$`.
- `types/index.d.ts`: the `$.state` contract (`KeepWarm`, `Mode`, `View`). Bump the `shape` tags in `register.tsx` (`kw-3`, `view-3`) whenever these change.
- `tests/`: `logic.test.ts` (pure) and `register.test.tsx` (engine harness with a mocked clock, `world()` helper).
- `.claude-plugin/marketplace.json`: makes this repo installable.
- `docs/history/`: the original build, ported from a multi-agent workflow. Read `01-t3code-spec.md` for t3code's exact semantics and `02-mod-api-notes.md` for the mod API findings. `build-workflow.js` is the workflow script itself, with Fable 5.2 reviewing the design and the code. These predate the modes, colors, hotkeys and the panel removal.

## Working on it

Run a working copy with:

```
claude --plugin-dir <this folder>
```

The folder is watched, and saves reload the mod. Check with `claude plugin validate .` and `claude plugin test .`. Type definitions are written by Claude Code into `.claude-plugin/types/` once it has loaded the mod (gitignored); `tsconfig.json` extends them, so `tsc -p .` type-checks after the first load.

Mod-authoring rules worth knowing:

- Never assign or pass `$`: validation refuses it. Timers and handlers reach the engine through the `ops` closures built in `session.start`.
- Don't `await $.prompt.submit` or `$.session.compact` inside the serial queue: they resolve only when their own turn or compaction runs, and this mod's own hooks queue work too.
- A hot reload cancels timers and resets module variables; `$.state` survives, and `session.start` re-arms from it.

## Ideas not done

- Hold pings while the person has a draft in the composer (`$.prompt.read()`).
- A configurable ping budget (`userConfig`) instead of the fixed 8.
- Recognising the subagent heartbeat from t3code more fully (only shown in the bar now).
