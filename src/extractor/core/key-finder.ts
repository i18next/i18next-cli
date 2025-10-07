import { glob } from 'glob'
import type { Expression } from '@swc/core'
import type { ExtractedKey, Logger, I18nextToolkitConfig, ASTVisitorHooks } from '../../types'
import { processFile } from './extractor'
import { ConsoleLogger } from '../../utils/logger'
import { initializePlugins, createPluginContext } from '../plugin-manager'
import { ASTVisitors } from './ast-visitors'

/**
 * Main function for finding translation keys across all source files in a project.
 *
 * This function orchestrates the key extraction process:
 * 1. Processes source files based on input patterns
 * 2. Initializes and manages plugins
 * 3. Processes each file through AST parsing and key extraction
 * 4. Runs plugin lifecycle hooks
 * 5. Returns a deduplicated map of all found keys
 *
 * @param config - The i18next toolkit configuration object
 * @param logger - Logger instance for output (defaults to ConsoleLogger)
 * @returns Promise resolving to a Map of unique translation keys with metadata
 *
 * @example
 * ```typescript
 * const config = {
 *   extract: {
 *     input: ['src/**\/*.{ts,tsx}'],
 *     functions: ['t', '*.t'],
 *     transComponents: ['Trans']
 *   }
 * }
 *
 * const keys = await findKeys(config)
 * console.log(`Found ${keys.size} unique translation keys`)
 * ```
 */
export async function findKeys (
  config: I18nextToolkitConfig,
  logger: Logger = new ConsoleLogger()
): Promise<{ allKeys: Map<string, ExtractedKey>, objectKeys: Set<string> }> {
  const { plugins: pluginsOrUndefined, ...otherConfig } = config
  const plugins = pluginsOrUndefined || []

  const sourceFiles = await processSourceFiles(config)
  const allKeys = new Map<string, ExtractedKey>()

  // 1. Create the base context with config and logger.
  const pluginContext = createPluginContext(allKeys, plugins, otherConfig, logger)

  // 2. Create hooks for plugins to hook into AST
  const hooks = {
    onBeforeVisitNode: (node) => {
      for (const plugin of plugins) {
        try {
          plugin.onVisitNode?.(node, pluginContext)
        } catch (err) {
          logger.warn(`Plugin ${plugin.name} onVisitNode failed:`, err)
        }
      }
    },
    resolvePossibleKeyStringValues: (expression: Expression) => {
      return plugins.flatMap(plugin => {
        try {
          return plugin.extractKeysFromExpression?.(expression, config, logger) ?? []
        } catch (err) {
          logger.warn(`Plugin ${plugin.name} extractKeysFromExpression failed:`, err)
          return []
        }
      })
    },
    resolvePossibleContextStringValues: (expression: Expression) => {
      return plugins.flatMap(plugin => {
        try {
          return plugin.extractContextFromExpression?.(expression, config, logger) ?? []
        } catch (err) {
          logger.warn(`Plugin ${plugin.name} extractContextFromExpression failed:`, err)
          return []
        }
      })
    },
  } satisfies ASTVisitorHooks

  // 3. Create the visitor instance, passing it the context.
  const astVisitors = new ASTVisitors(otherConfig, pluginContext, logger, hooks)

  // 4. "Wire up" the visitor's scope method to the context.
  // This avoids a circular dependency while giving plugins access to the scope.
  pluginContext.getVarFromScope = astVisitors.getVarFromScope.bind(astVisitors)

  // 5. Initialize plugins
  await initializePlugins(plugins)

  // 6. Process each file
  for (const file of sourceFiles) {
    await processFile(file, plugins, astVisitors, pluginContext, otherConfig, logger)
  }

  // 7. Run onEnd hooks
  for (const plugin of plugins) {
    await plugin.onEnd?.(allKeys)
  }

  return { allKeys, objectKeys: astVisitors.objectKeys }
}

/**
 * Processes source files using glob patterns from configuration.
 * Excludes node_modules by default and resolves relative to current working directory.
 *
 * @param config - The i18next toolkit configuration object
 * @returns Promise resolving to array of file paths to process
 *
 * @internal
 */
async function processSourceFiles (config: I18nextToolkitConfig): Promise<string[]> {
  const defaultIgnore = ['node_modules/**']

  // Normalize the user's ignore option into an array
  const userIgnore = Array.isArray(config.extract.ignore)
    ? config.extract.ignore
    : config.extract.ignore ? [config.extract.ignore] : []

  return await glob(config.extract.input, {
    // Combine default ignore patterns with user-configured ones
    ignore: [...defaultIgnore, ...userIgnore],
    cwd: process.cwd(),
  })
}
