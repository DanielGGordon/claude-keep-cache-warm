# Fable 5.2 code review

> From the multi-agent build workflow (2026-11-17), before the later changes listed in HANDOFF.md. Local paths are replaced with placeholders.

```json
{
  "verdict": "approve-with-changes",
  "issues": [
    {
      "severity": "low",
      "issue": "hooks/register.tsx armCountFallback (lines 224-250): the 60 s fallback timer is never cancelled and decides only on `v.countedClaim === claimAt`. session.end for `clear`/`resume` (line 283) resets S to INITIAL (countedClaim: null, lastUserAt: null). If the person runs /clear or resumes another session within 60 s of a ping being accepted, the fallback then sees an uncounted claim and counts it again in the NEW session: consecutivePings becomes 1 and a spurious toast 'Keep-alive ping sent ... (1 of 8)' appears while keep-warm is off. The same ping is counted twice (once at turn.start, once by the fallback).",
      "fix": "Make the fallback act only when the claim is still outstanding, which turn.start always clears: in the updater replace `if (v.countedClaim === claimAt) return v` with `if (v.pingFiredAt !== claimAt || v.countedClaim === claimAt) return v`. Optionally also keep the Timer returned by `o.after(COUNT_FALLBACK_MS, ...)` and cancel it in session.end."
    },
    {
      "severity": "low",
      "issue": "hooks/register.tsx refresh (line 124): `const delay = Math.min(remainingMs % 60_000 || 60_000, remainingMs) + 100`. When remainingMs is an exact multiple of a minute (e.g. exactly 55m00.000s) the floored minute flips 1 ms later, but the `|| 60_000` waits a full 60.1 s. The status line then shows 'Cache: 55m' for a minute while only 54m is left (overstating, violating round-DOWN), and then jumps straight to 53m. Reachable whenever a sync lands on the exact millisecond (always under the mock clock: after a turn at T0 the line reads 'Cache: 60m' for 60 s with 59m left; in live use when a timer fires exactly on a minute boundary).",
      "fix": "Drop the `|| 60_000`: `const delay = Math.min(remainingMs % 60_000, remainingMs) + 100`. A remainder of 0 then re-checks after 100 ms, when the floor has flipped."
    },
    {
      "severity": "low",
      "issue": "hooks/register.tsx turn.start (lines 356-373): `base` sets `hasFailed: false` for every main turn, including a ping turn judged stale by `isStalePing(v, now)` because `v.hasFailed` was true (a notification-started turn failed between the claim and the ping's own turn). The stale ping is answered locally with reason 'answer', so the failed-turn flag is erased by a turn that sent no request, and pings can resume after a failed turn once the anchor moves, contrary to 'skip after a failed turn'.",
      "fix": "Keep the flag on a stale ping turn: `if (isStalePing(v, now)) return { ...claimed, isPingTurnStale: true, hasFailed: v.hasFailed }`."
    }
  ],
  "summary": "Read every file in <mod folder>/ (hooks/register.tsx, hooks/logic.ts, types/index.d.ts, hooks/hooks.json, .claude-plugin/plugin.json, README.md, tests) and checked it against claude-code.d.ts by reading only; I did not run the tests or a typecheck.\n\nNo high or medium bugs found. The three issues are all low-severity edge cases; none can spam pings or cost money.\n\nWhat I checked and found sound:\n- **Event names and fields**: session.start/end reasons, prompt.submit origin, `turnId` and `drop`, turn.start `text`, turn.step `index` and `usage`, turn.complete `reason`, tool.check `approver`, AgentStatus values and `$.ui.status` all match the API types.\n- **Hot reload and toggle**: the host cancels old timers on reload, session.start re-arms from the state atom, and `schedule()` de-duplicates by deadline. A duplicate fire is harmless because the claim is one atomic update guarded by `lastPingAnchor`.\n- **Pings during a turn or permission prompt**: `busyTurnId` blocks arming, the engine queues plugin prompts until idle, and the turn.start guard answers a stale ping locally without a model request.\n- **Spam and cost bounds**: one ping per anchor; an engine drop is final for that idle period; a thrown submit retries at most 3 times; an errored ping turn sets `hasFailed`; a ping that reads under half its input from cache pauses as \"not-caching\".\n- **Counter**: counted once per claim at turn.start, reset only by user-origin prompts that were not dropped, and paused at 8 with a toast.\n- **Rounding**: `formatRemaining` floors, and the anchor is the request's send time, so the countdown never overstates except in the tick case listed.\n\nOne behaviour to be aware of, not reported as a bug: a due ping is held while background subagents are running or waiting, and re-checked every 60 s. If they outlast the remaining 5 minutes the cache expires un-pinged. The code comment says this follows t3code; I could not see that file to confirm.\n\nThe README's \"still to confirm live\" items remain unverified, chiefly whether turn.start sees the ping text for an `asUser` plugin prompt. If it does not, the stale-ping guard is bypassed and counting relies on the 60 s fallback."
}
```
