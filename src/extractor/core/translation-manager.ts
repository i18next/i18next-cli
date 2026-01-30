import { TranslationResult, ExtractedKey, I18nextToolkitConfig } from '../../types'
import { resolve, basename, extname } from 'node:path'
import { glob } from 'glob'
import { getNestedValue, setNestedValue, getNestedKeys } from '../../utils/nested-object'
import { getOutputPath, loadTranslationFile } from '../../utils/file-utils'
import { resolveDefaultValue } from '../../utils/default-value'

// used for natural language check
const chars = [' ', ',', '?', '!', ';']

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
 * Checks if an existing key is a context variant of a base key that accepts context.
 * This function handles complex cases where:
 * - The key might have plural suffixes (_one, _other, etc.)
 * - The context value itself might contain the separator (e.g., mc_laren)
 *
 * @param existingKey - The key from the translation file to check
 * @param keysAcceptingContext - Set of base keys that were used with context in source code
 * @param pluralSeparator - The separator used for plural forms (default: '_')
 * @param contextSeparator - The separator used for context variants (default: '_')
 * @returns true if the existing key is a context variant of a key accepting context
 */
function isContextVariantOfAcceptingKey (
  existingKey: string,
  keysAcceptingContext: ReadonlySet<string>,
  pluralSeparator: string,
  contextSeparator: string
): boolean {
  if (keysAcceptingContext.size === 0) {
    return false
  }

  // Try to extract the base key from this existing key by removing context and/or plural suffixes
  let potentialBaseKey = existingKey

  // First, try removing plural suffixes if present
  const pluralForms = ['zero', 'one', 'two', 'few', 'many', 'other']
  for (const form of pluralForms) {
    if (potentialBaseKey.endsWith(`${pluralSeparator}${form}`)) {
      potentialBaseKey = potentialBaseKey.slice(0, -(pluralSeparator.length + form.length))
      break
    }
    if (potentialBaseKey.endsWith(`${pluralSeparator}ordinal${pluralSeparator}${form}`)) {
      potentialBaseKey = potentialBaseKey.slice(0, -(pluralSeparator.length + 'ordinal'.length + pluralSeparator.length + form.length))
      break
    }
  }

  // Then, try removing the context suffix to get the base key
  // We need to check all possible base keys since the context value itself might contain separators
  // For example: 'formula_one_mc_laren' could be:
  //   - base: 'formula_one_mc', context: 'laren'
  //   - base: 'formula_one', context: 'mc_laren'  ← correct
  //   - base: 'formula', context: 'one_mc_laren'
  const parts = potentialBaseKey.split(contextSeparator)
  if (parts.length > 1) {
    // Try removing 1, 2, 3... parts from the end to find a matching base key
    for (let i = 1; i < parts.length; i++) {
      const baseWithoutContext = parts.slice(0, -i).join(contextSeparator)
      if (keysAcceptingContext.has(baseWithoutContext)) {
        return true
      }
    }
  }

  // Also check if the key itself (after removing plural suffix) accepts context
  // This handles cases like 'friend_other' where 'friend' accepts context
  if (keysAcceptingContext.has(potentialBaseKey)) {
    return true
  }

  return false
}

/**
 * Checks if a key looks like an object path or natural language.
 * (like in i18next)
 */
function looksLikeObjectPath (key: string, separator: string, regex: RegExp | null): boolean {
  if (!regex) return true
  let matched = !regex.test(key)
  if (!matched) {
    const ki = key.indexOf(separator)
    if (ki > 0 && !regex.test(key.substring(0, ki))) {
      matched = true
    }
  }
  return matched
}

/**
 * Recursively sorts the keys of an object.
 */
function sortObject (obj: any, config?: I18nextToolkitConfig, customSort?: (a: string, b: string) => number): any {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return obj
  }

  const sortedObj: Record<string, any> = {}
  const pluralSeparator = config?.extract?.pluralSeparator ?? '_'

  // Define the canonical order for plural forms
  const pluralOrder = ['zero', 'one', 'two', 'few', 'many', 'other']
  const ordinalPluralOrder = pluralOrder.map(form => `ordinal${pluralSeparator}${form}`)

  const keys = Object.keys(obj).sort((a, b) => {
    // Helper function to extract base key and form info
    const getKeyInfo = (key: string) => {
      // Handle ordinal plurals: key_ordinal_form or key_context_ordinal_form
      for (const form of ordinalPluralOrder) {
        if (key.endsWith(`${pluralSeparator}${form}`)) {
          const base = key.slice(0, -(pluralSeparator.length + form.length))
          return { base, form, isOrdinal: true, isPlural: true, fullKey: key }
        }
      }
      // Handle cardinal plurals: key_form or key_context_form
      for (const form of pluralOrder) {
        if (key.endsWith(`${pluralSeparator}${form}`)) {
          const base = key.slice(0, -(pluralSeparator.length + form.length))
          return { base, form, isOrdinal: false, isPlural: true, fullKey: key }
        }
      }
      return { base: key, form: '', isOrdinal: false, isPlural: false, fullKey: key }
    }

    const aInfo = getKeyInfo(a)
    const bInfo = getKeyInfo(b)

    // If both are plural forms
    if (aInfo.isPlural && bInfo.isPlural) {
      // First compare by base key
      const baseComparison = customSort
        ? customSort(aInfo.base, bInfo.base)
        : aInfo.base.localeCompare(bInfo.base, undefined, { sensitivity: 'base' })
      if (baseComparison !== 0) {
        return baseComparison
      }

      // Same base key - now sort by plural form order
      // Ordinal forms come after cardinal forms
      if (aInfo.isOrdinal !== bInfo.isOrdinal) {
        return aInfo.isOrdinal ? 1 : -1
      }

      // Both same type (cardinal or ordinal), sort by canonical order
      const orderArray = aInfo.isOrdinal ? ordinalPluralOrder : pluralOrder
      const aIndex = orderArray.indexOf(aInfo.form)
      const bIndex = orderArray.indexOf(bInfo.form)

      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex
      }

      // Fallback to alphabetical if forms not found in order array
      return aInfo.form.localeCompare(bInfo.form)
    }

    // Use custom sort if provided, otherwise default sorting
    if (customSort) {
      return customSort(a, b)
    }

    // Default: case-insensitive, then by case
    const caseInsensitiveComparison = a.localeCompare(b, undefined, { sensitivity: 'base' })
    if (caseInsensitiveComparison === 0) {
      return a.localeCompare(b, undefined, { sensitivity: 'case' })
    }
    return caseInsensitiveComparison
  })

  for (const key of keys) {
    sortedObj[key] = sortObject(obj[key], config, customSort)
  }

  return sortedObj
}

/**
 * A helper function to build a new translation object for a single namespace.
 * This centralizes the core logic of merging keys.
 */
function buildNewTranslationsForNs (
  nsKeys: ExtractedKey[],
  existingTranslations: Record<string, any>,
  config: I18nextToolkitConfig,
  locale: string,
  namespace?: string,
  preservePatterns: RegExp[] = [],
  objectKeys: Set<string> = new Set(),
  syncPrimaryWithDefaults: boolean = false,
  syncAll: boolean = false
): Record<string, any> {
  const {
    keySeparator = '.',
    sort = true,
    removeUnusedKeys = true,
    primaryLanguage,
    defaultValue: emptyDefaultValue = '',
    pluralSeparator = '_',
    contextSeparator = '_',
    preserveContextVariants = false,
  } = config.extract

  const nsSep = typeof config.extract.nsSeparator === 'string' ? config.extract.nsSeparator : ':'

  // Keep the raw configured defaultValue so we can distinguish:
  // - "not provided" (undefined) vs
  // - "provided as empty string" ('')
  const configuredDefaultValue = config.extract.defaultValue

  // Treat "defaultValue that equals the key (or a suffix of it)" as a derived fallback.
  // This happens for:
  // - plain calls without a code default: t('hello')
  // - keyPrefix calls where the stored key is prefixed but defaultValue is the unprefixed part:
  //   key="nested.another.key", defaultValue="another.key"
  const isDerivedFromKey = (key: string, defaultValue: any, explicitDefault?: boolean): boolean => {
    if (explicitDefault) return false
    if (defaultValue === undefined || defaultValue === null) return true

    const dv = String(defaultValue)

    // Exact fallback
    if (dv === key) return true

    // Namespace:key fallback
    if (nsSep && namespace && dv === `${namespace}${nsSep}${key}`) return true

    // keyPrefix-style fallback: defaultValue is a suffix of the full key
    // Example: key="nested.key", dv="key"  OR  key="nested.another.key", dv="another.key"
    if (typeof keySeparator === 'string' && keySeparator.length > 0) {
      if (key.endsWith(`${keySeparator}${dv}`)) return true
    }

    // Plural/context variants sometimes store base as default; keep existing logic parity
    if (dv && key !== dv) {
      if (key.startsWith(dv + pluralSeparator)) return true
      if (key.startsWith(dv + contextSeparator)) return true
    }

    return false
  }

  // Prepare regex for natural language detection
  const possibleChars = chars.filter(
    (c) => nsSep.indexOf(c) < 0 && (typeof keySeparator === 'string' ? keySeparator.indexOf(c) < 0 : true)
  )
  const naturalLanguageRegex = possibleChars.length > 0
    ? new RegExp(`(${possibleChars.map((c) => (c === '?' ? '\\?' : c)).join('|')})`)
    : null

  // Build a set of base keys that accept context (only if preserveContextVariants is enabled)
  // These are keys that were called with a context parameter in the source code
  const keysAcceptingContext = new Set<string>()
  if (preserveContextVariants) {
    for (const { keyAcceptingContext } of nsKeys) {
      if (keyAcceptingContext) {
        keysAcceptingContext.add(keyAcceptingContext)
      }
    }
  }

  // Get the plural categories for the target language
  const targetLanguagePluralCategories = new Set<string>()
  // Track cardinal plural categories separately so we can special-case single-"other" languages
  let cardinalCategories: string[] = []
  let ordinalCategories: string[] = []
  try {
    const cardinalRules = new Intl.PluralRules(locale, { type: 'cardinal' })
    const ordinalRules = new Intl.PluralRules(locale, { type: 'ordinal' })

    cardinalCategories = cardinalRules.resolvedOptions().pluralCategories
    ordinalCategories = ordinalRules.resolvedOptions().pluralCategories
    cardinalCategories.forEach(cat => targetLanguagePluralCategories.add(cat))
    ordinalRules.resolvedOptions().pluralCategories.forEach(cat => targetLanguagePluralCategories.add(`ordinal_${cat}`))
  } catch (e) {
    // Fallback to primaryLanguage (or English) if locale is invalid
    const fallbackLang = primaryLanguage || 'en'
    const cardinalRules = new Intl.PluralRules(fallbackLang, { type: 'cardinal' })
    const ordinalRules = new Intl.PluralRules(fallbackLang, { type: 'ordinal' })

    cardinalCategories = cardinalRules.resolvedOptions().pluralCategories
    ordinalCategories = ordinalRules.resolvedOptions().pluralCategories
    cardinalCategories.forEach(cat => targetLanguagePluralCategories.add(cat))
    ordinalRules.resolvedOptions().pluralCategories.forEach(cat => targetLanguagePluralCategories.add(`ordinal_${cat}`))
  }

  // Prepare namespace pattern checking helpers
  const rawPreserve = config.extract.preservePatterns || []

  // Helper to check if a key should be filtered out during extraction
  const shouldFilterKey = (key: string): boolean => {
    // 1) regex based patterns (existing behavior)
    if (preservePatterns.some(re => re.test(key))) {
      return true
    }
    // 2) namespace:* style patterns (respect nsSeparator)
    for (const rp of rawPreserve) {
      if (typeof rp !== 'string') continue
      if (rp.endsWith(`${nsSep}*`)) {
        const nsPrefix = rp.slice(0, -(nsSep.length + 1))
        // If namespace is provided to this builder, and pattern targets this namespace, skip keys from this ns
        // Support wildcard namespace '*' to match any namespace
        if (nsPrefix === '*' || (namespace && nsPrefix === namespace)) {
          return true
        }
      }
    }
    return false
  }

  // Helper to check if an existing key should be preserved
  const shouldPreserveExistingKey = (key: string): boolean => {
    // 1) regex-style patterns
    if (preservePatterns.some(re => re.test(key))) {
      return true
    }
    // 2) namespace:key patterns - check if pattern matches this namespace:key combination
    for (const rp of rawPreserve) {
      if (typeof rp !== 'string') continue

      // Handle namespace:* patterns
      if (rp.endsWith(`${nsSep}*`)) {
        const nsPrefix = rp.slice(0, -(nsSep.length + 1))
        if (nsPrefix === '*' || (namespace && nsPrefix === namespace)) {
          return true
        }
      }

      // Handle namespace:specificKey patterns (e.g., 'other:okey', 'other:second*')
      if (rp.includes(nsSep) && namespace) {
        const [patternNs, patternKey] = rp.split(nsSep)
        if (patternNs === namespace) {
          // Convert the key part to regex (handle wildcards)
          const keyRegex = globToRegex(patternKey)
          if (keyRegex.test(key)) {
            return true
          }
        }
      }
    }
    return false
  }

  // Filter nsKeys to only include keys relevant to this language
  const filteredKeys = nsKeys.filter(({ key, hasCount, isOrdinal }) => {
    // FIRST: Check if key matches preservePatterns and should be excluded
    if (shouldFilterKey(key)) {
      return false
    }

    if (!hasCount) {
      // Non-plural keys are always included
      return true
    }

    // For plural keys, check if this specific plural form is needed for the target language
    const keyParts = key.split(pluralSeparator)

    // If this is a base plural key (no plural suffix), keep it so that the
    // builder can expand it to the target locale's plural forms.
    if (hasCount && keyParts.length === 1) {
      return true
    }

    // Special-case single-cardinal-"other" languages (ja/zh/ko etc.):
    // when the target language's cardinal categories are exactly ['other'],
    // the extractor may have emitted the base key (no "_other" suffix).
    // Accept the base key in that situation, while still accepting explicit *_other variants.
    if (cardinalCategories.length === 1 && cardinalCategories[0] === 'other') {
      // If this is a plain/base key (no plural suffix), include it.
      if (keyParts.length === 1) return true
      // Otherwise fall through and check the explicit suffix as before.
    }

    if (isOrdinal && keyParts.includes('ordinal')) {
      // For ordinal plurals: key_context_ordinal_category or key_ordinal_category
      const lastPart = keyParts[keyParts.length - 1]
      return targetLanguagePluralCategories.has(`ordinal_${lastPart}`)
    } else if (hasCount) {
      // For cardinal plurals: key_context_category or key_category
      const lastPart = keyParts[keyParts.length - 1]
      return targetLanguagePluralCategories.has(lastPart)
    }

    return true
  })

  // NEW: detect bases that already have expanded plural variants extracted.
  // If a base has explicit expanded variants (e.g. key_one, key_other or key_ordinal_one),
  // we should avoid generating/expanding the base plural key for that base to prevent
  // double-generation / duplicate counting.
  const expandedBases = new Set<string>()
  for (const ek of filteredKeys) {
    if (ek.isExpandedPlural) {
      const parts = String(ek.key).split(pluralSeparator)
      // If ordinal form like "key_ordinal_one" -> base should strip "_ordinal_<cat>"
      if (parts.length >= 3 && parts[parts.length - 2] === 'ordinal') {
        expandedBases.add(parts.slice(0, -2).join(pluralSeparator))
      } else {
        // strip single trailing category
        expandedBases.add(parts.slice(0, -1).join(pluralSeparator))
      }
    }
  }

  // If `removeUnusedKeys` is true, start with an empty object. Otherwise, start with a clone of the existing translations.
  let newTranslations: Record<string, any> = removeUnusedKeys
    ? {}
    : JSON.parse(JSON.stringify(existingTranslations))

  // Preserve keys that match the configured patterns OR are context variants of keys accepting context
  const existingKeys = getNestedKeys(existingTranslations, keySeparator ?? '.')
  for (const existingKey of existingKeys) {
    const shouldPreserve = shouldPreserveExistingKey(existingKey)
    const isContextVariant = !shouldPreserve && isContextVariantOfAcceptingKey(
      existingKey,
      keysAcceptingContext,
      pluralSeparator,
      contextSeparator
    )

    if (shouldPreserve || (preserveContextVariants && isContextVariant)) {
      const value = getNestedValue(existingTranslations, existingKey, keySeparator ?? '.')
      setNestedValue(newTranslations, existingKey, value, keySeparator ?? '.')
    }
  }

  // SPECIAL HANDLING: Preserve existing _zero forms even if not in extracted keys
  // This ensures that optional _zero forms are not removed when they exist
  if (removeUnusedKeys) {
    const existingKeys = getNestedKeys(existingTranslations, keySeparator ?? '.')
    for (const existingKey of existingKeys) {
      // Check if this is a _zero form that should be preserved
      const keyParts = existingKey.split(pluralSeparator)
      const lastPart = keyParts[keyParts.length - 1]

      if (lastPart === 'zero') {
        // Check if the base plural key exists in our extracted keys
        const baseKey = keyParts.slice(0, -1).join(pluralSeparator)
        const hasBaseInExtracted = filteredKeys.some(({ key }) => {
          const extractedParts = key.split(pluralSeparator)
          const extractedBase = extractedParts.slice(0, -1).join(pluralSeparator)
          return extractedBase === baseKey
        })

        if (hasBaseInExtracted) {
          // Preserve the existing _zero form
          const value = getNestedValue(existingTranslations, existingKey, keySeparator ?? '.')
          setNestedValue(newTranslations, existingKey, value, keySeparator ?? '.')
        }
      }
    }
  }

  // 1. Build the object first, without any sorting.
  for (const { key, defaultValue, explicitDefault, hasCount, isExpandedPlural, isOrdinal } of filteredKeys) {
    // If this is a base plural key (hasCount true but not an already-expanded variant)
    // and we detected explicit expanded variants for this base, skip expanding the base.
    if (hasCount && !isExpandedPlural) {
      const parts = String(key).split(pluralSeparator)
      let base = key
      if (parts.length >= 3 && parts[parts.length - 2] === 'ordinal') {
        base = parts.slice(0, -2).join(pluralSeparator)
      } else if (parts.length >= 2) {
        base = parts.slice(0, -1).join(pluralSeparator)
      }
      if (expandedBases.has(base)) {
        // Skip generating/expanding this base key because explicit expanded forms exist.
        continue
      }
    }

    // If this is a base plural key (no explicit suffix) and the locale is NOT the primary,
    // expand it into locale-specific plural variants (e.g. key_one, key_other).
    // Use the extracted defaultValue (fallback to base) for variant values.
    if (hasCount && !isExpandedPlural) {
      const parts = String(key).split(pluralSeparator)
      const isBaseKey = parts.length === 1
      if (isBaseKey && locale !== primaryLanguage) {
        // If explicit expanded variants exist, do not expand the base.
        const base = key
        if (expandedBases.has(base)) {
          // Skip expansion when explicit variants were provided
        } else {
          // choose categories based on ordinal flag
          const categories = isOrdinal ? ordinalCategories : cardinalCategories
          for (const category of categories) {
            const finalKey = isOrdinal
              ? `${base}${pluralSeparator}ordinal${pluralSeparator}${category}`
              : `${base}${pluralSeparator}${category}`

            // If the key looks like a serialized Trans component (starts with <), treat it as a flat key
            // to prevent splitting on dots that appear within the content.
            const separator = finalKey.startsWith('<') ? false : (keySeparator ?? '.')

            // Preserve existing translation if present; otherwise set a sensible default
            const existingVariantValue = getNestedValue(existingTranslations, finalKey, separator)
            if (existingVariantValue === undefined) {
              // Prefer explicit defaultValue extracted for this key; fall back to configured defaultValue
              // (resolved via resolveDefaultValue which handles functions or strings and accepts the full parameter set).
              let resolvedValue: string
              if (typeof defaultValue === 'string') {
                resolvedValue = defaultValue
              } else {
                // Use resolveDefaultValue to compute a sensible default, providing namespace and locale context.
                resolvedValue = resolveDefaultValue(emptyDefaultValue, String(base), namespace || config?.extract?.defaultNS || 'translation', locale, defaultValue)
              }
              setNestedValue(newTranslations, finalKey, resolvedValue, separator)
            } else {
              // Keep existing translation
              setNestedValue(newTranslations, finalKey, existingVariantValue, separator)
            }
          }
        }
        // We've expanded variants for this base key; skip the normal single-key handling.
        continue
      }
    }

    // If the key looks like a serialized Trans component (starts with <), treat it as a flat key
    let separator = key.startsWith('<') ? false : (keySeparator ?? '.')

    if (separator && typeof separator === 'string') {
      if (!looksLikeObjectPath(key, separator, naturalLanguageRegex)) {
        separator = false
      }
    }

    const existingValue = getNestedValue(existingTranslations, key, separator)
    // When keySeparator === false we are working with flat keys (no nesting).
    // Avoid concatenating false into strings (``${key}${false}`` => "keyfalse") which breaks the startsWith check.
    // For flat keys there cannot be nested children, so treat them as leaves.
    const isLeafInNewKeys = keySeparator === false
      ? true
      : !filteredKeys.some(otherKey => otherKey.key !== key && otherKey.key.startsWith(`${key}${keySeparator}`))

    // Determine if we should preserve an existing object
    const shouldPreserveObject = typeof existingValue === 'object' && existingValue !== null && (
      objectKeys.has(key) || // Explicit returnObjects
      !defaultValue || defaultValue === key // No explicit default or default equals key
    )

    const isStaleObject = typeof existingValue === 'object' && existingValue !== null && isLeafInNewKeys && !objectKeys.has(key) && !shouldPreserveObject

    // Special handling for existing objects that should be preserved
    if (shouldPreserveObject) {
      setNestedValue(newTranslations, key, existingValue, separator)
      continue
    }

    let valueToSet: string

    if (existingValue === undefined || isStaleObject) {
      if (locale === primaryLanguage) {
        if (syncPrimaryWithDefaults) {
          // use the unified "derived" detector (includes keyPrefix suffixes).
          const isDerivedDefault = isDerivedFromKey(key, defaultValue, explicitDefault)

          valueToSet =
            (defaultValue && !isDerivedDefault)
              ? (defaultValue as any)
              : resolveDefaultValue(
                emptyDefaultValue,
                key,
                namespace || config?.extract?.defaultNS || 'translation',
                locale,
                defaultValue as any
              )
        } else {
          // If there's no real code-provided default (defaultValue is derived fallback),
          // use the configured extract.defaultValue for PRIMARY language too.
          const derived = isDerivedFromKey(key, defaultValue, explicitDefault)
          if (derived && configuredDefaultValue !== undefined) {
            valueToSet = resolveDefaultValue(configuredDefaultValue as any, key, namespace || config?.extract?.defaultNS || 'translation', locale, defaultValue)
          } else {
            valueToSet = (defaultValue as any) || key
          }
        }
      } else {
        // For secondary languages, always use empty string
        valueToSet = resolveDefaultValue(emptyDefaultValue, key, namespace || config?.extract?.defaultNS || 'translation', locale, defaultValue)
      }
    } else {
      // Existing value exists - decide whether to preserve, sync primary, or clear other locales when requested
      if (locale === primaryLanguage && syncPrimaryWithDefaults) {
        // Only update when we have a meaningful defaultValue that's not derived from the key pattern.
        const isDerivedDefault = defaultValue && (
          defaultValue === key || // Exact match with the key itself
            // Check if defaultValue matches the namespaced key format (namespace:key)
            (nsSep && namespace && defaultValue === `${namespace}${nsSep}${key}`) ||
            // For variant keys (plural/context), check if defaultValue is the base
            (key !== defaultValue &&
            (key.startsWith(defaultValue + pluralSeparator) ||
              key.startsWith(defaultValue + contextSeparator)))
        )

        // If this key looks like a plural/context variant and the default
        // wasn't explicitly provided in source code, preserve the existing value.
        const isVariantKey = key.includes(pluralSeparator) || key.includes(contextSeparator)
        if (isVariantKey && !explicitDefault) {
          valueToSet = existingValue
        } else if (defaultValue && !isDerivedDefault) {
          valueToSet = resolveDefaultValue(
            defaultValue as any,
            key,
            namespace || config?.extract?.defaultNS || 'translation',
            locale,
            defaultValue as any
          )
        } else {
          valueToSet = existingValue
        }
      } else {
        // Non-primary locale behavior
        if (syncAll && locale !== primaryLanguage && explicitDefault) {
          // When syncAll is requested, clear (reset) any existing translations for keys
          // that had explicit defaults in code so the primary default can be propagated
          // while secondary locales get a blank/placeholder value.
          valueToSet = resolveDefaultValue(emptyDefaultValue, key, namespace || config?.extract?.defaultNS || 'translation', locale, defaultValue)
        } else {
          // Preserve existing translation by default
          valueToSet = existingValue
        }
      }
    }

    setNestedValue(newTranslations, key, valueToSet, separator)
  }

  // 2. If sorting is enabled, recursively sort the entire object.
  // This correctly handles both top-level and nested keys.
  if (sort === true) {
    return sortObject(newTranslations, config)
  }
  // Custom sort function logic remains as a future enhancement if needed,
  // but for now, this robustly handles the most common `sort: true` case.
  if (typeof sort === 'function') {
    const sortedObject: Record<string, any> = {}
    const topLevelKeys = Object.keys(newTranslations)

    // Create a map from key string to ExtractedKey for lookup
    const keyMap = new Map<string, ExtractedKey>()
    for (const extractedKey of nsKeys) {
      // Store the full key path
      keyMap.set(String(extractedKey.key), extractedKey)

      // For nested keys, also store the top-level part
      if (keySeparator) {
        const topLevelKey = String(extractedKey.key).split(keySeparator)[0]
        if (!keyMap.has(topLevelKey)) {
          keyMap.set(topLevelKey, extractedKey)
        }
      }
    }

    // Create a string comparator that applies the same logic as the custom sort function
    // by extracting the actual comparison behavior
    const stringSort = (a: string, b: string) => {
      // Try to find ExtractedKey objects to use the custom comparator
      const keyA = keyMap.get(a)
      const keyB = keyMap.get(b)

      if (keyA && keyB) {
        return sort(keyA, keyB)
      }

      // If we don't have ExtractedKey objects, we need to apply the same sorting logic
      // Create mock ExtractedKey objects with just the key property
      const mockKeyA = { key: a } as ExtractedKey
      const mockKeyB = { key: b } as ExtractedKey

      return sort(mockKeyA, mockKeyB)
    }

    // Sort top-level keys
    topLevelKeys.sort(stringSort)

    // Pass the same string comparator to sortObject for nested keys
    for (const key of topLevelKeys) {
      sortedObject[key] = sortObject(newTranslations[key], config, stringSort)
    }
    newTranslations = sortedObject
  }

  return newTranslations
}

/**
 * Processes extracted translation keys and generates translation files for all configured locales.
 *
 * This function:
 * 1. Groups keys by namespace
 * 2. For each locale and namespace combination:
 * - Reads existing translation files
 * - Preserves keys matching `preservePatterns` and those from `objectKeys`
 * - Merges in newly extracted keys
 * - Uses primary language defaults or empty strings for secondary languages
 * - Maintains key sorting based on configuration
 * 3. Determines if files need updating by comparing content
 *
 * @param keys - Map of extracted translation keys with metadata.
 * @param objectKeys - A set of base keys that were called with the `returnObjects: true` option.
 * @param config - The i18next toolkit configuration object.
 * @returns Promise resolving to array of translation results with update status.
 *
 * @example
 * ```typescript
 * const keys = new Map([
 * ['translation:welcome', { key: 'welcome', defaultValue: 'Welcome!', ns: 'translation' }],
 * ]);
 * const objectKeys = new Set(['countries']);
 *
 * const results = await getTranslations(keys, objectKeys, config);
 * // Results contain update status and new/existing translations for each locale.
 * ```
 */
export async function getTranslations (
  keys: Map<string, ExtractedKey>,
  objectKeys: Set<string>,
  config: I18nextToolkitConfig,
  {
    syncPrimaryWithDefaults = false,
    syncAll = false
  }: {
    syncPrimaryWithDefaults?: boolean,
    syncAll?: boolean
  } = {}
): Promise<TranslationResult[]> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)
  const patternsToPreserve = [...(config.extract.preservePatterns || [])]
  const indentation = config.extract.indentation ?? 2

  for (const key of objectKeys) {
    // Convert the object key to a glob pattern to preserve all its children
    patternsToPreserve.push(`${key}.*`)
  }
  const preservePatterns = patternsToPreserve.map(globToRegex)

  // Group keys by namespace. If the plugin recorded the namespace as implicit
  // (nsIsImplicit) AND the user set defaultNS === false we treat those keys
  // as "no namespace" (will be merged at top-level). Otherwise use the stored
  // namespace (internally we keep implicit keys as 'translation').
  const NO_NS_TOKEN = '__no_namespace__'
  const keysByNS = new Map<string, ExtractedKey[]>()

  const nsSep = typeof config.extract.nsSeparator === 'string' ? config.extract.nsSeparator : ':'
  const nsNaturalLanguageRegex = new RegExp(`(${chars.map((c) => (c === '?' ? '\\?' : c)).join('|')})`)

  for (const k of keys.values()) {
    let ns = k.ns
    let key = k.key

    // Fix for incorrect splitting of natural language keys containing nsSeparator
    // If the namespace contains spaces or looks like natural language, assume it was split incorrectly
    // and rejoin it with the key.
    if (ns && nsNaturalLanguageRegex.test(ns)) {
      key = `${ns}${nsSep}${key}`
      ns = undefined
    }

    const nsKey = (k.nsIsImplicit && config.extract.defaultNS === false)
      ? NO_NS_TOKEN
      : String(ns ?? (config.extract.defaultNS ?? 'translation'))
    if (!keysByNS.has(nsKey)) keysByNS.set(nsKey, [])

    if (ns !== k.ns || key !== k.key) {
      keysByNS.get(nsKey)!.push({ ...k, ns, key })
    } else {
      keysByNS.get(nsKey)!.push(k)
    }
  }

  // Filter out ignored namespaces
  const ignoreNamespaces = new Set(config.extract.ignoreNamespaces ?? [])
  for (const ns of ignoreNamespaces) {
    keysByNS.delete(ns)
  }

  const results: TranslationResult[] = []
  const userIgnore = Array.isArray(config.extract.ignore)
    ? config.extract.ignore
    : config.extract.ignore ? [config.extract.ignore] : []

  // Process each locale one by one
  for (const locale of config.locales) {
    // If output is a string we can detect the presence of the namespace placeholder.
    // If it's a function we cannot reliably detect that here — default to not merged
    // unless mergeNamespaces is explicitly true.
    const shouldMerge = config.extract.mergeNamespaces || (typeof config.extract.output === 'string' ? !config.extract.output.includes('{{namespace}}') : false)

    // LOGIC PATH 1: Merged Namespaces
    if (shouldMerge) {
      const newMergedTranslations: Record<string, any> = {}
      const outputPath = getOutputPath(config.extract.output, locale)
      const fullPath = resolve(process.cwd(), outputPath)
      const existingMergedFile = await loadTranslationFile(fullPath) || {}

      // Determine whether the existing merged file already uses namespace objects
      // or is a flat mapping of translation keys -> values.
      // If it's flat (values are primitives), we must NOT treat each translation key as a namespace.
      const existingKeys = Object.keys(existingMergedFile)
      // Treat the file as namespaced only when the user is using namespaces.
      // If defaultNS === false the project stores translations at the top-level
      // (possibly as nested objects when keySeparator is '.'), which should NOT
      // be interpreted as "namespaced files". This avoids splitting a single
      // merged translations file into artificial namespace buckets on re-extract.
      const existingIsNamespaced = (config.extract.defaultNS !== false) && existingKeys.some(k => {
        const v = (existingMergedFile as any)[k]
        return typeof v === 'object' && v !== null && !Array.isArray(v)
      })

      // The namespaces to process:
      // - If existing file is namespaced, combine keysByNS with existingMergedFile namespaces.
      // - If existing file is flat (top-level translations), ensure NO_NS_TOKEN is processed.
      const namespacesToProcess = existingIsNamespaced
        ? new Set<string>([...keysByNS.keys(), ...existingKeys])
        : new Set<string>([...keysByNS.keys(), NO_NS_TOKEN])

      for (const nsKey of namespacesToProcess) {
        const nsKeys = keysByNS.get(nsKey) || []
        if (nsKey === NO_NS_TOKEN) {
          // keys without namespace -> merged into top-level of the merged file
          const built = buildNewTranslationsForNs(nsKeys, existingMergedFile, config, locale, undefined, preservePatterns, objectKeys, syncPrimaryWithDefaults)
          Object.assign(newMergedTranslations, built)
        } else {
          const existingTranslations = existingMergedFile[nsKey] || {}
          newMergedTranslations[nsKey] = buildNewTranslationsForNs(nsKeys, existingTranslations, config, locale, nsKey, preservePatterns, objectKeys, syncPrimaryWithDefaults)
        }
      }

      const oldContent = JSON.stringify(existingMergedFile, null, indentation)
      const newContent = JSON.stringify(newMergedTranslations, null, indentation)
      // Push a single result for the merged file
      results.push({ path: fullPath, updated: newContent !== oldContent, newTranslations: newMergedTranslations, existingTranslations: existingMergedFile })

    // LOGIC PATH 2: Separate Namespace Files
    } else {
      // Find all namespaces that exist on disk for this locale
      const namespacesToProcess = new Set(keysByNS.keys())
      const existingNsPattern = getOutputPath(config.extract.output, locale, '*')
      // Ensure glob receives POSIX-style separators so pattern matching works cross-platform (Windows -> backslashes)
      const existingNsGlobPattern = existingNsPattern.replace(/\\/g, '/')
      const existingNsFiles = await glob(existingNsGlobPattern, { ignore: userIgnore })
      for (const file of existingNsFiles) {
        namespacesToProcess.add(basename(file, extname(file)))
      }

      // Process each namespace individually and create a result for each one
      for (const ns of namespacesToProcess) {
        const nsKeys = keysByNS.get(ns) || []
        const outputPath = getOutputPath(config.extract.output, locale, ns)
        const fullPath = resolve(process.cwd(), outputPath)
        const existingTranslations = await loadTranslationFile(fullPath) || {}
        const newTranslations = buildNewTranslationsForNs(nsKeys, existingTranslations, config, locale, ns, preservePatterns, objectKeys, syncPrimaryWithDefaults, syncAll)

        const oldContent = JSON.stringify(existingTranslations, null, indentation)
        const newContent = JSON.stringify(newTranslations, null, indentation)
        // Push one result per namespace file
        results.push({ path: fullPath, updated: newContent !== oldContent, newTranslations, existingTranslations })
      }
    }
  }

  return results
}
