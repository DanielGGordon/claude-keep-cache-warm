// keep-cache-warm: keeps the Claude prompt cache warm. About 5 minutes before
// the 1-hour cache expires it pings or compacts, by the mode picked in the bar
// above the prompt. GUI only: the bar, a status-line countdown and toasts; it
// registers no slash command.
//
// Route: an in-mod timer ($.clock.after), then $.prompt.submit (a ping, which
// starts a turn of its own once the session is idle) or $.session.compact.

import { atom, read, update } from 'claude-code'
import type { AgentInfo, CommandRunResult, PromptSubmitResult, Register, SessionCompactResult, Timer } from 'claude-code'

import type { KeepWarm, Mode, View } from '../types'
import {
  ARM_SLACK_MS,
  COMPACT_CHECK_MS,
  FALLBACK_MIN_MS,
  FALLBACK_SUFFIX,
  COUNT_FALLBACK_MS,
  HEARTBEAT_RE,
  HOLD_RECHECK_MS,
  INITIAL,
  MAX_ATTEMPTS,
  getMaxPings,
  setMaxPings,
  NAME,
  OWN_DROP,
  PING_MARK,
  PING_TEXT,
  RETRY_MS,
  STALE_ANSWER,
  TTL_MS,
  modeLabel,
  MODES,
  cacheState,
  cleanError,
  compactedText,
  isCacheCold,
  isClaimable,
  isStalePing,
  isHalted,
  isUserOrigin,
  nextAction,
  nextPingAt,
  notCachingToast,
  pingToast,
  pingUsageText,
  toView,
} from './logic'

// One atom for all the logic state, so each change is one atomic update.
// Change the tag when KeepWarm's fields change: it declines older values.
const S = atom({ plugin: 'keep-cache-warm', key: 's' } as const, INITIAL, { shape: 'kw-8' })
// The derived display; the band reads only this, so it redraws only when the text changes.
const V = atom({ plugin: 'keep-cache-warm', key: 'view' } as const, null, { shape: 'view-4' })

const fresh = (v: KeepWarm): KeepWarm => ({
  ...v,
  consecutivePings: 0,
  pausedAt: null,
  pauseReason: null,
  lastPingAnchor: null,
  pingAttempts: 0,
  isHeldByBackground: false,
  lastProblem: null,
})

/** What the timers and continuations reach the engine through: closures over session.start's `$`. */
type Ops = {
  now: () => Promise<number>
  get: () => Promise<KeepWarm>
  set: (change: (v: KeepWarm) => KeepWarm) => Promise<KeepWarm>
  getView: () => Promise<View | null>
  setView: (view: View) => Promise<unknown>
  status: (text: string | undefined) => void
  toast: (text: string) => void
  log: (text: string) => void
  focus: (requestId: string, key: string) => void
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => void
  note: (text: string) => void
  after: (ms: number, fn: () => void) => Timer
  agents: () => Promise<AgentInfo[]>
  submit: (text: string) => Promise<PromptSubmitResult>
  command: () => Promise<CommandRunResult>
  compact: () => Promise<SessionCompactResult>
}

export const register: Register = (on, options) => {
  // Settings (the plugin's userConfig): the ping budget, and the mode a new session starts in.
  setMaxPings(options.maxPings)
  const defaultMode: Mode | null = MODES.find(m => m === options.defaultMode) ?? null
  const dailyCap =
    typeof options.maxPingsPerDay === 'number' && options.maxPingsPerDay > 0 ? Math.round(options.maxPingsPerDay) : 0
  /** No mode was ever picked on this machine: the Off bar explains the modes (kept in $.store). */
  let isFirstUse = true
  /** Resume was pressed on a daily-cap pause: the cap no longer holds this session (until the day changes). */
  let isDailyOverride = false
  let overrideDay: string | null = null
  const memStore = new Map<string, unknown>()
  let ops: Ops | null = null
  let pingTimer: Timer | null = null
  let pingDeadline: number | null = null
  let tickTimer: Timer | null = null
  /** Not before this time: set after a thrown submit or a background hold. */
  let retryAfter = 0
  let lastStatus: string | undefined
  /**
   * A desktop or other remote surface draws the bar. It shows a ping as a message
   * the person typed, so a transcript note says whose it is; the terminal labels it itself.
   */
  let isRemoteSurface = false
  /** The band's site, for moving its focus ring ($.ui.focus). */
  let bandRequestId: string | null = null
  /** A remote surface labels a plugin's transcript line with its name; the terminal does not. */
  const noteText = (text: string) => (isRemoteSurface ? text : `keep-cache-warm: ${text}`)
  /** This host refuses $.session.compact (headless): run the /compact command instead. */
  let compactViaCommand = false
  /** The claim of a /compact command in flight; cleared when the compaction reports in. */
  let promptCompactClaim: number | null = null
  // Waiting on the person is display only (it happens inside a turn, which
  // already holds the ping), so it lives in module memory.
  const waitingIds = new Set<string>()
  let isElicitWaiting = false
  const isWaiting = () => waitingIds.size > 0 || isElicitWaiting

  // Every refresh, schedule and fire runs through one queue, so two of them
  // never interleave (no double-armed timer, no double claim).
  let chain: Promise<void> = Promise.resolve()
  const serial = (job: () => Promise<void>): Promise<void> => {
    const run = chain.then(job).catch(err => ops?.log(`keep-cache-warm: ${String(err)}`))
    chain = run
    return run
  }
  let isSyncQueued = false
  const sync = (): Promise<void> => {
    if (isSyncQueued) return chain
    isSyncQueued = true
    return serial(async () => {
      isSyncQueued = false
      if (ops) await syncNow(ops)
    })
  }

  async function syncNow(o: Ops): Promise<void> {
    const now = await o.now()
    const s = await o.get()
    await refresh(o, s, now)
    schedule(o, s, now)
  }

  async function refresh(o: Ops, s: KeepWarm, now: number): Promise<void> {
    const view = toView(s, now, isWaiting(), { firstUse: isFirstUse, dailyCap })
    // While off there is nothing to say: no status line item (the terminal marks every one with a ⚠).
    const status = view.kind === 'off' ? undefined : view.status
    if (status !== lastStatus) {
      lastStatus = status
      o.status(status)
    }
    const old = await o.getView()
    if (!old || old.kind !== view.kind || old.status !== view.status || old.band !== view.band) {
      await o.setView(view)
    }
    // Tick about 100 ms after the floored minute flips, and at expiry.
    tickTimer?.cancel()
    tickTimer = null
    const { remainingMs } = cacheState(s, now)
    if (remainingMs !== null && remainingMs > 0) {
      const delay = Math.min(remainingMs % 60_000 || 60_000, remainingMs) + 100
      tickTimer = o.after(delay, () => {
        tickTimer = null
        void sync()
      })
    }
  }

  function schedule(o: Ops, s: KeepWarm, now: number): void {
    const due = nextPingAt(s, now)
    const at = due === null ? null : Math.max(due, retryAfter)
    if (at === null) {
      pingTimer?.cancel()
      pingTimer = null
      pingDeadline = null
      return
    }
    // Already armed for this deadline and not overdue (an overdue one was refused).
    if (pingTimer && pingDeadline === at && now <= at + ARM_SLACK_MS) return
    pingTimer?.cancel()
    pingDeadline = at
    pingTimer = o.after(Math.max(0, at - now), () => {
      pingTimer = null
      pingDeadline = null
      void serial(firePing)
    })
  }

  async function hasBackgroundAgents(o: Ops): Promise<boolean> {
    try {
      const agents = await o.agents()
      return agents.some(
        a =>
          a.teammateId === undefined &&
          (a.status === 'running' || a.status === 'pending' || a.status === 'waiting'),
      )
    } catch {
      return false
    }
  }

  async function firePing(): Promise<void> {
    const o = ops
    if (!o) return
    const now = await o.now()
    const s = await o.get()
    if (!isClaimable(s, now)) return
    // Background subagents' completion will wake the session: hold, as t3code does.
    if (await hasBackgroundAgents(o)) {
      retryAfter = now + HOLD_RECHECK_MS
      if (!s.isHeldByBackground) await o.set(v => ({ ...v, isHeldByBackground: true }))
      await syncNow(o)
      return
    }
    // The daily cap across sessions: a ping (not a compaction) over it pauses instead.
    const isOverridden = isDailyOverride && overrideDay === dayOf(now)
    if (dailyCap > 0 && !isOverridden && nextAction(s) === 'ping' && (await todayCount(o, now)) >= dailyCap) {
      await o.set(v => (v.pausedAt === null ? { ...v, pausedAt: now, pauseReason: 'daily' } : v))
      o.toast(`Keep cache warm paused: ${dailyCap} ping${dailyCap === 1 ? '' : 's'} today across all sessions, your daily cap.`)
      await syncNow(o)
      return
    }
    // Claim atomically: decide due-and-unclaimed and mark it in one update.
    let isClaimed = false
    let action = 'ping' as 'ping' | 'compact'
    let attempt = 1
    await o.set(v => {
      isClaimed = false
      if (!isClaimable(v, now)) return v
      isClaimed = true
      action = nextAction(v)
      attempt = v.pingAttempts + 1
      return {
        ...v,
        pingFiredAt: now,
        lastPingAnchor: v.lastOutputAt,
        pingAttempts: v.pingAttempts + 1,
        isHeldByBackground: false,
        isFallbackPing: false,
      }
    })
    if (!isClaimed) return
    retryAfter = 0
    await syncNow(o)
    const claimAt = now
    if (action === 'compact') {
      o.toast('Compacting the conversation before the prompt cache expires.')
      if (isRemoteSurface && attempt === 1) o.note('compacting the conversation before the prompt cache expires (this runs /compact)')
      runCompaction(o, claimAt)
      return
    }
    sendPing(o, claimAt)
  }

  /** A compaction into the session totals, with its own model request's tokens when reported. */
  const addCompaction = (t: KeepWarm['pingTotals'], usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null) => ({
    ...t,
    compactions: t.compactions + 1,
    compactTokens:
      t.compactTokens +
      (usage ? usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0),
  })

  /** UTC day, the key the cross-session ping count is kept under. */
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  async function todayCount(o: Ops, now: number): Promise<number> {
    const rec = (await o.storeGet('pingDay').catch(() => undefined)) as { day?: string; count?: number } | undefined
    return rec?.day === dayOf(now) ? (rec.count ?? 0) : 0
  }
  async function countToday(o: Ops, now: number): Promise<number> {
    const n = (await todayCount(o, now)) + 1
    o.storeSet('pingDay', { day: dayOf(now), count: n })
    return n
  }

  function sendPing(o: Ops, claimAt: number): void {
    // Never awaited: it resolves only as the ping's own turn starts.
    void o.submit(PING_TEXT).then(
      r =>
        serial(async () => {
          if (r.drop !== undefined) await onDropped(o, claimAt, r.drop)
          else armCountFallback(o, claimAt)
        }),
      err => serial(() => onThrew(o, claimAt, 'ping', err)),
    )
  }

  /**
   * A compaction that failed for good leaves the cache to expire. While there is
   * time left and ping budget to spend, one keep-alive ping stands in for it, so
   * the conversation is still warm when the person is back. It counts against the
   * budget like any ping, so a host that never compacts cannot ping forever.
   */
  async function fallbackPing(o: Ops): Promise<void> {
    const now = await o.now()
    if (dailyCap > 0 && (await todayCount(o, now)) >= dailyCap) return
    let claimAt: number | null = null
    await o.set(v => {
      claimAt = null
      const { remainingMs } = cacheState(v, now)
      if (!v.isEnabled || v.pingFiredAt !== null || v.busyTurnId !== null) return v
      if (remainingMs === null || remainingMs < FALLBACK_MIN_MS) return v
      if (v.consecutivePings >= getMaxPings()) return v
      if (options.fallbackPing === false) return v
      claimAt = now
      return {
        ...v,
        pingFiredAt: now,
        lastPingAnchor: v.lastOutputAt,
        isFallbackPing: true,
      }
    })
    if (claimAt === null) return
    o.note('the compaction failed; trying a keep-alive ping in its place')
    await syncNow(o)
    sendPing(o, claimAt)
  }

  /** A failure the person should see: kept in the bar and noted in the transcript. */
  async function problem(o: Ops, text: string): Promise<void> {
    await o.set(v => ({ ...v, lastProblem: text }))
    o.note(text)
  }

  /**
   * Compacts. A terminal session answers $.session.compact; a headless one (the
   * desktop app's Code tab, the SDK) refuses it; there the /compact command does
   * the same inside a turn, so $.command.run is used instead (and remembered).
   */
  function runCompaction(o: Ops, claimAt: number): void {
    const viaCommand = () => {
      promptCompactClaim = claimAt
      armCompactCheck(o, claimAt)
      // Never awaited inside the queue: the command settles when the compaction does.
      void o.command().then(
        r =>
          serial(async () => {
            // Resolved with no compaction reported by session.compact: it did not compact.
            if (promptCompactClaim !== claimAt) return
            promptCompactClaim = null
            await o.set(v => (v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null } : v))
            await problem(o, `/compact ran but compacted nothing${r.text ? `: ${r.text}` : ''}`)
            await syncNow(o)
            await fallbackPing(o)
          }),
        err => {
          promptCompactClaim = null
          return serial(() => onThrew(o, claimAt, 'compaction', err))
        },
      )
    }
    if (compactViaCommand) return viaCommand()
    // Never awaited inside the queue: this mod's own session.compact hook queues a sync.
    void o.compact().then(
      r => serial(() => onCompacted(o, claimAt, r)),
      err => {
        // A headless host refuses session.compact for good; any other refusal still deserves
        // one try of the /compact command before it counts as a failure.
        if (/headless/i.test(String(err))) compactViaCommand = true
        return viaCommand()
      },
    )
  }

  /** A /compact command that never settled and never reported a compaction. */
  function armCompactCheck(o: Ops, claimAt: number): void {
    o.after(COMPACT_CHECK_MS, () => {
      void serial(async () => {
        if (promptCompactClaim !== claimAt) return
        promptCompactClaim = null
        await o.set(v => (v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null } : v))
        await problem(o, 'compaction did not finish: the /compact command never reported a compaction')
        await syncNow(o)
        await fallbackPing(o)
      })
    })
  }

  async function onDropped(
    o: Ops,
    claimAt: number,
    reason: string,
    what: 'ping' | 'compaction' = 'ping',
  ): Promise<void> {
    // A refusal is final for this idle period (lastPingAnchor stays set).
    await o.set(v => (v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null } : v))
    if (reason !== OWN_DROP) {
      o.toast(`Keep-alive ${what === 'ping' ? 'ping' : 'compaction'} not sent: ${reason}`)
      await problem(o, `${what} not sent: ${reason}`)
    }
    await syncNow(o)
    if (what === 'compaction' && reason !== OWN_DROP) await fallbackPing(o)
  }

  async function onCompacted(o: Ops, claimAt: number, r: SessionCompactResult): Promise<void> {
    if (r.skip !== undefined) {
      // A veto is final for this idle period, like a dropped ping.
      await o.set(v => (v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null } : v))
      o.toast(`Compaction skipped: ${r.skip}`)
      await problem(o, `compaction skipped: ${r.skip}`)
      await syncNow(o)
      await fallbackPing(o)
      return
    } else {
      const now = await o.now()
      await o.set(v => ({
        ...v,
        pingFiredAt: v.pingFiredAt === claimAt ? null : v.pingFiredAt,
        compactedAt: now,
        lastOutputAt: null,
        lastPingAnchor: null,
        lastProblem: null,
        pingTotals: addCompaction(v.pingTotals, r.usage),
      }))
      o.toast(compactedText(r.tokensBefore, r.tokensAfter))
    }
    await syncNow(o)
  }

  async function onThrew(
    o: Ops,
    claimAt: number,
    what: 'ping' | 'compaction',
    err: unknown,
  ): Promise<void> {
    // Infrastructure failure: free the anchor and retry after RETRY_MS (MAX_ATTEMPTS in all).
    const s = await o.set(v =>
      v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null, lastPingAnchor: null } : v,
    )
    const reason = cleanError(err)
    o.log(`keep-cache-warm: ${what} failed: ${String(err)}`)
    const isFinal = s.pingAttempts >= MAX_ATTEMPTS
    if (isFinal) await problem(o, `${what} failed after ${MAX_ATTEMPTS} tries: ${reason}`)
    retryAfter = (await o.now()) + RETRY_MS
    await syncNow(o)
    if (isFinal && what === 'compaction') await fallbackPing(o)
  }

  /** Counts an accepted ping whose turn.start did not recognise it (normally a no-op). */
  function armCountFallback(o: Ops, claimAt: number): void {
    o.after(COUNT_FALLBACK_MS, () => {
      void serial(async () => {
        const now = await o.now()
        let counted = 0
        let mode: Mode = 'warm'
        await o.set(v => {
          counted = 0
          mode = v.mode
          if (v.countedClaim === claimAt) return v
          const cleared: KeepWarm = {
            ...v,
            countedClaim: claimAt,
            pingFiredAt: v.pingFiredAt === claimAt ? null : v.pingFiredAt,
          }
          if (v.lastUserAt !== null && v.lastUserAt > claimAt) return cleared
          counted = v.consecutivePings + 1
          return {
            ...cleared,
            consecutivePings: counted,
            pausedAt: counted >= getMaxPings() ? (v.pausedAt ?? now) : v.pausedAt,
            pauseReason: counted >= getMaxPings() ? (v.pauseReason ?? 'limit') : v.pauseReason,
          }
        })
        if (counted > 0) o.toast(pingToast(counted, mode))
        await syncNow(o)
      })
    })
  }

  // The toggle's actions, shared by the band buttons (through ops, never a passed $).
  /**
   * Turns it on in `mode`. Switching modes while it runs keeps the ping budget
   * (t3code's nextCacheKeepAlive); turning on from off or paused starts fresh.
   */
  const setMode = async (mode: Mode) => {
    const o = ops
    if (!o) return
    retryAfter = 0
    const s = await o.set(v =>
      v.isEnabled && !isHalted(v) && v.pausedAt === null
        ? { ...v, mode, lastProblem: null, isTouched: true }
        : { ...fresh(v), isEnabled: true, mode, isTouched: true },
    )
    await sync()
    if (isFirstUse) {
      isFirstUse = false
      o.storeSet('hasPicked', true)
    }
    // A hotkey leaves the ring where it was: move it to the mode now running.
    if (bandRequestId !== null) o.focus(bandRequestId, mode)
    if (cacheState(s, await o.now(), isWaiting()).kind === 'cold') {
      o.toast(`${modeLabel(mode)} is on. The cache is cold; it starts after your next message.`)
    }
  }
  const turnOn = () => setMode('warm')
  const turnOff = async () => {
    if (!ops) return
    retryAfter = 0
    await ops.set(v => ({ ...fresh(v), isEnabled: false, isTouched: true }))
    await sync()
  }
  const resume = async () => {
    if (!ops) return
    retryAfter = 0
    const s = await ops.get()
    // Resume past the daily cap is the person's say-so: this session goes on until tomorrow.
    if (s.pauseReason === 'daily') {
      isDailyOverride = true
      overrideDay = dayOf(await ops.now())
    }
    await ops.set(fresh)
    await sync()
  }

  on('session.start', async ($, e, next) => {
    ops = {
      now: () => $.clock.now(),
      get: () => read($, S),
      set: change => update($, S, change),
      getView: () => read($, V),
      setView: view => update($, V, () => view),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      log: text => $.ui.log(text, { to: 'debug' }),
      // $.store is the cross-session record; a copy in memory covers a host without one (tests).
      storeGet: async key => (await $.store.get(key).catch(() => undefined)) ?? memStore.get(key),
      storeSet: (key, value) => {
        memStore.set(key, value)
        void $.store.set(key, value).catch(() => undefined)
      },
      focus: (requestId, key) => {
        // Denied when the bar does not hold the keys (a click on Desktop): nothing to move then.
        void $.ui.focus({ requestId, key }).catch(() => undefined)
      },
      note: text => $.ui.log(noteText(text), { to: 'transcript' }),
      after: (ms, fn) => $.clock.after(ms, fn),
      agents: () => $.agent.list(),
      submit: text => $.prompt.submit({ text, asUser: true }),
      compact: () => $.session.compact(),
      command: () => $.command.run({ command: 'compact' }),
    }
    const now = await $.clock.now()
    const s = await read($, S)
    isFirstUse = (await ops?.storeGet('hasPicked')) !== true
    // A turn whose end this copy never heard (lost worker) does not block forever.
    if (s.busyTurnId !== null && (s.busySince === null || now - s.busySince > 2 * TTL_MS)) {
      await update($, S, v => ({ ...v, busyTurnId: null, busySince: null }))
    }
    // The defaultMode setting: a session nobody has chosen a mode in starts in it.
    if (defaultMode !== null && !s.isEnabled && !s.isTouched) {
      await update($, S, v => (v.isTouched || v.isEnabled ? v : { ...v, isEnabled: true, mode: defaultMode }))
    }
    lastStatus = undefined
    await sync()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      // The process goes on under another session: its cache and toggle start over.
      waitingIds.clear()
      isElicitWaiting = false
      retryAfter = 0
      await update($, S, () => ({ ...INITIAL }))
      await sync()
    } else {
      pingTimer?.cancel()
      tickTimer?.cancel()
      pingTimer = null
      tickTimer = null
      pingDeadline = null
    }
    return next(e)
  })

  // A resumed or forked transcript: seed the anchor unless the engine says the cache lapsed.
  on('classic.SessionStart', async ($, e, next) => {
    const secs = e.seconds_since_last_response
    if (
      (e.source === 'resume' || e.source === 'fork') &&
      !e.prompt_cache_likely_expired &&
      typeof secs === 'number'
    ) {
      const seeded = (await $.clock.now()) - secs * 1000
      await update($, S, v => (v.lastOutputAt === null ? { ...v, lastOutputAt: seeded } : v))
      await sync()
    }
    return next(e)
  })

  // After a compaction the old prefix is gone: nothing is cached until the next request.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && r.messages !== undefined) {
      const claim = promptCompactClaim
      promptCompactClaim = null
      const now = await $.clock.now()
      await update($, S, v => ({
        ...v,
        lastOutputAt: null,
        lastPingAnchor: null,
        // Our own /compact prompt finished (a terminal session's compact() does this in onCompacted).
        ...(claim !== null && v.pingFiredAt === claim
          ? {
              pingFiredAt: null,
              compactedAt: now,
              lastProblem: null,
              pingTotals: addCompaction(v.pingTotals, r.usage),
            }
          : {}),
      }))
      if (claim !== null) {
        const text = compactedText(r.tokensBefore, r.tokensAfter)
        $.ui.toast(text)
        $.ui.log(noteText(text), { to: 'transcript' })
      }
      await sync()
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === NAME) {
      const s = await read($, S)
      // Early exit for our own ping, if this hook hears it; turn.start is the real guard.
      if (s.pingFiredAt === null || isStalePing(s, await $.clock.now())) return { drop: OWN_DROP }
      return next(e)
    }
    const isUser = isUserOrigin(e.origin, e.isMeta === true)
    if (isUser && e.turnId === undefined && (await read($, S)).busyTurnId !== null) {
      // The engine says the session is idle: a busy flag still set is stale.
      await update($, S, v => ({ ...v, busyTurnId: null, busySince: null }))
    }
    const r = await next(e)
    if (r.drop === undefined && isUser) {
      const now = await $.clock.now()
      // The t3code reset: a message from the person restores the budget and lifts a limit pause.
      await update($, S, v => ({
        ...v,
        consecutivePings: 0,
        // A message from the person lifts a budget pause and a daily-cap pause; the cap is checked again at the next ping.
        pausedAt: v.pauseReason === 'limit' || v.pauseReason === 'daily' ? null : v.pausedAt,
        pauseReason: v.pauseReason === 'limit' || v.pauseReason === 'daily' ? null : v.pauseReason,
        lastPingAnchor: null,
        pingAttempts: 0,
        lastUserAt: now,
        compactedAt: null,
        lastProblem: null,
      }))
      await sync()
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    let counted = 0
    let mode: Mode = 'warm'
    await update($, S, v => {
      counted = 0
      mode = v.mode
      const base: KeepWarm = {
        ...v,
        busyTurnId: e.turnId,
        busySince: now,
        hasFailed: false,
        isHeldByBackground: false,
        pingTurnId: null,
        isPingTurnStale: false,
        isFallbackPing: false,
      }
      if (v.pingFiredAt === null || !e.text.includes(PING_MARK)) return base
      // This is our ping's turn: the dequeue-time guard, then count it once.
      const claimed: KeepWarm = {
        ...base,
        pingTurnId: e.turnId,
        countedClaim: v.pingFiredAt,
        pingFiredAt: null,
        // Kept to the ping's first request, where its outcome is known.
        isFallbackPing: v.isFallbackPing,
      }
      if (isStalePing(v, now)) return { ...claimed, isPingTurnStale: true }
      if (v.countedClaim === v.pingFiredAt) return claimed
      counted = v.consecutivePings + 1
      return {
        ...claimed,
        consecutivePings: counted,
        pausedAt: counted >= getMaxPings() ? now : v.pausedAt,
        pauseReason: counted >= getMaxPings() ? 'limit' : v.pauseReason,
      }
    })
    if (counted > 0) $.ui.toast(pingToast(counted, mode))
    void sync()
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    // A new request means every tool call of the last step has settled.
    if (waitingIds.size > 0) {
      waitingIds.clear()
      void sync()
    }
    const s = await read($, S)
    const isPingTurn = s.pingTurnId === e.turnId
    if (isPingTurn && s.isPingTurnStale) {
      // A stale ping: answer here, so no request is sent and nothing is billed.
      yield { kind: 'text', index: 0, text: STALE_ANSWER }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return {
        turnId: e.turnId,
        index: e.index,
        answer: STALE_ANSWER,
        toolUses: [],
        stopReason: 'end_turn',
        usage: null,
      }
    }
    const r = yield* next(e)
    if (r.usage != null) {
      const usage = r.usage
      // The ping's first request read little from the cache: the cache is not lasting an hour here.
      const isCold = isPingTurn && e.index === 0 && isCacheCold(usage)
      const isFirstPingRequest = isPingTurn && e.index === 0
      const s2 = await update($, S, (v): KeepWarm => {
        const anchor = Math.max(v.lastOutputAt ?? 0, sentAt)
        const moved: KeepWarm = {
          ...v,
          lastOutputAt: anchor,
          pingAttempts: anchor !== v.lastOutputAt ? 0 : v.pingAttempts,
          lastPromptTokens:
            usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
          ...(isFirstPingRequest
            ? {
                pingTotals: {
                  ...v.pingTotals,
                  count: v.pingTotals.count + 1,
                  read: v.pingTotals.read + usage.cache_read_input_tokens,
                  written: v.pingTotals.written + usage.cache_creation_input_tokens + usage.input_tokens,
                  out: v.pingTotals.out + usage.output_tokens,
                },
                // A ping that stood in for a failed compaction got through: say so.
                isFallbackPing: false,
                lastProblem:
                  v.isFallbackPing && v.lastProblem !== null && !v.lastProblem.endsWith(FALLBACK_SUFFIX)
                    ? `${v.lastProblem}${FALLBACK_SUFFIX}`
                    : v.lastProblem,
              }
            : {}),
        }
        return isCold
          ? { ...moved, pausedAt: v.pausedAt ?? sentAt, pauseReason: 'not-caching' }
          : moved
      })
      if (isCold) $.ui.toast(notCachingToast(usage))
      else if (isPingTurn && e.index === 0) {
        // What the ping bought: how much of the conversation the cache served.
        const today = ops ? await countToday(ops, sentAt) : undefined
        const text = pingUsageText(usage, s2.pingTotals, today)
        $.ui.toast(text)
        // One row under the ping, which the desktop draws as if the person had typed it.
        if (isRemoteSurface) {
          $.ui.log(noteText(`↑ that was a keep-alive ping sent automatically, not by you. ${text}`), { to: 'transcript' })
        }
      }
      void sync()
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      waitingIds.clear()
      isElicitWaiting = false
      await update($, S, v => {
        const isPingTurn = v.pingTurnId === e.turnId
        const isStalePingTurn = isPingTurn && v.isPingTurnStale
        return {
          ...v,
          busyTurnId: null,
          busySince: null,
          // Only ever set true within a turn (reset at turn.start), so hook order does not matter.
          hasFailed: v.hasFailed || (e.reason === 'error' && !isStalePingTurn),
          pingTurnId: isPingTurn ? null : v.pingTurnId,
          isPingTurnStale: isPingTurn ? false : v.isPingTurnStale,
        }
      })
      await sync()
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined && !(await read($, S)).hasFailed) {
      await update($, S, v => ({ ...v, hasFailed: true }))
      await sync()
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) {
      const hasHeartbeat = (e.background_tasks ?? []).some(
        t => t.type === 'shell' && HEARTBEAT_RE.test(`${t.description} ${t.command ?? ''}`),
      )
      if ((await read($, S)).hasHeartbeat !== hasHeartbeat) {
        await update($, S, v => ({ ...v, hasHeartbeat }))
        await sync()
      }
    }
    return next(e)
  })

  on('classic.Notification', (_$, e, next) => {
    if (e.notification_type === 'elicitation_dialog' && !isElicitWaiting) {
      isElicitWaiting = true
      void sync()
    }
    return next(e)
  })

  on('classic.ElicitationResult', (_$, e, next) => {
    if (isElicitWaiting) {
      isElicitWaiting = false
      void sync()
    }
    return next(e)
  })

  on('tool.check', async (_$, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.decision === 'ask' && e.approver !== 'host' && e.tool_use_id) {
      waitingIds.add(e.tool_use_id)
      void sync()
    }
    return r
  })

  on('tool.call', async (_$, e, next) => {
    const id = e.tool_use_id
    if (e.agentId !== undefined || id === undefined) return next(e)
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') {
      waitingIds.add(id)
      void sync()
    }
    try {
      return await next(e)
    } finally {
      if (waitingIds.delete(id)) void sync()
    }
  })

  // Short labels for the one-row bar.
  const SHORT: Record<Mode, string> = {
    warm: 'Keep warm',
    compact: 'Compact',
    'warm-then-compact': 'Warm → compact',
  }
  /** One-key shortcuts, pressed once the bar has focus (ctrl+x tab, or a click). */
  const HOTKEY: Record<Mode, string> = { warm: 'w', compact: 'c', 'warm-then-compact': 't' }
  /** Which mode button reads as pressed: the running mode, none while off or paused. */
  const isPressed = (view: View, m: Mode) => view.mode === m && view.kind !== 'paused'

  /** Rough width of a mode button on the terminal: "[ label ]" plus the gap. */
  const chipWidth = (label: string) => label.length + 5

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isCollapsed || e.props.view.agentId !== undefined) {
      return next(e)
    }
    const view = await read($, V)
    if (!view) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    if (!isTerminal) isRemoteSurface = true
    bandRequestId = e.requestId

    // The ring starts on the running mode (Keep warm while off), so the focus box and the ● agree.
    const focusMode = MODES.find(m => isPressed(view, m)) ?? 'warm'
    // A terminal button draws no hotkey of its own, so the letter goes in the label.
    const withKey = (label: string, key: string) => (isTerminal ? `${label} (${key})` : label)
    const labels = MODES.map(m =>
      withKey(isPressed(view, m) ? `● ${SHORT[m]}` : SHORT[m], HOTKEY[m]),
    )
    const buttons = [
      view.kind === 'paused' && (
        <Button key="resume" label="Resume" hotkey="r" variant="primary" onPress={resume} />
      ),
      ...MODES.map((m, i) => (
        <Button
          key={m}
          // The ● marks the running mode where a surface draws no color.
          label={labels[i]}
          hotkey={HOTKEY[m]}
          variant={isPressed(view, m) ? 'primary' : 'secondary'}
          autoFocus={m === focusMode ? true : undefined}
          onPress={() => setMode(m)}
        />
      )),
      view.kind !== 'off' && (
        <Button key="off" label={withKey('Off', 'o')} hotkey="o" onPress={turnOff} />
      ),
    ]
    // The keyboard route, first thing in the Off bar on the terminal (it has no clicks in its classic renderer).
    const text =
      isTerminal && view.kind === 'off'
        ? view.band.replace('Keep cache warm: off', 'Keep cache warm: off · ctrl+x tab, then w c or t')
        : isTerminal
          ? `${view.band} · ctrl+x tab for keys`
          : view.band

    // One row when the text and the buttons both fit; otherwise the text over the buttons, so
    // a long state never pushes a button (Off above all) out of reach. A desktop always stacks:
    // its text is not measured in cells.
    const buttonsWidth =
      chipWidth('Resume') * (view.kind === 'paused' ? 1 : 0) +
      labels.reduce((n, l) => n + chipWidth(l), 0) +
      (view.kind !== 'off' ? chipWidth('Off (o)') : 0)
    // A few cells spare: the engine's [-] mark and rounding.
    const fitsOneRow = isTerminal && text.length + buttonsWidth + 6 <= e.props.bodyColumns

    if (fitsOneRow) {
      return (
        <Box flexDirection="row" gap={1} width={e.props.bodyColumns}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={view.color} wrap="truncate-end">
              {text}
            </Text>
          </Box>
          {buttons}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={isTerminal ? e.props.bodyColumns : undefined}>
        <Text color={view.color}>{text}</Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {buttons}
        </Box>
      </Box>
    )
  })
}
