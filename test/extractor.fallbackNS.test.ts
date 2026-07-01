import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

// https://github.com/i18next/i18next-cli/issues/272
describe('extract with fallbackNS', () => {
  let tempDir: string

  const readJson = async (...segments: string[]) =>
    JSON.parse(await fs.readFile(join(tempDir, ...segments), 'utf-8'))

  const fileExists = async (...segments: string[]) =>
    fs.access(join(tempDir, ...segments)).then(() => true, () => false)

  const writeJson = async (relPath: string, content: any) => {
    const fullPath = join(tempDir, relPath)
    await fs.mkdir(join(fullPath, '..'), { recursive: true })
    await fs.writeFile(fullPath, JSON.stringify(content, null, 2))
  }

  const baseConfig = (extra: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
    locales: ['en', 'de'],
    extract: {
      input: normalizePath(join(tempDir, 'src/**/*.{ts,tsx}')),
      output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
      defaultNS: 'translations',
      fallbackNS: 'translations',
      ...extra,
    },
  })

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-fallbackns-'))
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('does not duplicate a key into a namespace file when it is already translated in fallbackNS', async () => {
    await writeJson('locales/en/translations.json', { cancel: 'Cancel' })
    await writeJson('locales/de/translations.json', { cancel: 'Abbrechen' })
    await fs.writeFile(join(tempDir, 'src', 'Checkout.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Checkout = () => {
        const { t } = useTranslation('page.checkout');
        return <div><button>{t('cancel')}</button><p>{t('checkoutOnly')}</p></div>;
      };
    `)

    await runExtractor(baseConfig(), { isDryRun: false })

    // The shared key must NOT be duplicated into the requested namespace...
    const enCheckout = await readJson('locales', 'en', 'page.checkout.json')
    expect(enCheckout).toEqual({ checkoutOnly: 'checkoutOnly' })
    const deCheckout = await readJson('locales', 'de', 'page.checkout.json')
    expect(deCheckout).toEqual({ checkoutOnly: '' })

    // ...and it must survive removeUnusedKeys in the fallback namespace,
    // because it IS used — through the fallback chain.
    expect(await readJson('locales', 'en', 'translations.json')).toEqual({ cancel: 'Cancel' })
    expect(await readJson('locales', 'de', 'translations.json')).toEqual({ cancel: 'Abbrechen' })
  })

  it('does not create a namespace file at all when every key resolves via fallbackNS', async () => {
    await writeJson('locales/en/translations.json', { cancel: 'Cancel' })
    await fs.writeFile(join(tempDir, 'src', 'Checkout.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Checkout = () => {
        const { t } = useTranslation('page.checkout');
        return <button>{t('cancel')}</button>;
      };
    `)

    await runExtractor(baseConfig(), { isDryRun: false })

    expect(await fileExists('locales', 'en', 'page.checkout.json')).toBe(false)
    expect(await fileExists('locales', 'de', 'page.checkout.json')).toBe(false)
    expect(await readJson('locales', 'en', 'translations.json')).toEqual({ cancel: 'Cancel' })
  })

  it('keeps an intentional per-namespace override of a fallback key', async () => {
    await writeJson('locales/en/translations.json', { cancel: 'Cancel' })
    await writeJson('locales/en/page.checkout.json', { cancel: 'Abort checkout' })
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Checkout = () => {
        const { t } = useTranslation('page.checkout');
        return <button>{t('cancel')}</button>;
      };
      export const Cart = () => {
        const { t } = useTranslation('page.cart');
        return <button>{t('cancel')}</button>;
      };
    `)

    await runExtractor(baseConfig(), { isDryRun: false })

    // The override stays in its namespace file (the requested namespace wins at runtime)
    expect(await readJson('locales', 'en', 'page.checkout.json')).toEqual({ cancel: 'Abort checkout' })
    // The non-overriding namespace does not get a duplicate
    expect(await fileExists('locales', 'en', 'page.cart.json')).toBe(false)
    // The fallback key is still used by page.cart, so it is preserved
    expect(await readJson('locales', 'en', 'translations.json')).toEqual({ cancel: 'Cancel' })
  })

  it('cleans up an empty-string duplicate left behind in a namespace file', async () => {
    await writeJson('locales/en/translations.json', { cancel: 'Cancel' })
    // A previous buggy extract added the key as an empty placeholder
    await writeJson('locales/en/page.checkout.json', { cancel: '', checkoutOnly: 'Checkout only' })
    await fs.writeFile(join(tempDir, 'src', 'Checkout.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Checkout = () => {
        const { t } = useTranslation('page.checkout');
        return <div><button>{t('cancel')}</button><p>{t('checkoutOnly')}</p></div>;
      };
    `)

    await runExtractor(baseConfig(), { isDryRun: false })

    expect(await readJson('locales', 'en', 'page.checkout.json')).toEqual({ checkoutOnly: 'Checkout only' })
    expect(await readJson('locales', 'en', 'translations.json')).toEqual({ cancel: 'Cancel' })
  })

  it('still adds keys that are not present in fallbackNS (saveMissing behavior)', async () => {
    await writeJson('locales/en/translations.json', { cancel: 'Cancel' })
    await fs.writeFile(join(tempDir, 'src', 'Checkout.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Checkout = () => {
        const { t } = useTranslation('page.checkout');
        return <p>{t('newKey', 'Brand new')}</p>;
      };
    `)

    await runExtractor(baseConfig(), { isDryRun: false })

    expect(await readJson('locales', 'en', 'page.checkout.json')).toEqual({ newKey: 'Brand new' })
  })

  it('recognises plural keys that are translated in fallbackNS', async () => {
    await writeJson('locales/en/translations.json', { item_one: '{{count}} item', item_other: '{{count}} items' })
    await writeJson('locales/de/translations.json', { item_one: '{{count}} Artikel', item_other: '{{count}} Artikel' })
    await fs.writeFile(join(tempDir, 'src', 'Shop.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Shop = ({ count }) => {
        const { t } = useTranslation('shop');
        return <p>{t('item', { count })}</p>;
      };
    `)

    await runExtractor(baseConfig(), { isDryRun: false })

    expect(await fileExists('locales', 'en', 'shop.json')).toBe(false)
    expect(await readJson('locales', 'en', 'translations.json')).toEqual({
      item_one: '{{count}} item',
      item_other: '{{count}} items',
    })
    expect(await readJson('locales', 'de', 'translations.json')).toEqual({
      item_one: '{{count}} Artikel',
      item_other: '{{count}} Artikel',
    })
  })

  it('supports an array of fallback namespaces looked up in order', async () => {
    await writeJson('locales/en/common.json', { ok: 'OK' })
    await writeJson('locales/en/shared.json', { cancel: 'Cancel' })
    await fs.writeFile(join(tempDir, 'src', 'Checkout.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Checkout = () => {
        const { t } = useTranslation('page.checkout');
        return <div><button>{t('ok')}</button><button>{t('cancel')}</button></div>;
      };
    `)

    await runExtractor(baseConfig({ fallbackNS: ['common', 'shared'] }), { isDryRun: false })

    expect(await fileExists('locales', 'en', 'page.checkout.json')).toBe(false)
    expect(await readJson('locales', 'en', 'common.json')).toEqual({ ok: 'OK' })
    expect(await readJson('locales', 'en', 'shared.json')).toEqual({ cancel: 'Cancel' })
  })

  it('respects fallbackNS with mergeNamespaces', async () => {
    await writeJson('locales/en.json', {
      translations: { cancel: 'Cancel' },
      'page.checkout': { checkoutOnly: 'Checkout only' },
    })
    await fs.writeFile(join(tempDir, 'src', 'Checkout.tsx'), `
      import { useTranslation } from 'react-i18next';
      export const Checkout = () => {
        const { t } = useTranslation('page.checkout');
        return <div><button>{t('cancel')}</button><p>{t('checkoutOnly')}</p></div>;
      };
    `)

    const config = baseConfig({ mergeNamespaces: true })
    config.extract.output = normalizePath(join(tempDir, 'locales/{{language}}.json'))
    await runExtractor(config, { isDryRun: false })

    expect(await readJson('locales', 'en.json')).toEqual({
      translations: { cancel: 'Cancel' },
      'page.checkout': { checkoutOnly: 'Checkout only' },
    })
  })
})
