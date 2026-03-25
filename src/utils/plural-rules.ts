/**
 * Creates an Intl.PluralRules instance, falling back to English ('en')
 * if the given locale is not a valid BCP 47 language tag.
 *
 * This allows projects to use custom locale codes (e.g. 'E', 'F')
 * that are not recognized by the Intl API.
 */
export function safePluralRules (locale: string, options?: Intl.PluralRulesOptions): Intl.PluralRules {
  try {
    return new Intl.PluralRules(locale, options)
  } catch {
    return new Intl.PluralRules('en', options)
  }
}
