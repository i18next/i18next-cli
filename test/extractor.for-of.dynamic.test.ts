import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const mockConfig: I18nextToolkitConfig = {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    functions: ['t'],
    defaultNS: 'translation',
    nsSeparator: false,
  },
}

async function run (code: string) {
  vol.fromJSON({ '/src/App.tsx': code })
  const results = await extract(mockConfig)
  return results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))?.newTranslations as any
}

describe('extractor: for-of and destructured dynamic keys (#289)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  it('binds a for-of loop variable over an as-const string array', async () => {
    const t = await run(`
      const timeUnits = ['day', 'hour', 'minute', 'second'] as const;
      export function Time({ seconds }: { seconds: number }) {
        for (const unit of timeUnits) {
          return t(\`{{count}} \${unit}\`, { count: seconds });
        }
      }
    `)
    expect(Object.keys(t)).toEqual(expect.arrayContaining([
      '{{count}} day_one', '{{count}} day_other',
      '{{count}} second_one', '{{count}} second_other',
    ]))
  })

  it('binds a destructured for-of loop variable over an as-const array of objects', async () => {
    const t = await run(`
      const timeUnits = [
        { unit: 'day', unitSeconds: 86400 },
        { unit: 'hour', unitSeconds: 3600 },
      ] as const;
      export function Time({ seconds }: { seconds: number }) {
        for (const { unit, unitSeconds } of timeUnits) {
          return t(\`{{count}} \${unit}\`, { count: seconds / unitSeconds });
        }
      }
    `)
    expect(Object.keys(t)).toEqual(expect.arrayContaining([
      '{{count}} day_one', '{{count}} day_other',
      '{{count}} hour_one', '{{count}} hour_other',
    ]))
  })

  it('binds a destructured element in .forEach over an as-const array of objects', async () => {
    const t = await run(`
      const timeUnits = [{ unit: 'day' }, { unit: 'hour' }] as const;
      timeUnits.forEach(({ unit }) => t(\`msg \${unit}\`));
    `)
    expect(Object.keys(t)).toEqual(expect.arrayContaining(['msg day', 'msg hour']))
  })

  it('binds object destructuring of a known as-const object', async () => {
    const t = await run(`
      const rate = { unit: 'minute' } as const;
      export function Destructured() {
        const { unit } = rate;
        return t(\`msg \${unit}\`);
      }
    `)
    expect(Object.keys(t)).toEqual(expect.arrayContaining(['msg minute']))
  })
})
