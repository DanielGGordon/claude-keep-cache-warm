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

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `DanielGGordon/claude-keep-cache-warm`, then **Add plugin**.

## Using it

A bar above the prompt shows the cache state and the mode buttons:

`[Keep warm] [Compact] [Warm → compact] [Off]`

It starts off in every session; pick a mode to turn it on for the current session. The running mode's button is highlighted.

| Mode | What happens about 5 minutes before the cache expires | Bar color |
|---|---|---|
| **Keep warm** | Sends: *Keep-alive ping to keep the prompt cache warm. No action needed — just reply “ok”.* Pauses after 8 pings in a row with no message from you. | orange |
| **Compact** | Compacts the conversation (as `/compact` does) instead of pinging, once, then waits for your next message. | blue |
| **Warm → compact** | Pings up to 8 times, then compacts instead of pausing. | violet |

The bar turns yellow when paused, red when the cache is cold or the last turn failed, green just after a compaction, and grey when off. **Resume** appears when it has paused. Switching modes while it runs keeps the ping count.

The status line shows the time left on the cache, rounded down to whole minutes (`Cache: 42m`), or the state: `off`, `busy`, `waiting`, `paused`, `cold` or `compacted`.

Toasts tell you when a ping goes out (`1 of 8`), when it pauses, when it compacts, and when something refused a ping or a compaction.

## When it does nothing

- while a turn is running or waiting on you (a permission prompt or a question);
- while background subagents are running;
- after a failed turn, until a turn succeeds;
- once the cache has already expired (a ping then would only pay for a full cache write);
- after 8 pings in a row with no message from you, in **Keep warm** mode. A message from you, or **Resume**, restores the count.

Only messages you type count as messages from you. Task notifications, scheduled triggers, auto-continuations and other plugins don't reset the count.

If a ping finds the cache already cold (it read less than half its input from the cache), the mod pauses rather than paying for cache writes every hour, and says so.

## Cost

Each ping is a real, billed turn: a cache read of the conversation plus a one-word reply. Each compaction is a model call too. Both are usually much cheaper than rewriting a large cache from scratch.

## Development

- `hooks/register.tsx`: hooks, timers and the bar.
- `hooks/logic.ts`: the state machine and texts, with no engine calls.
- `types/index.d.ts`: the `$.state` contract.
- `tests/`: run with `claude plugin test .`

Check it with `claude plugin validate .`. To try a working copy, start Claude Code with `claude --plugin-dir <this folder>`.
