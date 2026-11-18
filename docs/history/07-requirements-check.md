# Requirements check

> From the multi-agent build workflow (2026-11-17), before the later changes listed in HANDOFF.md. Local paths are replaced with placeholders.

```json
{
  "verdict": "approve-with-changes",
  "issues": [
    {
      "severity": "medium",
      "issue": "The spec says to check first whether a mod can send a message into the session on its own timer. The check rests only on the API docs and on harness tests, and those tests mock $.prompt.submit and run the ping turn by hand (tests/register.test.tsx, pingTurn). Nothing shows that a submit fired by $.clock.after actually starts a turn in an idle desktop or terminal session. The README lists this as 'Still to confirm live #1', and the heartbeat fallback (a background sleep of about 55 minutes started by the toggle) was not built. The ping requirement depends on this unverified path.",
      "fix": "Confirm it live: turn keep-warm on in an idle session, shorten TTL_MS and LEAD_MS for the test, and check that the ping turn starts on its own. If it does not, build the background-command fallback the spec describes, in which the toggle starts a command that wakes the session about 55 minutes later, like the subagent heartbeat pattern in cacheKeepAlive.ts."
    },
    {
      "severity": "low",
      "issue": "Anchor timing differs from the spec. The spec says the hour counts from the model's last output. turn.step instead sets lastOutputAt to sentAt, the time the request was sent (register.tsx lines 390 and 417). The countdown and the ping time therefore run early by the length of the request. This errs on the safe side but does not match the stated rule.",
      "fix": "Use $.clock.now() after `yield* next(e)` returns with usage as the anchor, or have the user confirm that request-send time is the intended rule and note that in the spec."
    },
    {
      "severity": "low",
      "issue": "In the last minute the countdown shows 'Cache: <1m' (logic.ts formatRemaining). The spec asks for whole minutes rounded down, which would read 'Cache: 0m'.",
      "fix": "Either return `${Math.floor(ms/60000)}m`, or keep '<1m' and tell the user it is a deliberate deviation (the tests label it a t3code case)."
    },
    {
      "severity": "low",
      "issue": "Two behaviours go beyond the spec and can stop pings the spec would send. (1) An automatic 'not-caching' pause when the ping's first request reads less than half its input from the cache. (2) Holding the ping while background subagents run. Neither is in the user spec's skip list. Both show a toast or band text, but they widen the conditions under which no ping goes out.",
      "fix": "Tell the user about these additions so they can accept or remove them, or remove them if a strict port of the spec is wanted. The background hold matches t3code, according to the code comment."
    }
  ],
  "summary": "I checked the mod at <mod folder> against the spec, item by item. Both required commands pass. `claude plugin validate` passes with warnings only (no author field, plus advisory notes about gating hooks and managed settings). `claude plugin test` passes 30 of 30 tests across tests/logic.test.ts and tests/register.test.tsx.\n\nThere is no slash command: there are no commands/ or skills/ folders, the manifest lists none, and validate reports only hooks plus a ui.render AbovePrompt band.\n\nRequirement by requirement:\n- **Toggle:** met. A band button ('Keep warm' / 'Turn off', plus 'Resume' when paused) applies to the current session. It starts off and /clear or a resume resets it.\n- **Countdown:** met. The status line shows 'Cache: Nm', rounded down, plus off, busy, paused, cold and waiting states, with a 1-hour TTL. Two small deviations: it shows '<1m' in the last minute, and the anchor is the time the request was sent rather than the time of the last output.\n- **Ping:** met. PING_TEXT matches the spec byte for byte, including the em dash and curly quotes. It is sent with $.prompt.submit(asUser) at anchor + 55 minutes. It is skipped while a turn is running or waiting on the user, after a failed turn, and once the cache has expired. A ping that goes stale is answered without sending a request.\n- **Limit:** met. It pauses after 8 pings in a row with no message from the user. A toast fires on each ping ('n of 8') and on the pause. A user message or Resume resets the count.\n- **Feasibility check:** partially met. The timer-then-submit route is chosen because the plugin docs say it works, but it has not been confirmed in a live idle session, and the background-command fallback was not built."
}
```
