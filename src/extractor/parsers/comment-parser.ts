import type { PluginContext, I18nextToolkitConfig } from '../../types'

/**
 * Extracts translation keys from comments in source code using regex patterns.
 * Supports extraction from single-line (//) and multi-line comments.
 *
 * @param code - The source code to analyze
 * @param pluginContext - Context object with helper methods to add found keys
 * @param config - Configuration object containing extraction settings
 * @param scopeResolver - Function to resolve scope information for variables (optional)
 *
 * @example
 * ```typescript
 * const code = `
 *   // t('user.name', 'User Name')
 *   /* t('app.title', { defaultValue: 'My App', ns: 'common' }) *\/
 * `
 *
 * const context = createPluginContext(allKeys)
 * extractKeysFromComments(code, context, config, scopeResolver)
 * // Extracts: user.name and app.title with their respective settings
 * ```
 */
export function extractKeysFromComments (
  code: string,
  pluginContext: PluginContext,
  config: I18nextToolkitConfig,
  scopeResolver?: (varName: string) => { defaultNs?: string; keyPrefix?: string } | undefined
): void {
  // Hardcode the function name to 't' to prevent parsing other functions like 'test()'.
  const functionNameToFind = 't'

  // Use a reliable word boundary (\b) to match 't(...)' but not 'http.get(...)'.
  const keyRegex = new RegExp(`\\b${functionNameToFind}\\s*\\(\\s*(['"])([^'"]+)\\1`, 'g')

  // Prepare preservePatterns for filtering
  const preservePatterns = (config.extract.preservePatterns || []).map(globToRegex)

  const commentTexts = collectCommentTexts(code)

  for (const text of commentTexts) {
    let match: RegExpExecArray | null
    while ((match = keyRegex.exec(text)) !== null) {
      let key = match[2]

      // Validate that the key is not empty or whitespace-only
      if (!key || key.trim() === '') {
        continue // Skip empty keys
      }

      // Check if key matches preservePatterns and should be excluded from extraction
      if (preservePatterns.some(re => re.test(key))) {
        continue // Skip keys that match preserve patterns
      }

      let ns: string | false | undefined
      const remainder = text.slice(match.index + match[0].length)

      const defaultValue = parseDefaultValueFromComment(remainder)
      const context = parseContextFromComment(remainder)
      const count = parseCountFromComment(remainder)
      const ordinal = parseOrdinalFromComment(remainder)

      // Check if key ends with _ordinal suffix (like in ast-visitors)
      let isOrdinalByKey = false
      const pluralSeparator = config.extract.pluralSeparator ?? '_'
      if (key.endsWith(`${pluralSeparator}ordinal`)) {
        isOrdinalByKey = true
        // Normalize the key by stripping the suffix
        key = key.slice(0, -(pluralSeparator.length + 7)) // Remove "_ordinal"

        // Validate that the key is still not empty after normalization
        if (!key || key.trim() === '') {
          continue // Skip keys that become empty after normalization
        }

        // Re-check preservePatterns after key normalization
        if (preservePatterns.some(re => re.test(key))) {
          continue // Skip normalized keys that match preserve patterns
        }
      }

      const isOrdinal = ordinal === true || isOrdinalByKey

      // 1. Check for namespace in options object first (e.g., { ns: 'common' })
      ns = parseNsFromComment(remainder)

      // 2. If not in options, check for separator in key (e.g., 'common:button.save')
      const nsSeparator = config.extract.nsSeparator ?? ':'
      if (!ns && nsSeparator && key.includes(nsSeparator)) {
        const parts = key.split(nsSeparator)
        ns = parts.shift()
        key = parts.join(nsSeparator)

        // Validate that the key didn't become empty after namespace removal
        if (!key || key.trim() === '') {
          continue // Skip keys that become empty after namespace removal
        }

        // Re-check preservePatterns after namespace processing
        if (preservePatterns.some(re => re.test(key))) {
          continue // Skip processed keys that match preserve patterns
        }
      }

      // 3. If no explicit namespace found, try to resolve from scope
      // This allows commented t() calls to inherit namespace from useTranslation scope
      if (!ns && scopeResolver) {
        const scopeInfo = scopeResolver('t')
        if (scopeInfo?.defaultNs) {
          ns = scopeInfo.defaultNs
        }
      }

      // 4. Final fallback to configured default namespace
      if (!ns) ns = config.extract.defaultNS

      // 5. Handle context and count combinations based on disablePlurals setting
      if (config.extract.disablePlurals) {
        // When plurals are disabled, ignore count for key generation
        if (context) {
          // Only generate context variants (no base key when context is static)
          pluginContext.addKey({ key: `${key}_${context}`, ns, defaultValue: defaultValue ?? key })
        } else {
          // Simple key (ignore count)
          pluginContext.addKey({ key, ns, defaultValue: defaultValue ?? key })
        }
      } else {
        // Original plural handling logic when plurals are enabled
        if (context && count) {
          // Generate context+plural combinations
          generateContextPluralKeys(key, defaultValue ?? key, ns, context, pluginContext, config, isOrdinal)

          // Only generate base plural forms if generateBasePluralForms is not disabled
          const shouldGenerateBaseForms = config.extract?.generateBasePluralForms !== false
          if (shouldGenerateBaseForms) {
            generatePluralKeys(key, defaultValue ?? key, ns, pluginContext, config, isOrdinal)
          }
        } else if (context) {
          // Just context variants
          pluginContext.addKey({ key, ns, defaultValue: defaultValue ?? key })
          pluginContext.addKey({ key: `${key}_${context}`, ns, defaultValue: defaultValue ?? key })
        } else if (count) {
          // Just plural variants
          generatePluralKeys(key, defaultValue ?? key, ns, pluginContext, config, isOrdinal)
        } else {
          // Simple key
          pluginContext.addKey({ key, ns, defaultValue: defaultValue ?? key })
        }
      }
    }
  }
}

/**
 * Generates plural keys for a given base key
 */
function generatePluralKeys (
  key: string,
  defaultValue: string,
  ns: string | false | undefined,
  pluginContext: PluginContext,
  config: I18nextToolkitConfig,
  isOrdinal = false
): void {
  try {
    const type = isOrdinal ? 'ordinal' : 'cardinal'

    // Generate plural forms for ALL target languages to ensure we have all necessary keys
    const allPluralCategories = new Set<string>()

    for (const locale of config.locales) {
      try {
        const pluralRules = new Intl.PluralRules(locale, { type })
        const categories = pluralRules.resolvedOptions().pluralCategories
        categories.forEach(cat => allPluralCategories.add(cat))
      } catch (e) {
        // If a locale is invalid, fall back to English rules
        const englishRules = new Intl.PluralRules('en', { type })
        const categories = englishRules.resolvedOptions().pluralCategories
        categories.forEach(cat => allPluralCategories.add(cat))
      }
    }

    const pluralCategories = Array.from(allPluralCategories).sort()
    const pluralSeparator = config.extract.pluralSeparator ?? '_'

    // Generate keys for each plural category
    for (const category of pluralCategories) {
      const finalKey = isOrdinal
        ? `${key}${pluralSeparator}ordinal${pluralSeparator}${category}`
        : `${key}${pluralSeparator}${category}`

      pluginContext.addKey({
        key: finalKey,
        ns,
        defaultValue,
        hasCount: true,
        isOrdinal
      })
    }
  } catch (e) {
    // Fallback if Intl API fails
    pluginContext.addKey({ key, ns, defaultValue })
  }
}

/**
 * Generates context + plural combination keys
 */
function generateContextPluralKeys (
  key: string,
  defaultValue: string,
  ns: string | false | undefined,
  context: string,
  pluginContext: PluginContext,
  config: I18nextToolkitConfig,
  isOrdinal = false
): void {
  try {
    const type = isOrdinal ? 'ordinal' : 'cardinal'

    // Generate plural forms for ALL target languages to ensure we have all necessary keys
    const allPluralCategories = new Set<string>()

    for (const locale of config.locales) {
      try {
        const pluralRules = new Intl.PluralRules(locale, { type })
        const categories = pluralRules.resolvedOptions().pluralCategories
        categories.forEach(cat => allPluralCategories.add(cat))
      } catch (e) {
        // If a locale is invalid, fall back to English rules
        const englishRules = new Intl.PluralRules(config.extract.primaryLanguage || 'en', { type })
        const categories = englishRules.resolvedOptions().pluralCategories
        categories.forEach(cat => allPluralCategories.add(cat))
      }
    }

    const pluralCategories = Array.from(allPluralCategories).sort()
    const pluralSeparator = config.extract.pluralSeparator ?? '_'

    // Generate keys for each context + plural combination
    for (const category of pluralCategories) {
      const finalKey = isOrdinal
        ? `${key}_${context}${pluralSeparator}ordinal${pluralSeparator}${category}`
        : `${key}_${context}${pluralSeparator}${category}`

      pluginContext.addKey({
        key: finalKey,
        ns,
        defaultValue,
        hasCount: true,
        isOrdinal
      })
    }
  } catch (e) {
    // Fallback if Intl API fails
    pluginContext.addKey({ key: `${key}_${context}`, ns, defaultValue })
  }
}

/**
 * Parses default value from the remainder of a comment after a translation function call.
 * Supports both string literals and object syntax with defaultValue property.
 *
 * @param remainder - The remaining text after the translation key
 * @returns The parsed default value or undefined if none found
 *
 * @internal
 */
function parseDefaultValueFromComment (remainder: string): string | undefined {
  // Simple string default: , 'VALUE' or , "VALUE"
  const dvString = /^\s*,\s*(['"])(.*?)\1/.exec(remainder)
  if (dvString) return dvString[2]

  // Object with defaultValue: , { defaultValue: 'VALUE', ... }
  const dvObj = /^\s*,\s*\{[^}]*defaultValue\s*:\s*(['"])(.*?)\1/.exec(remainder)
  if (dvObj) return dvObj[2]

  return undefined
}

/**
 * Parses namespace from the remainder of a comment after a translation function call.
 * Looks for namespace specified in options object syntax.
 *
 * @param remainder - The remaining text after the translation key
 * @returns The parsed namespace or undefined if none found
 *
 * @internal
 */
function parseNsFromComment (remainder: string): string | undefined {
  // Look for ns in an options object, e.g., { ns: 'common' }
  const nsObj = /^\s*,\s*\{[^}]*ns\s*:\s*(['"])(.*?)\1/.exec(remainder)
  if (nsObj) return nsObj[2]

  return undefined
}

/**
 * Collects all comment texts from source code, both single-line and multi-line.
 * Deduplicates comments to avoid processing the same text multiple times.
 *
 * @param src - The source code to extract comments from
 * @returns Array of unique comment text content
 *
 * @internal
 */
function collectCommentTexts (src: string): string[] {
  const texts: string[] = []
  const seen = new Set<string>()

  const commentRegex = /\/\/(.*)|\/\*([\s\S]*?)\*\//g
  let cmatch: RegExpExecArray | null
  while ((cmatch = commentRegex.exec(src)) !== null) {
    const content = cmatch[1] ?? cmatch[2]
    const s = content.trim()
    if (s && !seen.has(s)) {
      seen.add(s)
      texts.push(s)
    }
  }

  return texts
}

/**
 * Parses context from the remainder of a comment after a translation function call.
 * Looks for context specified in options object syntax.
 *
 * @param remainder - The remaining text after the translation key
 * @returns The parsed context value or undefined if none found
 *
 * @internal
 */
function parseContextFromComment (remainder: string): string | undefined {
  // Look for context in an options object, e.g., { context: 'male' }
  const contextObj = /^\s*,\s*\{[^}]*context\s*:\s*(['"])(.*?)\1/.exec(remainder)
  if (contextObj) return contextObj[2]

  return undefined
}

/**
 * Parses count from the remainder of a comment after a translation function call.
 * Looks for count specified in options object syntax.
 *
 * @param remainder - The remaining text after the translation key
 * @returns The parsed count value or undefined if none found
 *
 * @internal
 */
function parseCountFromComment (remainder: string): number | undefined {
  // Look for count in an options object, e.g., { count: 1 }
  const countObj = /^\s*,\s*\{[^}]*count\s*:\s*(\d+)/.exec(remainder)
  if (countObj) return parseInt(countObj[1], 10)

  return undefined
}

/**
 * Parses ordinal flag from the remainder of a comment after a translation function call.
 * Looks for ordinal specified in options object syntax.
 *
 * @param remainder - The remaining text after the translation key
 * @returns The parsed ordinal value or undefined if none found
 *
 * @internal
 */
function parseOrdinalFromComment (remainder: string): boolean | undefined {
  // Look for ordinal in an options object, e.g., { ordinal: true }
  const ordinalObj = /^\s*,\s*\{[^}]*ordinal\s*:\s*(true|false)/.exec(remainder)
  if (ordinalObj) return ordinalObj[1] === 'true'

  return undefined
}

/**
 * Converts a glob pattern to a regular expression.
 * Supports basic glob patterns with * wildcards.
 *
 * @param glob - The glob pattern to convert
 * @returns A RegExp that matches the glob pattern
 *
 * @internal
 */
function globToRegex (glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexString = `^${escaped.replace(/\*/g, '.*')}$`
  return new RegExp(regexString)
}
