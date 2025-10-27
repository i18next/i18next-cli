import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { access, readFile } from 'node:fs/promises'
import { createJiti } from 'jiti'
import { parse } from 'jsonc-parser'
import inquirer from 'inquirer'
import chalk from 'chalk'
import type { I18nextToolkitConfig, Logger } from './types'
import { runInit } from './init'
import { ConsoleLogger } from './utils/logger'

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
 * A helper function for defining the i18next-cli config with type-safety.
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
async function findConfigFile (configPath?: string): Promise<string | null> {
  if (configPath) {
    // Allow relative or absolute path provided by the user
    const resolved = resolve(process.cwd(), configPath)
    try {
      await access(resolved)
      return resolved
    } catch {
      return null
    }
  }

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
 * Loads and validates the i18next toolkit configuration from the project root or a provided path.
 *
 * @param configPath - Optional explicit path to a config file (relative to cwd or absolute)
 * @param logger - Optional logger instance
 */
export async function loadConfig (configPath?: string, logger: Logger = new ConsoleLogger()): Promise<I18nextToolkitConfig | null> {
  const configPathFound = await findConfigFile(configPath)

  if (!configPathFound) {
    if (configPath) {
      logger.error(`Error: Config file not found at "${configPath}"`)
    }
    // QUIETLY RETURN NULL: The caller will handle the "not found" case.
    return null
  }

  try {
    let config: any

    // Use jiti for TypeScript files, native import for JavaScript
    if (configPathFound.endsWith('.ts')) {
      const aliases = await getTsConfigAliases()
      const jiti = createJiti(process.cwd(), {
        alias: aliases,
        interopDefault: false,
      })

      const configModule = await jiti.import(configPathFound, { default: true })
      config = configModule
    } else {
      const configUrl = pathToFileURL(configPathFound).href
      const configModule = await import(`${configUrl}?t=${Date.now()}`)
      config = configModule.default
    }

    if (!config) {
      logger.error(`Error: No default export found in ${configPathFound}`)
      return null
    }

    // Set default sync options
    config.extract ||= {}
    config.extract.primaryLanguage ||= config.locales[0] || 'en'
    config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config.extract.primaryLanguage)

    return config
  } catch (error) {
    logger.error(`Error loading configuration from ${configPathFound}`)
    logger.error(error)
    return null
  }
}

/**
 * Ensures a configuration exists, prompting the user to create one if necessary.
 * Accepts an optional configPath which will be used when loading the config.
 */
export async function ensureConfig (configPath?: string, logger: Logger = new ConsoleLogger()): Promise<I18nextToolkitConfig> {
  let config = await loadConfig(configPath, logger)

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
    await runInit() // Run the interactive setup wizard (keeps existing behavior)
    logger.info(chalk.green('Configuration created. Resuming command...'))
    config = await loadConfig(configPath, logger) // Try loading the newly created config

    if (config) {
      return config
    } else {
      logger.error(chalk.red('Error: Failed to load configuration after creation. Please try running the command again.'))
      process.exit(1)
    }
  } else {
    logger.info('Operation cancelled. Please create a configuration file to proceed.')
    process.exit(0)
  }
}

/**
 * Searches upwards from the current directory to find the tsconfig.json file.
 * @returns The full path to the tsconfig.json file, or null if not found.
 */
async function findTsConfigFile (): Promise<string | null> {
  let currentDir = process.cwd()
  while (true) {
    const tsConfigPath = join(currentDir, 'tsconfig.json')
    try {
      await access(tsConfigPath)
      return tsConfigPath
    } catch {
      // File not found, move to parent directory
      const parentDir = dirname(currentDir)
      if (parentDir === currentDir) {
        // Reached the root of the file system
        return null
      }
      currentDir = parentDir
    }
  }
}

/**
 * Parses the project's tsconfig.json to extract path aliases for jiti.
 * @returns A record of aliases for jiti's configuration.
 */
export async function getTsConfigAliases (): Promise<Record<string, string>> {
  try {
    const tsConfigPath = await findTsConfigFile()
    if (!tsConfigPath) return {}

    const tsConfigStr = await readFile(tsConfigPath, 'utf-8')
    const tsConfig = parse(tsConfigStr)
    const paths = tsConfig.compilerOptions?.paths
    const baseUrl = tsConfig.compilerOptions?.baseUrl || '.'
    if (!paths) return {}

    const aliases: Record<string, string> = {}
    for (const [alias, aliasPaths] of Object.entries(paths as Record<string, string[]>)) {
      if (Array.isArray(aliasPaths) && aliasPaths.length > 0) {
        // Convert "@/*": ["./src/*"] to "@": "./src"
        const key = alias.replace('/*', '')
        const value = resolve(process.cwd(), baseUrl, aliasPaths[0].replace('/*', ''))
        aliases[key] = value
      }
    }
    return aliases
  } catch (e) {
    // Return empty if tsconfig doesn't exist or fails to parse
    return {}
  }
}
