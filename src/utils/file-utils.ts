import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, extname, resolve, normalize } from 'node:path'
import { createJiti } from 'jiti'
import type { I18nextToolkitConfig } from '../types'
import { getTsConfigAliases } from '../config'
import { JsonParser, JsonObjectNode } from '@croct/json5-parser'

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
 * Resolve an output template (string or function) into an actual path string.
 *
 * - If `outputTemplate` is a function, call it with (language, namespace)
 * - If it's a string, replace placeholders:
 *    - {{language}} or {{lng}} -> language
 *    - {{namespace}} -> namespace (or removed if namespace is undefined)
 * - Normalizes duplicate slashes and returns a platform-correct path.
 */
export function getOutputPath (
  outputTemplate: string | ((language: string, namespace?: string) => string) | undefined,
  language: string,
  namespace?: string
): string {
  if (!outputTemplate) {
    // Fallback to a sensible default
    return normalize(`locales/${language}/${namespace ?? 'translation'}.json`)
  }

  if (typeof outputTemplate === 'function') {
    try {
      const result = String(outputTemplate(language, namespace))
      return normalize(result.replace(/\/\/+/g, '/'))
    } catch {
      // If user function throws, fallback to default path
      return normalize(`locales/${language}/${namespace ?? 'translation'}.json`)
    }
  }

  // It's a string template
  let out = String(outputTemplate)
  out = out.replace(/\{\{language\}\}|\{\{lng\}\}/g, language)

  if (namespace !== undefined && namespace !== null) {
    out = out.replace(/\{\{namespace\}\}/g, namespace)
  } else {
    // remove any occurrences of /{{namespace}} or {{namespace}} (keeping surrounding slashes tidy)
    out = out.replace(/\/?\{\{namespace\}\}/g, '')
  }

  // collapse duplicate slashes and normalize to platform-specific separators
  out = out.replace(/\/\/+/g, '/')
  return normalize(out)
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

    if (ext === '.json5') {
      const content = await readFile(fullPath, 'utf-8')
      // Parse as a JSON5 object node
      const node = JsonParser.parse(content, JsonObjectNode)
      return node.toJSON()
    } else if (ext === '.json') {
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

// Helper to load raw JSON5 content for preservation
export async function loadRawJson5Content (filePath: string): Promise<string | null> {
  const fullPath = resolve(process.cwd(), filePath)
  try {
    await access(fullPath)
    return await readFile(fullPath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Serializes a translation object into a string based on the desired format.
 * For JSON5, preserves comments and formatting using JsonObjectNode.update().
 */
export function serializeTranslationFile (
  data: Record<string, any>,
  format: I18nextToolkitConfig['extract']['outputFormat'] = 'json',
  indentation: number | string = 2,
  rawContent?: string // Pass raw content for JSON5 preservation
): string {
  const jsonString = JSON.stringify(data, null, indentation)

  switch (format) {
    case 'json5': {
      if (rawContent) {
        // Parse the original JSON5 file, update it, and output as string
        const node = JsonParser.parse(rawContent, JsonObjectNode)
        node.update(data)
        return node.toString({ object: { indentationSize: Number(indentation) ?? 2 } })
      }
      // Fallback: create a new node by parsing the generated JSON string and output as string
      const node = JsonParser.parse(jsonString, JsonObjectNode)
      return node.toString({ object: { indentationSize: Number(indentation) ?? 2 } })
    }
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
