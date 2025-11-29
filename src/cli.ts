#!/usr/bin/env node

import { Command } from 'commander'
import chokidar from 'chokidar'
import { glob } from 'glob'
import { minimatch } from 'minimatch'
import chalk from 'chalk'
import { loadConfig, ensureConfig } from './config'
import { detectConfig } from './heuristic-config'
import { runExtractor } from './extractor'
import { runTypesGenerator } from './types-generator'
import { runSyncer } from './syncer'
import { runMigrator } from './migrator'
import { runInit } from './init'
import { runLinterCli } from './linter'
import { runStatus } from './status'
import { runLocizeSync, runLocizeDownload, runLocizeMigrate } from './locize'
import { runRenameKey } from './rename-key'
import type { I18nextToolkitConfig } from './types'

const program = new Command()

program
  .name('i18next-cli')
  .description('A unified, high-performance i18next CLI.')
  .version('__packageVersion__') // This string is replaced with the actual version at build time by rollup

// new: global config override option
program.option('-c, --config <path>', 'Path to i18next-cli config file (overrides detection)')

program
  .command('extract')
  .description('Extract translation keys from source files and update resource files.')
  .option('-w, --watch', 'Watch for file changes and re-run the extractor.')
  .option('--ci', 'Exit with a non-zero status code if any files are updated.')
  .option('--dry-run', 'Run the extractor without writing any files to disk.')
  .option('--sync-primary', 'Sync primary language values with default values from code.')
  .option('--sync-all', 'Sync primary language values with default values from code AND clear synced keys in all other locales.')
  .action(async (options) => {
    try {
      const cfgPath = program.opts().config
      const config = await ensureConfig(cfgPath)

      const runExtract = async () => {
        // --sync-all implies sync-primary behavior
        const syncPrimary = !!options.syncPrimary || !!options.syncAll
        const success = await runExtractor(config, {
          isWatchMode: !!options.watch,
          isDryRun: !!options.dryRun,
          syncPrimaryWithDefaults: syncPrimary,
          syncAll: !!options.syncAll
        })

        if (options.ci && !success) {
          console.log('✅ No files were updated.')
          process.exit(0)
        } else if (options.ci && success) {
          console.error('❌ Some files were updated. This should not happen in CI mode.')
          process.exit(1)
        }

        return success
      }

      // Run the extractor once initially
      await runExtract()

      // If in watch mode, set up the chokidar watcher
      if (options.watch) {
        console.log('\nWatching for changes...')
        // expand configured input globs (keep original behavior for detection)
        const expanded = await expandGlobs(config.extract.input)
        // build ignore list (configured + derived from output template)
        const configuredIgnore = toArray(config.extract.ignore)
        const derivedIgnore = deriveOutputIgnore(config.extract.output)
        const ignoreGlobs = [...configuredIgnore, ...derivedIgnore].filter(Boolean)
        // filter expanded files by ignore globs
        const watchFiles = expanded.filter(f => !ignoreGlobs.some(g => minimatch(f, g, { dot: true })))

        const watcher = chokidar.watch(watchFiles, {
          ignored: /node_modules/,
          persistent: true,
        })
        watcher.on('change', path => {
          console.log(`\nFile changed: ${path}`)
          runExtract()
        })
      }
    } catch (error) {
      console.error('Error running extractor:', error)
      process.exit(1)
    }
  })

program
  .command('status [locale]')
  .description('Display translation status. Provide a locale for a detailed key-by-key view.')
  .option('-n, --namespace <ns>', 'Filter the status report by a specific namespace')
  .action(async (locale, options) => {
    const cfgPath = program.opts().config
    let config = await loadConfig(cfgPath)
    if (!config) {
      console.log(chalk.blue('No config file found. Attempting to detect project structure...'))
      const detected = await detectConfig()
      if (!detected) {
        console.error(chalk.red('Could not automatically detect your project structure.'))
        console.log(`Please create a config file first by running: ${chalk.cyan('npx i18next-cli init')}`)
        process.exit(1)
      }
      console.log(chalk.green('Project structure detected successfully!'))
      config = detected as I18nextToolkitConfig
    }
    await runStatus(config, { detail: locale, namespace: options.namespace })
  })

program
  .command('types')
  .description('Generate TypeScript definitions from translation resource files.')
  .option('-w, --watch', 'Watch for file changes and re-run the type generator.')
  .action(async (options) => {
    const cfgPath = program.opts().config
    const config = await ensureConfig(cfgPath)

    const run = () => runTypesGenerator(config)
    await run()

    if (options.watch) {
      console.log('\nWatching for changes...')
      const expandedTypes = await expandGlobs(config.types?.input || [])
      const ignoredTypes = [...toArray(config.extract?.ignore)].filter(Boolean)
      const watchTypes = expandedTypes.filter(f => !ignoredTypes.some(g => minimatch(f, g, { dot: true })))
      const watcher = chokidar.watch(watchTypes, { persistent: true })
      watcher.on('change', path => {
        console.log(`\nFile changed: ${path}`)
        run()
      })
    }
  })

program
  .command('sync')
  .description('Synchronize secondary language files with the primary language file.')
  .action(async () => {
    const cfgPath = program.opts().config
    const config = await ensureConfig(cfgPath)
    await runSyncer(config)
  })

program
  .command('migrate-config [configPath]')
  .description('Migrate a legacy i18next-parser.config.js to the new format.')
  .action(async (configPath) => {
    await runMigrator(configPath)
  })

program
  .command('init')
  .description('Create a new i18next.config.ts/js file with an interactive setup wizard.')
  .action(runInit)

program
  .command('lint')
  .description('Find potential issues like hardcoded strings in your codebase.')
  .option('-w, --watch', 'Watch for file changes and re-run the linter.')
  .action(async (options) => {
    const cfgPath = program.opts().config

    const loadAndRunLinter = async () => {
      // The existing logic for loading the config or detecting it is now inside this function
      let config = await loadConfig(cfgPath)
      if (!config) {
        console.log(chalk.blue('No config file found. Attempting to detect project structure...'))
        const detected = await detectConfig()
        if (!detected) {
          console.error(chalk.red('Could not automatically detect your project structure.'))
          console.log(`Please create a config file first by running: ${chalk.cyan('npx i18next-cli init')}`)
          process.exit(1)
        }
        console.log(chalk.green('Project structure detected successfully!'))
        config = detected as I18nextToolkitConfig
      }
      await runLinterCli(config)
    }

    // Run the linter once initially
    await loadAndRunLinter()

    // If in watch mode, set up the chokidar watcher
    if (options.watch) {
      console.log('\nWatching for changes...')
      // Re-load the config to get the correct input paths for the watcher
      const config = await loadConfig(cfgPath)
      if (config?.extract?.input) {
        const expandedLint = await expandGlobs(config.extract.input)
        const configuredIgnore2 = toArray(config.extract.ignore)
        const derivedIgnore2 = deriveOutputIgnore(config.extract.output)
        const ignoredLint = [...configuredIgnore2, ...derivedIgnore2].filter(Boolean)
        const watchLint = expandedLint.filter(f => !ignoredLint.some(g => minimatch(f, g, { dot: true })))

        const watcher = chokidar.watch(watchLint, {
          ignored: /node_modules/,
          persistent: true,
        })
        watcher.on('change', path => {
          console.log(`\nFile changed: ${path}`)
          loadAndRunLinter() // Re-run on change
        })
      }
    }
  })

program
  .command('locize-sync')
  .description('Synchronize local translations with your locize project.')
  .option('--update-values', 'Update values of existing translations on locize.')
  .option('--src-lng-only', 'Check for changes in source language only.')
  .option('--compare-mtime', 'Compare modification times when syncing.')
  .option('--dry-run', 'Run the command without making any changes.')
  .action(async (options) => {
    const cfgPath = program.opts().config
    const config = await ensureConfig(cfgPath)
    await runLocizeSync(config, options)
  })

program
  .command('locize-download')
  .description('Download all translations from your locize project.')
  .action(async (options) => {
    const cfgPath = program.opts().config
    const config = await ensureConfig(cfgPath)
    await runLocizeDownload(config, options)
  })

program
  .command('locize-migrate')
  .description('Migrate local translation files to a new locize project.')
  .action(async (options) => {
    const cfgPath = program.opts().config
    const config = await ensureConfig(cfgPath)
    await runLocizeMigrate(config, options)
  })

program
  .command('rename-key <oldKey> <newKey>')
  .description('Rename a translation key across all source files and translation files.')
  .option('--dry-run', 'Preview changes without modifying files')
  .action(async (oldKey, newKey, options) => {
    try {
      const cfgPath = program.opts().config
      const config = await ensureConfig(cfgPath)

      const result = await runRenameKey(config, oldKey, newKey, options)

      if (!result.success) {
        if (result.conflicts) {
          console.error(chalk.red('\n❌ Conflicts detected:'))
          result.conflicts.forEach(c => console.error(`   - ${c}`))
        }
        if (result.error) {
          console.error(chalk.red(`\n❌ ${result.error}`))
        }
        process.exit(1)
      }

      const totalChanges = result.sourceFiles.reduce((sum, f) => sum + f.changes, 0)
      if (totalChanges === 0) {
        console.log(chalk.yellow(`\n⚠️  No usages found for "${oldKey}"`))
      }
    } catch (error) {
      console.error(chalk.red('Error renaming key:'), error)
      process.exit(1)
    }
  })

program.parse(process.argv)

const toArray = (v: any) => Array.isArray(v) ? v : (v ? [v] : [])
const deriveOutputIgnore = (output?: string | ((language: string, namespace?: string) => string)) => {
  if (!output || typeof output !== 'string') return []
  return [output.replace(/\{\{[^}]+\}\}/g, '*')]
}
// helper to expand one or many glob patterns
const expandGlobs = async (patterns: string | string[] = []) => {
  const arr = toArray(patterns)
  const sets = await Promise.all(arr.map(p => glob(p || '', { nodir: true })))
  return Array.from(new Set(sets.flat()))
}

export { program }
