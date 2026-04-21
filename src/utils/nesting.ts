/**
 * Shared parser for i18next-style nested translation references of the form
 * `$t(key, { options })`.
 *
 * Used in two places:
 * 1. The extractor's AST pass scans source-code keys and default values for
 *    nested references and registers the referenced keys (so they show up in
 *    output translation files).
 * 2. The translation-manager uses it during `removeUnusedKeys` cleanup so
 *    keys that are only referenced from inside a translation value (and thus
 *    invisible to the AST pass) are preserved instead of being deleted.
 */

const naturalLanguageChars = /[ ,?!;]/
const looksLikeNaturalLanguage = (s: string) => naturalLanguageChars.test(s)

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface NestingConfig {
  nestingPrefix?: string
  nestingSuffix?: string
  nestingOptionsSeparator?: string
  nsSeparator?: string | false | null
  defaultNS?: string | false
}

export interface NestedReference {
  /** The referenced key (namespace-stripped when a namespace was resolved). */
  key: string
  /** Resolved namespace for the reference (or defaultNS / undefined). */
  ns: string | false | undefined
  /** True when the nested options object contains a `count` property. */
  hasCount: boolean
  /** Static context string, if the nested options contain `context: 'foo'`. */
  context?: string
}

/**
 * Scans a string for `$t(...)` references and returns metadata about each one.
 * The implementation mirrors the behaviour of i18next's Interpolator so that
 * the extractor and translation manager agree on what counts as a reference.
 */
export function parseNestedReferences (text: string, config: NestingConfig): NestedReference[] {
  if (!text || typeof text !== 'string') return []

  const prefix = config.nestingPrefix ?? '$t('
  const suffix = config.nestingSuffix ?? ')'
  const separator = config.nestingOptionsSeparator ?? ','
  const nsSeparator = config.nsSeparator ?? ':'

  const escapedPrefix = escapeRegex(prefix)
  const escapedSuffix = escapeRegex(suffix)

  // Regex adapted from i18next Interpolator.js — matches `$t(key)` or
  // `$t(key, { options })` with (limited) support for balanced parens and
  // quoted strings.
  const nestingRegexp = new RegExp(
    `${escapedPrefix}((?:[^()"']+|"[^"]*"|'[^']*'|\\((?:[^()]|"[^"]*"|'[^']*')*\\))*?)${escapedSuffix}`,
    'g'
  )

  const results: NestedReference[] = []
  let match: RegExpExecArray | null
  while ((match = nestingRegexp.exec(text)) !== null) {
    const content = match[1]
    if (!content) continue

    let key = content
    let optionsString = ''

    if (content.indexOf(separator) < 0) {
      key = content.trim()
    } else {
      // i18next does: const c = key.split(new RegExp(`${sep}[ ]*{`));
      // This assumes options start with `{`.
      const sepRegex = new RegExp(`${escapeRegex(separator)}[ ]*{`)
      const parts = content.split(sepRegex)

      if (parts.length > 1) {
        key = parts[0].trim()
        optionsString = `{${parts.slice(1).join(separator + ' {')}`
      } else {
        const sepIdx = content.indexOf(separator)
        key = content.substring(0, sepIdx).trim()
        optionsString = content.substring(sepIdx + 1).trim()
      }
    }

    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1)
    }

    if (!key) continue

    let ns: string | false | undefined
    if (nsSeparator && typeof nsSeparator === 'string' && key.includes(nsSeparator)) {
      const parts = key.split(nsSeparator)
      const candidateNs = parts[0]
      if (!looksLikeNaturalLanguage(candidateNs)) {
        ns = parts.shift()
        key = parts.join(nsSeparator)
        if (!key || key.trim() === '') continue
      } else {
        ns = config.defaultNS
      }
    } else {
      ns = config.defaultNS
    }

    let hasCount = false
    let context: string | undefined

    if (optionsString) {
      if (/['"]?count['"]?\s*:/.test(optionsString)) {
        hasCount = true
      }
      const contextMatch = /['"]?context['"]?\s*:\s*(['"])(.*?)\1/.exec(optionsString)
      if (contextMatch) {
        context = contextMatch[2]
      }
    }

    results.push({ key, ns, hasCount, context })
  }

  return results
}
