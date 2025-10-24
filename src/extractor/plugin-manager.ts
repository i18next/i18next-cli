import type { ExtractedKey, PluginContext, I18nextToolkitConfig, Logger, Plugin } from '../types'

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
export function createPluginContext (allKeys: Map<string, ExtractedKey>, plugins: Plugin[], config: Omit<I18nextToolkitConfig, 'plugins'>, logger: Logger): PluginContext {
  const pluginContextConfig = Object.freeze({
    ...config,
    plugins: [...plugins],
  })

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

        // If existing value is a generic fallback and new value is specific, replace it
        if (isExistingGenericFallback && !isNewGenericFallback) {
          allKeys.set(uniqueKey, { ...keyInfo, ns: storedNs || config.extract?.defaultNS || 'translation', nsIsImplicit, defaultValue })
        }
        // Otherwise keep the existing one
      } else {
        // New key, just add it
        allKeys.set(uniqueKey, { ...keyInfo, ns: storedNs || config.extract?.defaultNS || 'translation', nsIsImplicit, defaultValue })
      }
    },
    config: pluginContextConfig,
    logger,
    // This will be attached later, so we provide a placeholder
    getVarFromScope: () => undefined,
  }
}
