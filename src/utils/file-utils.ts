import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
  namespace: string
): string {
  return template
    .replace('{{language}}', locale).replace('{{lng}}', locale)
    .replace('{{namespace}}', namespace).replace('{{ns}}', namespace)
}
