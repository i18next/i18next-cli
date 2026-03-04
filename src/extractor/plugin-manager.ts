import type { ExtractedKey, PluginContext, I18nextToolkitConfig, Logger, Plugin, ScopeInfo } from '../types'

/**
 * Error thrown when warnOnConflicts is set to 'error' and a key conflict is detected.
 * This error is intentionally not caught by the per-file error handler in the extractor.
 */
export class ConflictError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

/**
 * Initializes an array of plugins by calling their setup hooks.
 * This function should be called before starting the extraction process.
 *
 * @param plugins - Array of plugin objects to initialize
 *
 * @example
 * ```typescript
 * const plugins = [customPlugin(), anotherPlugin()]
 * await initializePlugins(plugins)
 * // All plugin setup hooks have been called
 * ```
 */
export async function initializePlugins (plugins: any[]): Promise<void> {
  for (const plugin of plugins) {
    await plugin.setup?.()
  }
}

/**
 * Creates a plugin context object that provides helper methods for plugins.
 * The context allows plugins to add extracted keys to the main collection.
 *
 * @param allKeys - The main map where extracted keys are stored
 * @returns A context object with helper methods for plugins
 *
 * @example
 * ```typescript
 * const allKeys = new Map()
 * const context = createPluginContext(allKeys)
 *
 * // Plugin can now add keys
 * context.addKey({
 *   key: 'my.custom.key',
 *   defaultValue: 'Default Value',
 *   ns: 'common'
 * })
 * ```
 */
export function createPluginContext (
  allKeys: Map<string, ExtractedKey>,
  plugins: Plugin[],
  config: Omit<I18nextToolkitConfig, 'plugins'>,
  logger: Logger
): PluginContext {
  const pluginContextConfig = Object.freeze({
    ...config,
    plugins: [...plugins],
  })

  // Internal tracker for warnOnConflicts — maps uniqueKey → first defaultValue
  const seenDefaults = new Map<string, string>()
  const warnOnConflicts = config.extract?.warnOnConflicts

  return {
    addKey: (keyInfo: ExtractedKey) => {
      // Normalize boolean `false` namespace -> undefined (meaning "no explicit ns")
      const explicitNs = keyInfo.ns === false ? undefined : keyInfo.ns
      // Internally prefer 'translation' as the logical namespace when none was specified.
      // Record whether the namespace was implicit so the output generator can
      // special-case config.extract.defaultNS === false.
      const storedNs = explicitNs ?? (config.extract?.defaultNS ?? 'translation')
      const nsIsImplicit = explicitNs === undefined
      const nsForKey = String(storedNs)

      const uniqueKey = `${nsForKey}:${keyInfo.key}`
      const defaultValue = keyInfo.defaultValue ?? keyInfo.key

      // Fire onKeySubmitted hook for every submission (before deduplication)
      const frozenKey: Readonly<ExtractedKey> = Object.freeze({
        ...keyInfo,
        ns: storedNs || config.extract?.defaultNS || 'translation',
        nsIsImplicit,
        defaultValue
      })
      for (const plugin of plugins) {
        try {
          plugin.onKeySubmitted?.(frozenKey)
        } catch (err) {
          logger.warn(`Plugin ${plugin.name} onKeySubmitted failed:`, err)
        }
      }

      // Built-in warnOnConflicts check
      if (warnOnConflicts) {
        // Skip generic fallbacks (defaultValue === key) — these are the normal
        // "override generic with specific" path handled by deduplication and
        // should not trigger a conflict warning.
        const isGenericFallback = defaultValue === keyInfo.key
        const prev = seenDefaults.get(uniqueKey)
        if (prev !== undefined && prev !== defaultValue && !isGenericFallback) {
          const msg =
            `Key "${uniqueKey}" has conflicting default values:\n` +
            `  "${prev}" (first seen)\n` +
            `  "${defaultValue}" (duplicate)`
          if (warnOnConflicts === 'error') {
            throw new ConflictError(msg)
          } else {
            logger.warn(msg)
          }
        }
        if (prev === undefined && !isGenericFallback) {
          seenDefaults.set(uniqueKey, defaultValue)
        }
      }

      // Check if key already exists
      const existingKey = allKeys.get(uniqueKey)

      if (existingKey) {
        // Check if existing value is a generic fallback
        // For plural keys, the fallback is often the base key (e.g., "item.count" for "item.count_other")
        // For regular keys, the fallback is the key itself
        const isExistingGenericFallback =
          existingKey.defaultValue === existingKey.key || // Regular key fallback
          (existingKey.hasCount && existingKey.defaultValue &&
            existingKey.key.includes('_') &&
            existingKey.key.startsWith(existingKey.defaultValue)) // Plural key with base key fallback

        const isNewGenericFallback = defaultValue === keyInfo.key

        // Merge locations
        if (keyInfo.locations) {
          existingKey.locations = [
            ...(existingKey.locations || []),
            ...keyInfo.locations
          ]
        }

        // If existing value is a generic fallback and new value is specific, replace it
        if (isExistingGenericFallback && !isNewGenericFallback) {
          allKeys.set(uniqueKey, {
            ...keyInfo,
            ns: storedNs || config.extract?.defaultNS || 'translation',
            nsIsImplicit,
            defaultValue,
            locations: existingKey.locations // Preserve merged locations
          })
        }
        // Otherwise keep the existing one
      } else {
        // New key, just add it
        allKeys.set(uniqueKey, {
          ...keyInfo,
          ns: storedNs || config.extract?.defaultNS || 'translation',
          nsIsImplicit,
          defaultValue
        })
      }
    },
    config: pluginContextConfig,
    logger,
    // This will be attached later, so we provide a placeholder
    getVarFromScope: () => undefined,
    // This will be attached later, so we provide a placeholder
    setVarInScope: (_name: string, _info: ScopeInfo) => undefined,
  }
}
