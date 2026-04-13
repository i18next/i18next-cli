import { createSpinnerLike } from '../../utils/wrap-ora.js'
import { styleText } from 'node:util'
import { parse } from '@swc/core'
import type { Module } from '@swc/types'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { Logger, I18nextToolkitConfig, Plugin, PluginContext, TranslationResult } from '../../types.js'
import { findKeys } from './key-finder.js'
import { getTranslations } from './translation-manager.js'
import { validateExtractorConfig, ExtractorError } from '../../utils/validation.js'
import { ConflictError } from '../plugin-manager.js'
import { extractKeysFromComments } from '../parsers/comment-parser.js'
import { normalizeASTSpans, findFirstTokenIndex } from '../parsers/ast-utils.js'
import { ASTVisitors } from './ast-visitors.js'
import { ConsoleLogger } from '../../utils/logger.js'
import { serializeTranslationFile, loadRawJson5Content, inferFormatFromPath } from '../../utils/file-utils.js'
import { shouldShowFunnel, recordFunnelShown } from '../../utils/funnel-msg-tracker.js'

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
  options: {
    isWatchMode?: boolean,
    isDryRun?: boolean,
    syncPrimaryWithDefaults?: boolean,
    syncAll?: boolean,
    trustDerivedDefaults?: boolean,
    quiet?: boolean,
    logger?: Logger
  } = {}
): Promise<{ anyFileUpdated: boolean; hasErrors: boolean }> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)

  // Ensure default function and component names are set if not provided.
  config.extract.functions ||= ['t', '*.t']
  config.extract.transComponents ||= ['Trans']

  validateExtractorConfig(config)

  const plugins = config.plugins || []
  const internalLogger = options.logger ?? new ConsoleLogger()
  // Only pass logger to spinner if explicitly provided
  const spinner = createSpinnerLike('Running i18next key extractor...\n', { quiet: !!options.quiet, logger: options.logger })

  try {
    const fileErrors: string[] = []
    const { allKeys, objectKeys } = await findKeys(config, internalLogger, fileErrors)
    spinner.text = `Found ${allKeys.size} unique keys. Updating translation files...`

    const results = await getTranslations(allKeys, objectKeys, config, {
      syncPrimaryWithDefaults: options.syncPrimaryWithDefaults,
      syncAll: options.syncAll,
      trustDerivedDefaults: options.trustDerivedDefaults,
      logger: options.logger
    })

    let anyFileUpdated = false
    let anyNewFile = false
    for (const result of results) {
      if (result.updated) {
        anyFileUpdated = true
        if (Object.keys(result.existingTranslations || {}).length === 0) {
          anyNewFile = true
        }
        if (!options.isDryRun) {
          // prefer explicit outputFormat; otherwise infer from file extension per-file
          const effectiveFormat = config.extract.outputFormat ?? inferFormatFromPath(result.path)
          const rawContent = effectiveFormat === 'json5'
            ? (await loadRawJson5Content(result.path)) ?? undefined
            : undefined
          const fileContent = serializeTranslationFile(
            result.newTranslations,
            effectiveFormat,
            config.extract.indentation,
            rawContent
          )
          await mkdir(dirname(result.path), { recursive: true })
          await writeFile(result.path, fileContent)
          internalLogger.info(styleText('green', `Updated: ${result.path}`))
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

    const completionMessage = fileErrors.length > 0
      ? styleText('bold', `Extraction complete, but ignored ${fileErrors.length} file${fileErrors.length === 1 ? '' : 's'}!`)
      : styleText('bold', 'Extraction complete!')
    spinner.succeed(completionMessage)

    // Show the funnel message only if files were actually changed.
    // When new translation files are created (new namespace or first extraction),
    // always show the funnel regardless of cooldown.
    if (anyFileUpdated && !options.isDryRun && !options.quiet) await printLocizeFunnel(options.logger, anyNewFile)

    return { anyFileUpdated, hasErrors: fileErrors.length > 0 }
  } catch (error) {
    spinner.fail(styleText('red', 'Extraction failed.'))
    // Re-throw or handle error
    throw error
  }
}

/**
 * Returns true when the given file extension (e.g. '.svelte') is explicitly
 * referenced in at least one of the input glob patterns.
 *
 * This is used to decide whether to emit a warning when a non-native file is
 * skipped because no plugin handled it.  A pattern like `src/**\/*.{ts,svelte}`
 * or `src/**\/*.svelte` clearly signals intent; a catch-all like `src/**\/*`
 * does not.
 *
 * @internal
 */
function isExtExplicitlyInInputPatterns (ext: string, input: string | string[]): boolean {
  const patterns = Array.isArray(input) ? input : [input]
  // Strip the leading dot for matching (e.g. '.svelte' → 'svelte')
  const bare = ext.startsWith('.') ? ext.slice(1) : ext
  return patterns.some(p => {
    // Matches both `*.svelte` and `*.{ts,svelte}` style patterns
    const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`[{,*]${escaped}[},*]|[.]${escaped}(?:[^a-z]|$)`).test(p)
  })
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
  logger: Logger = new ConsoleLogger(),
  fileErrors?: string[]
): Promise<void> {
  try {
    // Skip directories that happen to match file-extension globs (e.g. a directory named "Foo.tsx")
    const fileStat = await stat(file)
    if (fileStat.isDirectory()) return

    let code = await readFile(file, 'utf-8')

    // Run onLoad hooks from plugins with error handling.
    // Track whether any plugin actually transformed the code so we can make
    // the right parse decision for non-native file types (e.g. .svelte, .vue).
    let wasTransformedByPlugin = false
    for (const plugin of plugins) {
      try {
        const result = await plugin.onLoad?.(code, file)
        if (result !== undefined) {
          code = result
          wasTransformedByPlugin = true
          // No break — plugins chain: each receives the previous plugin's output
        }
      } catch (err) {
        logger.warn(`Plugin ${plugin.name} onLoad failed:`, err)
        // Continue with the original code if the plugin fails
      }
    }

    // Determine parser options.
    // For non-native extensions (e.g. .svelte, .vue):
    //   - If a plugin transformed the code, parse the *result* as tsx (most
    //     permissive SWC syntax) regardless of the original extension.
    //   - If no plugin handled the file, skip it gracefully — there is nothing
    //     SWC can do with raw .svelte/.vue markup.
    const fileExt = extname(file).toLowerCase()
    const isNativeExt = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(fileExt)

    if (!isNativeExt && !wasTransformedByPlugin) {
      // Non-JS/TS file with no plugin handler — skip, but warn when the
      // extension was explicitly listed in the input glob patterns.  That
      // strongly suggests the developer intended to handle it (e.g. via a
      // Svelte/Vue plugin) but forgot to install or register the plugin.
      if (isExtExplicitlyInInputPatterns(fileExt, config.extract.input)) {
        logger.warn(
          `No plugin handled "${file}" (${fileExt}). ` +
          `If you intended to extract translations from ${fileExt} files, ` +
          'make sure the appropriate plugin is installed and added to your config.'
        )
      }
      return
    }

    // When a plugin transformed a non-native file, always use tsx so SWC can
    // handle TypeScript syntax that the plugin may have extracted from the file.
    const effectiveExt = (!isNativeExt && wasTransformedByPlugin) ? '.tsx' : fileExt
    const isTypeScriptFile = effectiveExt === '.ts' || effectiveExt === '.tsx' || effectiveExt === '.mts' || effectiveExt === '.cts'
    const isTSX = effectiveExt === '.tsx'
    const isJSX = effectiveExt === '.jsx'

    let ast: Module
    try {
      ast = await parse(code, {
        syntax: isTypeScriptFile ? 'typescript' : 'ecmascript',
        tsx: isTSX,
        jsx: isJSX,
        decorators: true,
        dynamicImport: true,
        comments: true,
      })
    } catch (err) {
      // Fallback for .ts files with JSX (already present)
      if (effectiveExt === '.ts' && !isTSX) {
        try {
          ast = await parse(code, {
            syntax: 'typescript',
            tsx: true,
            decorators: true,
            dynamicImport: true,
            comments: true,
          })
          logger.info?.(`Parsed ${file} using TSX fallback`)
        } catch (err2) {
          throw new ExtractorError('Failed to process file', file, err2 as Error)
        }
      // Fallback for .js files with JSX
      } else if (effectiveExt === '.js' && !isJSX) {
        try {
          ast = await parse(code, {
            syntax: 'ecmascript',
            jsx: true,
            decorators: true,
            dynamicImport: true,
            comments: true,
          })
          logger.info?.(`Parsed ${file} using JSX fallback`)
        } catch (err2) {
          throw new ExtractorError('Failed to process file', file, err2 as Error)
        }
      } else {
        throw new ExtractorError('Failed to process file', file, err as Error)
      }
    }

    // Normalize SWC span offsets so every span is file-relative (0-based).
    // SWC accumulates byte offsets across successive parse() calls and uses
    // 1-based positions, so Module.span.start points to the first token,
    // NOT to byte 0 of the source.  We derive the true base by subtracting
    // the 0-based index of that first token in the source string.
    const firstTokenIdx = findFirstTokenIndex(code)
    const spanBase = ast.span.start - firstTokenIdx
    normalizeASTSpans(ast, spanBase)

    // "Wire up" the visitor's scope method to the context.
    // This avoids a circular dependency while giving plugins access to the scope.
    pluginContext.getVarFromScope = astVisitors.getVarFromScope.bind(astVisitors)
    pluginContext.setVarInScope = astVisitors.scopeManager.setVarInScope.bind(astVisitors.scopeManager)

    // Pass BOTH file and code
    astVisitors.setCurrentFile(file, code)

    // 3. FIRST: Visit the AST to build scope information
    astVisitors.visit(ast)

    // 4. THEN: Extract keys from comments with scope resolution (now scope info is available)
    if (config.extract.extractFromComments !== false) {
      extractKeysFromComments(code, pluginContext, config, astVisitors.getVarFromScope.bind(astVisitors))
    }
  } catch (error) {
    // Re-throw ConflictError so warnOnConflicts: 'error' aborts extraction
    if (error instanceof ConflictError) {
      throw error
    }
    logger.warn(`${styleText('yellow', 'Skipping file due to error:')} ${file}`)

    const err = error as any
    const msg =
      typeof err?.message === 'string' && err.message.trim().length > 0
        ? err.message
        : (typeof err === 'string' ? err : '') || err?.toString?.() || 'Unknown error'

    logger.warn(`  ${msg}`)

    // If message is missing, stack is often the only useful clue
    if ((!err?.message || String(err.message).trim() === '') && err?.stack) {
      logger.warn(`  ${String(err.stack)}`)
    }

    // Record the failure so callers can exit non-zero even though we continue extraction
    fileErrors?.push(file)
  }
}

/**
 * Lightweight pre-scan pass for a single file.
 *
 * Parses the file and calls `astVisitors.preScanForConstants()` to populate
 * cross-file shared constant / type-alias / array tables WITHOUT extracting
 * any translation keys or running plugin hooks.
 *
 * Intended to be called for ALL files in a first pass before `processFile` is
 * called for any file, ensuring that exported identifier references such as
 * `NS_CALENDAR` from `@core/translations/ns` are resolved in all files
 * regardless of processing order.
 *
 * @param file   - Absolute or CWD-relative path of the source file to pre-scan
 * @param astVisitors - Shared visitor instance (holds the shared constant tables)
 * @param config - Extractor configuration (without plugins)
 * @param logger - Logger for warnings/errors
 * @param fileErrors - Optional array to collect per-file error messages
 */
export async function preScanFile (
  file: string,
  astVisitors: ASTVisitors,
  config: Omit<I18nextToolkitConfig, 'plugins'>,
  logger: Logger = new ConsoleLogger(),
  fileErrors?: string[]
): Promise<void> {
  try {
    // Skip directories that happen to match file-extension globs (e.g. a directory named "Foo.tsx")
    const fileStat = await stat(file)
    if (fileStat.isDirectory()) return

    const code = await readFile(file, 'utf-8')
    const fileExt = extname(file).toLowerCase()

    // Non-native files (e.g. .svelte, .vue) cannot be parsed by SWC in the
    // pre-scan pass — plugins have not run yet so no onLoad transformation is
    // available.  Skip them silently; processFile will handle them correctly.
    const isNativeExt = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(fileExt)
    if (!isNativeExt) return

    const isTypeScriptFile = fileExt === '.ts' || fileExt === '.tsx' || fileExt === '.mts' || fileExt === '.cts'
    const isTSX = fileExt === '.tsx'
    const isJSX = fileExt === '.jsx'

    let ast: Module
    try {
      ast = await parse(code, {
        syntax: isTypeScriptFile ? 'typescript' : 'ecmascript',
        tsx: isTSX,
        jsx: isJSX,
        decorators: true,
        dynamicImport: true,
        comments: true,
      })
    } catch (err) {
      if (fileExt === '.ts' && !isTSX) {
        try {
          ast = await parse(code, { syntax: 'typescript', tsx: true, decorators: true, dynamicImport: true, comments: true })
        } catch (err2) {
          throw new ExtractorError('Failed to pre-scan file', file, err2 as Error)
        }
      } else if (fileExt === '.js' && !isJSX) {
        try {
          ast = await parse(code, { syntax: 'ecmascript', jsx: true, decorators: true, dynamicImport: true, comments: true })
        } catch (err2) {
          throw new ExtractorError('Failed to pre-scan file', file, err2 as Error)
        }
      } else {
        throw new ExtractorError('Failed to pre-scan file', file, err as Error)
      }
    }

    const firstTokenIdx = findFirstTokenIndex(code)
    normalizeASTSpans(ast, ast.span.start - firstTokenIdx)

    astVisitors.setCurrentFile(file, code)
    astVisitors.preScanForConstants(ast)
  } catch (error) {
    if (error instanceof ConflictError) throw error
    logger.warn(`${styleText('yellow', 'Skipping file in constants pre-scan due to error:')} ${file}`)
    const err = error as any
    const msg = typeof err?.message === 'string' && err.message.trim().length > 0
      ? err.message
      : (typeof err === 'string' ? err : '') || err?.toString?.() || 'Unknown error'
    if (fileErrors) fileErrors.push(`${file}: ${msg}`)
  }
}

/**
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
export async function extract (config: I18nextToolkitConfig, { syncPrimaryWithDefaults = false }: { syncPrimaryWithDefaults?: boolean } = {}): Promise<TranslationResult[]> {
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
async function printLocizeFunnel (logger?: Logger, force?: boolean) {
  if (!force && !(await shouldShowFunnel('extract'))) return

  const internalLogger = logger ?? new ConsoleLogger()
  const lines = [
    styleText(['yellow', 'bold'], '\n💡 Tip: Tired of running the extractor manually?'),
    '   Discover a real-time "push" workflow with `saveMissing` and Locize AI/MT,',
    '   where keys are created and translated automatically as you code.',
    `   Learn more: ${styleText('cyan', 'https://www.locize.com/blog/i18next-savemissing-ai-automation')}`,
    `   Watch the video: ${styleText('cyan', 'https://youtu.be/joPsZghT3wM')}`,
    '',
    '   You can also sync your extracted translations to Locize:',
    `     ${styleText('cyan', 'npx i18next-cli locize-sync')}      – upload/sync translations to Locize`,
    `     ${styleText('cyan', 'npx i18next-cli locize-migrate')}   – migrate local translations to Locize`,
    '   Or import them manually via the Locize UI, API, or locize-cli.',
  ]
  const log = typeof internalLogger.info === 'function'
    ? (msg: string) => internalLogger.info(msg)
    : (msg: string) => console.log(msg)
  for (const line of lines) log(line)

  return recordFunnelShown('extract')
}
