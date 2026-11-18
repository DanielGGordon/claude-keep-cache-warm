// The Claude Code workflow script that built the first version of this mod
// (research -> design -> Fable 5.2 design review -> build -> Fable 5.2 code review
// + requirements check -> fixes). Local paths are replaced with placeholders.

export const meta = {
  name: 'keep-cache-warm-mod',
  description: 'Port t3code cacheKeepAlive into a GUI-only Claude Code mod, with Fable 5.2 reviews',
  phases: [
    { title: 'Research', detail: 'read the t3code source and the mod API' },
    { title: 'Design', detail: 'write the mod design' },
    { title: 'Fable design review', detail: 'Fable 5.2 critiques the design', model: 'fable' },
    { title: 'Build', detail: 'write, validate, type-check and test the mod' },
    { title: 'Review', detail: 'Fable 5.2 code review + requirements check' },
    { title: 'Fix', detail: 'apply confirmed review fixes' },
  ],
}

const SKILL = '<plugin-authoring skill>'
const MOD_DIR = '<mod folder>'

const SPEC = `
USER SPEC (authoritative):
Build a GUI-only mod (NO slash commands) that keeps the Claude prompt cache warm, ported from the keep-cache-warm feature in https://github.com/DanielGGordon/t3code (packages/shared/src/cacheKeepAlive.ts).
* Toggle: a panel or band control that turns keep-warm on or off for the current session.
* Countdown: a status-line readout of the time left on the cache ("Cache: 42m"), rounded DOWN to whole minutes, plus states like off, busy, paused and cold. The cache lasts an hour, counted from the model's last output in the session.
* Ping: when on, send exactly this prompt: Keep-alive ping to keep the prompt cache warm. No action needed — just reply “ok”.  about 5 minutes before the cache expires. Skip it while a turn is running or waiting on the user, after a failed turn, or once the cache has already expired.
* Limit: stop after 8 pings in a row with no message from the user, and show a toast when it pauses or a ping goes out.
* First, check whether a mod can send a message into the session on its own timer. If it can't, have the toggle start a background command that wakes the session about 55 minutes later instead, like the subagent heartbeat pattern in that file.
`

const MOD_RULES = `
MOD AUTHORING FACTS (from the plugin-authoring skill):
- Skill folder: ${SKILL}. Read ${SKILL}/reference.md and the examples in ${SKILL}/examples/ (band.tsx, band-state.d.ts, pane.tsx, pane-state.d.ts, pane.test.tsx, tool-call.ts). The full API is ${SKILL}/types/claude-code.d.ts (~24k lines) — grep it, don't read it whole.
- Mod folder: ${MOD_DIR}/ with .claude-plugin/plugin.json ({name, version "0.1.0", description, "types": "./types/index.d.ts" if using $.state}), hooks/hooks.json ({"modules": ["./register.tsx"]}), hooks/register.tsx exporting \`export const register: Register = (on, options) => {...}\` (type from 'claude-code'), and types/index.d.ts declaring PluginState values under the mod name.
- Hooks are ($, e, next). JSX compiles against global h; elements via $.ui.resolve(e). Band = ui.render hook on {component:'AbovePrompt'}; pane = $.ui.open + ui.render on {component:'Pane', requestId}. Status line = $.ui.status(text). Toast = $.ui.toast(text). Timers = $.clock.after/every/now (a hot reload cancels pending timers; module variables reset; $.state/$.store persist). Prompt = $.prompt.submit({text}) — runs as its own turn once the session is idle.
- No DOM, no Node, no Date.now in the module — use $.clock.now().
- Check: \`claude plugin validate ${MOD_DIR}\`; type-check with tsc (see the tsconfig in the header of the types file if .claude-plugin/types is not laid yet); test with a *.test.ts(x) like pane.test.tsx and \`claude plugin test ${MOD_DIR}\`.
- The mod must NOT register any slash command.
`

phase('Research')
const [sourceNotes, apiNotes] = await parallel([
  () => agent(`Read the file packages/shared/src/cacheKeepAlive.ts from the public GitHub repo DanielGGordon/t3code (raw URL: https://raw.githubusercontent.com/DanielGGordon/t3code/main/packages/shared/src/cacheKeepAlive.ts — try master if main 404s; also look at its tests or callers in the repo if helpful, e.g. via the GitHub web UI or api.github.com search). Use WebFetch (or the web-fetch agent type) — gh is not installed.

Return a precise behavioural spec of the keep-alive logic: every constant (TTL, lead time, max consecutive pings, etc.), the exact ping text, the state machine / status labels, how the "last model output" timestamp is tracked, every skip condition, how the consecutive-ping counter resets, what toasts/notifications exist, the countdown formatting/rounding, and the "subagent heartbeat" pattern (how a background command wakes the session ~55 min later). Quote short code fragments where exact semantics matter. Note anything ambiguous.`, { label: 'read t3code source', phase: 'Research' }),
  () => agent(`${MOD_RULES}

Investigate the Claude Code mod API at ${SKILL}/types/claude-code.d.ts and ${SKILL}/reference.md and answer concretely, with type/event names and line numbers:
1. Can a mod send a prompt into the session on its own timer while the session is idle? Check $.clock.after/every (do timers fire while idle between turns? max duration?) and $.prompt.submit (does it start a turn when idle? what happens if a turn is running — queued or rejected?). Give a clear YES/NO verdict with evidence. If NO, document what $.process / background commands offer for the fallback.
2. Which events tell the mod: the model produced output (and when — for the 1-hour cache timer); a turn started / ended; a turn FAILED (error/abort) vs succeeded; the session is waiting on the user (permission prompt, AskUserQuestion, elicitation, etc.); the user submitted a message (and how to distinguish a user-typed prompt from this mod's own $.prompt.submit, e.g. e.origin / e.source).
3. How to store per-session state ($.state + atoms vs module variables) so it survives hot reload, and how a band (AbovePrompt) Button toggle reads/writes it and redraws.
4. $.ui.status and $.ui.toast signatures and any surface caveats (desktop app vs terminal).
5. Anything that would stop a periodic status-line refresh every ~30-60s (hook budgets, clock.every limits).
Be exhaustive about exact event names and input fields; the designer will rely only on your notes.`, { label: 'scout mod API', phase: 'Research' }),
])

phase('Design')
const design = await agent(`${SPEC}
${MOD_RULES}

NOTES ON THE ORIGINAL t3code IMPLEMENTATION:
${sourceNotes}

NOTES ON THE MOD API:
${apiNotes}

Write a complete design for the keep-cache-warm mod. Decide (with the API notes' verdict) whether the ping uses an in-mod timer ($.clock + $.prompt.submit) or the background-command fallback, and justify. Cover: file list; PluginState contract; the state machine (off / warm with minutes / busy / waiting / paused / cold, and what the status line shows for each, e.g. "Cache: 42m", "Cache: off", "Cache: busy", "Cache: paused", "Cache: cold"); exactly which events update lastOutputAt, busy, waiting, failed, consecutivePings; how the user's own message resets the counter but the mod's ping does not; ping scheduling (fire at lastOutputAt + 55m, re-check all skip conditions at fire time, reschedule after each output); status refresh cadence and floor-minutes rounding; toggle UI (band button, per-session) and its labels; toasts (ping sent, paused after 8); behaviour across hot reload (re-arm timers from $.state in session.start); edge cases (toggle on when no output yet; cache already cold on toggle; ping turn itself failing; user typing while ping in flight). Include pseudo-code for register.tsx. Keep it faithful to the t3code semantics where they don't conflict with the user spec (user spec wins).`, { label: 'design mod', phase: 'Design' })

phase('Fable design review')
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'approve-with-changes', 'rework'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'issue', 'fix'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'issues', 'summary'],
}
const fableDesign = await agent(`You are reviewing a design for a Claude Code mod before it is built. Be a demanding reviewer: find correctness gaps, race conditions, requirement misses, wasted pings (cost!), and UX problems. You may grep ${SKILL}/types/claude-code.d.ts to check that cited events/APIs exist and behave as claimed.

${SPEC}

API NOTES THE DESIGN RELIED ON:
${apiNotes}

DESIGN UNDER REVIEW:
${design}

Return your verdict and concrete issues with fixes.`, { label: 'Fable 5.2: review design', phase: 'Fable design review', model: 'fable', schema: REVIEW_SCHEMA })
log(`Fable 5.2 design verdict: ${fableDesign ? fableDesign.verdict + ' (' + fableDesign.issues.length + ' issues)' : 'no answer'}`)

phase('Build')
const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    mechanism: { type: 'string', description: 'in-mod timer or background-command fallback, and why' },
    validate: { type: 'string', description: 'claude plugin validate result summary' },
    typecheck: { type: 'string' },
    tests: { type: 'string', description: 'claude plugin test result summary (pass/fail counts)' },
    deviations: { type: 'string', description: 'any place the build departs from design or Fable feedback, and why' },
    summary: { type: 'string' },
  },
  required: ['files', 'mechanism', 'validate', 'typecheck', 'tests', 'deviations', 'summary'],
}
const build = await agent(`${SPEC}
${MOD_RULES}

Build the mod in ${MOD_DIR}/ (create the folder). If the Skill tool offers "plugin-authoring", load it first.

DESIGN:
${design}

FABLE 5.2 REVIEW OF THE DESIGN (apply every high and medium issue unless you can show it is wrong; note any you reject in deviations):
${JSON.stringify(fableDesign, null, 2)}

API NOTES:
${apiNotes}

Then: run claude plugin validate, type-check, and write hooks/register.test.tsx covering at least: countdown floors minutes ("Cache: 42m"); ping fires ~5 min before expiry with the exact text; no ping while busy / waiting on user / after failed turn / when cold; counter resets on a user message but not on the mod's own ping; pauses after 8 consecutive pings with a toast; toast on each ping; toggle off cancels. Run claude plugin test and iterate until validate, typecheck and tests all pass. No slash commands.`, { label: 'build mod', phase: 'Build', schema: BUILD_SCHEMA })

phase('Review')
const [fableCode, reqCheck] = await parallel([
  () => agent(`Code-review the Claude Code mod in ${MOD_DIR}/ (read every file). API reference: ${SKILL}/types/claude-code.d.ts (grep it) and ${SKILL}/reference.md. Hunt for real bugs: timer leaks or double-scheduling across hot reload/toggle, pings that could fire during a running turn or permission prompt, counter not resetting/resetting wrongly, stale status line, floor-rounding errors, wrong event names/fields, anything that could spam pings or cost money. Only report issues you are confident are real, with the file and a concrete fix.

${SPEC}`, { label: 'Fable 5.2: review code', phase: 'Review', model: 'fable', schema: REVIEW_SCHEMA }),
  () => agent(`Check the Claude Code mod in ${MOD_DIR}/ against the user spec below, item by item. For each requirement, read the code and decide met / not met; report every unmet or partially met item as an issue (severity high if a stated requirement is missing). Also confirm there is no slash command and that \`claude plugin validate ${MOD_DIR}\` and \`claude plugin test ${MOD_DIR}\` pass (run them).

${SPEC}`, { label: 'requirements check', phase: 'Review', schema: REVIEW_SCHEMA }),
])

const toFix = [fableCode, reqCheck].filter(Boolean).flatMap(r => r.issues).filter(i => i.severity !== 'low')
const lows = [fableCode, reqCheck].filter(Boolean).flatMap(r => r.issues).filter(i => i.severity === 'low')
log(`Review: ${toFix.length} high/medium issues to fix, ${lows.length} low left for the report`)

let fix = null
if (toFix.length) {
  phase('Fix')
  fix = await agent(`${MOD_RULES}
${SPEC}

Fix these review findings in ${MOD_DIR}/. First verify each is real by reading the code; skip any that are not and say why. Add or update tests for each real fix. Finish with claude plugin validate, type-check and claude plugin test all passing.

FINDINGS:
${JSON.stringify(toFix, null, 2)}`, { label: 'apply fixes', phase: 'Fix', schema: {
    type: 'object',
    properties: {
      fixed: { type: 'array', items: { type: 'string' } },
      rejected: { type: 'array', items: { type: 'string' } },
      finalChecks: { type: 'string' },
    },
    required: ['fixed', 'rejected', 'finalChecks'],
  } })
}

return { modDir: MOD_DIR, apiVerdict: apiNotes, fableDesign, build, fableCode, reqCheck, lowIssues: lows, fix }
