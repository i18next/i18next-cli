import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { createJiti } from 'jiti'
import type { I18nextToolkitConfig } from '../types'
import { getTsConfigAliases } from '../config'

/**
 * Ensures that the directory for a given file path exists.
 * Creates all necessary parent directories recursively if they don't exist.
 *
 * @param filePath - The file path for which to ensure the directory exists
 *
 * @example
 * ```typescript
 * await ensureDirectoryExists('/path/to/nested/file.json')
 * // Creates /path/to/nested/ directory if it doesn't exist
 * ```
 */
export async function ensureDirectoryExists (filePath: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
}

/**
 * Reads a file asynchronously and returns its content as a UTF-8 string.
 *
 * @param filePath - The path to the file to read
 * @returns Promise resolving to the file content as a string
 *
 * @example
 * ```typescript
 * const content = await readFileAsync('./config.json')
 * const config = JSON.parse(content)
 * ```
 */
export async function readFileAsync (filePath: string): Promise<string> {
  return await readFile(filePath, 'utf-8')
}

/**
 * Writes data to a file asynchronously.
 *
 * @param filePath - The path where to write the file
 * @param data - The string data to write to the file
 *
 * @example
 * ```typescript
 * const jsonData = JSON.stringify({ key: 'value' }, null, 2)
 * await writeFileAsync('./output.json', jsonData)
 * ```
 */
export async function writeFileAsync (filePath: string, data: string): Promise<void> {
  await writeFile(filePath, data)
}

/**
 * Generates a file path by replacing template placeholders with actual values.
 * Supports both legacy and modern placeholder formats for language and namespace.
 *
 * @param template - The template string containing placeholders
 * @param locale - The locale/language code to substitute
 * @param namespace - The namespace to substitute
 * @returns The resolved file path with placeholders replaced
 *
 * @example
 * ```typescript
 * // Modern format
 * getOutputPath('locales/{{language}}/{{namespace}}.json', 'de', 'validation')
 * // Returns: 'locales/de/validation.json'
 *
 * // Legacy format (also supported)
 * getOutputPath('locales/{{lng}}/{{ns}}.json', 'en', 'common')
 * // Returns: 'locales/en/common.json'
 * ```
 */
export function getOutputPath (
  template: string,
  locale: string,
  namespace: string = ''
): string {
  return template
    .replace('{{language}}', locale).replace('{{lng}}', locale)
    .replace('{{namespace}}', namespace).replace('{{ns}}', namespace)
}

/**
 * Dynamically loads a translation file, supporting .json, .js, and .ts formats.
 * @param filePath - The path to the translation file.
 * @returns The parsed content of the file, or null if not found or failed to parse.
 */
export async function loadTranslationFile (filePath: string): Promise<Record<string, any> | null> {
  const fullPath = resolve(process.cwd(), filePath)
  try {
    await access(fullPath)
  } catch {
    return null // File doesn't exist
  }

  try {
    const ext = extname(fullPath).toLowerCase()

    if (ext === '.json') {
      const content = await readFile(fullPath, 'utf-8')
      return JSON.parse(content)
    } else if (ext === '.ts' || ext === '.js') {
      // Load TypeScript path aliases for proper module resolution
      const aliases = await getTsConfigAliases()

      const jiti = createJiti(process.cwd(), {
        alias: aliases,
        interopDefault: true,
      })

      const module = await jiti.import(fullPath, { default: true }) as unknown
      return module as Record<string, any> | null
    }

    return null // Unsupported file type
  } catch (error) {
    console.warn(`Could not parse translation file ${filePath}:`, error)
    return null
  }
}

/**
 * Serializes a translation object into a string based on the desired format.
 * @param data - The translation data object.
 * @param format - The desired output format ('json', 'js-esm', etc.).
 * @param indentation - The number of spaces for indentation.
 * @returns The serialized file content as a string.
 */
export function serializeTranslationFile (
  data: Record<string, any>,
  format: I18nextToolkitConfig['extract']['outputFormat'] = 'json',
  indentation: number | string = 2
): string {
  const jsonString = JSON.stringify(data, null, indentation)

  switch (format) {
    case 'js':
    case 'js-esm':
      return `export default ${jsonString};\n`
    case 'js-cjs':
      return `module.exports = ${jsonString};\n`
    case 'ts':
      // Using `as const` provides better type inference for TypeScript users
      return `export default ${jsonString} as const;\n`
    case 'json':
    default:
      return `${jsonString}\n`
  }
}
