import { glob } from 'glob'
import type { ExtractedKey, Logger, I18nextToolkitConfig } from '../../types'
import { processFile } from './extractor'
import { ConsoleLogger } from '../../utils/logger'
import { initializePlugins } from '../plugin-manager'

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
 *     functions: ['t'],
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
): Promise<Map<string, ExtractedKey>> {
  const sourceFiles = await processSourceFiles(config)
  const allKeys = new Map<string, ExtractedKey>()

  await initializePlugins(config.plugins || [])

  for (const file of sourceFiles) {
    await processFile(file, config, logger, allKeys)
  }

  // Run onEnd hooks
  for (const plugin of (config.plugins || [])) {
    await plugin.onEnd?.(allKeys)
  }

  return allKeys
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
  return await glob(config.extract.input, {
    ignore: 'node_modules/**',
    cwd: process.cwd(),
  })
}
