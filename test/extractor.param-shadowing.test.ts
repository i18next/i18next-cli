import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { glob } from 'glob'
import { findKeys } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

const keysOf = async (files: Record<string, string>) => {
  vol.fromJSON(files)
  vi.mocked(glob).mockResolvedValue(Object.keys(files))
  const { allKeys } = await findKeys({
    locales: ['en'],
    extract: { input: ['src/**/*.js'], output: 'locales/{{language}}/{{namespace}}.json', functions: ['t'] },
  })
  return [...allKeys.values()].map(k => `${k.ns}:${k.key}`).sort()
}

describe('extractor: parameter shadowing a module variable (#316)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('does not resolve a parameter to a same-named module object', async () => {
    expect(await keysOf({
      '/src/repro.js': `
        function translate(options, value, t) {
          t(options[value]);
        }
        const options = { method: 'GET' };
      `,
    })).toEqual([])
  })

  it('does not take the namespace or keyPrefix of a custom hook from a same-named constant of another file', async () => {
    expect(await keysOf({
      '/src/hooks.js': `
        import { useTranslation } from 'react-i18next';
        export function useNsT (ns) {
          const { t } = useTranslation(ns);
          return t('hook.ns');
        }
        export function usePrefixedT (keyPrefix) {
          const { t } = useTranslation('translation', { keyPrefix });
          return t('hook.prefixed');
        }
      `,
      '/src/admin.js': `
        export const keyPrefix = 'settings';
        export function load () {
          const ns = 'admin';
          return ns;
        }
      `,
    })).toEqual(['translation:hook.ns', 'translation:hook.prefixed'])
  })

  it('does not resolve a parameter to a local variable of another file', async () => {
    expect(await keysOf({
      '/src/jobOfferForm.js': `
        export class JobOfferForm {
          async load (userId) {
            const options = { method: 'GET', headers: { Accept: 'application/ld+json' } };
            return fetch('/people/' + userId, options);
          }
        }
      `,
      '/src/careerProfileForm.js': `
        const getLabel = (options, value, t) => {
          const translationKey = options[value];
          return translationKey ? t(translationKey) : value;
        };
        function getMethod (options, value) {
          return options[value];
        }
        t(getMethod(x, y));
      `,
    })).toEqual([])
  })

  it('still resolves a module object or constant read inside a function without such a parameter', async () => {
    expect(await keysOf({
      '/src/labels.js': `
        const LABELS = { save: 'label.save', cancel: 'label.cancel' };
        function render (options, t) {
          t(LABELS[options.kind]);
        }
        class Form {
          submit (value) { t(LABELS.save); }
        }
        const ns = 'forms';
        const keyPrefix = 'form';
        function useFormT (value) {
          const { t } = useTranslation(ns, { keyPrefix });
          return t('title');
        }
      `,
    })).toEqual(['forms:form.title', 'translation:label.cancel', 'translation:label.save'])
  })
})
