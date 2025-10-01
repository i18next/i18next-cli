import type { PluginContext, I18nextToolkitConfig } from '../../types'

/**
 * Extracts translation keys from comments in source code using regex patterns.
 * Supports extraction from single-line (//) and multi-line comments.
 *
 * @param code - The source code to analyze
 * @param functionNames - Array of function names to look for (e.g., ['t', 'i18n.t'])
 * @param pluginContext - Context object with helper methods to add found keys
 * @param config - Configuration object containing extraction settings
 *
 * @example
 * ```typescript
 * const code = `
 *   // t('user.name', 'User Name')
 *   /* t('app.title', { defaultValue: 'My App', ns: 'common' }) *\/
 * `
 *
 * const context = createPluginContext(allKeys)
 * extractKeysFromComments(code, ['t'], context, config)
 * // Extracts: user.name and app.title with their respective settings
 * ```
 */
export function extractKeysFromComments (
  code: string,
  pluginContext: PluginContext,
  config: I18nextToolkitConfig
): void {
  // Hardcode the function name to 't' to prevent parsing other functions like 'test()'.
  const functionNameToFind = 't'

  // Use a reliable word boundary (\b) to match 't(...)' but not 'http.get(...)'.
  const keyRegex = new RegExp(`\\b${functionNameToFind}\\s*\\(\\s*(['"])([^'"]+)\\1`, 'g')

  const commentTexts = collectCommentTexts(code)

  for (const text of commentTexts) {
    let match: RegExpExecArray | null
    while ((match = keyRegex.exec(text)) !== null) {
      let key = match[2]
      let ns: string | undefined
      const remainder = text.slice(match.index + match[0].length)

      const defaultValue = parseDefaultValueFromComment(remainder)
      // 1. Check for namespace in options object first (e.g., { ns: 'common' })
      ns = parseNsFromComment(remainder)

      // 2. If not in options, check for separator in key (e.g., 'common:button.save')
      const nsSeparator = config.extract.nsSeparator ?? ':'
      if (!ns && nsSeparator && key.includes(nsSeparator)) {
        const parts = key.split(nsSeparator)
        ns = parts.shift()
        key = parts.join(nsSeparator)
      }
      if (!ns) ns = config.extract.defaultNS

      pluginContext.addKey({ key, ns, defaultValue: defaultValue ?? key })
    }
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
