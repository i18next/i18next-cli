import ora from 'ora'
import chalk from 'chalk'
import { parse } from '@swc/core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger, ExtractedKey, PluginContext, I18nextToolkitConfig } from '../../types'
import { findKeys } from './key-finder'
import { getTranslations } from './translation-manager'
import { validateExtractorConfig, ExtractorError } from '../../utils/validation'
import { createPluginContext } from '../plugin-manager'
import { extractKeysFromComments } from '../parsers/comment-parser'
import { ASTVisitors } from '../parsers/ast-visitors'
import { ConsoleLogger } from '../../utils/logger'
import { serializeTranslationFile } from '../../utils/file-utils'

let hasLocizeFunnelBeenPrintedInWatchMode = false

/**
 * Main extractor function that runs the complete key extraction and file generation process.
 *
 * This is the primary entry point that:
 * 1. Validates configuration
 * 2. Sets up default sync options
 * 3. Finds all translation keys across source files
 * 4. Generates/updates translation files for all locales
 * 5. Provides progress feedback via spinner
 * 6. Returns whether any files were updated
 *
 * @param config - The i18next toolkit configuration object
 * @param logger - Logger instance for output (defaults to ConsoleLogger)
 * @returns Promise resolving to boolean indicating if any files were updated
 *
 * @throws {ExtractorError} When configuration validation fails or extraction process encounters errors
 *
 * @example
 * ```typescript
 * const config = await loadConfig()
 * const updated = await runExtractor(config)
 * if (updated) {
 *   console.log('Translation files were updated')
 * }
 * ```
 */
export async function runExtractor (
  config: I18nextToolkitConfig,
  {
    isWatchMode = false,
    isDryRun = false
  }: {
    isWatchMode?: boolean,
    isDryRun?: boolean,
  } = {},
  logger: Logger = new ConsoleLogger()
): Promise<boolean> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)

  // Ensure default function and component names are set if not provided.
  config.extract.functions ||= ['t']
  config.extract.transComponents ||= ['Trans']

  validateExtractorConfig(config)

  const spinner = ora('Running i18next key extractor...\n').start()

  try {
    const { allKeys, objectKeys } = await findKeys(config, logger)
    spinner.text = `Found ${allKeys.size} unique keys. Updating translation files...`

    const results = await getTranslations(allKeys, objectKeys, config)

    let anyFileUpdated = false
    for (const result of results) {
      if (result.updated) {
        anyFileUpdated = true
        // Only write files if it's not a dry run.
        if (!isDryRun) {
          const fileContent = serializeTranslationFile(
            result.newTranslations,
            config.extract.outputFormat,
            config.extract.indentation
          )
          await mkdir(dirname(result.path), { recursive: true })
          await writeFile(result.path, fileContent)
          logger.info(chalk.green(`Updated: ${result.path}`))
        }
      }
    }

    // Run afterSync hooks from plugins
    if ((config.plugins || []).length > 0) {
      spinner.text = 'Running post-extraction plugins...'
      for (const plugin of (config.plugins || [])) {
        await plugin.afterSync?.(results, config)
      }
    }

    spinner.succeed(chalk.bold('Extraction complete!'))

    // Show the funnel message only if files were actually changed.
    if (anyFileUpdated) {
      printLocizeFunnel(isWatchMode)
    }

    return anyFileUpdated
  } catch (error) {
    spinner.fail(chalk.red('Extraction failed.'))
    // Re-throw or handle error
    throw error
  }
}

/**
 * Processes an individual source file for translation key extraction.
 *
 * This function:
 * 1. Reads the source file
 * 2. Runs plugin onLoad hooks for code transformation
 * 3. Parses the code into an Abstract Syntax Tree (AST) using SWC
 * 4. Extracts keys from comments using regex patterns
 * 5. Traverses the AST using visitors to find translation calls
 * 6. Runs plugin onVisitNode hooks for custom extraction logic
 *
 * @param file - Path to the source file to process
 * @param config - The i18next toolkit configuration object
 * @param logger - Logger instance for output
 * @param allKeys - Map to accumulate found translation keys
 *
 * @throws {ExtractorError} When file processing fails
 *
 * @internal
 */
export async function processFile (
  file: string,
  config: I18nextToolkitConfig,
  allKeys: Map<string, ExtractedKey>,
  astVisitors: ASTVisitors,
  logger: Logger = new ConsoleLogger()
): Promise<void> {
  try {
    let code = await readFile(file, 'utf-8')

    // Run onLoad hooks from plugins
    for (const plugin of (config.plugins || [])) {
      code = (await plugin.onLoad?.(code, file)) ?? code
    }

    const ast = await parse(code, {
      syntax: 'typescript',
      tsx: true,
      decorators: true,
      comments: true
    })

    const pluginContext = createPluginContext(allKeys)

    // Extract keys from comments
    extractKeysFromComments(code, pluginContext, config)

    astVisitors.visit(ast)

    // Run plugin visitors
    if ((config.plugins || []).length > 0) {
      traverseEveryNode(ast, (config.plugins || []), pluginContext, logger)
    }
  } catch (error) {
    throw new ExtractorError('Failed to process file', file, error as Error)
  }
}

/**
 * Recursively traverses AST nodes and calls plugin onVisitNode hooks.
 *
 * @param node - The AST node to traverse
 * @param plugins - Array of plugins to run hooks for
 * @param pluginContext - Context object with helper methods for plugins
 *
 * @internal
 */
function traverseEveryNode (node: any, plugins: any[], pluginContext: PluginContext, logger: Logger = new ConsoleLogger()): void {
  if (!node || typeof node !== 'object') return

  // Call plugins for this node
  for (const plugin of plugins) {
    try {
      plugin.onVisitNode?.(node, pluginContext)
    } catch (err) {
      logger.warn(`Plugin ${plugin.name} onVisitNode failed:`, err)
    }
  }

  for (const key of Object.keys(node)) {
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === 'object') traverseEveryNode(c, plugins, pluginContext, logger)
      }
    } else if (child && typeof child === 'object') {
      traverseEveryNode(child, plugins, pluginContext, logger)
    }
  }
}

/**
 * Simplified extraction function that returns translation results without file writing.
 * Used primarily for testing and programmatic access.
 *
 * @param config - The i18next toolkit configuration object
 * @returns Promise resolving to array of translation results
 *
 * @example
 * ```typescript
 * const results = await extract(config)
 * for (const result of results) {
 *   console.log(`${result.path}: ${result.updated ? 'Updated' : 'No changes'}`)
 * }
 * ```
 */
export async function extract (config: I18nextToolkitConfig) {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)
  config.extract.functions ||= ['t']
  config.extract.transComponents ||= ['Trans']
  const { allKeys, objectKeys } = await findKeys(config)
  return getTranslations(allKeys, objectKeys, config)
}

/**
 * Prints a promotional message for the locize saveMissing workflow.
 * This message is shown after a successful extraction that resulted in changes.
 */
function printLocizeFunnel (isWatchMode: boolean = false) {
  // Only print if not in watch mode, or if in watch mode and not yet printed.
  if (isWatchMode && hasLocizeFunnelBeenPrintedInWatchMode) {
    return
  }
  console.log(chalk.yellow.bold('\n💡 Tip: Tired of running the extractor manually?'))
  console.log('   Discover a real-time "push" workflow with `saveMissing` and Locize AI,')
  console.log('   where keys are created and translated automatically as you code.')
  console.log(`   Learn more: ${chalk.cyan('https://www.locize.com/blog/i18next-savemissing-ai-automation')}`)
  console.log(`   Watch the video: ${chalk.cyan('https://youtu.be/joPsZghT3wM')}`)

  if (isWatchMode) {
    hasLocizeFunnelBeenPrintedInWatchMode = true // Mark as printed for watch mode
  }
}
