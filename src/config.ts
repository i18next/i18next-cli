import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'
import { createJiti } from 'jiti'
import inquirer from 'inquirer'
import chalk from 'chalk'
import type { I18nextToolkitConfig } from './types'
import { runInit } from './init'

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
    // QUIETLY RETURN NULL: The caller will handle the "not found" case.
    return null
  }

  try {
    let config: any

    // Use jiti for TypeScript files, native import for JavaScript
    if (configPath.endsWith('.ts')) {
      const jiti = createJiti(import.meta.url)
      const configModule = await jiti.import(configPath, { default: true })
      config = configModule
    } else {
      const configUrl = pathToFileURL(configPath).href
      const configModule = await import(`${configUrl}?t=${Date.now()}`)
      config = configModule.default
    }

    if (!config) {
      console.error(`Error: No default export found in ${configPath}`)
      return null
    }

    // Set default sync options
    config.extract ||= {}
    config.extract.primaryLanguage ||= config.locales[0] || 'en'
    config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config.extract.primaryLanguage)

    return config
  } catch (error) {
    console.error(`Error loading configuration from ${configPath}`)
    console.error(error)
    return null
  }
}

/**
 * NEW: Ensures a configuration exists, prompting the user to create one if necessary.
 * This function is a wrapper around loadConfig that provides an interactive fallback.
 *
 * @returns A promise that resolves to a valid configuration object.
 * @throws Exits the process if the user declines to create a config or if loading fails after creation.
 */
export async function ensureConfig (): Promise<I18nextToolkitConfig> {
  let config = await loadConfig()

  if (config) {
    return config
  }

  // No config found, so we prompt the user.
  const { shouldInit } = await inquirer.prompt([{
    type: 'confirm',
    name: 'shouldInit',
    message: chalk.yellow('Configuration file not found. Would you like to create one now?'),
    default: true,
  }])

  if (shouldInit) {
    await runInit() // Run the interactive setup wizard
    console.log(chalk.green('Configuration created. Resuming command...'))
    config = await loadConfig() // Try loading the newly created config

    if (config) {
      return config
    } else {
      console.error(chalk.red('Error: Failed to load configuration after creation. Please try running the command again.'))
      process.exit(1)
    }
  } else {
    console.log('Operation cancelled. Please create a configuration file to proceed.')
    process.exit(0)
  }
}
