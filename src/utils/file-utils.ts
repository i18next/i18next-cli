import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, extname, resolve, normalize } from 'node:path'
import { createJiti } from 'jiti'
import type { I18nextToolkitConfig } from '../types.js'
import { getTsConfigAliases } from '../config.js'
import { JsonParser, JsonObjectNode } from '@croct/json5-parser'
import yaml from 'yaml'

/**
 * Thrown when an existing translation file in a structured data format
 * (JSON/JSON5/YAML) exists on disk but cannot be parsed. Callers should treat
 * this as fatal rather than as an empty/missing file, since overwriting an
 * unparseable file would silently destroy its contents (e.g. a merge conflict
 * marker accidentally committed into an en.json).
 */
export class ParseTranslationFileError extends Error {
  constructor (public readonly filePath: string, public readonly cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Could not parse translation file ${filePath}: ${detail}`)
    this.name = 'ParseTranslationFileError'
  }
}

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

  const ext = extname(fullPath).toLowerCase()

  // Structured data formats (JSON/JSON5/YAML): the file exists (it passed the
  // access() check above) but could not be parsed. Treating this as `null` is
  // dangerous: callers coalesce it to an empty object and may overwrite the
  // existing file, silently destroying its contents (e.g. when a merge conflict
  // marker breaks an en.json that a watcher then re-extracts). Fail loudly so
  // the caller can stop instead of overwriting good data with nothing.
  if (ext === '.json5') {
    const content = await readFile(fullPath, 'utf-8')
    try {
      // Parse as a JSON5 object node
      const node = JsonParser.parse(content, JsonObjectNode)
      return node.toJSON()
    } catch (error) {
      throw new ParseTranslationFileError(filePath, error)
    }
  } else if (ext === '.yaml' || ext === '.yml') {
    const content = await readFile(fullPath, 'utf-8')
    try {
      return yaml.parse(content) as Record<string, any>
    } catch (error) {
      throw new ParseTranslationFileError(filePath, error)
    }
  } else if (ext === '.json') {
    const content = await readFile(fullPath, 'utf-8')
    try {
      return JSON.parse(content)
    } catch (error) {
      throw new ParseTranslationFileError(filePath, error)
    }
  } else if (ext === '.ts' || ext === '.js') {
    // .ts/.js resource files are loaded via jiti, which can fail for reasons
    // unrelated to corruption (e.g. a transitive import or a side-effectful
    // module). This path has been deliberately lenient since #59, so keep
    // degrading to `null` here rather than aborting the whole command.
    try {
      // Load TypeScript path aliases for proper module resolution
      const aliases = await getTsConfigAliases()

      const jiti = createJiti(process.cwd(), {
        alias: aliases,
        interopDefault: true,
      })

      const module = await jiti.import(fullPath, { default: true }) as unknown
      return module as Record<string, any> | null
    } catch (error) {
      console.warn(`Could not parse translation file ${filePath}:`, error)
      return null
    }
  }

  return null // Unsupported file type
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
    case 'yaml':
      return yaml.stringify(data, { indent: Number(indentation) || 2, lineWidth: 0 })
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

/**
 * Infers the output format from the file path extension.
 * @param filePath - The path to the translation file
 * @param defaultFormat - The default format to return if no match (default: 'json')
 * @returns The inferred output format
 */
export function inferFormatFromPath (
  filePath: string,
  defaultFormat: I18nextToolkitConfig['extract']['outputFormat'] = 'json'
): NonNullable<I18nextToolkitConfig['extract']['outputFormat']> {
  if (filePath.endsWith('.json5')) return 'json5'
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml'
  if (filePath.endsWith('.ts')) return 'ts'
  if (filePath.endsWith('.js')) return 'js'
  if (filePath.endsWith('.json')) return 'json'
  return defaultFormat || 'json'
}
