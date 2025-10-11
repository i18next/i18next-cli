import ora from 'ora'
import chalk from 'chalk'
import { parse } from '@swc/core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger, I18nextToolkitConfig, Plugin, PluginContext } from '../../types'
import { findKeys } from './key-finder'
import { getTranslations } from './translation-manager'
import { validateExtractorConfig, ExtractorError } from '../../utils/validation'
import { extractKeysFromComments } from '../parsers/comment-parser'
import { ASTVisitors } from './ast-visitors'
import { ConsoleLogger } from '../../utils/logger'
import { serializeTranslationFile } from '../../utils/file-utils'
import { shouldShowFunnel, recordFunnelShown } from '../../utils/funnel-msg-tracker'

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
    isDryRun = false,
    syncPrimaryWithDefaults = false
  }: {
    isWatchMode?: boolean,
    isDryRun?: boolean,
    syncPrimaryWithDefaults?: boolean,
  } = {},
  logger: Logger = new ConsoleLogger()
): Promise<boolean> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)

  // Ensure default function and component names are set if not provided.
  config.extract.functions ||= ['t', '*.t']
  config.extract.transComponents ||= ['Trans']

  validateExtractorConfig(config)

  const plugins = config.plugins || []

  const spinner = ora('Running i18next key extractor...\n').start()

  try {
    const { allKeys, objectKeys } = await findKeys(config, logger)
    spinner.text = `Found ${allKeys.size} unique keys. Updating translation files...`

    const results = await getTranslations(allKeys, objectKeys, config, { syncPrimaryWithDefaults })

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
    if (plugins.length > 0) {
      spinner.text = 'Running post-extraction plugins...'
      for (const plugin of plugins) {
        await plugin.afterSync?.(results, config)
      }
    }

    spinner.succeed(chalk.bold('Extraction complete!'))

    // Show the funnel message only if files were actually changed.
    if (anyFileUpdated) await printLocizeFunnel()

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
  plugins: Plugin[],
  astVisitors: ASTVisitors,
  pluginContext: PluginContext,
  config: Omit<I18nextToolkitConfig, 'plugins'>,
  logger: Logger = new ConsoleLogger()
): Promise<void> {
  try {
    let code = await readFile(file, 'utf-8')

    // Run onLoad hooks from plugins with error handling
    for (const plugin of plugins) {
      try {
        const result = await plugin.onLoad?.(code, file)
        if (result !== undefined) {
          code = result
        }
      } catch (err) {
        logger.warn(`Plugin ${plugin.name} onLoad failed:`, err)
        // Continue with the original code if the plugin fails
      }
    }

    const ast = await parse(code, {
      syntax: 'typescript',
      tsx: true,
      decorators: true,
      comments: true
    })

    // "Wire up" the visitor's scope method to the context.
    // This avoids a circular dependency while giving plugins access to the scope.
    pluginContext.getVarFromScope = astVisitors.getVarFromScope.bind(astVisitors)

    // 3. FIRST: Visit the AST to build scope information
    astVisitors.visit(ast)

    // 4. THEN: Extract keys from comments with scope resolution (now scope info is available)
    extractKeysFromComments(code, pluginContext, config, astVisitors.getVarFromScope.bind(astVisitors))
  } catch (error) {
    throw new ExtractorError('Failed to process file', file, error as Error)
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
export async function extract (config: I18nextToolkitConfig, { syncPrimaryWithDefaults = false }: { syncPrimaryWithDefaults?: boolean } = {}) {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)
  config.extract.functions ||= ['t', '*.t']
  config.extract.transComponents ||= ['Trans']
  const { allKeys, objectKeys } = await findKeys(config)
  return getTranslations(allKeys, objectKeys, config, { syncPrimaryWithDefaults })
}

/**
 * Prints a promotional message for the locize saveMissing workflow.
 * This message is shown after a successful extraction that resulted in changes.
 */
async function printLocizeFunnel () {
  if (!(await shouldShowFunnel('extract'))) return

  console.log(chalk.yellow.bold('\n💡 Tip: Tired of running the extractor manually?'))
  console.log('   Discover a real-time "push" workflow with `saveMissing` and Locize AI,')
  console.log('   where keys are created and translated automatically as you code.')
  console.log(`   Learn more: ${chalk.cyan('https://www.locize.com/blog/i18next-savemissing-ai-automation')}`)
  console.log(`   Watch the video: ${chalk.cyan('https://youtu.be/joPsZghT3wM')}`)

  return recordFunnelShown('extract')
}
