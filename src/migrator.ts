import { resolve } from 'node:path'
import { writeFile, access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { getJitiAliases } from './config.js'

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
      const aliases = await getJitiAliases()
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
 * Collects a list option (`functions`, `componentFunctions`, `namespaceFunctions`) from every
 * lexer entry of an i18next-parser config. Lexers are arrays per extension, and each entry is
 * either a lexer name ('JsxLexer'), a custom lexer (class or function) or an options object.
 */
function collectLexerOption (lexers: any, option: string): string[] {
  const found = new Set<string>()
  if (!lexers || typeof lexers !== 'object') return []
  for (const entries of Object.values(lexers)) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const values = entry && typeof entry === 'object' ? (entry as any)[option] : undefined
      if (Array.isArray(values)) {
        for (const value of values) if (typeof value === 'string') found.add(value)
      }
    }
  }
  return [...found]
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
  const lexerFunctions = collectLexerOption(oldConfig.lexers, 'functions')
  const lexerComponents = collectLexerOption(oldConfig.lexers, 'componentFunctions')
  const lexerHooks = collectLexerOption(oldConfig.lexers, 'namespaceFunctions')

  const newConfig = {
    locales: oldConfig.locales || ['en'],
    extract: {
      input: oldConfig.input || 'src/**/*.{js,jsx,mjs,ts,tsx}',
      output: (oldConfig.output || 'locales/$LOCALE/$NAMESPACE.json')
        .replace('$LOCALE', '{{language}}')
        .replace('$NAMESPACE', '{{namespace}}'),
      defaultNS: oldConfig.defaultNamespace || 'translation',
      keySeparator: oldConfig.keySeparator,
      nsSeparator: oldConfig.namespaceSeparator,
      contextSeparator: oldConfig.contextSeparator,
      // `pluralSeparator: false` means "do not generate plural keys" in i18next-parser
      pluralSeparator: oldConfig.pluralSeparator === false ? undefined : oldConfig.pluralSeparator,
      disablePlurals: oldConfig.pluralSeparator === false ? true : undefined,
      indentation: oldConfig.indentation,
      // i18next-parser keeps the keys that are no longer in the code with `keepRemoved: true` or
      // a pattern list; i18next-cli removes them by default
      removeUnusedKeys: oldConfig.keepRemoved === true || Array.isArray(oldConfig.keepRemoved) ? false : undefined,
      // i18next-parser never sorts unless asked to; i18next-cli sorts by default
      sort: oldConfig.sort === true,
      functions: lexerFunctions.length > 0 ? lexerFunctions : ['t', '*.t'],
      transComponents: lexerComponents.length > 0 ? lexerComponents : ['Trans'],
      useTranslationNames: lexerHooks.length > 0 ? lexerHooks : undefined,
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

  // Warnings for options that have no equivalent
  if (Array.isArray(oldConfig.keepRemoved)) {
    console.warn(`Warning: "keepRemoved" is a list of patterns (${oldConfig.keepRemoved.map(String).join(', ')}). It was migrated to "removeUnusedKeys: false"; convert the patterns to "extract.preservePatterns" (globs, not regexes) to keep only those keys.`)
  }
  if (oldConfig.customValueTemplate) {
    console.warn('Warning: "customValueTemplate" is not supported in i18next-cli and was not migrated.')
  }
  if (oldConfig.resetDefaultValueLocale) {
    console.warn('Warning: "resetDefaultValueLocale" is not supported in i18next-cli and was not migrated.')
  }
  if (typeof oldConfig.defaultValue === 'function') {
    console.warn('Warning: a function "defaultValue" is not supported in i18next-cli and was not migrated.')
  }
  if (oldConfig.failOnUpdate) {
    console.warn('Warning: "failOnUpdate" is not supported in i18next-cli. Use "extract --ci" instead.')
  }
  // i18next-parser creates the _old catalogs unless this is set to false
  if (oldConfig.createOldCatalogs !== false) {
    console.warn('Warning: "createOldCatalogs" is not supported in i18next-cli: no "_old" catalogs are written, and existing "_old" files get emptied.')
  }

  // Warning for compatibilityJSON v3
  if (oldConfig.i18nextOptions?.compatibilityJSON === 'v3') {
    console.warn('Warning: compatibilityJSON "v3" is not supported in i18next-cli. Only i18next v4 format is supported.')
  }
}
