import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExtractor } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import { normalizePath } from './utils/path'

describe('plural form preservation across locales with --sync-primary', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-plural-forms-'))
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })
    await fs.mkdir(join(tempDir, 'locales'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should auto-generate all CLDR plural forms for t() function and preserve them across --sync-primary runs', async () => {
    // Setup source code with pluralized t() call
    // When using t() function with count, the extractor generates ALL CLDR plural forms for the target locale
    // For Polish (pl): _one, _few, _many, _other
    // For English (en): _one, _other (only English's CLDR categories)
    const component = `
      import { useTranslation } from 'react-i18next';

      export const ItemCounter = () => {
        const { t } = useTranslation();
        const itemCount = 3;
        return (
          <div>
            <p>{t('example.itemCount', { count: itemCount, defaultValue_one: '{{count}} item', defaultValue_other: '{{count}} items' })}</p>
          </div>
        );
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'ItemCounter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        removeUnusedKeys: true,
        sort: true,
        keySeparator: false,
      },
    }

    // First run: Initial extraction
    const updated1 = await runExtractor(config, { isDryRun: false })
    expect(updated1).toBe(true)

    const enPath = join(tempDir, 'locales', 'en.json')
    const plPath = join(tempDir, 'locales', 'pl.json')

    const en1 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Verify English has the basic plural forms (one and other)
    expect(en1.translation['example.itemCount_one']).toBeDefined()
    expect(en1.translation['example.itemCount_other']).toBeDefined()
    expect(en1.translation['example.itemCount_one']).toEqual('{{count}} item')
    expect(en1.translation['example.itemCount_other']).toEqual('{{count}} items')

    // EXPECTED: t() function DOES generate all CLDR plural forms for the target locale
    // For Polish, this should include _one, _few, _many, _other
    expect(pl1.translation['example.itemCount_one']).toBeDefined()
    expect(pl1.translation['example.itemCount_other']).toBeDefined()
    expect(pl1.translation['example.itemCount_few']).toBeDefined()
    expect(pl1.translation['example.itemCount_many']).toBeDefined()

    // t() function correctly generates all Polish CLDR forms with default values
    // No need to manually add them - the extractor already did
    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second run: Re-extraction with sync-primary should preserve all generated plural forms
    // EXPECTED: pl.json retains itemCount_one, itemCount_few, itemCount_many, itemCount_other
    // This ensures the auto-generated forms are not lost when syncing with primary language
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const en2 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // English should remain unchanged (only _one, _other)
    expect(en2.translation['example.itemCount_one']).toEqual('{{count}} item')
    expect(en2.translation['example.itemCount_other']).toEqual('{{count}} items')

    // Polish should preserve all auto-generated CLDR plural forms
    // The fix ensures that when --sync-primary runs, it doesn't remove the auto-generated
    // plural forms that are valid for the target locale
    expect(pl2.translation['example.itemCount_one']).toBeDefined()
    expect(pl2.translation['example.itemCount_other']).toBeDefined()
    expect(pl2.translation['example.itemCount_few']).toBeDefined()
    expect(pl2.translation['example.itemCount_many']).toBeDefined()
  })

  it('should preserve Arabic plural forms (_zero, _one, _two, _few, _many, _other) across extraction runs', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Counter = () => {
        const { t } = useTranslation();
        const count = 5;
        return <p>{t('messages.unread', { count })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Counter.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'ar'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        removeUnusedKeys: true,
      },
    }

    // First extraction
    await runExtractor(config, { isDryRun: false })

    const arPath = join(tempDir, 'locales', 'ar.json')
    const ar1 = JSON.parse(await fs.readFile(arPath, 'utf-8'))

    // BUG REPRODUCTION: Verify Arabic only got one and other from the extractor
    // Arabic CLDR requires: zero, one, two, few, many, other (6 forms!)
    // But extractor only generates English's _one/_other (others are empty strings)
    expect(ar1.translation.messages.unread_one).toBeDefined()
    expect(ar1.translation.messages.unread_other).toBeDefined()
    expect(ar1.translation.messages.unread_zero).toBeFalsy() // Generated as empty string
    expect(ar1.translation.messages.unread_two).toBeFalsy() // Generated as empty string
    expect(ar1.translation.messages.unread_few).toBeFalsy() // Generated as empty string
    expect(ar1.translation.messages.unread_many).toBeFalsy() // Generated as empty string

    // Now manually add all Arabic plural forms
    // Arabic CLDR: zero, one, two, few, many, other (6 forms vs English's 2)
    // These might come from translators, previous versions, or manual curation.
    if (!ar1.translation.messages) ar1.translation.messages = {}
    ar1.translation.messages.unread_zero = 'لا توجد رسائل'
    ar1.translation.messages.unread_one = 'رسالة واحدة'
    ar1.translation.messages.unread_two = 'رسالتان'
    ar1.translation.messages.unread_few = 'عدة رسائل'
    ar1.translation.messages.unread_many = 'الكثير من الرسائل'
    ar1.translation.messages.unread_other = '{{count}} رسالة'

    await fs.writeFile(arPath, JSON.stringify(ar1, null, 2), 'utf-8')

    // Second extraction should preserve all forms
    // BUG: Only unread_one/_other survive (English forms); _zero, _two, _few, _many are removed.
    // EXPECTED: All 6 Arabic CLDR forms survive because they're valid for Arabic locale.
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const ar2 = JSON.parse(await fs.readFile(arPath, 'utf-8'))

    // All plural forms should be preserved
    expect(ar2.translation.messages.unread_zero).toEqual('لا توجد رسائل')
    expect(ar2.translation.messages.unread_one).toEqual('رسالة واحدة')
    expect(ar2.translation.messages.unread_two).toEqual('رسالتان')
    expect(ar2.translation.messages.unread_few).toEqual('عدة رسائل')
    expect(ar2.translation.messages.unread_many).toEqual('الكثير من الرسائل')
    expect(ar2.translation.messages.unread_other).toEqual('{{count}} رسالة')
  })

  it('should preserve manually-added plural forms in <Trans> components (note: <Trans> only generates primary locale forms)', async () => {
    const component = `
      import { Trans, useTranslation } from 'react-i18next';

      export const TransComponent = ({ itemCount }: { itemCount: number }) => {
        const { t } = useTranslation();
        return (
          <Trans
            i18nKey="shop.items"
            count={itemCount}
            values={{ count: itemCount }}
          >
            You have <b>{{count}}</b> item
          </Trans>
        );
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'TransComponent.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        removeUnusedKeys: true,
      },
    }

    // First extraction - Trans component with count generates key_one and key_other ONLY
    // (Unlike t(), <Trans> component extraction does NOT auto-generate all locale CLDR forms)
    // This is a known difference in how <Trans> plurals are handled vs t() function plurals
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // NOTE: Trans component only generates primary locale's forms (en: _one, _other)
    // Unlike t() function which generates all target locale CLDR forms
    expect(pl1.translation.shop.items_one).toBeDefined()
    expect(pl1.translation.shop.items_other).toBeDefined()
    expect(pl1.translation.shop.items_few).toBeFalsy() // NOT auto-generated for Trans
    expect(pl1.translation.shop.items_many).toBeFalsy() // NOT auto-generated for Trans

    // Now manually add Polish plural forms for Trans component
    // These would come from translators who need to handle Polish plurals: one, few, many, other
    if (!pl1.translation.shop) pl1.translation.shop = {}
    pl1.translation.shop.items_few = 'Masz <1>{{count}}</1> przedmioty'
    pl1.translation.shop.items_many = 'Masz <1>{{count}}</1> przedmiotów'

    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second extraction should preserve the added forms
    // BUG: items_few and items_many are removed (sync-primary strips unknown forms)
    // EXPECTED: Trans plural forms for locale-specific needs are preserved
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Verify Polish forms are preserved
    expect(pl2.translation.shop.items_one).toBeDefined()
    expect(pl2.translation.shop.items_other).toBeDefined()
    expect(pl2.translation.shop.items_few).toEqual('Masz <1>{{count}}</1> przedmioty')
    expect(pl2.translation.shop.items_many).toEqual('Masz <1>{{count}}</1> przedmiotów')
  })

  it('should handle nested plural keys and preserve all CLDR forms', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const NestedPlurals = () => {
        const { t } = useTranslation();
        const messageCount = 7;
        return <div>{t('notifications.messages.new', { count: messageCount })}</div>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'NestedPlurals.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        keySeparator: '.',
      },
    }

    // First extraction - nested plural key with keySeparator: '.'
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // BUG REPRODUCTION: Verify nested plural keys also only get primary locale's forms
    expect(pl1.translation.notifications.messages.new_one).toBeDefined()
    expect(pl1.translation.notifications.messages.new_other).toBeDefined()
    expect(pl1.translation.notifications.messages.new_few).toBeFalsy() // Generated as empty string
    expect(pl1.translation.notifications.messages.new_many).toBeFalsy() // Generated as empty string

    // Manually add Polish-specific plural forms for nested key
    // Even with nested structure (notifications > messages > new), the bug applies.
    if (!pl1.translation.notifications) pl1.translation.notifications = {}
    if (!pl1.translation.notifications.messages) pl1.translation.notifications.messages = {}
    pl1.translation.notifications.messages.new_few = '{{count}} nowe wiadomości'
    pl1.translation.notifications.messages.new_many = '{{count}} nowych wiadomości'

    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second extraction should preserve nested plural forms
    // BUG: Nested forms are also lost during sync-primary (plural handling applies to all depths)
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Verify preservation of manually added forms
    expect(pl2.translation.notifications.messages.new_few).toEqual('{{count}} nowe wiadomości')
    expect(pl2.translation.notifications.messages.new_many).toEqual('{{count}} nowych wiadomości')
  })

  it('should auto-generate t() plurals but require manual entry for <Trans> plurals', async () => {
    const component = `
      import { Trans, useTranslation } from 'react-i18next';

      export const Mixed = ({ count }: { count: number }) => {
        const { t } = useTranslation();
        return (
          <div>
            <p>{t('items.tExample', { count })}</p>
            <Trans i18nKey="items.transExample" count={count}>
              You have {{count}} item
            </Trans>
          </div>
        );
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Mixed.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
      },
    }

    // First extraction - t() and <Trans> are handled differently
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    if (!pl1.translation.items) pl1.translation.items = {}

    // t() function auto-generates all CLDR plural forms for Polish
    expect(pl1.translation.items.tExample_one).toBeDefined()
    expect(pl1.translation.items.tExample_other).toBeDefined()
    expect(pl1.translation.items.tExample_few).toBeDefined() // Auto-generated by t()
    expect(pl1.translation.items.tExample_many).toBeDefined() // Auto-generated by t()

    // <Trans> component only generates primary locale forms
    expect(pl1.translation.items.transExample_one).toBeDefined()
    expect(pl1.translation.items.transExample_other).toBeDefined()
    expect(pl1.translation.items.transExample_few).toBeFalsy() // NOT auto-generated for Trans
    expect(pl1.translation.items.transExample_many).toBeFalsy() // NOT auto-generated for Trans

    // Note: t() already has all forms auto-generated, so we only need to manually add Trans forms
    // Translator must add Polish plural forms for <Trans> keys (since Trans doesn't auto-generate)
    pl1.translation.items.transExample_few = 'Masz {{count}} przedmioty'
    pl1.translation.items.transExample_many = 'Masz {{count}} przedmiotów'

    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second extraction with sync-primary
    // EXPECTED: Auto-generated t() forms are preserved, and manually-added Trans forms are preserved
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Auto-generated t() plural forms should be preserved
    expect(pl2.translation.items.tExample_few).toBeDefined()
    expect(pl2.translation.items.tExample_many).toBeDefined()

    // Manually-added Trans plural forms should also be preserved (not removed by sync-primary)
    expect(pl2.translation.items.transExample_few).toEqual('Masz {{count}} przedmioty')
    expect(pl2.translation.items.transExample_many).toEqual('Masz {{count}} przedmiotów')
  })

  it('should preserve plural forms across multiple extraction runs with changing source code', async () => {
    let component = `
      import { useTranslation } from 'react-i18next';

      export const App = ({ count }: { count: number }) => {
        const { t } = useTranslation();
        return <p>{t('products.total', { count })}</p>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
      },
    }

    // First extraction
    // Scenario: Code has one plural key
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    let pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // BUG REPRODUCTION: Verify first extraction only generated primary locale's forms
    expect(pl.translation.products.total_one).toBeDefined()
    expect(pl.translation.products.total_other).toBeDefined()
    expect(pl.translation.products.total_few).toBeFalsy() // Generated as empty string
    expect(pl.translation.products.total_many).toBeFalsy() // Generated as empty string

    // Add Polish plural forms for products.total
    if (!pl.translation.products) pl.translation.products = {}
    pl.translation.products.total_few = '{{count}} produkty'
    pl.translation.products.total_many = '{{count}} produktów'
    await fs.writeFile(plPath, JSON.stringify(pl, null, 2), 'utf-8')

    // Add a new key to source code (source code changes)
    component = `
      import { useTranslation } from 'react-i18next';

      export const App = ({ count, orders }: { count: number; orders: number }) => {
        const { t } = useTranslation();
        return (
          <>
            <p>{t('products.total', { count })}</p>
            <p>{t('orders.total', { count: orders })}</p>
          </>
        );
      };
    `
    await fs.writeFile(join(tempDir, 'src', 'App.tsx'), component)

    // Second extraction (adds new key, shouldn't remove existing forms)
    // BUG: Even with new keys added, existing plural forms are at risk of removal
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Original plural forms should still be there
    // EXPECTED: products.total_few/many survive the first sync-primary
    expect(pl.translation.products.total_few).toEqual('{{count}} produkty')
    expect(pl.translation.products.total_many).toEqual('{{count}} produktów')

    // New key should be added
    expect(pl.translation.orders).toBeDefined()
    expect(pl.translation.orders.total_one).toBeDefined()
    expect(pl.translation.orders.total_other).toBeDefined()

    // Add forms for the new key - translator adds Polish forms for the new orders key
    pl.translation.orders.total_few = '{{count}} zamówienia'
    pl.translation.orders.total_many = '{{count}} zamówień'
    await fs.writeFile(plPath, JSON.stringify(pl, null, 2), 'utf-8')

    // Third extraction (no changes to source) - run sync-primary again
    // EXPECTED: Both keys' locale forms survive repeated sync-primary runs
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Both keys should have all their plural forms intact
    expect(pl.translation.products.total_few).toEqual('{{count}} produkty')
    expect(pl.translation.products.total_many).toEqual('{{count}} produktów')
    expect(pl.translation.orders.total_few).toEqual('{{count}} zamówienia')
    expect(pl.translation.orders.total_many).toEqual('{{count}} zamówień')
  })

  it('should not remove plural forms that exist in locale but not in primary language', async () => {
    const component = `
      import { useTranslation } from 'react-i18next';

      export const Status = ({ count }: { count: number }) => {
        const { t } = useTranslation();
        return <div>{t('status.active', { count })}</div>;
      };
    `

    await fs.writeFile(join(tempDir, 'src', 'Status.tsx'), component)

    const config: I18nextToolkitConfig = {
      locales: ['en', 'pl', 'ru'],
      extract: {
        input: normalizePath(join(tempDir, 'src/*.{ts,tsx,cts,mts}')),
        output: normalizePath(join(tempDir, 'locales/{{language}}.json')),
        removeUnusedKeys: true,
      },
    }

    // First extraction
    // All locales get status.active_one and status.active_other (English plural forms)
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const ruPath = join(tempDir, 'locales', 'ru.json')

    let pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))
    let ru = JSON.parse(await fs.readFile(ruPath, 'utf-8'))

    // BUG REPRODUCTION: Verify first extraction only generated primary locale's forms for both
    expect(pl.translation.status.active_one).toBeDefined()
    expect(pl.translation.status.active_other).toBeDefined()
    expect(pl.translation.status.active_few).toBeFalsy() // Generated as empty string
    expect(pl.translation.status.active_many).toBeFalsy() // Generated as empty string

    expect(ru.translation.status.active_one).toBeDefined()
    expect(ru.translation.status.active_other).toBeDefined()
    expect(ru.translation.status.active_few).toBeFalsy() // Generated as empty string
    expect(ru.translation.status.active_many).toBeFalsy() // Generated as empty string

    // Add locale-specific plural forms to Polish and Russian
    // Both languages have plural forms that English doesn't have
    if (!pl.translation.status) pl.translation.status = {}
    pl.translation.status.active_few = '{{count}} aktywne'
    pl.translation.status.active_many = '{{count}} aktywnych'

    if (!ru.translation.status) ru.translation.status = {}
    ru.translation.status.active_few = '{{count}} активных'
    ru.translation.status.active_many = '{{count}} активных'

    await fs.writeFile(plPath, JSON.stringify(pl, null, 2), 'utf-8')
    await fs.writeFile(ruPath, JSON.stringify(ru, null, 2), 'utf-8')

    // Second extraction with sync-primary
    // BUG: Polish and Russian _few/_many forms removed, leaving only _one/_other
    // EXPECTED: Each locale keeps its CLDR forms even if they don't exist in primary language
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))
    ru = JSON.parse(await fs.readFile(ruPath, 'utf-8'))

    // Locale-specific forms should NOT be removed
    // These forms are required by the locale's CLDR plural rules
    expect(pl.translation.status.active_few).toEqual('{{count}} aktywne')
    expect(pl.translation.status.active_many).toEqual('{{count}} aktywnych')
    expect(ru.translation.status.active_few).toEqual('{{count}} активных')
    expect(ru.translation.status.active_many).toEqual('{{count}} активных')
  })
})
