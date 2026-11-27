import { glob } from 'glob'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, extname } from 'node:path'
import type { I18nextToolkitConfig } from './types.js'
import { readProjectDeps } from './utils/file-utils.js'

/** The directories source files usually live in, one glob for those that exist (`{app,components}/**`). */
async function sourceInput (): Promise<string[]> {
  const dirs = []
  // not `lib`, often the build output of a package
  for (const dir of ['src', 'app', 'pages', 'components']) {
    if (await stat(dir).then(found => found.isDirectory(), () => false)) dirs.push(dir)
  }
  const exts = '**/*.{js,jsx,mjs,ts,tsx}'
  return [dirs.length > 1 ? `{${dirs.join(',')}}/${exts}` : `${dirs[0] ?? 'src'}/${exts}`]
}

/**
 * The extract options the app's own setup decides: next-i18next's `defaultNS` (from its config, `common` when it
 * sets none), the message format of i18next-icu or i18next-mf2, and `keySeparator: false` for translation files
 * with flat keys that contain dots (`"blog.title": "…"`).
 */
async function setupOptions (translationFiles: string[]): Promise<Partial<I18nextToolkitConfig['extract']>> {
  const deps = await readProjectDeps()
  const options: Partial<I18nextToolkitConfig['extract']> = {}
  if (deps['next-i18next']) {
    const configs = await glob('{i18n.config,next-i18next.config,i18n.shared}.{ts,js,mjs,cjs}', { ignore: 'node_modules/**' })
    for (const file of configs) {
      const ns = /\bdefaultNS\s*:\s*['"]([^'"]+)['"]/.exec(await readFile(file, 'utf-8'))?.[1]
      if (ns) { options.defaultNS = ns; break }
    }
    options.defaultNS ??= 'common'
  }
  if (deps['i18next-icu']) options.messageFormat = 'icu'
  else if (deps['i18next-mf2']) options.messageFormat = 'mf2'
  const flat: boolean[] = []
  for (const file of translationFiles.filter(f => extname(f) === '.json')) {
    try {
      const json = JSON.parse(await readFile(file, 'utf-8'))
      if (Object.values(json).some(v => typeof v === 'object')) return options
      flat.push(Object.keys(json).some(key => key.includes('.')))
    } catch {}
  }
  if (flat.includes(true)) options.keySeparator = false
  return options
}

// A list of common glob patterns for the primary language ('en') or ('dev') translation files.
const HEURISTIC_PATTERNS = [
  'public/locales/dev/*.json',
  'locales/dev/*.json',
  'src/locales/dev/*.json',
  'src/assets/locales/dev/*.json',
  'app/i18n/locales/dev/*.json',
  'src/i18n/locales/dev/*.json',

  'public/locales/en/*.json',
  'locales/en/*.json',
  'src/locales/en/*.json',
  'src/assets/locales/en/*.json',
  'app/i18n/locales/en/*.json',
  'src/i18n/locales/en/*.json',

  'public/locales/en/*.json5',
  'locales/en/*.json5',
  'src/locales/en/*.json5',
  'src/assets/locales/en/*.json5',
  'app/i18n/locales/en/*.json5',
  'src/i18n/locales/en/*.json5',

  'public/locales/en/*.yaml',
  'locales/en/*.yaml',
  'src/locales/en/*.yaml',
  'src/assets/locales/en/*.yaml',
  'app/i18n/locales/en/*.yaml',
  'src/i18n/locales/en/*.yaml',

  'public/locales/en/*.yml',
  'locales/en/*.yml',
  'src/locales/en/*.yml',
  'src/assets/locales/en/*.yml',
  'app/i18n/locales/en/*.yml',
  'src/i18n/locales/en/*.yml',

  'public/locales/en-*/*.json',
  'locales/en-*/*.json',
  'src/locales/en-*/*.json',
  'src/assets/locales/en-*/*.json',
  'app/i18n/locales/en-*/*.json',
  'src/i18n/locales/en-*/*.json',
]

/**
 * Attempts to automatically detect the project's i18n structure by searching for
 * common translation file locations.
 *
 * @returns A promise that resolves to a partial I18nextToolkitConfig if detection
 * is successful, otherwise null.
 */
export async function detectConfig (): Promise<Partial<I18nextToolkitConfig> | null> {
  for (const pattern of HEURISTIC_PATTERNS) {
    const files = await glob(pattern, { ignore: 'node_modules/**' })

    if (files.length > 0) {
      // Prefer .json5 if present
      const json5File = files.find(f => extname(f) === '.json5')
      const firstFile = json5File || files[0]
      const basePath = dirname(dirname(firstFile))
      const extension = extname(firstFile)

      // Infer outputFormat from the file extension
      let outputFormat: I18nextToolkitConfig['extract']['outputFormat'] = 'json'
      if (extension === '.ts') {
        outputFormat = 'ts'
      } else if (extension === '.js') {
        // We can't know if it's ESM or CJS, so we default to a safe choice.
        // The tool's file loaders can handle both.
        outputFormat = 'js'
      } else if (extension === '.json5') {
        outputFormat = 'json5'
      } else if (extension === '.yaml' || extension === '.yml') {
        outputFormat = 'yaml'
      }

      try {
        const allDirs = await readdir(basePath)
        let locales = allDirs.filter(dir => /^(dev|[a-z]{2}(-[A-Z]{2})?)$/.test(dir))

        if (locales.length > 0) {
          // Prioritization Logic
          locales.sort()
          if (locales.includes('dev')) {
            locales = ['dev', ...locales.filter(l => l !== 'dev')]
          }
          // Found via an `en-*` pattern (e.g. en-US): that locale is the primary one
          const matchedLocale = basename(dirname(firstFile))
          if (matchedLocale.startsWith('en-') && locales.includes(matchedLocale)) {
            locales = [matchedLocale, ...locales.filter(l => l !== matchedLocale)]
          }
          if (locales.includes('en')) {
            locales = ['en', ...locales.filter(l => l !== 'en')]
          }

          return {
            locales,
            extract: {
              input: await sourceInput(),
              output: join(basePath, '{{language}}', `{{namespace}}${extension}`),
              outputFormat,
              primaryLanguage: locales.includes('en') ? 'en' : locales[0],
              ...await setupOptions(files),
            },
          }
        }
      } catch {
        continue
      }
    }
  }

  return null
}
