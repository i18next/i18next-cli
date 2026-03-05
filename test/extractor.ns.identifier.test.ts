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

// "extract: resolve namespace from const/identifier expressions without custom plugins"
describe('extractor: namespace resolution from identifier expressions (issue)', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
    const { glob } = await import('glob')
    ;(glob as any).mockResolvedValue(['/src/Component.tsx'])
  })

  describe('useTranslation with a local const identifier', () => {
    it('should resolve namespace when useTranslation receives a local const string variable', async () => {
      // Mirrors the exact scenario from issue
      const sampleCode = `
        const SETTINGS_NS = 'settings';

        const { t } = useTranslation(SETTINGS_NS);
        t('planTitle');
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)
      const settingsFile = results.find(r => pathEndsWith(r.path, '/locales/en/settings.json'))

      expect(settingsFile, 'settings.json should be created').toBeDefined()
      expect(settingsFile!.newTranslations).toHaveProperty('planTitle')
    })

    it('should not put the key into the default namespace when the const namespace is resolved', async () => {
      const sampleCode = `
        const SETTINGS_NS = 'settings';

        const { t } = useTranslation(SETTINGS_NS);
        t('planTitle');
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      // planTitle must NOT bleed into the default namespace
      expect(translationFile?.newTranslations ?? {}).not.toHaveProperty('planTitle')
    })
  })

  describe('t() ns option with a local const identifier', () => {
    it('should resolve namespace when the ns option receives a local const string variable', async () => {
      // Mirrors the exact scenario from issue
      const sampleCode = `
        const GLOBAL_NS = 'global';

        t('globalTitle', { ns: GLOBAL_NS });
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)
      const globalFile = results.find(r => pathEndsWith(r.path, '/locales/en/global.json'))

      expect(globalFile, 'global.json should be created').toBeDefined()
      expect(globalFile!.newTranslations).toHaveProperty('globalTitle')
    })

    it('should not put the key into the default namespace when ns option const is resolved', async () => {
      const sampleCode = `
        const GLOBAL_NS = 'global';

        t('globalTitle', { ns: GLOBAL_NS });
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      expect(translationFile?.newTranslations ?? {}).not.toHaveProperty('globalTitle')
    })
  })

  describe('combined: useTranslation + ns option override, both using local consts', () => {
    it('should handle the full issue example correctly', async () => {
      // The exact reproduction case from the issue
      const sampleCode = `
        import { useTranslation } from 'react-i18next';

        const SETTINGS_NS = 'settings';
        const GLOBAL_NS = 'global';

        export const SettingsPage = () => {
          const { t } = useTranslation(SETTINGS_NS);

          return (
            <div>
              <h1>{t('planTitle')}</h1>
              <p>{t('globalTitle', { ns: GLOBAL_NS })}</p>
            </div>
          );
        };
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)

      const settingsFile = results.find(r => pathEndsWith(r.path, '/locales/en/settings.json'))
      const globalFile = results.find(r => pathEndsWith(r.path, '/locales/en/global.json'))
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      // planTitle -> 'settings' namespace (via useTranslation(SETTINGS_NS))
      expect(settingsFile, 'settings.json should exist').toBeDefined()
      expect(settingsFile!.newTranslations).toHaveProperty('planTitle')

      // globalTitle -> 'global' namespace (via ns: GLOBAL_NS override)
      expect(globalFile, 'global.json should exist').toBeDefined()
      expect(globalFile!.newTranslations).toHaveProperty('globalTitle')

      // Neither key should fall through to the default namespace
      expect(translationFile?.newTranslations ?? {}).not.toHaveProperty('planTitle')
      expect(translationFile?.newTranslations ?? {}).not.toHaveProperty('globalTitle')
    })

    it('should keep keys separate when two consts point to different namespaces', async () => {
      const sampleCode = `
        const NS_A = 'alpha';
        const NS_B = 'beta';

        const { t: tA } = useTranslation(NS_A);
        const { t: tB } = useTranslation(NS_B);

        tA('keyAlpha');
        tB('keyBeta');
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)

      const alphaFile = results.find(r => pathEndsWith(r.path, '/locales/en/alpha.json'))
      const betaFile = results.find(r => pathEndsWith(r.path, '/locales/en/beta.json'))

      expect(alphaFile).toBeDefined()
      expect(alphaFile!.newTranslations).toHaveProperty('keyAlpha')
      expect(alphaFile!.newTranslations).not.toHaveProperty('keyBeta')

      expect(betaFile).toBeDefined()
      expect(betaFile!.newTranslations).toHaveProperty('keyBeta')
      expect(betaFile!.newTranslations).not.toHaveProperty('keyAlpha')
    })
  })

  describe('edge cases', () => {
    it('should fall back to the default namespace when the identifier cannot be statically resolved', async () => {
      // A dynamic value — extractor cannot know the namespace at parse time
      const sampleCode = `
        const getNS = () => 'dynamic';
        const { t } = useTranslation(getNS());
        t('someKey');
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)
      const translationFile = results.find(r =>
        pathEndsWith(r.path, '/locales/en/translation.json')
      )

      // Key ends up in default namespace because the namespace is not statically knowable
      expect(translationFile, 'translation.json should exist').toBeDefined()
      expect(translationFile!.newTranslations).toHaveProperty('someKey')
    })

    it('should resolve a const declared with "as const" type assertion', async () => {
      const sampleCode = `
        const FEATURE_NS = 'feature' as const;

        const { t } = useTranslation(FEATURE_NS);
        t('featureTitle');
      `
      vol.fromJSON({ '/src/Component.tsx': sampleCode })

      const results = await extract(mockConfig)
      const featureFile = results.find(r => pathEndsWith(r.path, '/locales/en/feature.json'))

      expect(featureFile, 'feature.json should exist').toBeDefined()
      expect(featureFile!.newTranslations).toHaveProperty('featureTitle')
    })
  })
})
