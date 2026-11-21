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

## Current state (2026-11-20)

Done and passing: `claude plugin validate .` (warnings only), `claude plugin test .` (49 of 49). Version 0.4.1: cost-first session totals that include compactions, the per-ping size in the Off bar, the key route on the armed terminal bar. Version 0.4.0 adds a daily ping cap across sessions (`maxPingsPerDay`, kept in `$.store` as `pingDay`), a one-time mode explainer (`hasPicked` in `$.store`), the relative cost of a ping, and `Cache: cold` once the cache runs out while paused. Version 0.3.1 (session ping totals in toasts and the paused bar, a `fallbackPing` setting, a mode explainer while Off, (state marks ⏸ ✕ ✓, a rescued-by-ping state with the countdown kept, the key route first in the Off bar). Version 0.3.0 adds settings (`defaultMode`, `maxPings`), focus that follows the hotkey, and a fallback ping when a compaction fails.

| Area | State |
|---|---|
| Bar above the prompt | `[Keep warm] [Compact] [Warm → compact] [Off]`, `[Resume]` when paused; the running mode is highlighted and marked `●`. Hotkeys w/c/t/o/r after ctrl+x tab. |
| Status line | `Cache: Nm`, or `off`/`busy`/`waiting`/`paused`/`cold`/`compacted` |
| Ping | `$.clock.after` at anchor + 55 min → `$.prompt.submit({ text, asUser: true })` |
| Compaction | `$.session.compact()` at anchor + 55 min in Compact mode, or in Warm → compact once 8 pings are spent |
| Colors | explicit hex in `hooks/logic.ts` (`MODE_COLOR`, `STATE_COLOR`) |
| Side panel | **removed** on purpose (the user found it extra). Don't add it back. |

### Verified live (Windows 11 VM, CLI 2.1.327-329 in Windows Terminal, Claude Desktop 4.29.0, 2026-11-20)

Ping and compaction runs used a short-timer variant (`TTL_MS` 6 min, `MAX_PINGS` 2); everything else is the shipped code.

- Install from the GitHub marketplace (`claude plugin marketplace add` then `claude plugin install keep-cache-warm@claude-keep-cache-warm`); the README's one-command form (`claude plugin install keep-cache-warm --marketplace DanielGGordon/claude-keep-cache-warm`) also works in a clean profile, and the Desktop app's own flow (**+** > Add plugins > **+** > Add from a repository > Sync > **+**) installs it with no restart needed.
- Real pings answered by the model, real compaction after the ping budget, on **both** surfaces. Bar colors, the `●` marker, hotkeys `w c t o` (after `ctrl+x tab`) in the CLI, chip clicks on Desktop.
- **Desktop is headless**: `$.session.compact()` is refused there ("not available in a headless (-p / SDK) session yet"). The mod falls back to `$.command.run({ command: 'compact' })` and remembers it (`compactViaCommand`). Before this fix Desktop compaction silently never happened.
- Failures set `lastProblem` (state `failed`, red bar, `Cache: failed`, a transcript line via `$.ui.log(..., { to: 'transcript' })`, which Desktop draws as a labelled row; toasts are not obviously visible on Desktop).
- Bar layout: text over buttons (stacked) on Desktop, and on the terminal whenever text plus buttons would not fit in `bodyColumns`.

### Also verified live (final build)

- Real shipped timers: a CLI ping 55 minutes after the previous request read 44,585 of 44,639 input tokens from the cache (99.9%) and wrote 50; a Desktop compaction fired unattended at 55 minutes (72.1K to 9.5K tokens).
- Pause and Resume (click) on Desktop; a forced compaction failure on Desktop (red bar, `Cache: failed`, reason kept after expiry).
- Install: README one-command form in a clean profile; Desktop UI flow with no restart needed.

- The full budget on the shipped timers (0.3.0, 2026-11-20, 8.5 hours): 8 pings 55 minutes apart in the CLI (then the pause, no 9th) and in Desktop Warm -> compact (then a compaction at the 9th deadline); every ping read ~99.9% from the cache, wrote ~35 tokens, 4 output.
- A draft in the composer survives pings (CLI); `defaultMode` starts a new session in its mode.
- With `fallbackPing` off, a failed compaction stays red with no ping in its place (Desktop).
- Clicks in Windows Terminal work with the fullscreen renderer (`/tui fullscreen`), not the classic one (it takes no mouse).

### Not yet verified live

1. Machine sleep/wake across the deadline (a wall-clock jump past expiry was simulated; see below).
2. macOS. (Linux: the CLI was run on Ubuntu with `--setting-sources project --plugin-dir`, short timers: bar, hotkeys, two labelled pings answered, countdown and status line all as on Windows.)

### Known small issues (from the Fable 5.2 code review, all low severity)

- The 60 s count-fallback timer isn't cancelled on `/clear`; its claim check makes it harmless.
- At an exact minute boundary the status line can lag up to a minute (`refresh` uses `remainingMs % 60_000 || 60_000`).
- A ping judged stale because a turn failed between claim and start resets `hasFailed` at `turn.start`.
- The anchor is the time the last request was *sent*, not when its output ended, so the countdown runs slightly early (conservative).

### Host limits found

- The terminal draws a yellow ⚠ before every plugin status line; no option in `$.ui.status`.
- The Desktop app ignores `ui.render` hooks on `UserMessage` rows for a plugin's prompt, so a ping always looks typed; the transcript note is the label.
- Changing a setting writes Claude Code's own "options changed - reloaded (N hooks: ...)" line into the transcript.
- On Desktop the host draws its "Compacted session" row before the `/compact` command's own bubble.
- The terminal's classic renderer takes no mouse input; the fullscreen one (`/tui fullscreen`) does.
- (Solved: the focus ring now follows a hotkey through `$.ui.focus`.)

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
- Recognising the subagent heartbeat from t3code more fully (only shown in the bar now).
