import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInstrumenter, writeExtractedKeys } from '../src/instrumenter'
import type { I18nextToolkitConfig, Logger } from '../src/types'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { parse } from '@swc/core'
import { normalizePath } from './utils/path'
import { loadMessageAnalyzer } from '../src/utils/message-format'
import { findExistingI18nInitFile } from '../src/instrumenter/index'

const silentLogger: Logger = { info () {}, warn () {}, error () {} }

describe('instrument with messageFormat icu / mf2', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-instrument-mf-'))
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })
    await fs.writeFile(join(tempDir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0', 'react-i18next': '^17.0.0', i18next: '^26.0.0' } }))
    await fs.writeFile(join(tempDir, 'src', 'Tasks.tsx'), [
      "import React from 'react'",
      '',
      'export function Tasks({ activeCount, name }: { activeCount: number, name: string }) {',
      // eslint-disable-next-line no-template-curly-in-string
      '  const greeting = `Welcome back to your tasks, ${name}`',
      '  return (',
      '    <div>',
      '      <h1>{greeting}</h1>',
      "      <span>{activeCount} {activeCount === 1 ? 'task' : 'tasks'} remaining</span>",
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  async function instrument (messageFormat: 'icu' | 'mf2') {
    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.tsx')),
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        primaryLanguage: 'en',
        defaultNS: 'translation',
        messageFormat,
      },
    }
    const results = await runInstrumenter(config, { isDryRun: false, quiet: true }, silentLogger)
    await writeExtractedKeys(results.files.flatMap(f => f.candidates), config, 'translation', silentLogger)
    const src = await readFile(join(tempDir, 'src', 'Tasks.tsx'), 'utf-8')
    const translations = JSON.parse(await readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8'))
    await expect(parse(src, { syntax: 'typescript', tsx: true })).resolves.toBeDefined()
    // every written value is a valid message in the chosen format
    const analyze = await loadMessageAnalyzer(messageFormat)
    for (const value of Object.values(translations)) expect(() => analyze(value as string)).not.toThrow()
    const initFile = await findExistingI18nInitFile()
    const init = initFile ? await readFile(join(tempDir, initFile), 'utf-8') : ''
    return { src, init, values: Object.values(translations), keys: Object.keys(translations) }
  }

  it('writes ICU placeholders and one plural message', async () => {
    const { src, init, values, keys } = await instrument('icu')
    // without the plugin the app would render the ICU source text
    expect(init).toContain("import ICU from 'i18next-icu'")
    expect(init).toContain('.use(ICU)')
    expect(init).toContain('npm install i18next react-i18next i18next-icu intl-messageformat')
    expect(values).toContain('Welcome back to your tasks, {name}')
    expect(values).toContain('{count, plural, one {{count} task remaining} other {{count} tasks remaining}}')
    expect(keys.some(k => /_(one|other)$/.test(k))).toBe(false)
    expect(src).toContain("'{count, plural, one {{count} task remaining} other {{count} tasks remaining}}', { count: activeCount })")
    expect(src).not.toContain('defaultValue_one')
  })

  it('writes MF2 placeholders and one .match message', async () => {
    const { src, init, values } = await instrument('mf2')
    expect(init).toContain("import MF2 from 'i18next-mf2'")
    expect(init).toContain('.use(MF2)')
    expect(values).toContain('Welcome back to your tasks, {$name}')
    expect(values).toContain('.input {$count :number} .match $count one {{{$count} task remaining}} * {{{$count} tasks remaining}}')
    expect(src).toContain('{ count: activeCount }')
  })
})
