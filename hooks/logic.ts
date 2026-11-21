// Pure logic for keep-cache-warm: constants, the cache state machine and the
// display texts. No `$` here, so tests/logic.test.ts can exercise it alone.
// Ported from t3code's packages/shared/src/cacheKeepAlive.ts.

import type { ModelUsage, PromptOrigin } from 'claude-code'

import type { KeepWarm, Kind, Mode, View } from '../types'

export const NAME = 'keep-cache-warm'

/** The prompt cache lasts an hour from the model's last request. */
export const TTL_MS = 60 * 60_000
/** Ping this long before the cache expires. */
export const LEAD_MS = 5 * 60_000
/** Pings in a row with no message from the person before pausing (the default of the `maxPings` setting). */
export const MAX_PINGS = 8
let maxPings = MAX_PINGS
/** The ping budget in force: the `maxPings` setting, 1 to 50, or 8. */
export function getMaxPings(): number {
  return maxPings
}
export function setMaxPings(n: unknown): void {
  maxPings = typeof n === 'number' && Number.isFinite(n) ? Math.min(50, Math.max(1, Math.round(n))) : MAX_PINGS
}
/** Submit attempts per idle period; only a thrown submit retries. */
export const MAX_ATTEMPTS = 3
export const RETRY_MS = 30_000
/** How often a ping held by running background subagents is checked again. */
export const HOLD_RECHECK_MS = 60_000
/** A claimed ping counts as in flight (busy) for this long. */
export const FRESH_FIRE_MS = 2 * 60_000
/** After an accepted submit, count the ping here if turn.start did not. */
export const COUNT_FALLBACK_MS = 60_000
/** Appended to the problem text when a ping stood in for a failed compaction. */
export const FALLBACK_SUFFIX = '; a keep-alive ping was sent instead'
/** A fallback ping is not sent with less than this left on the cache. */
export const FALLBACK_MIN_MS = 30_000
/** A /compact command that has not reported a compaction by this long is a failure. */
export const COMPACT_CHECK_MS = 3 * 60_000
/** A re-check later than this past an armed deadline re-arms the ping timer. */
export const ARM_SLACK_MS = 5_000

/** Exactly the text the spec gives. */
export const PING_TEXT =
  'Keep-alive ping to keep the prompt cache warm. No action needed — just reply “ok”.'
/** What recognises the ping turn at turn.start. */
export const PING_MARK = 'Keep-alive ping to keep the prompt cache warm.'
/** The mod's own early guard drop: benign, so no toast. */
export const OWN_DROP = 'keep-cache-warm: ping no longer needed'
/** What a stale ping turn answers instead of sending a request. */
export const STALE_ANSWER = 'ok (keep-cache-warm skipped this ping: the cache no longer needed it)'
export const HEARTBEAT_RE = /subagent[- ]heartbeat|subagent-status\.sh/i

export const INITIAL: KeepWarm = {
  isEnabled: false,
  mode: 'warm',
  compactedAt: null,
  lastOutputAt: null,
  busyTurnId: null,
  busySince: null,
  hasFailed: false,
  consecutivePings: 0,
  pausedAt: null,
  pauseReason: null,
  lastPingAnchor: null,
  pingFiredAt: null,
  countedClaim: null,
  pingTurnId: null,
  isPingTurnStale: false,
  pingAttempts: 0,
  lastUserAt: null,
  isHeldByBackground: false,
  hasHeartbeat: false,
  lastProblem: null,
  isFallbackPing: false,
  isTouched: false,
  pingTotals: { count: 0, read: 0, written: 0, out: 0, compactions: 0, compactTokens: 0 },
  lastPromptTokens: null,
}

export type CacheState = {
  kind: Kind
  expiresAt: number | null
  pingAt: number | null
  /** Time left on a live cache; null when there is none or it has expired. */
  remainingMs: number | null
}

/** "42m", rounded down to whole minutes; "<1m" under a minute. */
export function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  return minutes < 1 ? '<1m' : `${minutes}m`
}

/** A claimed ping still in flight. */
export function isFiring(s: KeepWarm, now: number): boolean {
  return s.pingFiredAt !== null && now - s.pingFiredAt < FRESH_FIRE_MS
}

export const MODES: readonly Mode[] = ['warm', 'compact', 'warm-then-compact']

/** Button labels, and the band's title while the mode runs. */
export function modeLabel(mode: Mode): string {
  return { warm: 'Keep warm', compact: 'Compact before expiry', 'warm-then-compact': `Warm, then compact after ${maxPings}` }[mode]
}
function modeTitle(mode: Mode): string {
  return {
    warm: 'Keeping cache warm',
    compact: 'Compacting before expiry',
    'warm-then-compact': `Warm → compact after ${maxPings} pings`,
  }[mode]
}
/**
 * Explicit colors (theme keys are not drawn everywhere): t3code's warm orange,
 * compact blue and warm-then-compact violet, plus the state colors.
 */
export const MODE_COLOR: Record<Mode, string> = {
  warm: '#d97757',
  compact: '#3b82f6',
  'warm-then-compact': '#8b5cf6',
}
export const STATE_COLOR = {
  off: '#6b7280',
  paused: '#d97706',
  cold: '#dc2626',
  problem: '#dc2626',
  compacted: '#16a34a',
} as const

/**
 * Paused and stopped. In warm-then-compact a spent ping budget is not a stop:
 * the next action becomes a compaction (t3code's cacheKeepAliveActive).
 */
export function isHalted(s: KeepWarm): boolean {
  return s.pausedAt !== null && !(s.mode === 'warm-then-compact' && s.pauseReason === 'limit')
}

/** What goes out before the cache expires: a ping, or a compaction. */
export function nextAction(s: KeepWarm): 'ping' | 'compact' {
  return s.mode === 'compact' || (s.mode === 'warm-then-compact' && s.pausedAt !== null)
    ? 'compact'
    : 'ping'
}

/** The state machine, first match wins (t3code section 3, plus "waiting"). */
export function cacheState(s: KeepWarm, now: number, isWaiting = false): CacheState {
  const expiresAt = s.lastOutputAt === null ? null : s.lastOutputAt + TTL_MS
  const pingAt = expiresAt === null ? null : expiresAt - LEAD_MS
  const remainingMs = expiresAt === null || now >= expiresAt ? null : expiresAt - now
  const at = (kind: Kind): CacheState => ({ kind, expiresAt, pingAt, remainingMs })

  if (!s.isEnabled) return at('off')
  if (isHalted(s)) return at('paused')
  if (isWaiting) return at('waiting')
  if (s.busyTurnId !== null || isFiring(s, now)) return at('busy')
  if (s.hasFailed) return at('cold')
  if (s.compactedAt !== null && s.lastOutputAt === null) return at('compacted')
  if (remainingMs === null || pingAt === null) return at('cold')
  if (s.lastProblem !== null) return at('problem')
  if (s.isHeldByBackground) return at('busy')
  if (now >= pingAt) return at('due')
  return at('scheduled')
}

/**
 * When the next ping should go out, or null when none should be armed:
 * off, paused, a turn running, a ping in flight, a failed turn, no output,
 * an expired cache, a ping already claimed for this anchor, or retries spent.
 * Background subagents are checked at fire time, not here.
 */
export function nextPingAt(s: KeepWarm, now: number): number | null {
  if (!s.isEnabled || isHalted(s) || s.hasFailed) return null
  if (s.busyTurnId !== null || isFiring(s, now)) return null
  if (s.lastOutputAt === null || now >= s.lastOutputAt + TTL_MS) return null
  if (s.lastPingAnchor === s.lastOutputAt) return null
  if (s.pingAttempts >= MAX_ATTEMPTS) return null
  return s.lastOutputAt + TTL_MS - LEAD_MS
}

export function isClaimable(s: KeepWarm, now: number): boolean {
  const at = nextPingAt(s, now)
  return at !== null && now >= at
}

/**
 * Whether a claimed ping is no longer wanted by the time its turn starts
 * (the authoritative, dequeue-time guard).
 */
export function isStalePing(s: KeepWarm, now: number): boolean {
  if (!s.isEnabled || s.pausedAt !== null || s.hasFailed) return true
  if (nextAction(s) !== 'ping' && !s.isFallbackPing) return true
  if (s.lastOutputAt === null || s.lastOutputAt !== s.lastPingAnchor) return true
  if (now >= s.lastOutputAt + TTL_MS) return true
  return s.lastUserAt !== null && s.pingFiredAt !== null && s.lastUserAt > s.pingFiredAt
}

/** A ping whose request read less than half its input from the cache found it cold. */
export function isCacheCold(usage: ModelUsage): boolean {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return total > 0 && usage.cache_read_input_tokens < total / 2
}

const USER_KINDS: ReadonlySet<PromptOrigin['kind']> = new Set([
  'composer',
  'bridge',
  'sdk',
  'slack-ping',
  'channel',
])

/**
 * A message from the person, which resets the ping budget. Autonomous
 * sources (auto-continuation, unclassified, notifications, schedules, peers,
 * every plugin, this one's pings included) never do.
 */
export function isUserOrigin(origin: PromptOrigin, isMeta: boolean): boolean {
  return !isMeta && USER_KINDS.has(origin.kind)
}

export function statusText(st: CacheState): string {
  switch (st.kind) {
    case 'scheduled':
    case 'due':
      return `Cache: ${formatRemaining(st.remainingMs ?? 0)}`
    case 'problem':
      return 'Cache: failed'
    default:
      return `Cache: ${st.kind}`
  }
}

/** A failed compaction whose place a keep-alive ping took: the cache is warm. */
function isRescued(s: KeepWarm): boolean {
  return s.lastProblem?.endsWith(FALLBACK_SUFFIX) === true
}

export function toView(
  s: KeepWarm,
  now: number,
  isWaiting = false,
  opts: { firstUse?: boolean; dailyCap?: number } = {},
): View {
  const st = cacheState(s, now, isWaiting)
  const left = st.remainingMs === null ? '' : ` · cache ${formatRemaining(st.remainingMs)} left`
  const sent =
    s.consecutivePings > 0
      ? ` · ${s.consecutivePings} of ${maxPings} pings in a row`
      : ''
  const heartbeat = s.hasHeartbeat ? ' · also kept warm by the subagent heartbeat' : ''
  // What one ping would read here, from the last request's size.
  const perPing = s.lastPromptTokens
    ? ` (each reads ~${fmtTokens(s.lastPromptTokens)} tokens from the cache; the first can cost more)`
    : ''
  const title = modeTitle(s.mode)
  const action: 'ping' | 'compaction' = nextAction(s) === 'compact' ? 'compaction' : 'ping'
  let band: string
  let color: string = MODE_COLOR[s.mode]
  switch (st.kind) {
    case 'off':
      band = opts.firstUse
        ? `Keep cache warm: off${left} · Keep warm pings before the cache expires; Compact summarizes the conversation once; Warm → compact pings, then summarizes · pings${perPing} and compactions are billed; it pauses after ${maxPings} pings in a row`
        : `Keep cache warm: off${left} · billed pings${perPing}, pauses after ${maxPings} pings in a row`
      color = STATE_COLOR.off
      break
    case 'paused': {
      color = STATE_COLOR.paused
      // Paused long enough for the cache to run out: say so, the next message pays for a rewrite.
      const expired =
        st.remainingMs === null && s.lastOutputAt !== null
          ? ' · the cache has expired; your next message rewrites it'
          : left
      band =
        s.pauseReason === 'not-caching'
          ? `‖ Paused: the last ping found the cache already cold, so it is not lasting an hour here${expired}`
          : s.pauseReason === 'daily'
            ? `‖ Paused: ${opts.dailyCap ?? ''} ping${opts.dailyCap === 1 ? '' : 's'} today across all sessions, your daily cap; Resume goes on for this session today${expired}`
            : `‖ Paused after ${maxPings} pings in a row with no message from you; send a message or press Resume${expired}`
      break
    }
    case 'waiting':
      band = `${title} · waiting on you${left}`
      break
    case 'busy': {
      const what =
        s.busyTurnId !== null
          ? 'turn running'
          : isFiring(s, now)
            ? action === 'compaction'
              ? 'compacting'
              : 'sending keep-alive ping'
            : `${action} held while background subagents run`
      band = `${title} · ${what}${left}`
      break
    }
    case 'compacted':
      color = STATE_COLOR.compacted
      band = `✓ Compacted before the cache expired; your next message starts a fresh cache`
      break
    case 'problem':
      if (isRescued(s)) {
        // A ping kept the cache warm in the failed action's place: amber, and the countdown stands.
        color = STATE_COLOR.paused
        band = `↻ Kept warm by a ping instead; ${(s.lastProblem ?? '').slice(0, -FALLBACK_SUFFIX.length)}${left}`
      } else {
        color = STATE_COLOR.problem
        band = `✕ Failed: ${s.lastProblem}${left}`
      }
      break
    case 'cold':
      color = STATE_COLOR.cold
      band = s.hasFailed
        ? `${title} · last turn failed, so nothing is sent until a turn succeeds${left}`
        : s.lastOutputAt === null
          ? `${title} · no cached conversation yet; your next message warms it`
          : s.lastProblem !== null
            ? `✕ Cache expired after a failure: ${s.lastProblem}`
            : `✕ Cache expired; your next message warms it`
      break
    case 'due':
      band = `${title} · ${action} due now${left}${sent}`
      break
    case 'scheduled':
      band = `${title} · ${action} in ${formatRemaining((st.pingAt ?? now) - now)}${left}${sent}`
      break
  }
  return {
    kind: st.kind,
    mode: s.isEnabled ? s.mode : null,
    color,
    status:
      st.kind === 'problem' && isRescued(s) && st.remainingMs !== null
        ? `Cache: ${formatRemaining(st.remainingMs)}`
        : st.kind === 'paused' && st.remainingMs === null && s.lastOutputAt !== null
          ? 'Cache: cold'
          : statusText(st),
    band: band + heartbeat,
  }
}

export function pingToast(n: number, mode: Mode = 'warm'): string {
  if (n < maxPings) return `Keep-alive ping sent to keep the prompt cache warm (${n} of ${maxPings}).`
  return mode === 'warm-then-compact'
    ? `Ping ${maxPings} of ${maxPings} sent. Next time the conversation is compacted instead.`
    : `Keep cache warm paused: ${maxPings} pings in a row with no message from you. The cache stays warm for about another hour; send a message or press Resume to continue.`
}

export function notCachingToast(usage: ModelUsage): string {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return `Keep cache warm paused: the ping found the cache already cold (${usage.cache_read_input_tokens} of ${total} input tokens read from cache), so the cache is not lasting an hour here. Press Resume to try again.`
}

/** 62800 -> "62.8K", 1200000 -> "1.2M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** What a ping's first request got from the cache: the saving, in the person's terms. */
export function pingUsageText(
  usage: ModelUsage,
  totals?: KeepWarm['pingTotals'],
  todayCount?: number,
): string {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const pct = total === 0 ? 0 : Math.round((usage.cache_read_input_tokens / total) * 100)
  const rel = relativeCost(usage)
  const one = `Ping read ${pct}% of its ${fmtTokens(total)} input tokens from the cache${rel === null ? '' : `, about ${rel}% of what rewriting the cache would cost`}.`
  const session = totals && totals.count > 1 ? ` ${totalsText(totals)}.` : ''
  const today = todayCount !== undefined && todayCount > (totals?.count ?? 0) ? ` Today, all sessions: ${todayCount} pings.` : ''
  return `${one}${session}${today}`
}

/**
 * A ping's price as a share of rewriting its whole prompt into the 1-hour cache, at the
 * standard prompt-caching multipliers (cache read 0.1x input, 1-hour cache write 2x, output 5x).
 */
export function relativeCost(usage: ModelUsage): number | null {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total === 0) return null
  const ping =
    usage.input_tokens + 0.1 * usage.cache_read_input_tokens + 2 * usage.cache_creation_input_tokens + 5 * usage.output_tokens
  return Math.max(1, Math.round((ping / (2 * total)) * 100))
}

/**
 * "This session: 3 pings wrote 105 tokens and 12 output (216.0K read from the cache) · 1 compaction, 70.1K tokens".
 * What a ping costs most is what it writes and outputs; the cached read is the cheap part.
 */
export function totalsText(t: KeepWarm['pingTotals']): string {
  const pings =
    t.count === 0
      ? 'no pings'
      : `${t.count} ping${t.count === 1 ? '' : 's'} wrote ${fmtTokens(t.written)} tokens and ${fmtTokens(t.out)} output (${fmtTokens(t.read)} read from the cache)`
  const compactions =
    t.compactions === 0
      ? ''
      : ` · ${t.compactions} compaction${t.compactions === 1 ? '' : 's'}${t.compactTokens > 0 ? `, ${fmtTokens(t.compactTokens)} tokens` : ''}`
  return `This session: ${pings}${compactions}`
}

export function compactedText(tokensBefore?: number, tokensAfter?: number): string {
  const base = 'Compacted the conversation before the prompt cache expired'
  return tokensBefore !== undefined && tokensAfter !== undefined
    ? `${base} (${fmtTokens(tokensBefore)} → ${fmtTokens(tokensAfter)} tokens).`
    : `${base}.`
}

/** An engine error as a short reason: no "$.x.y:" or plugin prefixes, no advice for plugin authors. */
export function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const bare = text.replace(/^(?:keep-cache-warm:\s*|\$\.[\w.]+:\s*|prompt\.submit:\s*)+/i, '')
  const reason = bare.split(/;\s*(?:catch it|run one with)/i)[0] ?? bare
  return reason.length > 160 ? `${reason.slice(0, 157)}...` : reason
}
