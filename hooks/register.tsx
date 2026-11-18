// keep-cache-warm: keeps the Claude prompt cache warm. About 5 minutes before
// the 1-hour cache expires it pings or compacts, by the mode picked in the bar
// above the prompt. GUI only: the bar, a status-line countdown and toasts; it
// registers no slash command.
//
// Route: an in-mod timer ($.clock.after), then $.prompt.submit (a ping, which
// starts a turn of its own once the session is idle) or $.session.compact.

import { atom, read, update } from 'claude-code'
import type { AgentInfo, PromptSubmitResult, Register, SessionCompactResult, Timer } from 'claude-code'

import type { KeepWarm, Mode, View } from '../types'
import {
  ARM_SLACK_MS,
  COUNT_FALLBACK_MS,
  HEARTBEAT_RE,
  HOLD_RECHECK_MS,
  INITIAL,
  MAX_PINGS,
  NAME,
  OWN_DROP,
  PING_MARK,
  PING_TEXT,
  RETRY_MS,
  STALE_ANSWER,
  TTL_MS,
  MODE_LABEL,
  MODES,
  cacheState,
  isCacheCold,
  isClaimable,
  isStalePing,
  isHalted,
  isUserOrigin,
  nextAction,
  nextPingAt,
  notCachingToast,
  pingToast,
  toView,
} from './logic'

// One atom for all the logic state, so each change is one atomic update.
// Change the tag when KeepWarm's fields change: it declines older values.
const S = atom({ plugin: 'keep-cache-warm', key: 's' } as const, INITIAL, { shape: 'kw-3' })
// The derived display; the band reads only this, so it redraws only when the text changes.
const V = atom({ plugin: 'keep-cache-warm', key: 'view' } as const, null, { shape: 'view-3' })

const fresh = (v: KeepWarm): KeepWarm => ({
  ...v,
  consecutivePings: 0,
  pausedAt: null,
  pauseReason: null,
  lastPingAnchor: null,
  pingAttempts: 0,
  isHeldByBackground: false,
})

/** What the timers and continuations reach the engine through: closures over session.start's `$`. */
type Ops = {
  now: () => Promise<number>
  get: () => Promise<KeepWarm>
  set: (change: (v: KeepWarm) => KeepWarm) => Promise<KeepWarm>
  getView: () => Promise<View | null>
  setView: (view: View) => Promise<unknown>
  status: (text: string) => void
  toast: (text: string) => void
  log: (text: string) => void
  after: (ms: number, fn: () => void) => Timer
  agents: () => Promise<AgentInfo[]>
  submit: (text: string) => Promise<PromptSubmitResult>
  compact: () => Promise<SessionCompactResult>
}

export const register: Register = on => {
  let ops: Ops | null = null
  let pingTimer: Timer | null = null
  let pingDeadline: number | null = null
  let tickTimer: Timer | null = null
  /** Not before this time: set after a thrown submit or a background hold. */
  let retryAfter = 0
  let lastStatus: string | undefined
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
    const view = toView(s, now, isWaiting())
    if (view.status !== lastStatus) {
      lastStatus = view.status
      o.status(view.status)
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
    // Claim atomically: decide due-and-unclaimed and mark it in one update.
    let isClaimed = false
    let action = 'ping' as 'ping' | 'compact'
    await o.set(v => {
      isClaimed = false
      if (!isClaimable(v, now)) return v
      isClaimed = true
      action = nextAction(v)
      return {
        ...v,
        pingFiredAt: now,
        lastPingAnchor: v.lastOutputAt,
        pingAttempts: v.pingAttempts + 1,
        isHeldByBackground: false,
      }
    })
    if (!isClaimed) return
    retryAfter = 0
    await syncNow(o)
    const claimAt = now
    if (action === 'compact') {
      o.toast('Compacting the conversation before the prompt cache expires.')
      // Never awaited inside the queue: this mod's own session.compact hook queues a sync.
      void o.compact().then(
        r => serial(() => onCompacted(o, claimAt, r)),
        () => serial(() => onThrew(o, claimAt)),
      )
      return
    }
    // Never awaited: it resolves only as the ping's own turn starts.
    void o.submit(PING_TEXT).then(
      r =>
        serial(async () => {
          if (r.drop !== undefined) await onDropped(o, claimAt, r.drop)
          else armCountFallback(o, claimAt)
        }),
      () => serial(() => onThrew(o, claimAt)),
    )
  }

  async function onDropped(o: Ops, claimAt: number, reason: string): Promise<void> {
    // A refusal is final for this idle period (lastPingAnchor stays set).
    await o.set(v => (v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null } : v))
    if (reason !== OWN_DROP) o.toast(`Keep-alive ping not sent: ${reason}`)
    await syncNow(o)
  }

  async function onCompacted(o: Ops, claimAt: number, r: SessionCompactResult): Promise<void> {
    if (r.skip !== undefined) {
      // A veto is final for this idle period, like a dropped ping.
      await o.set(v => (v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null } : v))
      o.toast(`Compaction skipped: ${r.skip}`)
    } else {
      const now = await o.now()
      await o.set(v => ({
        ...v,
        pingFiredAt: v.pingFiredAt === claimAt ? null : v.pingFiredAt,
        compactedAt: now,
        lastOutputAt: null,
        lastPingAnchor: null,
      }))
      o.toast('Compacted the conversation before the prompt cache expired.')
    }
    await syncNow(o)
  }

  async function onThrew(o: Ops, claimAt: number): Promise<void> {
    // Infrastructure failure: free the anchor and retry after RETRY_MS (MAX_ATTEMPTS in all).
    await o.set(v =>
      v.pingFiredAt === claimAt ? { ...v, pingFiredAt: null, lastPingAnchor: null } : v,
    )
    retryAfter = (await o.now()) + RETRY_MS
    await syncNow(o)
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
            pausedAt: counted >= MAX_PINGS ? (v.pausedAt ?? now) : v.pausedAt,
            pauseReason: counted >= MAX_PINGS ? (v.pauseReason ?? 'limit') : v.pauseReason,
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
        ? { ...v, mode }
        : { ...fresh(v), isEnabled: true, mode },
    )
    await sync()
    if (cacheState(s, await o.now(), isWaiting()).kind === 'cold') {
      o.toast(`${MODE_LABEL[mode]} is on. The cache is cold; it starts after your next message.`)
    }
  }
  const turnOn = () => setMode('warm')
  const turnOff = async () => {
    if (!ops) return
    retryAfter = 0
    await ops.set(v => ({ ...fresh(v), isEnabled: false }))
    await sync()
  }
  const resume = async () => {
    if (!ops) return
    retryAfter = 0
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
      after: (ms, fn) => $.clock.after(ms, fn),
      agents: () => $.agent.list(),
      submit: text => $.prompt.submit({ text, asUser: true }),
      compact: () => $.session.compact(),
    }
    const now = await $.clock.now()
    const s = await read($, S)
    // A turn whose end this copy never heard (lost worker) does not block forever.
    if (s.busyTurnId !== null && (s.busySince === null || now - s.busySince > 2 * TTL_MS)) {
      await update($, S, v => ({ ...v, busyTurnId: null, busySince: null }))
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
      await update($, S, v => ({ ...v, lastOutputAt: null, lastPingAnchor: null }))
      await sync()
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === NAME) {
      // Early exit for our own ping, if this hook hears it; turn.start is the real guard.
      const s = await read($, S)
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
        pausedAt: v.pauseReason === 'limit' ? null : v.pausedAt,
        pauseReason: v.pauseReason === 'limit' ? null : v.pauseReason,
        lastPingAnchor: null,
        pingAttempts: 0,
        lastUserAt: now,
        compactedAt: null,
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
      }
      if (v.pingFiredAt === null || !e.text.includes(PING_MARK)) return base
      // This is our ping's turn: the dequeue-time guard, then count it once.
      const claimed: KeepWarm = {
        ...base,
        pingTurnId: e.turnId,
        countedClaim: v.pingFiredAt,
        pingFiredAt: null,
      }
      if (isStalePing(v, now)) return { ...claimed, isPingTurnStale: true }
      if (v.countedClaim === v.pingFiredAt) return claimed
      counted = v.consecutivePings + 1
      return {
        ...claimed,
        consecutivePings: counted,
        pausedAt: counted >= MAX_PINGS ? now : v.pausedAt,
        pauseReason: counted >= MAX_PINGS ? 'limit' : v.pauseReason,
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
      await update($, S, (v): KeepWarm => {
        const anchor = Math.max(v.lastOutputAt ?? 0, sentAt)
        const moved: KeepWarm = {
          ...v,
          lastOutputAt: anchor,
          pingAttempts: anchor !== v.lastOutputAt ? 0 : v.pingAttempts,
        }
        return isCold
          ? { ...moved, pausedAt: v.pausedAt ?? sentAt, pauseReason: 'not-caching' }
          : moved
      })
      if (isCold) $.ui.toast(notCachingToast(usage))
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isCollapsed || e.props.view.agentId !== undefined) {
      return next(e)
    }
    const view = await read($, V)
    if (!view) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1} width={e.props.bodyColumns}>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={view.color} wrap="truncate-end">
            {view.band}
          </Text>
        </Box>
        {view.kind === 'paused' && (
          <Button key="resume" label="Resume" hotkey="r" variant="primary" onPress={resume} />
        )}
        {MODES.map(m => (
          <Button
            key={m}
            // The ● marks the running mode where a surface draws no color.
            label={isPressed(view, m) ? `● ${SHORT[m]}` : SHORT[m]}
            hotkey={HOTKEY[m]}
            variant={isPressed(view, m) ? 'primary' : 'secondary'}
            onPress={() => setMode(m)}
          />
        ))}
        {view.kind !== 'off' && <Button key="off" label="Off" hotkey="o" onPress={turnOff} />}
      </Box>
    )
  })
}
