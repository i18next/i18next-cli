import { join } from 'node:path'
import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { findExistingI18nInitFile } from '../src/instrumenter/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

describe('findExistingI18nInitFile', () => {
  beforeEach(() => {
    vol.reset()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The function returns native platform separators (path.join), so the
  // expectations are built with join() too — same cross-platform approach
  // as pathEndsWith in test/utils/path.ts.
  it('finds src/i18n.ts', async () => {
    vol.fromJSON({ '/src/i18n.ts': 'import i18next from "i18next"' })
    expect(await findExistingI18nInitFile()).toBe(join('src', 'i18n.ts'))
  })

  it('finds a root-level i18next.js', async () => {
    vol.fromJSON({ '/i18next.js': 'import i18next from "i18next"' })
    expect(await findExistingI18nInitFile()).toBe('i18next.js')
  })

  it('finds an i18n/index.ts directory entry', async () => {
    vol.fromJSON({ '/src/i18n/index.ts': 'import i18next from "i18next"' })
    expect(await findExistingI18nInitFile()).toBe(join('src', 'i18n', 'index.ts'))
  })

  it('returns null when no init file exists', async () => {
    vol.fromJSON({ '/src/App.tsx': 'export default function App() {}' })
    expect(await findExistingI18nInitFile()).toBeNull()
  })
})
