import { describe, it, expect } from 'vitest'
import { runExtractor } from '../src/index'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

describe('extractor: scope tests', () => {
  it('runExtractor should be idempotent regardless of input file ordering', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'i18next-cli-test-'))
    const originalCwd = process.cwd()
    try {
      // Prepare source tree
      const srcDir = path.join(tmp, 'src')
      await fs.mkdir(srcDir, { recursive: true })

      const aPath = path.join(srcDir, 'a.tsx')
      const bPath = path.join(srcDir, 'b.tsx')

      await fs.writeFile(
        aPath,
        `
        import { useTranslation } from 'react-i18next';
        export const A = () => {
          const { t } = useTranslation('nsA');
          return (
            <>
              { /* t('commentA') */ }
              <div>{t('keyA')}</div>
            </>
          );
        };
      `
      )

      await fs.writeFile(
        bPath,
        `
        import { useTranslation } from 'react-i18next';
        export const B = () => {
          const footerTemplate = () => {
            return (
                <div>{t('footerB')}</div>
            )
          }
        
          const { t } = useTranslation('nsB'); 
          
          return (
            <>
              { /* t('commentB') */ }
              <div>{t('keyB')}</div>
              {footerTemplate()}
            </>
          );
        };
      `
      )

      // Run inside temporary directory so extractor writes into tmp/locales
      process.chdir(tmp)

      const baseConfig = {
        locales: ['en'],
        extract: {
          input: [aPath, bPath], // first run order
          output: 'locales/{{language}}/{{namespace}}.json',
          functions: ['t'],
          transComponents: [],
          defaultNS: 'translation',
        },
      } as any

      // First run: A then B
      await runExtractor(baseConfig)

      const nsAPath = path.join(tmp, 'locales/en/nsA.json')
      const nsBPath = path.join(tmp, 'locales/en/nsB.json')
      const translationPath = path.join(tmp, 'locales/en/translation.json')

      const nsAJson1 = JSON.parse(await fs.readFile(nsAPath, 'utf-8'))
      const nsBJson1 = JSON.parse(await fs.readFile(nsBPath, 'utf-8'))
      const nsTranslationReadFile1 = async () => { await fs.readFile(translationPath) }

      // Sanity checks
      expect(nsAJson1).toHaveProperty('commentA')
      expect(nsAJson1).toHaveProperty('keyA')
      expect(nsBJson1).toHaveProperty('commentB')
      expect(nsBJson1).toHaveProperty('keyB')
      expect(nsBJson1).toHaveProperty('footerB')
      await expect(() => nsTranslationReadFile1()).rejects.toThrowError(/ENOENT/)

      // Second run: reverse input order (B then A)
      const reversedConfig = {
        ...baseConfig,
        extract: {
          ...baseConfig.extract,
          input: [bPath, aPath],
        },
      } as any

      await runExtractor(reversedConfig)

      const nsAJson2 = JSON.parse(await fs.readFile(nsAPath, 'utf-8'))
      const nsBJson2 = JSON.parse(await fs.readFile(nsBPath, 'utf-8'))
      const nsTranslationReadFile2 = async () => { await fs.readFile(translationPath, 'utf-8') }

      // Files must be identical across runs for idempotency
      expect(nsAJson2).toEqual(nsAJson1)
      expect(nsBJson2).toEqual(nsBJson1)
      await expect(() => nsTranslationReadFile2()).rejects.toThrowError(/ENOENT/)
    } finally {
      // restore cwd and cleanup
      process.chdir(originalCwd)
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
