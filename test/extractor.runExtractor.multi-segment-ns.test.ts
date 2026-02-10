import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

/**
 * Regression tests for namespaces whose value contains path separators,
 * e.g. `useTranslation('widgets/component')`.
 *
 * When the output template is `src/{{namespace}}/locales/{{language}}.json`,
 * the namespace becomes part of a directory hierarchy:
 *
 *   src/widgets/component/locales/en.json
 *
 * The extractor must:
 * 1. Write translations to the correct deep path on first extraction.
 * 2. Discover existing namespace files on re-extraction (glob must cross
 *    directory boundaries, i.e. `**` instead of `*`).
 * 3. Recover the full multi-segment namespace from discovered file paths
 *    so that keys are associated with the right namespace.
 */
describe('extractor: multi-segment namespace paths', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-multiseg-ns-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should write translation files into a deep namespace directory', async () => {
    await fs.mkdir(join(tempDir, 'src', 'widgets', 'component'), { recursive: true })

    const component = `
      import { useTranslation } from 'react-i18next';

      export function Component() {
        const { t } = useTranslation('widgets/component');
        return <div>{t('title', 'Component Title')}</div>;
      }
    `
    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'component', 'component.tsx'),
      component
    )

    const config: I18nextToolkitConfig = {
      locales: ['en', 'de'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'src/{{namespace}}/locales/{{language}}.json')),
        defaultNS: 'translation',
      },
    }

    await runExtractor(config, { isDryRun: false })

    // The file should be at src/widgets/component/locales/en.json
    const enPath = join(tempDir, 'src', 'widgets', 'component', 'locales', 'en.json')
    const en = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    expect(en).toEqual({ title: 'Component Title' })

    const dePath = join(tempDir, 'src', 'widgets', 'component', 'locales', 'de.json')
    const de = JSON.parse(await fs.readFile(dePath, 'utf-8'))
    expect(de).toEqual({ title: '' })
  })

  it('should preserve existing keys on re-extraction with multi-segment namespace', async () => {
    await fs.mkdir(join(tempDir, 'src', 'widgets', 'component'), { recursive: true })

    const component = `
      import { useTranslation } from 'react-i18next';

      export function Component() {
        const { t } = useTranslation('widgets/component');
        return <div>{t('title', 'Component Title')}</div>;
      }
    `
    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'component', 'component.tsx'),
      component
    )

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'src/{{namespace}}/locales/{{language}}.json')),
        defaultNS: 'translation',
      },
    }

    // --- First extraction ---
    await runExtractor(config, { isDryRun: false })

    const enPath = join(tempDir, 'src', 'widgets', 'component', 'locales', 'en.json')
    const en1 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    expect(en1).toEqual({ title: 'Component Title' })

    // --- Re-extraction (same source) ---
    // This should NOT produce any changes — the existing file already has the key.
    const updated = await runExtractor(config, { isDryRun: false })
    expect(updated).toBe(false)

    const en2 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    expect(en2).toEqual({ title: 'Component Title' })
  })

  it('should discover existing multi-segment namespace files when removeUnusedKeys is true', async () => {
    await fs.mkdir(join(tempDir, 'src', 'widgets', 'component'), { recursive: true })

    // First: write a component that extracts a key
    const componentV1 = `
      import { useTranslation } from 'react-i18next';

      export function Component() {
        const { t } = useTranslation('widgets/component');
        return (
          <div>
            <h1>{t('title', 'Title')}</h1>
            <p>{t('description', 'Description')}</p>
          </div>
        );
      }
    `
    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'component', 'component.tsx'),
      componentV1
    )

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'src/{{namespace}}/locales/{{language}}.json')),
        defaultNS: 'translation',
        removeUnusedKeys: true,
      },
    }

    // First extraction — creates both keys
    await runExtractor(config, { isDryRun: false })
    const enPath = join(tempDir, 'src', 'widgets', 'component', 'locales', 'en.json')
    const en1 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    expect(en1.title).toBe('Title')
    expect(en1.description).toBe('Description')

    // Now modify the component to remove the 'description' key
    const componentV2 = `
      import { useTranslation } from 'react-i18next';

      export function Component() {
        const { t } = useTranslation('widgets/component');
        return <div><h1>{t('title', 'Title')}</h1></div>;
      }
    `
    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'component', 'component.tsx'),
      componentV2
    )

    // Re-extraction should remove the 'description' key
    await runExtractor(config, { isDryRun: false })
    const en2 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    expect(en2).toEqual({ title: 'Title' })
    expect(en2.description).toBeUndefined()
  })

  it('should discover orphaned multi-segment namespace files and clean unused keys', async () => {
    // This is the core regression: when a multi-segment namespace is removed
    // from source but its translation file still exists on disk, the glob
    // pattern must find it (crossing directory boundaries) and the namespace
    // must be correctly recovered from the file path — not just basename.
    await fs.mkdir(join(tempDir, 'src', 'widgets', 'component'), { recursive: true })
    await fs.mkdir(join(tempDir, 'src', 'common'), { recursive: true })

    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'component', 'component.tsx'),
      `
        import { useTranslation } from 'react-i18next';
        export function Component() {
          const { t } = useTranslation('widgets/component');
          return <div>{t('title', 'Title')}</div>;
        }
      `
    )

    await fs.writeFile(
      join(tempDir, 'src', 'common', 'common.tsx'),
      `
        import { useTranslation } from 'react-i18next';
        export function Common() {
          const { t } = useTranslation('common');
          return <div>{t('hello', 'Hello')}</div>;
        }
      `
    )

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'src/{{namespace}}/locales/{{language}}.json')),
        defaultNS: 'translation',
        removeUnusedKeys: true,
      },
    }

    // First extraction — creates both namespace files
    await runExtractor(config, { isDryRun: false })

    const deepPath = join(tempDir, 'src', 'widgets', 'component', 'locales', 'en.json')
    const flatPath = join(tempDir, 'src', 'common', 'locales', 'en.json')
    expect(JSON.parse(await fs.readFile(deepPath, 'utf-8'))).toEqual({ title: 'Title' })
    expect(JSON.parse(await fs.readFile(flatPath, 'utf-8'))).toEqual({ hello: 'Hello' })

    // Now remove the multi-segment namespace from source (delete the component).
    // The translation file on disk remains.
    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'component', 'component.tsx'),
      '// empty — namespace removed'
    )

    // Re-extraction with removeUnusedKeys.
    // The glob should discover src/widgets/component/locales/en.json,
    // recover namespace = "widgets/component", and empty it since no keys
    // reference that namespace any more.
    await runExtractor(config, { isDryRun: false })

    const deepAfter = JSON.parse(await fs.readFile(deepPath, 'utf-8'))
    expect(deepAfter).toEqual({})

    // The flat namespace should remain unchanged
    const flatAfter = JSON.parse(await fs.readFile(flatPath, 'utf-8'))
    expect(flatAfter).toEqual({ hello: 'Hello' })
  })

  it('should handle multiple multi-segment namespaces in the same project', async () => {
    await fs.mkdir(join(tempDir, 'src', 'widgets', 'header'), { recursive: true })
    await fs.mkdir(join(tempDir, 'src', 'widgets', 'footer'), { recursive: true })
    await fs.mkdir(join(tempDir, 'src', 'pages', 'home'), { recursive: true })

    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'header', 'header.tsx'),
      `
        import { useTranslation } from 'react-i18next';
        export function Header() {
          const { t } = useTranslation('widgets/header');
          return <nav>{t('nav.home', 'Home')}</nav>;
        }
      `
    )

    await fs.writeFile(
      join(tempDir, 'src', 'widgets', 'footer', 'footer.tsx'),
      `
        import { useTranslation } from 'react-i18next';
        export function Footer() {
          const { t } = useTranslation('widgets/footer');
          return <footer>{t('copyright', '© 2026')}</footer>;
        }
      `
    )

    await fs.writeFile(
      join(tempDir, 'src', 'pages', 'home', 'home.tsx'),
      `
        import { useTranslation } from 'react-i18next';
        export function Home() {
          const { t } = useTranslation('pages/home');
          return <h1>{t('welcome', 'Welcome')}</h1>;
        }
      `
    )

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.{ts,tsx}')),
        output: normalizePath(join(tempDir, 'src/{{namespace}}/locales/{{language}}.json')),
        defaultNS: 'translation',
      },
    }

    await runExtractor(config, { isDryRun: false })

    // Each namespace should have its own translation file
    const headerEn = JSON.parse(
      await fs.readFile(join(tempDir, 'src', 'widgets', 'header', 'locales', 'en.json'), 'utf-8')
    )
    expect(headerEn).toEqual({ nav: { home: 'Home' } })

    const footerEn = JSON.parse(
      await fs.readFile(join(tempDir, 'src', 'widgets', 'footer', 'locales', 'en.json'), 'utf-8')
    )
    expect(footerEn).toEqual({ copyright: '© 2026' })

    const homeEn = JSON.parse(
      await fs.readFile(join(tempDir, 'src', 'pages', 'home', 'locales', 'en.json'), 'utf-8')
    )
    expect(homeEn).toEqual({ welcome: 'Welcome' })

    // Re-extraction should not produce changes
    const updated = await runExtractor(config, { isDryRun: false })
    expect(updated).toBe(false)
  })
})
