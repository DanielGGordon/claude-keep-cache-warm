import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type {
  AgentInfo,
  On,
  PromptSubmitInput,
  PromptSubmitResult,
  SessionCompactResult,
  TurnUsage,
} from 'claude-code'

import { OWN_DROP, PING_TEXT, STALE_ANSWER } from '../hooks/logic'

const MIN = 60_000
const T0 = 1_700_000_000_000
const PLUGIN = 'keep-cache-warm'

const WARM: TurnUsage = {
  model: 'm',
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 100,
}
const COLD: TurnUsage = { ...WARM, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000 }

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

/** The engine beneath the plugin, with recorders and the knobs a test turns. */
function world($: Engine, on: On) {
  const clock = mock.clock(on, { now: T0 })
  const w = {
    clock,
    statuses: [] as string[],
    toasts: [] as string[],
    logs: [] as string[],
    /** Lines the mod put in the transcript (ui.log to 'transcript'). */
    notes: [] as string[],
    submits: [] as PromptSubmitInput[],
    steps: 0,
    compactions: [] as string[],

    compactAnswer: { messages: [{ role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }] } as SessionCompactResult,
    usage: WARM as TurnUsage | null,
    agents: [] as AgentInfo[],
    /**
     * When true, a plugin's submit resolves only as its turn starts, as the
     * live engine did (README, "Confirmed live"), not at once.
     */
    holdUntilTurn: false,
    held: [] as Array<{ text: string; resolve: () => void }>,
    answer: (e: PromptSubmitInput): PromptSubmitResult => ({ text: e.text, origin: e.origin }),
    status: () => w.statuses[w.statuses.length - 1],
    pings: () => w.submits.filter(e => e.origin.kind === 'plugin'),
    start: async () => {
      await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
      await clock.settle()
    },
    /** One main turn: start, one model request, complete. */
    turn: async (text: string, turnId: string, reason: 'answer' | 'error' | 'aborted' = 'answer') => {
      await $.turn.start({ text, turnId })
      const stream = $.turn.step({ turnId, index: 0, model: 'm', messageCount: 1 })
      let piece = await stream.next()
      while (!piece.done) piece = await stream.next()
      const step = piece.value
      await $.turn.complete({ turnId, answer: step.answer, durationMs: 1, isAborted: reason === 'aborted', reason })
      await clock.settle()
      return step
    },
    user: async (text: string, turnId: string) => {
      await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
      return w.turn(text, turnId)
    },
    band: async (surface: 'terminal' | 'desktop' | 'mobile' = 'desktop') => $.ui.mount({ ...BAND, surface }),
    press: async (key: string) => {
      const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
      await ui.press({ key })
      await ui.unmount()
      await clock.settle()
    },
    bandText: async () => {
      const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
      const text = (await ui.find({ type: 'Text' }))?.text ?? ''
      await ui.unmount()
      return text
    },
    /** Runs the ping's own turn, as the engine would once the session is idle. */
    pingTurn: async (turnId: string) => w.turn(PING_TEXT, turnId),
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => {
    w.statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    ;(e.to === 'transcript' ? w.notes : w.logs).push(e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: w.agents }))
  on('session.compact', (_, e) => {
    w.compactions.push('plugin')
    return w.compactAnswer
  })

  on('prompt.submit', (_, e) => {
    w.submits.push(e)
    const answer = w.answer(e)
    if (!w.holdUntilTurn || e.origin.kind !== 'plugin' || answer.drop !== undefined) return answer
    return new Promise<PromptSubmitResult>(resolve => w.held.push({ text: e.text, resolve: () => resolve(answer) }))
  })
  on('turn.start', (_, e) => {
    // The engine resolves a queued submit as its turn starts.
    const i = w.held.findIndex(h => h.text === e.text)
    if (i >= 0) w.held.splice(i, 1)[0]?.resolve()
    return { turnId: e.turnId }
  })
  on('turn.step', async function* (_, e) {
    w.steps += 1
    const usage = w.usage
    yield { kind: 'text', index: 0, text: 'ok' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.Notification', () => ({}))
  return w
}

test('countdown floors minutes; one ping at +55m with the exact text; its own ping does not reset the count', async ($, on) => {
  const w = world($, on)
  await w.start()
  expect(w.status() ?? '').toBe('')

  await w.press('warm')
  expect(w.status()).toBe('Cache: cold')
  expect(w.toasts.some(t => t.includes('The cache is cold'))).toBe(true)

  await w.user('hello', 'u1')
  expect(w.status()).toBe('Cache: 60m')

  await w.clock.advance(5 * MIN + 1_000)
  expect(w.status()).toBe('Cache: 54m') // 54m59s left
  await w.clock.set(T0 + 18 * MIN)
  expect(w.status()).toBe('Cache: 42m')

  await w.clock.set(T0 + 55 * MIN - 1)
  expect(w.pings().length).toBe(0)
  await w.clock.advance(1)
  expect(w.pings().length).toBe(1)
  const ping = w.pings()[0]
  expect(ping?.text).toBe(PING_TEXT)
  expect(ping?.origin).toEqual({ kind: 'plugin', name: PLUGIN, asUser: true })
  expect(w.status()).toBe('Cache: busy')

  await w.pingTurn('p1')
  expect(w.toasts).toContain('Keep-alive ping sent to keep the prompt cache warm (1 of 8).')
  expect(w.status()).toBe('Cache: 60m')
  expect(await w.bandText()).toContain('1 of 8 pings sent')

  // The count fallback does not count it twice.
  await w.clock.advance(2 * MIN)
  expect(w.toasts.filter(t => t.includes('of 8')).length).toBe(1)

  // The ping's own output chains the next ping an hour on.
  await w.clock.set(T0 + 110 * MIN - 1)
  expect(w.pings().length).toBe(1)
  await w.clock.advance(1)
  expect(w.pings().length).toBe(2)
  expect(w.logs).toEqual([])
})

test('a timer-sent ping whose submit resolves only as its turn starts (the live engine) is sent once and counted once', async ($, on) => {
  const w = world($, on)
  w.holdUntilTurn = true
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')

  // Nothing but the mod's own timer acts: the session is idle.
  await w.clock.set(T0 + 55 * MIN)
  expect(w.pings().length).toBe(1)
  expect(w.held.length).toBe(1)
  expect(w.status()).toBe('Cache: busy')

  // The queued ping has not started its turn yet: no second ping, no early count, nothing logged.
  await w.clock.advance(MIN)
  expect(w.status()).toBe('Cache: busy')
  await w.clock.advance(3 * MIN)
  expect(w.pings().length).toBe(1)
  expect(w.toasts.some(t => t.includes('of 8'))).toBe(false)

  // The engine starts the ping's turn, which resolves the submit.
  await w.pingTurn('p1')
  expect(w.held.length).toBe(0)
  expect(w.toasts.filter(t => t.includes('of 8'))).toEqual([
    'Keep-alive ping sent to keep the prompt cache warm (1 of 8).',
  ])
  expect(w.status()).toBe('Cache: 60m')
  // The count fallback, now armed, does not count it again.
  await w.clock.advance(2 * MIN)
  expect(w.toasts.filter(t => t.includes('of 8')).length).toBe(1)

  // The ping's own output chains the next one.
  await w.clock.advance(53 * MIN)
  expect(w.pings().length).toBe(2)
  expect(w.logs).toEqual([])
})

test('pauses after 8 pings with a toast, sends no 9th, and a user message resumes', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  for (let i = 1; i <= 8; i += 1) {
    await w.clock.advance(55 * MIN)
    expect(w.pings().length).toBe(i)
    await w.pingTurn(`p${i}`)
  }
  expect(w.status()).toBe('Cache: paused')
  expect(w.toasts.some(t => t.startsWith('Keep cache warm paused: 8 pings in a row'))).toBe(true)
  expect(await w.bandText()).toContain('Paused after 8 pings')

  await w.clock.advance(3 * 60 * MIN)
  expect(w.pings().length).toBe(8)

  await w.user('back again', 'u2')
  expect(w.status()).toBe('Cache: 60m')
  expect(await w.bandText()).not.toContain('of 8')
  await w.clock.advance(55 * MIN)
  expect(w.pings().length).toBe(9)
})

test('Resume restores a fresh budget', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  for (let i = 1; i <= 8; i += 1) {
    await w.clock.advance(55 * MIN)
    await w.pingTurn(`p${i}`)
  }
  expect(w.status()).toBe('Cache: paused')
  await w.press('resume')
  expect(w.status()).toBe('Cache: 60m')
})

test('no ping while a turn runs or waits on the person; a due ping goes out once the turn ends', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')

  await w.clock.set(T0 + 50 * MIN)
  await $.turn.start({ text: 'long one', turnId: 'u2' })
  await w.clock.settle()
  expect(w.status()).toBe('Cache: busy')
  await $.classic.Notification({ message: 'needs input', notification_type: 'elicitation_dialog' })
  await w.clock.settle()
  expect(w.status()).toBe('Cache: waiting')

  await w.clock.set(T0 + 57 * MIN)
  expect(w.pings().length).toBe(0)

  // The turn ends without a model request; the cache from T0 is still live and due.
  await $.turn.complete({ turnId: 'u2', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  await w.clock.settle()
  expect(w.pings().length).toBe(1)
})

test('no ping after a failed turn', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  w.usage = null
  await w.clock.advance(MIN)
  await w.turn('again', 'u2', 'error')
  expect(w.status()).toBe('Cache: cold')
  await w.clock.set(T0 + 59 * MIN)
  expect(w.pings().length).toBe(0)
})

test('a dropped ping toasts, is final for its idle period, and the cache goes cold at +60m', async ($, on) => {
  const w = world($, on)
  w.answer = () => ({ drop: 'a host limit was reached' })
  await w.start()
  await w.press('warm')
  w.answer = e => (e.origin.kind === 'plugin' ? { drop: 'a host limit was reached' } : { text: e.text, origin: e.origin })
  await w.user('hello', 'u1')
  await w.clock.set(T0 + 55 * MIN)
  expect(w.pings().length).toBe(1)
  expect(w.toasts).toContain('Keep-alive ping not sent: a host limit was reached')
  await w.clock.set(T0 + 60 * MIN - 1)
  // The refusal stays in the bar until the cache expires, instead of reading "due now".
  expect(w.status()).toBe('Cache: failed')
  expect(await w.bandText()).toContain('ping not sent: a host limit was reached')
  await w.clock.set(T0 + 60 * MIN + 200)
  expect(w.status()).toBe('Cache: cold')
  await w.clock.advance(2 * 60 * MIN)
  expect(w.pings().length).toBe(1)
})

test('a drop by its own guard shows no toast', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  w.answer = e => (e.origin.kind === 'plugin' ? { drop: OWN_DROP } : { text: e.text, origin: e.origin })
  await w.user('hello', 'u1')
  await w.clock.set(T0 + 55 * MIN)
  expect(w.pings().length).toBe(1)
  expect(w.toasts.some(t => t.includes('not sent'))).toBe(false)
})

test('turning it off cancels the ping', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await w.press('off')
  expect(w.status() ?? '').toBe('')
  expect(await w.bandText()).toContain('Keep cache warm: off · cache 60m left')
  await w.clock.set(T0 + 59 * MIN)
  expect(w.pings().length).toBe(0)
})

test('a ping made stale by a user message sends no request when its turn starts', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await w.clock.set(T0 + 55 * MIN)
  expect(w.pings().length).toBe(1)

  // The person writes before the queued ping's turn starts; their turn runs first.
  await w.user('actually, one more thing', 'u2')
  const steps = w.steps
  const step = await w.pingTurn('p1')
  expect(step.answer).toBe(STALE_ANSWER)
  expect(w.steps).toBe(steps)
  expect(w.toasts.some(t => t.includes('of 8'))).toBe(false)
  await w.clock.advance(2 * MIN)
  expect(w.toasts.some(t => t.includes('of 8'))).toBe(false)
})

test('a ping that finds the cache cold pauses as not caching', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await w.clock.set(T0 + 55 * MIN)
  w.usage = COLD
  await w.pingTurn('p1')
  expect(w.status()).toBe('Cache: paused')
  expect(w.toasts.some(t => t.includes('not lasting an hour'))).toBe(true)
  await w.clock.advance(2 * 60 * MIN)
  expect(w.pings().length).toBe(1)
})

test('background subagents hold the ping until they finish', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  w.agents = [
    {
      id: 'a1',
      description: 'explore',
      type: 'Explore',
      status: 'running',
      kind: 'local_agent',
      taskStatus: 'running',
      label: 'explore',
      startTime: T0,
      cwd: '/',
      tokenCount: 0,
      tokenSamples: [],
      hasRow: true,
    },
  ]
  await w.clock.set(T0 + 55 * MIN)
  expect(w.pings().length).toBe(0)
  expect(w.status()).toBe('Cache: busy')
  w.agents = []
  await w.clock.advance(MIN)
  expect(w.pings().length).toBe(1)
})

test('two triggers at the same moment send exactly one ping', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await w.clock.set(T0 + 55 * MIN - 10)
  await Promise.all([
    w.clock.advance(10),
    $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true }),
    $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true }),
  ])
  await w.clock.settle()
  expect(w.pings().length).toBe(1)
})

test('messages from other sources do not reset the budget', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await w.clock.advance(55 * MIN)
  await w.pingTurn('p1')
  await $.prompt.submit({ text: 'task done', origin: { kind: 'task-notification' }, wait: false })
  await $.prompt.submit({ text: 'go on', origin: { kind: 'auto-continuation' }, wait: false })
  await w.clock.settle()
  expect(await w.bandText()).toContain('1 of 8')
})

test('/clear turns it off and forgets the cache', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await w.clock.settle()
  expect(w.status() ?? '').toBe('')
  await w.clock.advance(60 * MIN)
  expect(w.pings().length).toBe(0)
})

test('the band draws on terminal, desktop and mobile', async ($, on) => {
  const w = world($, on)
  await w.start()
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await w.band(surface)
    expect((await ui.find({ type: 'Text' }))?.text).toContain('Keep cache warm: off')
    expect(await ui.find({ key: 'warm' })).toBeDefined()
    await ui.unmount()
  }
})

test('a long state stacks the text over the buttons, so Off is always reachable', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm-then-compact')
  await w.user('hello', 'u1')
  for (const surface of ['desktop', 'terminal'] as const) {
    const props = { ...BAND.props, bodyColumns: surface === 'terminal' ? 60 : 120 }
    const ui = await $.ui.mount({ ...BAND, props, surface })
    expect((await ui.find({ type: 'Text' }))?.text).toContain('Warm → compact')
    for (const key of ['warm', 'compact', 'warm-then-compact', 'off']) {
      expect(await ui.find({ key })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a ping is noted in the transcript where the surface shows it as the person\'s own message', async ($, on) => {
  const w = world($, on)
  await w.start()
  // The terminal labels the ping row itself: no note.
  const terminal = await w.band('terminal')
  await terminal.press({ key: 'warm' })
  await terminal.unmount()
  await w.clock.settle()
  await w.user('hello', 'u1')
  await w.clock.set(T0 + 55 * MIN)
  expect(w.pings().length).toBe(1)
  expect(w.notes).toEqual([])
  // A desktop shows it as a user bubble, so the transcript says who sent it.
  const desktop = await w.band('desktop')
  await desktop.unmount()
  await w.pingTurn('p1')
  await w.clock.set(T0 + 55 * MIN + 55 * MIN + 10)
  expect(w.pings().length).toBe(2)
  expect(w.notes).toContain('sending a keep-alive ping automatically (not typed by you) to keep the prompt cache warm')
  expect(w.notes.some(n => n.includes('Ping read 100% of its 50.1K input tokens from the cache.'))).toBe(true)
})

test('compact mode compacts 5 minutes before expiry instead of pinging, once, until you write again', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('compact')
  await w.user('hello', 'u1')
  expect(await w.bandText()).toContain('Compacting before expiry')
  expect(await w.bandText()).toContain('compaction in 55m')
  await w.clock.set(T0 + 55 * MIN - 1)
  expect(w.compactions).toEqual([])
  await w.clock.advance(1)
  expect(w.compactions).toEqual(['plugin'])
  expect(w.pings().length).toBe(0)
  expect(w.toasts).toContain('Compacted the conversation before the prompt cache expired.')
  expect(w.status()).toBe('Cache: compacted')
  await w.clock.advance(3 * 60 * MIN)
  expect(w.compactions.length).toBe(1)
  // The next message starts a fresh cache, which is compacted again before it expires.
  await w.user('back', 'u2')
  expect(w.status()).toBe('Cache: 60m')
  await w.clock.advance(55 * MIN)
  expect(w.compactions.length).toBe(2)
  expect(w.logs).toEqual([])
})

test('a vetoed compaction toasts, stays in the bar, and a keep-alive ping keeps the cache warm instead', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.compactAnswer = { skip: 'a hook said no' }
  await w.press('compact')
  await w.user('hello', 'u1')
  await w.clock.advance(55 * MIN)
  expect(w.toasts).toContain('Compaction skipped: a hook said no')
  expect(w.compactions.length).toBe(1)
  // One ping stands in for the failed compaction.
  expect(w.pings().length).toBe(1)
  await w.pingTurn('p1')
  // ...and the bar keeps saying what happened; the cache is warm again, so the countdown stands.
  expect(w.status()).toBe('Cache: 60m')
  expect(await w.bandText()).toContain('Kept warm by a ping instead; compaction skipped: a hook said no')
  // The next idle period tries to compact again; nothing more goes out before it.
  await w.clock.advance(50 * MIN)
  expect(w.compactions.length).toBe(1)
  expect(w.pings().length).toBe(1)
})

test('a compaction that keeps failing stands in pings only up to the budget', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.compactAnswer = { skip: 'never' }
  await w.press('compact')
  await w.user('hello', 'u1')
  for (let i = 1; i <= 10; i += 1) {
    await w.clock.advance(55 * MIN)
    if (w.pings().length === i) await w.pingTurn(`p${i}`)
  }
  expect(w.pings().length).toBe(8)
  expect(w.status()).toBe('Cache: paused')
})

test('with fallbackPing off, a failed compaction sends nothing in its place', { options: { fallbackPing: false } }, async ($, on) => {
  const w = world($, on)
  await w.start()
  w.compactAnswer = { skip: 'no' }
  await w.press('compact')
  await w.user('hello', 'u1')
  await w.clock.advance(55 * MIN)
  expect(w.compactions.length).toBe(1)
  expect(w.pings().length).toBe(0)
  expect(w.status()).toBe('Cache: failed')
})

test('each ping reports the session totals, and the pause shows them', { options: { maxPings: 2 } }, async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await w.clock.advance(55 * MIN)
  await w.pingTurn('p1')
  await w.clock.advance(55 * MIN)
  await w.pingTurn('p2')
  expect(w.toasts).toContain(
    'Ping read 100% of its 50.1K input tokens from the cache. This session: 2 pings, 100.0K tokens read from the cache, 200 written.',
  )
  expect(await w.bandText()).toContain('This session: 2 pings, 100.0K tokens read from the cache, 200 written')
})

test('the maxPings setting sets the budget', { options: { maxPings: 2 } }, async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  expect(await w.bandText()).toContain('Keeping cache warm')
  await w.clock.advance(55 * MIN)
  await w.pingTurn('p1')
  expect(await w.bandText()).toContain('1 of 2 pings sent')
  await w.clock.advance(55 * MIN)
  await w.pingTurn('p2')
  expect(w.status()).toBe('Cache: paused')
  expect(await w.bandText()).toContain('Paused after 2 pings')
  await w.clock.advance(55 * MIN)
  expect(w.pings().length).toBe(2)
})

test('the defaultMode setting starts a new session in that mode, until the person picks', { options: { defaultMode: 'warm' } }, async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.user('hello', 'u1')
  expect(await w.bandText()).toContain('Keeping cache warm · ping in 55m')
  await w.press('off')
  expect(await w.bandText()).toContain('Keep cache warm: off')
})

test('warm-then-compact pings 8 times, then compacts instead of pausing', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm-then-compact')
  await w.user('hello', 'u1')
  for (let i = 1; i <= 8; i += 1) {
    await w.clock.advance(55 * MIN)
    expect(w.pings().length).toBe(i)
    await w.pingTurn(`p${i}`)
  }
  expect(w.toasts.some(t => t.startsWith('Ping 8 of 8 sent'))).toBe(true)
  expect(w.status()).toBe('Cache: 60m')
  expect(await w.bandText()).toContain('compaction in 55m')
  await w.clock.advance(55 * MIN)
  expect(w.pings().length).toBe(8)
  expect(w.compactions).toEqual(['plugin'])
  expect(w.status()).toBe('Cache: compacted')
  // Your next message restores the ping budget.
  await w.user('back', 'u2')
  await w.clock.advance(55 * MIN)
  expect(w.pings().length).toBe(9)
  expect(w.compactions.length).toBe(1)
})

test('switching modes while on keeps the ping budget; the bar has no Panel button', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.press('warm')
  await w.user('hello', 'u1')
  await w.clock.advance(55 * MIN)
  await w.pingTurn('p1')
  await w.press('warm-then-compact')
  expect(await w.bandText()).toContain('1 of 8 pings')
  const ui = await w.band('desktop')
  expect(await ui.find({ key: 'panel' })).toBeUndefined()
  await ui.unmount()
})
