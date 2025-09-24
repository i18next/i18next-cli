import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'
import type { I18nextToolkitConfig } from './types'

/**
 * List of supported configuration file names in order of precedence
 */
const CONFIG_FILES = [
  'i18next.config.ts',
  'i18next.config.js',
  'i18next.config.mjs',
  'i18next.config.cjs',
]

/**
 * A helper function for defining the i18next-toolkit config with type-safety.
 *
 * @param config - The configuration object to define
 * @returns The same configuration object with type safety
 *
 * @example
 * ```typescript
 * export default defineConfig({
 *   locales: ['en', 'de'],
 *   extract: {
 *     input: 'src',
 *     output: 'locales/{{language}}/{{namespace}}.json'
 *   }
 * })
 * ```
 */
export function defineConfig (config: I18nextToolkitConfig): I18nextToolkitConfig {
  return config
}

/**
 * Helper function to find the first existing config file in the current working directory.
 * Searches for files in the order defined by CONFIG_FILES.
 *
 * @returns Promise that resolves to the full path of the found config file, or null if none found
 */
async function findConfigFile (): Promise<string | null> {
  for (const file of CONFIG_FILES) {
    const fullPath = resolve(process.cwd(), file)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      // File doesn't exist, continue to the next one
    }
  }
  return null
}

/**
 * Loads and validates the i18next toolkit configuration from the project root.
 *
 * This function:
 * 1. Searches for a config file using findConfigFile()
 * 2. Dynamically imports the config file using ESM import()
 * 3. Validates the configuration structure
 * 4. Sets default values for sync options
 * 5. Adds cache busting for watch mode
 *
 * @returns Promise that resolves to the loaded configuration object, or null if loading failed
 *
 * @example
 * ```typescript
 * const config = await loadConfig()
 * if (!config) {
 *   console.error('Failed to load configuration')
 *   process.exit(1)
 * }
 * ```
 */
export async function loadConfig (): Promise<I18nextToolkitConfig | null> {
  const configPath = await findConfigFile()

  if (!configPath) {
    console.error(`Error: Configuration file not found. Please create one of the following: ${CONFIG_FILES.join(', ')}`)
    return null
  }

  try {
    // Use pathToFileURL to ensure correct path resolution on all OSes for ESM
    const configUrl = pathToFileURL(configPath).href
    // Append a timestamp to bust the cache in watch mode
    const configModule = await import(`${configUrl}?t=${Date.now()}`)
    const config = configModule.default

    if (!config) {
      console.error(`Error: No default export found in ${configPath}`)
      return null
    }

    // Set default sync options
    if (!config.extract) config.extract = {}
    if (!config.extract.primaryLanguage) config.extract.primaryLanguage = config.locales[0] || 'en'
    if (!config.extract.secondaryLanguages) config.extract.secondaryLanguages = config.locales.filter((l: string) => l !== config.extract.primaryLanguage)

    return config
  } catch (error) {
    console.error(`Error loading configuration from ${configPath}`)
    console.error(error)
    return null
  }
}
