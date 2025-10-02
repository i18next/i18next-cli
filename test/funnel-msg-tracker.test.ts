import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shouldShowFunnel, recordFunnelShown, reset } from '../src/utils/funnel-msg-tracker'

// Correctly mock fs/promises to use memfs
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

describe('funnel-msg-tracker', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Reset the state for the specific funnel before each test
    reset('test-funnel')
    reset('extract-funnel')
    reset('status-funnel')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return true if the tip has never been shown', async () => {
    expect(await shouldShowFunnel('test-funnel')).toBe(true)
  })

  it('should return false if the tip was shown recently (in-memory check)', async () => {
    await recordFunnelShown('test-funnel')
    expect(await shouldShowFunnel('test-funnel')).toBe(false)
  })

  it('should return true if the tip was shown more than 24 hours ago (file-based check)', async () => {
    // 1. Record that the tip was shown (writes to file and sets in-memory flag)
    await recordFunnelShown('test-funnel')

    // 2. Reset the in-memory state to simulate a new CLI run
    reset('test-funnel')

    // 3. Advance time by more than 24 hours
    vi.advanceTimersByTime(1000 * 60 * 60 * 25) // 25 hours

    // 4. Now, the function will bypass the in-memory check and use the file timestamp
    expect(await shouldShowFunnel('test-funnel')).toBe(true)
  })

  it('should track different funnels independently', async () => {
    await recordFunnelShown('extract-funnel')

    expect(await shouldShowFunnel('extract-funnel')).toBe(false)
    expect(await shouldShowFunnel('status-funnel')).toBe(true)
  })
})
