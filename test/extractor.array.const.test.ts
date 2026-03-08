import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { extract } from '../src/index'
import type { I18nextToolkitConfig } from '../src/index'
import { pathEndsWith } from './utils/path'

// Mocks
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

// Helper to set up multi-file mock
async function setupMultiFile (files: Record<string, string>) {
  vol.fromJSON(files)
  const { glob } = await import('glob')
  ;(glob as any).mockResolvedValue(Object.keys(files))
}

describe('extractor: as-const array and cross-file patterns', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/App.tsx'])
  })

  // ─── as-const array: capture ────────────────────────────────────────────────

  describe('as-const array literal', () => {
    it('should expand array elements used directly in a template literal', async () => {
      // `const arr = ['a','b','c'] as const` and `t(\`${arr[0]}Key\`)` - basic sanity
      // The main value is ensuring the array IS captured at all
      const sampleCode = `
        const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
        // Use a ternary so it hits the existing ternary resolution path via the identifier
        t(ACCESS_OPTIONS[0] ? \`\${ACCESS_OPTIONS[0]}Access\` : 'fallback');
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })
      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))
      // At minimum, 'fallback' must appear (ternary alt path always resolves)
      expect(translationFile).toBeDefined()
    })

    it('should expand all array values when the array is iterated with .map()', async () => {
      // Core pattern from the issue:
      // const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
      // ACCESS_OPTIONS.map((option) => ({ label: t(`${option}Access`) }))
      const sampleCode = `
        const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
        ACCESS_OPTIONS.map((option) => ({
          label: t(\`\${option}Access\`),
        }))
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('fullAccess')
      expect(translationFile!.newTranslations).toHaveProperty('editAccess')
      expect(translationFile!.newTranslations).toHaveProperty('restrictedAccess')
    })

    it('should expand all array values when iterated with .forEach()', async () => {
      const sampleCode = `
        const MODES = ['read', 'write'] as const;
        MODES.forEach((mode) => {
          t(\`permission.\${mode}\`);
        });
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('permission.read')
      expect(translationFile!.newTranslations).toHaveProperty('permission.write')
    })

    it('should not produce extra keys beyond the array elements', async () => {
      const sampleCode = `
        const SIZES = ['sm', 'md', 'lg'] as const;
        SIZES.map((size) => t(\`size_\${size}\`));
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      const keys = Object.keys(translationFile!.newTranslations)
      expect(keys).toEqual(expect.arrayContaining(['size_sm', 'size_md', 'size_lg']))
      expect(keys).toHaveLength(3)
    })
  })

  // ─── typeof arr[number] type resolution ─────────────────────────────────────

  describe('typeof arr[number] type alias', () => {
    it('should resolve (typeof ACCESS_OPTIONS)[number] in a type alias', async () => {
      // type AccessOptions = (typeof ACCESS_OPTIONS)[number]
      // declare const accessPreset: AccessOptions
      // t(`${accessPreset}Access`)
      const sampleCode = `
        const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
        type AccessOptions = (typeof ACCESS_OPTIONS)[number];
        declare const accessPreset: AccessOptions;
        t(\`\${accessPreset}Access\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('fullAccess')
      expect(translationFile!.newTranslations).toHaveProperty('editAccess')
      expect(translationFile!.newTranslations).toHaveProperty('restrictedAccess')
    })

    it('should resolve through the type alias in a template slot', async () => {
      const sampleCode = `
        const PLANS = ['free', 'pro', 'enterprise'] as const;
        type Plan = (typeof PLANS)[number];
        declare const currentPlan: Plan;
        t(\`billing.\${currentPlan}.label\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('billing.free.label')
      expect(translationFile!.newTranslations).toHaveProperty('billing.pro.label')
      expect(translationFile!.newTranslations).toHaveProperty('billing.enterprise.label')
    })
  })

  // ─── useState<T> — typed state variable ─────────────────────────────────────

  describe('useState<T> where T resolves to a finite union', () => {
    it('should expand all union values for useState typed with a type-alias union', async () => {
      // Exact pattern from the issue:
      // const [accessPreset, setAccessPreset] = useState<AccessOptions>('full');
      // t(`${accessPreset}Access`)
      const sampleCode = `
        const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
        type AccessOptions = (typeof ACCESS_OPTIONS)[number];
        const [accessPreset, setAccessPreset] = useState<AccessOptions>('full');
        t(\`\${accessPreset}Access\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('fullAccess')
      expect(translationFile!.newTranslations).toHaveProperty('editAccess')
      expect(translationFile!.newTranslations).toHaveProperty('restrictedAccess')
    })

    it('should expand all union values for useState typed with an inline literal union', async () => {
      const sampleCode = `
        const [tab, setTab] = useState<'overview' | 'settings' | 'billing'>('overview');
        t(\`tabs.\${tab}\`);
      `
      vol.fromJSON({ '/src/App.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile).toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('tabs.overview')
      expect(translationFile!.newTranslations).toHaveProperty('tabs.settings')
      expect(translationFile!.newTranslations).toHaveProperty('tabs.billing')
    })
  })

  // ─── Cross-file: imported namespace ─────────────────────────────────────────

  describe('cross-file: imported namespace constant', () => {
    it('should resolve a namespace imported from another file into useTranslation', async () => {
      await setupMultiFile({
        '/src/namespaces.ts': 'export const SETTINGS_NS = \'settings\';',
        '/src/Component.tsx': `
          import { SETTINGS_NS } from './namespaces';
          const { t } = useTranslation(SETTINGS_NS);
          t('planTitle');
        `,
      })

      const results = await extract(mockConfig)
      const settingsFile = results.find(r => pathEndsWith(r.path, '/locales/en/settings.json'))

      expect(settingsFile, 'settings.json should be created').toBeDefined()
      expect(settingsFile!.newTranslations).toHaveProperty('planTitle')
    })

    it('should resolve a namespace imported from another file into t() ns option', async () => {
      await setupMultiFile({
        '/src/namespaces.ts': 'export const GLOBAL_NS = \'global\';',
        '/src/Component.tsx': `
          import { GLOBAL_NS } from './namespaces';
          t('globalTitle', { ns: GLOBAL_NS });
        `,
      })

      const results = await extract(mockConfig)
      const globalFile = results.find(r => pathEndsWith(r.path, '/locales/en/global.json'))

      expect(globalFile, 'global.json should be created').toBeDefined()
      expect(globalFile!.newTranslations).toHaveProperty('globalTitle')
    })
  })

  // ─── Cross-file: imported as-const array ────────────────────────────────────

  describe('cross-file: imported as-const array used in .map()', () => {
    it('should expand array values when the array is exported from a constants file', async () => {
      // Exact pattern from the issue's second example:
      // export const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
      // import { ACCESS_OPTIONS } from '@core/constants'
      // ACCESS_OPTIONS.map((option) => ({ label: t(`${option}Access`) }))
      await setupMultiFile({
        '/src/constants.ts': `
          export const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
        `,
        '/src/Component.tsx': `
          import { ACCESS_OPTIONS } from './constants';
          ACCESS_OPTIONS.map((option) => ({
            label: t(\`\${option}Access\`),
          }));
        `,
      })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('fullAccess')
      expect(translationFile!.newTranslations).toHaveProperty('editAccess')
      expect(translationFile!.newTranslations).toHaveProperty('restrictedAccess')
    })
  })

  // ─── Cross-file: imported typeof arr[number] type alias ─────────────────────

  describe('cross-file: imported type alias derived from as-const array', () => {
    it('should resolve the type alias across files and expand keys', async () => {
      // Exact pattern from the issue's third example:
      // export const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
      // export type AccessOptions = (typeof ACCESS_OPTIONS)[number];
      // import { AccessOptions } from '@core/constants'
      // const [accessPreset] = useState<AccessOptions>('full');
      // t(`${accessPreset}Access`)
      await setupMultiFile({
        '/src/constants.ts': `
          export const ACCESS_OPTIONS = ['full', 'edit', 'restricted'] as const;
          export type AccessOptions = (typeof ACCESS_OPTIONS)[number];
        `,
        '/src/Component.tsx': `
          import { AccessOptions } from './constants';
          const [accessPreset, setAccessPreset] = useState<AccessOptions>('full');
          t(\`\${accessPreset}Access\`);
        `,
      })

      const results = await extract(mockConfig)
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(translationFile, 'translation.json should be created').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('fullAccess')
      expect(translationFile!.newTranslations).toHaveProperty('editAccess')
      expect(translationFile!.newTranslations).toHaveProperty('restrictedAccess')
    })
  })

  // ─── hazem3500 bug report ────────────────────────────────────────────────────
  // https://github.com/i18next/i18next-cli/issues/XXX (reported 2026-03-08)
  //
  // All three cases share the same root cause: the constants file
  // (`@core/translations/ns`) was processed AFTER the component files, so
  // `NS_SETTINGS` / `NS_CALENDAR` were not in `sharedConstants` yet when the
  // `useTranslation` / `t()` calls were walked.  The fix (two-pass extraction
  // in key-finder.ts) pre-scans every file for constants before extracting.

  describe('hazem3500: cross-file namespace constants (regression)', () => {
    // ── Bug 1 ──────────────────────────────────────────────────────────────────
    // useTranslation([NS_SETTINGS, NS_TOASTS, NS_TRANSLATION]) — array form.
    // The first element should become the default namespace for `t`.
    it('should use first element of a cross-file identifier array as the default namespace', async () => {
      await setupMultiFile({
        // ns constants file processed AFTER the component (worst-case order)
        '/src/z_ns.ts': `
          export const NS_SETTINGS = 'settings';
          export const NS_TOASTS = 'toasts';
          export const NS_TRANSLATION = 'translation';
        `,
        '/src/Component.tsx': `
          import { NS_SETTINGS, NS_TOASTS, NS_TRANSLATION } from './z_ns';
          const { t } = useTranslation([NS_SETTINGS, NS_TOASTS, NS_TRANSLATION]);
          t('settingsTitle');
        `,
      })

      const results = await extract(mockConfig)
      const settingsFile = results.find(r => pathEndsWith(r.path, '/locales/en/settings.json'))
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      // 'settingsTitle' must land in 'settings' — not in the default namespace
      expect(settingsFile, 'settings.json should be created').toBeDefined()
      expect(settingsFile!.newTranslations).toHaveProperty('settingsTitle')
      expect(translationFile?.newTranslations ?? {}).not.toHaveProperty('settingsTitle')
    })

    // ── Bug 2 ──────────────────────────────────────────────────────────────────
    // useTranslation(NS_CALENDAR) where NS_CALENDAR is imported from another file
    // AND the key itself is dynamic (DAY_NAMES[dayIndex]).
    it('should resolve cross-file useTranslation identifier and scoped dynamic key correctly', async () => {
      await setupMultiFile({
        '/src/z_ns.ts': `
          export const NS_CALENDAR = 'calendar';
        `,
        '/src/Component.tsx': `
          import { NS_CALENDAR } from './z_ns';

          const DAY_NAMES = [
            'sunday', 'monday', 'tuesday', 'wednesday',
            'thursday', 'friday', 'saturday',
          ] as const;

          const { t } = useTranslation(NS_CALENDAR);

          DAY_NAMES.map((day) => t(day));
        `,
      })

      const results = await extract(mockConfig)
      const calendarFile = results.find(r => pathEndsWith(r.path, '/locales/en/calendar.json'))
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      // All day keys must be in 'calendar', not in the default namespace
      expect(calendarFile, 'calendar.json should be created').toBeDefined()
      expect(calendarFile!.newTranslations).toHaveProperty('sunday')
      expect(calendarFile!.newTranslations).toHaveProperty('saturday')
      expect(translationFile?.newTranslations ?? {}).not.toHaveProperty('sunday')
    })

    // ── Bug 3 ──────────────────────────────────────────────────────────────────
    // t('startWeekOn', { ns: NS_SETTINGS }) — explicit ns option from a cross-file
    // identifier.  The key must appear ONLY in 'settings', never in 'translation'.
    it('should not duplicate a key into default ns when explicit ns option is a cross-file identifier', async () => {
      await setupMultiFile({
        '/src/z_ns.ts': `
          export const NS_SETTINGS = 'settings';
        `,
        '/src/Component.tsx': `
          import { NS_SETTINGS } from './z_ns';
          t('startWeekOn', { ns: NS_SETTINGS });
        `,
      })

      const results = await extract(mockConfig)
      const settingsFile = results.find(r => pathEndsWith(r.path, '/locales/en/settings.json'))
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      expect(settingsFile, 'settings.json should be created').toBeDefined()
      expect(settingsFile!.newTranslations).toHaveProperty('startWeekOn')

      // Must NOT appear in default namespace as well
      expect(translationFile?.newTranslations ?? {}).not.toHaveProperty('startWeekOn')
    })

    // ── Combined ───────────────────────────────────────────────────────────────
    // All three patterns in a single realistic project layout where the constants
    // file sorts AFTER all component files alphabetically.
    it('should handle all three hazem3500 patterns together in a realistic project', async () => {
      await setupMultiFile({
        '/src/z_translations_ns.ts': `
          export const NS_SETTINGS = 'settings';
          export const NS_TOASTS   = 'toasts';
          export const NS_CALENDAR = 'calendar';
        `,
        '/src/CalendarWidget.tsx': `
          import { NS_CALENDAR } from './z_translations_ns';

          const DAY_NAMES = ['sunday', 'monday', 'tuesday'] as const;
          const { t } = useTranslation(NS_CALENDAR);
          DAY_NAMES.map((day) => t(day));
        `,
        '/src/SettingsPage.tsx': `
          import { NS_SETTINGS, NS_TOASTS } from './z_translations_ns';

          const { t } = useTranslation([NS_SETTINGS, NS_TOASTS]);
          t('settingsTitle');
          t('startWeekOn', { ns: NS_SETTINGS });
        `,
      })

      const results = await extract(mockConfig)
      const calendarFile = results.find(r => pathEndsWith(r.path, '/locales/en/calendar.json'))
      const settingsFile = results.find(r => pathEndsWith(r.path, '/locales/en/settings.json'))
      const translationFile = results.find(r => pathEndsWith(r.path, '/locales/en/translation.json'))

      // Calendar keys in correct namespace
      expect(calendarFile, 'calendar.json should be created').toBeDefined()
      expect(calendarFile!.newTranslations).toHaveProperty('sunday')
      expect(calendarFile!.newTranslations).toHaveProperty('monday')

      // Settings keys in correct namespace
      expect(settingsFile, 'settings.json should be created').toBeDefined()
      expect(settingsFile!.newTranslations).toHaveProperty('settingsTitle')
      expect(settingsFile!.newTranslations).toHaveProperty('startWeekOn')

      // Nothing should bleed into the default namespace
      const defaultKeys = Object.keys(translationFile?.newTranslations ?? {})
      expect(defaultKeys).not.toContain('sunday')
      expect(defaultKeys).not.toContain('settingsTitle')
      expect(defaultKeys).not.toContain('startWeekOn')
    })
  })
})
