import { resolve } from 'node:path'
import { writeFile, access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * Path to the legacy i18next-parser configuration file
 */
const oldConfigPath = resolve(process.cwd(), 'i18next-parser.config.js')

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
 * Migrates a legacy i18next-parser.config.js configuration file to the new
 * i18next-toolkit configuration format.
 *
 * This function:
 * 1. Checks if a legacy config file exists
 * 2. Prevents migration if any new config file already exists
 * 3. Dynamically imports the old configuration
 * 4. Maps old configuration properties to new format:
 *    - `$LOCALE` → `{{language}}`
 *    - `$NAMESPACE` → `{{namespace}}`
 *    - Maps lexer functions and components
 *    - Creates sensible defaults for new features
 * 5. Generates a new TypeScript configuration file
 * 6. Provides warnings for deprecated features
 *
 * @example
 * ```typescript
 * // Legacy config (i18next-parser.config.js):
 * module.exports = {
 *   locales: ['en', 'de'],
 *   output: 'locales/$LOCALE/$NAMESPACE.json',
 *   input: ['src/**\/*.js']
 * }
 *
 * // After migration (i18next.config.ts):
 * export default defineConfig({
 *   locales: ['en', 'de'],
 *   extract: {
 *     input: ['src/**\/*.js'],
 *     output: 'locales/{{language}}/{{namespace}}.json'
 *   }
 * })
 * ```
 */
export async function runMigrator () {
  console.log('Attempting to migrate legacy i18next-parser.config.js...')

  try {
    await access(oldConfigPath)
  } catch (e) {
    console.log('No i18next-parser.config.js found. Nothing to migrate.')
    return
  }

  try {
    await access(oldConfigPath)
  } catch (e) {
    console.log('No i18next-parser.config.js found. Nothing to migrate.')
    return
  }

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

  // Dynamically import the CJS config file
  const oldConfigUrl = pathToFileURL(oldConfigPath).href
  const oldConfigModule = await import(oldConfigUrl)
  const oldConfig = oldConfigModule.default

  if (!oldConfig) {
    console.error('Could not read the legacy config file.')
    return
  }

  // --- Start Migration Logic ---
  const newConfig = {
    locales: oldConfig.locales || ['en'],
    extract: {
      input: oldConfig.input || 'src/**/*.{js,jsx,ts,tsx}',
      output: (oldConfig.output || 'locales/$LOCALE/$NAMESPACE.json').replace('$LOCALE', '{{language}}').replace('$NAMESPACE', '{{namespace}}'),
      defaultNS: oldConfig.defaultNamespace || 'translation',
      keySeparator: oldConfig.keySeparator,
      nsSeparator: oldConfig.namespaceSeparator,
      contextSeparator: oldConfig.contextSeparator,
      // A simple mapping for functions
      functions: oldConfig.lexers?.js?.functions || ['t'],
      transComponents: oldConfig.lexers?.js?.components || ['Trans'],
    },
    typesafe: {
      input: 'locales/{{language}}/{{namespace}}.json', // Sensible default
      output: 'src/types/i18next.d.ts', // Sensible default
    },
    sync: {
      primaryLanguage: oldConfig.locales?.[0] || 'en',
      secondaryLanguages: oldConfig.locales.filter((l: string) => l !== (oldConfig.locales?.[0] || 'en'))
    },
  }
  // --- End Migration Logic ---

  // Generate the new file content as a string
  const newConfigFileContent = `
import { defineConfig } from 'i18next-toolkit';

export default defineConfig(${JSON.stringify(newConfig, null, 2)});
`

  await writeFile(newConfigPath, newConfigFileContent.trim())

  console.log('✅ Success! Migration complete.')
  console.log(`New configuration file created at: ${newConfigPath}`)
  console.warn('\nPlease review the generated file and adjust paths for "typesafe.input" if necessary.')
  if (oldConfig.keepRemoved) {
    console.warn('Warning: The "keepRemoved" option is deprecated. Consider using the "preservePatterns" feature for dynamic keys.')
  }
}
