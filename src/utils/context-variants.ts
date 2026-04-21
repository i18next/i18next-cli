/**
 * Helpers for reasoning about context variants of translation keys.
 *
 * A "key accepting context" is a base key that was called with a `context`
 * option in source code (e.g. `t('friend', { context: gender })`). Its
 * variants in the translation file look like `<base><contextSeparator><ctx>`
 * (optionally suffixed with a CLDR plural form).
 */

const pluralForms = ['zero', 'one', 'two', 'few', 'many', 'other']

/**
 * Checks if an existing key is a context variant of a base key that accepts context.
 * Handles:
 * - Keys suffixed with a CLDR plural form (e.g. `friend_male_one`).
 * - Context values that contain the separator (e.g. `mc_laren`).
 *
 * @param existingKey - The key from the translation file to check
 * @param keysAcceptingContext - Set of base keys that were used with context in source code
 * @param pluralSeparator - The separator used for plural forms (default: '_')
 * @param contextSeparator - The separator used for context variants (default: '_')
 * @returns true if the existing key is a context variant of a key accepting context
 */
export function isContextVariantOfAcceptingKey (
  existingKey: string,
  keysAcceptingContext: ReadonlySet<string>,
  pluralSeparator: string,
  contextSeparator: string
): boolean {
  if (keysAcceptingContext.size === 0) {
    return false
  }

  let potentialBaseKey = existingKey

  // First, try removing plural suffixes if present
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

  // The context value itself may contain the separator — try every possible
  // split to find a base that matches an accepting-context key.
  const parts = potentialBaseKey.split(contextSeparator)
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const baseWithoutContext = parts.slice(0, -i).join(contextSeparator)
      if (keysAcceptingContext.has(baseWithoutContext)) {
        return true
      }
    }
  }

  // Also accept the plural-stripped key itself as a direct match
  // (e.g. `friend_other` → base `friend`).
  if (keysAcceptingContext.has(potentialBaseKey)) {
    return true
  }

  return false
}
