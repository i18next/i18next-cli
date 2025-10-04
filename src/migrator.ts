import { resolve } from 'node:path'
import { writeFile, access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { getTsConfigAliases } from './config'

/**
 * Path where the new configuration file will be created
 */
const newConfigPath = resolve(process.cwd(), 'i18next.config.ts')

/**
 * List of possible new configuration file names that would prevent migration
 */
const POSSIBLE_NEW_CONFIGS = [
  'i18next.config.ts',
  'i18next.config.js',
  'i18next.config.mjs',
  'i18next.config.cjs',
]

/**
 * List of supported legacy configuration file extensions
 */
const LEGACY_CONFIG_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts']

/**
 * Helper function to find a legacy config file with various extensions
 */
async function findLegacyConfigFile (basePath: string): Promise<string | null> {
  // If the provided path already has an extension, use it directly
  if (LEGACY_CONFIG_EXTENSIONS.some(ext => basePath.endsWith(ext))) {
    try {
      await access(basePath)
      return basePath
    } catch {
      return null
    }
  }

  // Try different extensions
  for (const ext of LEGACY_CONFIG_EXTENSIONS) {
    const fullPath = `${basePath}${ext}`
    try {
      await access(fullPath)
      return fullPath
    } catch {
      // Continue to next extension
    }
  }

  return null
}

/**
 * Loads a legacy config file using the appropriate loader (jiti for TS, dynamic import for JS/MJS/CJS)
 */
async function loadLegacyConfig (configPath: string): Promise<any> {
  try {
    let config: any

    // Use jiti for TypeScript files, native import for JavaScript
    if (configPath.endsWith('.ts')) {
      const aliases = await getTsConfigAliases()
      const jiti = createJiti(process.cwd(), {
        alias: aliases,
        interopDefault: false,
      })

      const configModule = await jiti.import(configPath, { default: true })
      config = configModule
    } else {
      const configUrl = pathToFileURL(configPath).href
      const configModule = await import(`${configUrl}?t=${Date.now()}`)
      config = configModule.default
    }

    return config
  } catch (error) {
    console.error(`Error loading legacy config from ${configPath}:`, error)
    return null
  }
}

/**
 * Migrates a legacy i18next-parser configuration file to the new
 * i18next-cli configuration format.
 *
 * This function:
 * 1. Checks if a legacy config file exists (supports .js, .mjs, .cjs, .ts)
 * 2. Prevents migration if any new config file already exists
 * 3. Dynamically imports the old configuration using appropriate loader
 * 4. Maps old configuration properties to new format:
 *    - `$LOCALE` → `{{language}}`
 *    - `$NAMESPACE` → `{{namespace}}`
 *    - Maps lexer functions and components
 *    - Creates sensible defaults for new features
 * 5. Generates a new TypeScript configuration file
 * 6. Provides warnings for deprecated features
 *
 * @param customConfigPath - Optional custom path to the legacy config file
 *
 * @example
 * ```bash
 * # Migrate default config
 * npx i18next-cli migrate-config
 *
 * # Migrate custom config with extension
 * npx i18next-cli migrate-config i18next-parser.config.mjs
 *
 * # Migrate custom config without extension (will try .js, .mjs, .cjs, .ts)
 * npx i18next-cli migrate-config my-custom-config
 * ```
 */
export async function runMigrator (customConfigPath?: string) {
  let oldConfigPath: string | null

  if (customConfigPath) {
    oldConfigPath = await findLegacyConfigFile(resolve(process.cwd(), customConfigPath))
    if (!oldConfigPath) {
      console.log(`No legacy config file found at or near: ${customConfigPath}`)
      console.log('Tried extensions: .js, .mjs, .cjs, .ts')
      return
    }
  } else {
    // Default behavior: look for i18next-parser.config.* files
    oldConfigPath = await findLegacyConfigFile(resolve(process.cwd(), 'i18next-parser.config'))
    if (!oldConfigPath) {
      console.log('No i18next-parser.config.* found. Nothing to migrate.')
      console.log('Tried: i18next-parser.config.js, .mjs, .cjs, .ts')
      return
    }
  }

  console.log(`Attempting to migrate legacy config from: ${oldConfigPath}...`)

  // Check if ANY new config file already exists
  for (const configFile of POSSIBLE_NEW_CONFIGS) {
    try {
      const fullPath = resolve(process.cwd(), configFile)
      await access(fullPath)
      console.warn(`Warning: A new configuration file already exists at "${configFile}". Migration skipped to avoid overwriting.`)
      return
    } catch (e) {
      // File doesn't exist, which is good
    }
  }

  // Load the legacy config using the appropriate loader
  const oldConfig = await loadLegacyConfig(oldConfigPath)

  if (!oldConfig) {
    console.error('Could not read the legacy config file.')
    return
  }

  // --- Start Migration Logic ---
  const newConfig = {
    locales: oldConfig.locales || ['en'],
    extract: {
      input: oldConfig.input || 'src/**/*.{js,jsx,ts,tsx}',
      output: (oldConfig.output || 'locales/$LOCALE/$NAMESPACE.json')
        .replace('$LOCALE', '{{language}}')
        .replace('$NAMESPACE', '{{namespace}}'),
      defaultNS: oldConfig.defaultNamespace || 'translation',
      keySeparator: oldConfig.keySeparator,
      nsSeparator: oldConfig.namespaceSeparator,
      contextSeparator: oldConfig.contextSeparator,
      // A simple mapping for functions
      functions: oldConfig.lexers?.js?.functions || ['t', '*.t'],
      transComponents: oldConfig.lexers?.js?.components || ['Trans'],
    },
    types: {
      input: ['locales/{{language}}/{{namespace}}.json'], // Sensible default
      output: 'src/types/i18next.d.ts', // Sensible default
    },
  }

  // Make the migration smarter: if 't' is a function, also add the '*.t' wildcard
  // to provide better out-of-the-box support for common patterns like `i18n.t`.
  if (newConfig.extract.functions.includes('t') && !newConfig.extract.functions.includes('*.t')) {
    newConfig.extract.functions.push('*.t')
  }
  // --- End Migration Logic ---

  // Generate the new file content as a string
  const newConfigFileContent = `
import { defineConfig } from 'i18next-cli';

export default defineConfig(${JSON.stringify(newConfig, null, 2)});
`

  await writeFile(newConfigPath, newConfigFileContent.trim())

  console.log('✅ Success! Migration complete.')
  console.log(`New configuration file created at: ${newConfigPath}`)
  console.warn('\nPlease review the generated file and adjust paths for "types.input" if necessary.')

  // Warning for deprecated features
  if (oldConfig.keepRemoved) {
    console.warn('Warning: The "keepRemoved" option is deprecated. Consider using the "preservePatterns" feature for dynamic keys.')
  }

  // Warning for compatibilityJSON v3
  if (oldConfig.i18nextOptions?.compatibilityJSON === 'v3') {
    console.warn('Warning: compatibilityJSON "v3" is not supported in i18next-cli. Only i18next v4 format is supported.')
  }
}
