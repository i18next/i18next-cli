import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

describe('extract: no namespace with custom plugin', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-issue163-'))
    await fs.mkdir(join(tempDir, 'src', 'app'), { recursive: true })
    await fs.mkdir(join(tempDir, 'src', 'locales'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should not create a "false" namespace when ns: false and defaultNS: false', async () => {
    // Simulate Angular HTML file with translate pipe
    const htmlContent = '<p>Some text</p>\n{{\'HEADER.TITLE\' | translate}}'
    await fs.writeFile(join(tempDir, 'src', 'app', 'app.component.html'), htmlContent)

    // Minimal config to reproduce the issue
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.html')),
        output: normalizePath(join(tempDir, 'src/locales/{{language}}.json')),
        keySeparator: '.',
        defaultNS: false,
        nsSeparator: false,
      },
      plugins: [
        {
          name: 'angular-html-translate',
          async onEnd (keys: Map<string, any>) {
            const content = await fs.readFile(join(tempDir, 'src', 'app', 'app.component.html'), 'utf-8')
            const translatePipeRegex = /['"`]?([^'"`]+?)['"`]\s*\|\s*translate\b/g
            let match: RegExpExecArray | null
            while ((match = translatePipeRegex.exec(content))) {
              const key = match[1]
              if (!keys.has(key)) {
                keys.set(key, {
                  key,
                  nsIsImplicit: true
                })
              }
            }
          },
        },
      ],
    }

    // Run extractor
    const updated = await runExtractor(config, { isDryRun: false })
    expect(updated).toBe(true)

    const en = JSON.parse(await fs.readFile(join(tempDir, 'src', 'locales', 'en.json'), 'utf-8'))
    // Should NOT have a top-level "false" key
    expect(en).toEqual({
      HEADER: {
        TITLE: 'HEADER.TITLE',
      },
    })
  })
})
