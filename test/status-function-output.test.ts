import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'
import { runStatus } from '../src/status'

// Mock fs/promises
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

// Mock findKeys to return one key in namespace 'pkg'
vi.mock('../src/extractor/core/find-keys', () => ({
  findKeys: vi.fn().mockResolvedValue({
    allKeys: new Map([['pkg:key', { key: 'pkg:key', namespace: 'pkg' }]]),
    objectKeys: new Set(),
  }),
}))

describe('runStatus with functional extract.output', () => {
  beforeEach(() => {
    vol.reset()
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/project')

    // create translations where secondary lang is missing the key
    vol.fromJSON({
      '/project/packages/pkg/locales/en/pkg.json': JSON.stringify({ 'pkg:key': 'Value' }),
      '/project/packages/pkg/locales/de/pkg.json': JSON.stringify({}),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs status command without throwing when output is a function', async () => {
    const config: any = {
      locales: ['en', 'de'],
      extract: {
        primaryLanguage: 'en',
        input: ['src/**/*.ts'],
        output: (lng: string, ns?: string) => `packages/${ns ?? 'pkg'}/locales/${lng}/${ns ?? 'pkg'}.json`,
      },
    }

    await expect(runStatus(config)).resolves.not.toThrow()
  })
})
