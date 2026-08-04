import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Linter } from '../src/linter'
import type { I18nextToolkitConfig } from '../src/index'

// Real fs + real glob on purpose: the bug (#277) is that glob matches a
// *directory* named like a source file and readFile then throws EISDIR.
describe('linter: directories matching the input glob (#277)', () => {
  let dir: string
  let cwd: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18next-lint-'))
    cwd = process.cwd()
    process.chdir(dir)
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('ignores a directory named like a source file', async () => {
    await mkdir(join(dir, 'src/abc.tsx'), { recursive: true })
    await writeFile(join(dir, 'src/App.tsx'), 'export const App = () => null\n')

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.tsx'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
    }

    const errors: Error[] = []
    const linter = new Linter(config)
    linter.on('error', (err) => errors.push(err))

    const { files } = await linter.run()

    expect(errors).toEqual([])
    expect(Object.keys(files)).not.toContain('src/abc.tsx')
  })
})
