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

  it('should preserve Polish plural forms (_few, _many) when running extract with --sync-primary', async () => {
    // Setup source code with pluralized t() call
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

    // Verify Polish also has one and other forms
    expect(pl1.translation['example.itemCount_one']).toBeDefined()
    expect(pl1.translation['example.itemCount_other']).toBeDefined()

    // Now manually add Polish-specific plural forms (few and many) to simulate existing translations
    pl1.translation['example.itemCount_few'] = '{{count}} elementy'
    pl1.translation['example.itemCount_many'] = '{{count}} elementów'
    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second run: Re-extraction with sync-primary should NOT remove _few and _many
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const en2 = JSON.parse(await fs.readFile(enPath, 'utf-8'))
    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // English should remain unchanged
    expect(en2.translation['example.itemCount_one']).toEqual('{{count}} item')
    expect(en2.translation['example.itemCount_other']).toEqual('{{count}} items')

    // Polish should PRESERVE _few and _many forms added manually
    // BUG: Currently these are removed during sync-primary
    expect(pl2.translation['example.itemCount_one']).toBeDefined()
    expect(pl2.translation['example.itemCount_other']).toBeDefined()
    expect(pl2.translation['example.itemCount_few']).toEqual('{{count}} elementy')
    expect(pl2.translation['example.itemCount_many']).toEqual('{{count}} elementów')
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

    // Manually add all Arabic plural forms
    if (!ar1.translation.messages) ar1.translation.messages = {}
    ar1.translation.messages.unread_zero = 'لا توجد رسائل'
    ar1.translation.messages.unread_one = 'رسالة واحدة'
    ar1.translation.messages.unread_two = 'رسالتان'
    ar1.translation.messages.unread_few = 'عدة رسائل'
    ar1.translation.messages.unread_many = 'الكثير من الرسائل'
    ar1.translation.messages.unread_other = '{{count}} رسالة'

    await fs.writeFile(arPath, JSON.stringify(ar1, null, 2), 'utf-8')

    // Second extraction should preserve all forms
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

  it('should preserve plural forms in <Trans> components across locales', async () => {
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

    // First extraction
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Manually add Polish plural forms
    if (!pl1.translation.shop) pl1.translation.shop = {}
    pl1.translation.shop.items_few = 'Masz <1>{{count}}</1> przedmioty'
    pl1.translation.shop.items_many = 'Masz <1>{{count}}</1> przedmiotów'

    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second extraction should preserve the added forms
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

    // First extraction
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Manually add Polish-specific plural forms for nested key
    if (!pl1.translation.notifications) pl1.translation.notifications = {}
    if (!pl1.translation.notifications.messages) pl1.translation.notifications.messages = {}
    pl1.translation.notifications.messages.new_few = '{{count}} nowe wiadomości'
    pl1.translation.notifications.messages.new_many = '{{count}} nowych wiadomości'

    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second extraction should preserve nested plural forms
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Verify preservation of manually added forms
    expect(pl2.translation.notifications.messages.new_few).toEqual('{{count}} nowe wiadomości')
    expect(pl2.translation.notifications.messages.new_many).toEqual('{{count}} nowych wiadomości')
  })

  it('should preserve plural forms when mixing t() and <Trans> with plural keys', async () => {
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

    // First extraction
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const pl1 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Add Polish plural forms for both keys
    if (!pl1.translation.items) pl1.translation.items = {}
    pl1.translation.items.tExample_few = '{{count}} przedmioty'
    pl1.translation.items.tExample_many = '{{count}} przedmiotów'
    pl1.translation.items.transExample_few = 'Masz {{count}} przedmioty'
    pl1.translation.items.transExample_many = 'Masz {{count}} przedmiotów'

    await fs.writeFile(plPath, JSON.stringify(pl1, null, 2), 'utf-8')

    // Second extraction
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    const pl2 = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Both t() and <Trans> plural forms should be preserved
    expect(pl2.translation.items.tExample_few).toEqual('{{count}} przedmioty')
    expect(pl2.translation.items.tExample_many).toEqual('{{count}} przedmiotów')
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
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    let pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Add Polish plural forms
    if (!pl.translation.products) pl.translation.products = {}
    pl.translation.products.total_few = '{{count}} produkty'
    pl.translation.products.total_many = '{{count}} produktów'
    await fs.writeFile(plPath, JSON.stringify(pl, null, 2), 'utf-8')

    // Add a new key to source code
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
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))

    // Original plural forms should still be there
    expect(pl.translation.products.total_few).toEqual('{{count}} produkty')
    expect(pl.translation.products.total_many).toEqual('{{count}} produktów')

    // New key should be added
    expect(pl.translation.orders).toBeDefined()
    expect(pl.translation.orders.total_one).toBeDefined()
    expect(pl.translation.orders.total_other).toBeDefined()

    // Add forms for the new key
    pl.translation.orders.total_few = '{{count}} zamówienia'
    pl.translation.orders.total_many = '{{count}} zamówień'
    await fs.writeFile(plPath, JSON.stringify(pl, null, 2), 'utf-8')

    // Third extraction (no changes to source)
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
    await runExtractor(config, { isDryRun: false })

    const plPath = join(tempDir, 'locales', 'pl.json')
    const ruPath = join(tempDir, 'locales', 'ru.json')

    let pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))
    let ru = JSON.parse(await fs.readFile(ruPath, 'utf-8'))

    // Add locale-specific plural forms
    if (!pl.translation.status) pl.translation.status = {}
    pl.translation.status.active_few = '{{count}} aktywne'
    pl.translation.status.active_many = '{{count}} aktywnych'

    if (!ru.translation.status) ru.translation.status = {}
    ru.translation.status.active_few = '{{count}} активных'
    ru.translation.status.active_many = '{{count}} активных'

    await fs.writeFile(plPath, JSON.stringify(pl, null, 2), 'utf-8')
    await fs.writeFile(ruPath, JSON.stringify(ru, null, 2), 'utf-8')

    // Second extraction
    await runExtractor(config, { isDryRun: false, syncPrimaryWithDefaults: true })

    pl = JSON.parse(await fs.readFile(plPath, 'utf-8'))
    ru = JSON.parse(await fs.readFile(ruPath, 'utf-8'))

    // Locale-specific forms should NOT be removed
    expect(pl.translation.status.active_few).toEqual('{{count}} aktywne')
    expect(pl.translation.status.active_many).toEqual('{{count}} aktywnych')
    expect(ru.translation.status.active_few).toEqual('{{count}} активных')
    expect(ru.translation.status.active_many).toEqual('{{count}} активных')
  })
})
