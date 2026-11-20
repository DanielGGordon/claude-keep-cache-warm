import { describe, expect, test } from 'claude-code/testing'

import {
  INITIAL,
  LEAD_MS,
  MAX_ATTEMPTS,
  TTL_MS,
  cacheState,
  cleanError,
  compactedText,
  fmtTokens,
  formatRemaining,
  isCacheCold,
  isStalePing,
  isUserOrigin,
  nextPingAt,
  pingUsageText,
  statusText,
  toView,
} from '../hooks/logic'
import type { KeepWarm } from '../types'

const MIN = 60_000
const T0 = 1_700_000_000_000
const on = (over: Partial<KeepWarm> = {}): KeepWarm => ({
  ...INITIAL,
  isEnabled: true,
  lastOutputAt: T0,
  ...over,
})

describe('formatRemaining (t3code cases)', () => {
  test('rounds down to whole minutes', async () => {
    expect(formatRemaining(55 * MIN)).toBe('55m')
    expect(formatRemaining(54 * MIN + 59_000)).toBe('54m')
    expect(formatRemaining(MIN)).toBe('1m')
    expect(formatRemaining(59_000)).toBe('<1m')
    expect(formatRemaining(60 * MIN)).toBe('60m')
  })
})

describe('cacheState order', () => {
  test('off beats everything', async () => {
    expect(cacheState(on({ isEnabled: false, pausedAt: T0 }), T0).kind).toBe('off')
  })
  test('paused beats busy and waiting', async () => {
    expect(cacheState(on({ pausedAt: T0, busyTurnId: 't' }), T0, true).kind).toBe('paused')
  })
  test('waiting beats busy', async () => {
    expect(cacheState(on({ busyTurnId: 't' }), T0, true).kind).toBe('waiting')
  })
  test('busy while a turn runs or a ping is in flight', async () => {
    expect(cacheState(on({ busyTurnId: 't' }), T0).kind).toBe('busy')
    expect(cacheState(on({ pingFiredAt: T0 }), T0 + MIN).kind).toBe('busy')
    // A stale in-flight marker no longer reads busy.
    expect(cacheState(on({ pingFiredAt: T0 }), T0 + 10 * MIN).kind).toBe('scheduled')
  })
  test('a failed turn, no output, or an expired cache is cold', async () => {
    expect(cacheState(on({ hasFailed: true }), T0).kind).toBe('cold')
    expect(cacheState(on({ lastOutputAt: null }), T0).kind).toBe('cold')
    expect(cacheState(on(), T0 + TTL_MS).kind).toBe('cold')
  })
  test('due from 55 minutes, scheduled before', async () => {
    expect(cacheState(on(), T0 + TTL_MS - LEAD_MS - 1).kind).toBe('scheduled')
    expect(cacheState(on(), T0 + TTL_MS - LEAD_MS).kind).toBe('due')
  })
})

describe('status text', () => {
  test('countdown and states', async () => {
    expect(statusText(cacheState(on(), T0 + 18 * MIN))).toBe('Cache: 42m')
    expect(statusText(cacheState(on(), T0 + 5 * MIN + 1_000))).toBe('Cache: 54m')
    expect(statusText(cacheState(on(), T0 + TTL_MS - 30_000))).toBe('Cache: <1m')
    expect(statusText(cacheState(on({ isEnabled: false }), T0))).toBe('Cache: off')
    expect(statusText(cacheState(on({ busyTurnId: 't' }), T0))).toBe('Cache: busy')
    expect(statusText(cacheState(on({ pausedAt: T0 }), T0))).toBe('Cache: paused')
    expect(statusText(cacheState(on(), T0 + TTL_MS))).toBe('Cache: cold')
    expect(statusText(cacheState(on(), T0, true))).toBe('Cache: waiting')
  })
  test('the band shows time left even when paused or off', async () => {
    expect(toView(on({ pausedAt: T0, pauseReason: 'limit' }), T0 + 10 * MIN).band).toContain('50m left')
    expect(toView(on({ isEnabled: false }), T0 + 10 * MIN).band).toContain('50m left')
  })
})

describe('nextPingAt', () => {
  test('anchor + 55m, once per anchor, within the attempt budget', async () => {
    expect(nextPingAt(on(), T0)).toBe(T0 + 55 * MIN)
    expect(nextPingAt(on({ lastPingAnchor: T0 }), T0)).toBe(null)
    expect(nextPingAt(on({ pingAttempts: MAX_ATTEMPTS }), T0)).toBe(null)
    expect(nextPingAt(on({ hasFailed: true }), T0)).toBe(null)
    expect(nextPingAt(on(), T0 + TTL_MS)).toBe(null)
    expect(nextPingAt(on({ busyTurnId: 't' }), T0)).toBe(null)
  })
})

describe('isStalePing', () => {
  const claimed = on({ lastPingAnchor: T0, pingFiredAt: T0 + 55 * MIN })
  test('a fresh claim is not stale', async () => {
    expect(isStalePing(claimed, T0 + 56 * MIN)).toBe(false)
  })
  test('newer output, a user message, expiry, off or paused make it stale', async () => {
    expect(isStalePing({ ...claimed, lastOutputAt: T0 + 55 * MIN + 1 }, T0 + 56 * MIN)).toBe(true)
    expect(isStalePing({ ...claimed, lastUserAt: T0 + 55 * MIN + 1 }, T0 + 56 * MIN)).toBe(true)
    expect(isStalePing(claimed, T0 + TTL_MS)).toBe(true)
    expect(isStalePing({ ...claimed, isEnabled: false }, T0 + 56 * MIN)).toBe(true)
    expect(isStalePing({ ...claimed, pausedAt: T0 }, T0 + 56 * MIN)).toBe(true)
  })
})

describe('isCacheCold', () => {
  test('mostly read from cache is warm; mostly written is cold', async () => {
    const usage = (read: number, creation: number) => ({
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: creation,
    })
    expect(isCacheCold(usage(50_000, 200))).toBe(false)
    expect(isCacheCold(usage(3_000, 50_000))).toBe(true)
    expect(isCacheCold(usage(0, 0))).toBe(true)
  })
})

describe('isUserOrigin', () => {
  test('the person resets the budget', async () => {
    expect(isUserOrigin({ kind: 'composer' }, false)).toBe(true)
    expect(isUserOrigin({ kind: 'sdk' }, false)).toBe(true)
    expect(isUserOrigin({ kind: 'bridge' }, false)).toBe(true)
  })
  test('autonomous sources and every plugin do not', async () => {
    expect(isUserOrigin({ kind: 'plugin', name: 'keep-cache-warm', asUser: true }, false)).toBe(false)
    expect(isUserOrigin({ kind: 'plugin', name: 'other' }, false)).toBe(false)
    expect(isUserOrigin({ kind: 'task-notification' }, false)).toBe(false)
    expect(isUserOrigin({ kind: 'scheduled-trigger' }, false)).toBe(false)
    expect(isUserOrigin({ kind: 'auto-continuation' }, false)).toBe(false)
    expect(isUserOrigin({ kind: 'unclassified' }, false)).toBe(false)
    expect(isUserOrigin({ kind: 'composer' }, true)).toBe(false)
  })
})

describe('texts', () => {
  test('token counts are short', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(62_800)).toBe('62.8K')
    expect(fmtTokens(1_250_000)).toBe('1.3M')
  })

  test('a ping says how much of the cache it read', () => {
    const usage = { model: 'm', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 49_990, cache_creation_input_tokens: 0 }
    expect(pingUsageText(usage)).toBe(
      'Ping read 100% of its 50.0K input tokens from the cache, about 5% of what rewriting the cache would cost.',
    )
    expect(pingUsageText({ ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000 })).toBe(
      'Ping read 0% of its 50.0K input tokens from the cache, about 100% of what rewriting the cache would cost.',
    )
  })

  test('a compaction says what it saved, when the engine reports it', () => {
    expect(compactedText()).toBe('Compacted the conversation before the prompt cache expired.')
    expect(compactedText(62_800, 4_100)).toBe(
      'Compacted the conversation before the prompt cache expired (62.8K → 4.1K tokens).',
    )
  })

  test('an engine error becomes a short reason', () => {
    expect(
      cleanError(
        new Error(
          'keep-cache-warm: $.session.compact: not available in a headless (-p / SDK) session yet; catch it and carry on',
        ),
      ),
    ).toBe('not available in a headless (-p / SDK) session yet')
    expect(cleanError('plain failure')).toBe('plain failure')
    expect(cleanError(new Error('x'.repeat(300))).length).toBe(160)
  })
})
