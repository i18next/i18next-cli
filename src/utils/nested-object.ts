/**
 * Sets a nested value in an object using a key path and separator.
 * Creates intermediate objects as needed.
 *
 * @param obj - The target object to modify
 * @param path - The key path (e.g., 'user.profile.name')
 * @param value - The value to set
 * @param keySeparator - The separator to use for splitting the path, or false for flat keys
 *
 * @example
 * ```typescript
 * const obj = {}
 * setNestedValue(obj, 'user.profile.name', 'John', '.')
 * // Result: { user: { profile: { name: 'John' } } }
 *
 * // With flat keys
 * setNestedValue(obj, 'user.name', 'Jane', false)
 * // Result: { 'user.name': 'Jane' }
 * ```
 */
export function setNestedValue (
  obj: Record<string, any>,
  path: string,
  value: any,
  keySeparator: string | false
): void {
  if (keySeparator === false) {
    obj[path] = value
    return
  }

  const keys = path.split(keySeparator)
  let current = obj

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const isLastKey = i === keys.length - 1

    if (isLastKey) {
      // We've reached the end of the path, set the value.
      current[key] = value
      return
    }

    const nextLevel = current[key]

    // Check for a conflict: the path requires an object, but a primitive exists.
    if (nextLevel !== undefined && (typeof nextLevel !== 'object' || nextLevel === null)) {
      // Conflict detected. The parent path is already a leaf node.
      // We must set the entire original path as a flat key on the root object.
      obj[path] = value
      return // Stop processing to prevent overwriting the parent.
    }

    // If the path doesn't exist, create an empty object to continue.
    if (nextLevel === undefined) {
      current[key] = {}
    }

    current = current[key]
  }
}

/**
 * Retrieves a nested value from an object using a key path and separator.
 *
 * @param obj - The object to search in
 * @param path - The key path (e.g., 'user.profile.name')
 * @param keySeparator - The separator to use for splitting the path, or false for flat keys
 * @returns The found value or undefined if not found
 *
 * @example
 * ```typescript
 * const obj = { user: { profile: { name: 'John' } } }
 * const name = getNestedValue(obj, 'user.profile.name', '.')
 * // Returns: 'John'
 *
 * // With flat keys
 * const flatObj = { 'user.name': 'Jane' }
 * const name = getNestedValue(flatObj, 'user.name', false)
 * // Returns: 'Jane'
 * ```
 */
export function getNestedValue (
  obj: Record<string, any>,
  path: string,
  keySeparator: string | false
): any {
  if (keySeparator === false) {
    return obj[path]
  }
  return path.split(keySeparator).reduce((acc, key) => acc && acc[key], obj)
}

/**
 * Extracts all nested keys from an object, optionally with a prefix.
 * Recursively traverses the object structure to build a flat list of key paths.
 *
 * @param obj - The object to extract keys from
 * @param keySeparator - The separator to use for joining keys, or false for flat keys
 * @param prefix - Optional prefix to prepend to all keys
 * @returns Array of all nested key paths
 *
 * @example
 * ```typescript
 * const obj = {
 *   user: {
 *     profile: { name: 'John', age: 30 },
 *     settings: { theme: 'dark' }
 *   }
 * }
 *
 * const keys = getNestedKeys(obj, '.')
 * // Returns: ['user.profile.name', 'user.profile.age', 'user.settings.theme']
 *
 * // With flat keys
 * const flatObj = { 'user.name': 'Jane', 'user.age': 25 }
 * const flatKeys = getNestedKeys(flatObj, false)
 * // Returns: ['user.name', 'user.age']
 * ```
 */
export function getNestedKeys (obj: object, keySeparator: string | false, prefix = ''): string[] {
  if (keySeparator === false) {
    return Object.keys(obj)
  }
  return Object.entries(obj).reduce((acc, [key, value]) => {
    const newKey = prefix ? `${prefix}${keySeparator}${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      acc.push(...getNestedKeys(value, keySeparator, newKey))
    } else {
      acc.push(newKey)
    }
    return acc
  }, [] as string[])
}
