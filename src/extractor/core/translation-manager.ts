import { TranslationResult, ExtractedKey, I18nextToolkitConfig } from '../../types'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getNestedValue, setNestedValue, getNestedKeys } from '../../utils/nested-object'
import { getOutputPath } from '../../utils/file-utils'

/**
 * Converts a glob pattern to a regular expression for matching keys
 * @param glob - The glob pattern to convert
 * @returns A RegExp object that matches the glob pattern
 */
function globToRegex (glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexString = `^${escaped.replace(/\*/g, '.*')}$`
  return new RegExp(regexString)
}

/**
 * Processes extracted translation keys and generates translation files for all configured locales.
 *
 * This function:
 * 1. Groups keys by namespace
 * 2. For each locale and namespace combination:
 *    - Reads existing translation files
 *    - Preserves keys matching `preservePatterns`
 *    - Merges in newly extracted keys
 *    - Uses primary language defaults or empty strings for secondary languages
 *    - Maintains key sorting based on configuration
 * 3. Determines if files need updating by comparing content
 *
 * @param keys - Map of extracted translation keys with metadata
 * @param config - The i18next toolkit configuration object
 * @returns Promise resolving to array of translation results with update status
 *
 * @example
 * ```typescript
 * const keys = new Map([
 *   ['translation:welcome', { key: 'welcome', defaultValue: 'Welcome!', ns: 'translation' }],
 *   ['common:button.save', { key: 'button.save', defaultValue: 'Save', ns: 'common' }]
 * ])
 *
 * const results = await getTranslations(keys, config)
 * // Results contain update status and new/existing translations for each locale
 * ```
 */
export async function getTranslations (
  keys: Map<string, ExtractedKey>,
  config: I18nextToolkitConfig
): Promise<TranslationResult[]> {
  const defaultNS = config.extract.defaultNS ?? 'translation'
  const keySeparator = config.extract.keySeparator ?? '.'
  const preservePatterns = (config.extract.preservePatterns ?? []).map(globToRegex)
  if (!config.extract.primaryLanguage) config.extract.primaryLanguage = config.locales[0] || 'en'
  if (!config.extract.secondaryLanguages) config.extract.secondaryLanguages = config.locales.filter((l: string) => l !== config.extract.primaryLanguage)

  // Group keys by namespace
  const keysByNS = new Map<string, ExtractedKey[]>()
  for (const key of keys.values()) {
    const ns = key.ns || defaultNS
    if (!keysByNS.has(ns)) {
      keysByNS.set(ns, [])
    }
    keysByNS.get(ns)!.push(key)
  }

  const results: TranslationResult[] = []

  for (const locale of config.locales) {
    for (const [ns, nsKeys] of keysByNS.entries()) {
      const outputPath = getOutputPath(config.extract.output, locale, ns)

      const fullPath = resolve(process.cwd(), outputPath)

      let oldContent = ''
      let existingTranslations: Record<string, any> = {}
      try {
        oldContent = await readFile(fullPath, 'utf-8')
        existingTranslations = JSON.parse(oldContent)
      } catch (e) { /* File doesn't exist, which is fine */ }

      const newTranslations: Record<string, any> = {}

      // 1. Preserve keys from existing translations that match patterns
      const existingKeys = getNestedKeys(existingTranslations, keySeparator)
      for (const existingKey of existingKeys) {
        if (preservePatterns.some(re => re.test(existingKey))) {
          const value = getNestedValue(existingTranslations, existingKey, keySeparator)
          setNestedValue(newTranslations, existingKey, value, keySeparator)
        }
      }

      // 2. Merge in newly found keys for this namespace
      const sortedKeys = (config.extract.sort === false)
        ? nsKeys
        : nsKeys.sort((a, b) => a.key.localeCompare(b.key))
      for (const { key, defaultValue } of sortedKeys) {
        const existingValue = getNestedValue(existingTranslations, key, keySeparator)
        const valueToSet = existingValue ?? (locale === config.extract?.primaryLanguage ? defaultValue : '')
        setNestedValue(newTranslations, key, valueToSet, keySeparator)
      }

      const indentation = config.extract.indentation ?? 2
      const newContent = JSON.stringify(newTranslations, null, indentation)

      results.push({
        path: fullPath,
        updated: newContent !== oldContent,
        newTranslations,
        existingTranslations,
      })
    }
  }

  return results
}
