/**
 * Resolves the default value for a missing key in secondary languages.
 * Supports both string and function-based default values.
 *
 * @param defaultValue - The configured default value (string or function)
 * @param key - The translation key
 * @param namespace - The namespace for the key
 * @param language - The target language
 * @returns The resolved default value
 *
 * @example
 * ```typescript
 * // String-based default value
 * const result1 = resolveDefaultValue('[MISSING]', 'user.name', 'common', 'de', 'Alice')
 * // Returns: '[MISSING]'
 *
 * // Function-based default value
 * const defaultValueFn = (key, ns, lang) => `${lang.toUpperCase()}_${ns}_${key}`
 * const result2 = resolveDefaultValue(defaultValueFn, 'user.name', 'common', 'de', 'Alice')
 * // Returns: 'DE_common_user.name_Alice'
 *
 * // Error handling - function throws
 * const errorFn = () => { throw new Error('Oops') }
 * const result3 = resolveDefaultValue(errorFn, 'user.name', 'common', 'de', 'Alice')
 * // Returns: '' (fallback to empty string)
 * ```
 */
export function resolveDefaultValue (
  defaultValue: string | ((key: string, namespace: string, language: string, value: string) => string) | undefined,
  key: string,
  namespace: string,
  language: string,
  value?: string
): string {
  if (typeof defaultValue === 'function') {
    try {
      return defaultValue(key, namespace, language, value || key)
    } catch (error) {
      // If the function throws an error, fall back to empty string
      return ''
    }
  }

  return defaultValue || ''
}
