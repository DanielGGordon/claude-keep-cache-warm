/** Why keep-warm paused itself: the 8-ping limit, or a ping that found the cache already cold. */
export type PauseReason = 'limit' | 'not-caching' | 'daily'

/**
 * What it does before the cache expires (t3code's modes): ping to keep it warm,
 * compact instead, or ping until the 8-ping budget is spent and then compact.
 */
export type Mode = 'warm' | 'compact' | 'warm-then-compact'

/** The mod's whole logic state, one atom so every change is atomic. */
export type KeepWarm = {
  /** Per-session toggle; off by default and after /clear or a resume. */
  isEnabled: boolean
  mode: Mode
  /** When the mod last compacted the conversation; cleared by the person's next message. */
  compactedAt: number | null
  /** Anchor: $.clock.now() when the last main-thread model request that returned usage was sent. */
  lastOutputAt: number | null
  /** The main turn running now (turn.start .. turn.complete). */
  busyTurnId: string | null
  busySince: number | null
  /** The last main turn ended on an error; reset at the next main turn.start. */
  hasFailed: boolean
  /** Pings counted since the person's last message. */
  consecutivePings: number
  pausedAt: number | null
  pauseReason: PauseReason | null
  /** The anchor a ping was claimed for: one ping per idle period. */
  lastPingAnchor: number | null
  /** When the in-flight ping was claimed; cleared once its turn starts, or on a drop or throw. */
  pingFiredAt: number | null
  /** The claim time already counted (by turn.start, or the fallback), so a ping counts once. */
  countedClaim: number | null
  /** The main turn recognised as a ping turn, and whether it was stale (answered without a request). */
  pingTurnId: string | null
  isPingTurnStale: boolean
  /** Submit attempts for the current anchor (only a thrown submit retries). */
  pingAttempts: number
  lastUserAt: number | null
  /** Display only: the last fire found background subagents running and held the ping. */
  isHeldByBackground: boolean
  /** Display only: a background shell task looks like the subagent heartbeat. */
  hasHeartbeat: boolean
  /**
   * Why the last ping or compaction did not happen (refused, vetoed, or failed
   * past its retries). Shown in the bar until the person acts or one succeeds.
   */
  lastProblem: string | null
  /** The claimed ping stands in for a compaction that failed (one per idle period, inside the budget). */
  isFallbackPing: boolean
  /** The person picked a mode or Off in this session; until then the `defaultMode` setting applies. */
  isTouched: boolean
  /** This session's pings so far: how many, and the input tokens read from and written to the cache. */
  pingTotals: { count: number; read: number; written: number }
}

export type Kind =
  | 'off'
  | 'paused'
  | 'waiting'
  | 'busy'
  | 'cold'
  | 'problem'
  | 'compacted'
  | 'scheduled'
  | 'due'

/** What the band and status line draw; written only when it changes. */
export type View = {
  kind: Kind
  /** The selected mode while on; null while off. */
  mode: Mode | null
  /** The band text color, as hex. */
  color: string
  status: string
  band: string
}

declare module 'claude-code' {
  interface PluginState {
    'keep-cache-warm': { s: Shaped<KeepWarm>; view: Shaped<View | null> }
  }
}
