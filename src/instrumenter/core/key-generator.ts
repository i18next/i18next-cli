/**
 * Generates camelCase keys from English string content.
 *
 * Examples:
 *   "Welcome back" → "welcomeBack"
 *   "Hello, World!" → "helloWorld"
 *   "You have 3 items" → "youHave3Items"
 *
 * @param content - The string content to derive a key from
 * @returns camelCase key
 */
export function generateKeyFromContent (content: string): string {
  // Remove punctuation and split by whitespace and word boundaries
  const normalized = content
    .replace(/[^\w\s\d]/g, '') // Remove punctuation
    .trim()

  if (!normalized) {
    return 'key'
  }

  // Split on whitespace and camelCase
  const words = normalized.split(/\s+/)
  const camelCased = words
    .map((word, index) => {
      if (index === 0) {
        return word.toLowerCase()
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join('')

  // If result is empty, use fallback
  return camelCased.length > 0 ? camelCased : 'key'
}

/**
 * Interface for tracking generated keys and managing collisions
 */
export interface KeyRegistry {
  keys: Map<string, string> // key -> original content that generated it
  add (key: string, content: string): string // Returns the final key (may have suffix if collision)
}

/**
 * Creates a new key registry with collision detection.
 */
export function createKeyRegistry (): KeyRegistry {
  const keys = new Map<string, string>()

  return {
    keys,
    add (baseKey: string, content: string): string {
      const existing = keys.get(baseKey)

      // No collision - add the key
      if (!existing) {
        keys.set(baseKey, content)
        return baseKey
      }

      // Same content already exists - return the existing key
      if (existing === content) {
        return baseKey
      }

      // Collision detected - try with numeric suffixes
      let counter = 2
      let candidateKey = `${baseKey}${counter}`
      while (keys.has(candidateKey)) {
        const candidate = keys.get(candidateKey)
        if (candidate === content) {
          return candidateKey // This exact content already has a numbered key
        }
        counter++
        candidateKey = `${baseKey}${counter}`
      }

      keys.set(candidateKey, content)
      return candidateKey
    }
  }
}

/**
 * Sanitizes a generated key to be valid according to i18next conventions.
 * Removes invalid characters and ensures it's a valid JavaScript identifier
 * that can be used as an object key.
 */
export function sanitizeKey (key: string): string {
  // Remove any non-alphanumeric, non-dash, non-underscore, non-dot characters
  let sanitized = key.replace(/[^a-zA-Z0-9._-]/g, '')

  // Ensure it doesn't start with a number
  if (/^\d/.test(sanitized)) {
    sanitized = `_${sanitized}`
  }

  // If result is empty after sanitization, use fallback
  return sanitized.length > 0 ? sanitized : 'key'
}
