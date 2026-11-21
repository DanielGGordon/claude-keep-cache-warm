# keep-cache-warm

A Claude Code mod that keeps the prompt cache warm while you step away, so coming back to a long conversation doesn't mean paying to write the whole cache again.

The prompt cache lasts an hour from the model's last request. About 5 minutes before it expires, the mod either sends a tiny keep-alive ping or compacts the conversation, depending on the mode you pick. It's GUI only: no slash commands.

Ported from the keep-cache-warm feature in [t3code](https://github.com/DanielGGordon/t3code) (`packages/shared/src/cacheKeepAlive.ts`).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install keep-cache-warm --marketplace DanielGGordon/claude-keep-cache-warm
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install keep-cache-warm --marketplace DanielGGordon/claude-keep-cache-warm
```

In the Claude desktop app (Code tab): click **+** next to the prompt box, then **Add plugins**, the **+** at the top right of the directory, **Add from a repository**, pick `DanielGGordon/claude-keep-cache-warm`, **Sync**, then the **+** on *Keep cache warm*. It is ready at once: the bar appears in the next new session, with no restart.

## Using it

A bar above the prompt shows the cache state and the mode buttons. Until you first pick a mode it also explains the three modes; after that the Off bar is one short line, with what a ping would read here (`billed pings (~69.4K cached tokens each), pauses after 8 in a row`). In a terminal the bar always ends with the key route (`ctrl+x tab for keys`).

`[Keep warm] [Compact] [Warm → compact] [Off]`

It starts off in every session (unless you change that in its settings); pick a mode to turn it on for the current session. The running mode's button is highlighted and marked ●.

In a terminal, press **ctrl+x** then **tab** to focus the bar and use its keys (each button shows its letter). With Claude Code's fullscreen renderer (`/tui fullscreen`) a mouse click on a button works too; the classic renderer takes no clicks: **w** Keep warm, **c** Compact, **t** Warm → compact, **o** Off, **r** Resume. **Esc** returns to the prompt.

| Mode | What happens about 5 minutes before the cache expires | Bar color |
|---|---|---|
| **Keep warm** | Sends: *Keep-alive ping to keep the prompt cache warm. No action needed — just reply “ok”.* Pauses after 8 pings in a row with no message from you. | orange |
| **Compact** | Compacts the conversation (as `/compact` does) instead of pinging, once, then waits for your next message. | blue |
| **Warm → compact** | Pings up to 8 times, then compacts instead of pausing. | violet |

The bar turns yellow when paused (‖; once the cache has run out while paused it says so and the status reads `Cache: cold`), red when the cache is cold, the last turn failed or a ping or compaction did not happen (✕), amber when a compaction failed but a ping kept the cache warm in its place (↻), green just after a compaction (✓), and grey when off. The marks carry the state where colors are hard to tell apart. **Resume** appears when it has paused. Switching modes while it runs keeps the ping count.

The bar is one row when its text and buttons fit, and two (the text over the buttons) when they don't, so no button, Off above all, is ever pushed out of reach. In the terminal, while Off, it also shows the keyboard route (`ctrl+x` then `tab`, then `w` `c` `t` `o`); the Desktop app's buttons show their letters.

The status line shows the time left on the cache, rounded down to whole minutes (`Cache: 42m`), or the state: `off`, `busy`, `waiting`, `paused`, `cold`, `compacted` or `failed`. (The yellow ⚠ the terminal draws in front of it is Claude Code's own mark for every plugin status line; the mod cannot change it.)

Toasts tell you when a ping goes out (`1 of 8`), what it got from the cache, what that cost next to rewriting the cache, and the running totals (`Ping read 100% of its 50.1K input tokens from the cache, about 5% of what rewriting the cache would cost. This session: 2 pings wrote 220 tokens and 10 output (100.0K read from the cache) · 1 compaction, 60.9K tokens. Today, all sessions: 5 pings.`; the share uses the standard prompt-caching multipliers: cache reads 0.1x input, 1-hour cache writes 2x, output 5x), when it pauses, when it compacts (and how many tokens that saved, when the engine reports it), and when something refused a ping or a compaction.

**When something goes wrong** the bar says why (for example `✕ Failed: compaction failed after 3 tries: …`), the status line reads `Cache: failed`, and a `keep-cache-warm: …` line is written into the transcript. If a ping then kept the cache warm in the failed compaction's place, the bar turns amber (`↻ Kept warm by a ping instead; …`) and the countdown stays. It clears when you send a message, pick a mode, or a later compaction succeeds.

### In the Claude Desktop app

The Code tab is a headless session, where the engine refuses a plugin's compact call. The mod notices and runs the `/compact` command instead (you will see a `/compact` message in the transcript, after a `keep-cache-warm:` line saying why). The Desktop app also draws a ping as if you had typed it, so the mod writes a `keep-cache-warm: sending a keep-alive ping …` line just before each one; the terminal labels the row itself.

## Settings

Four settings, under `/config` (search "keep") or in the Desktop app's plugin settings:

| Setting | Default | What it does |
|---|---|---|
| **Start each session in** | `off` | The mode a new session starts in: `off`, `warm`, `compact` or `warm-then-compact`. Picking a mode or Off in the bar wins for that session. |
| **Pings before it stops** | `8` | Pings in a row with no message from you before Keep warm pauses and Warm → compact compacts instead (1 to 50). |
| **Daily ping cap, all sessions** | `0` (none) | Most pings per day (UTC) across every session on this machine; past it, keep-warm pauses until you press Resume or the next day. |
| **Ping when a compaction fails** | on | If a compaction fails, one keep-alive ping goes out in its place (counted against the budget) so the cache is still warm when you come back. |

They are stored in `settings.json` under `pluginConfigs["keep-cache-warm@claude-keep-cache-warm"].options` (`defaultMode`, `maxPings`, `maxPingsPerDay`, `fallbackPing`); a change reloads the mod at once.

## When it does nothing

- while a turn is running or waiting on you (a permission prompt or a question);
- while background subagents are running;
- after a failed turn, until a turn succeeds;
- once the cache has already expired (a ping then would only pay for a full cache write);
- after 8 pings in a row (or your **Pings before it stops** setting) with no message from you, in **Keep warm** mode. A message from you, or **Resume**, restores the count.

Only messages you type count as messages from you. Task notifications, scheduled triggers, auto-continuations and other plugins don't reset the count.

If a ping finds the cache already cold (it read less than half its input from the cache), the mod pauses rather than paying for cache writes every hour, and says so.

## Cost

A ping on a 44.6K-token conversation, 55 minutes after the previous request, read 44,585 tokens from the cache, wrote 50 and produced 4 output tokens (measured on a real run). One caveat: a conversation that has made only a single request may already have lost the cache of its own part after the engine's short window, so its first ping re-writes that part (about 12.8K tokens in the same test) and every ping after it reads the whole thing. If a ping reads under half its input from the cache, the mod pauses and says so.

Each ping is a real, billed turn: a cache read of the conversation plus a one-word reply. Each compaction is a model call too. Both are usually much cheaper than rewriting a large cache from scratch.

If a compaction fails (refused, vetoed, or erroring three times), the bar says why and, while there is time and ping budget left, one keep-alive ping goes out in its place so the cache does not expire; it counts against the budget.

## Development

See [HANDOFF.md](HANDOFF.md) for the current state, what is verified, open items and the build history.

- `hooks/register.tsx`: hooks, timers and the bar.
- `hooks/logic.ts`: the state machine and texts, with no engine calls.
- `types/index.d.ts`: the `$.state` contract.
- `tests/`: run with `claude plugin test .`

Check it with `claude plugin validate .`. To try a working copy, start Claude Code with `claude --plugin-dir <this folder>`.
