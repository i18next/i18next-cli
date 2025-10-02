import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/extractor'
import type { I18nextToolkitConfig } from '../src/types'
import { findKeys } from '../src/extractor/core/key-finder'
import { getTranslations } from '../src/extractor/core/translation-manager'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock the dependencies of `runExtractor`
vi.mock('../src/extractor/core/key-finder')
vi.mock('../src/extractor/core/translation-manager')

describe('extractor: watch mode behavior', () => {
  let consoleLogSpy: any
  const config: I18nextToolkitConfig = {
    locales: ['en'],
    extract: {
      input: ['src/'],
      output: 'locales/{{language}}/{{namespace}}.json',
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Provide a default mock implementation for all tests in this suite.
    // Individual tests can override this if they need specific behavior.
    vi.mocked(findKeys).mockResolvedValue({ allKeys: new Map([['k', { key: 'k' }]]), objectKeys: new Set() })
    const tempDirPath = await mkdtemp(join(tmpdir(), 'i18next-cli-'))
    vi.mocked(getTranslations).mockResolvedValue([{ updated: true, path: join(tempDirPath, 'test.json') } as any])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should print the locize funnel message only once when called multiple times in watch mode', async () => {
    // Act: Call runExtractor twice, simulating two runs in a watch cycle
    await runExtractor(config, { isWatchMode: true })
    await runExtractor(config, { isWatchMode: true })

    // Assert: Check that the funnel was logged exactly once
    const funnelTipLogs = consoleLogSpy.mock.calls.filter((call: any[]) =>
      (call[0] || '').includes('Tip: Tired of running the extractor manually?')
    )
    expect(funnelTipLogs.length).toBe(1)
  })

  it('should NOT print the locize funnel if no files are updated', async () => {
    // Arrange: Override the default mock to simulate no file updates
    vi.mocked(getTranslations).mockResolvedValue([{ updated: false, path: 'test.json' } as any])

    // Act
    await runExtractor(config, { isWatchMode: true })

    // Assert
    const funnelTipLogs = consoleLogSpy.mock.calls.filter((call: any[]) =>
      (call[0] || '').includes('Tip: Tired of running the extractor manually?')
    )
    expect(funnelTipLogs.length).toBe(0)
  })
})
