#!/usr/bin/env node

import { Command } from 'commander'
import chokidar from 'chokidar'
import chalk from 'chalk'
import { loadConfig, ensureConfig } from './config'
import { detectConfig } from './heuristic-config'
import { runExtractor } from './extractor'
import { runTypesGenerator } from './types-generator'
import { runSyncer } from './syncer'
import { runMigrator } from './migrator'
import { runInit } from './init'
import { runLinter } from './linter'
import { runStatus } from './status'
import { runLocizeSync, runLocizeDownload, runLocizeMigrate } from './locize'
import type { I18nextToolkitConfig } from './types'

const program = new Command()

program
  .name('i18next-cli')
  .description('A unified, high-performance i18next CLI.')
  .version('1.11.13')

program
  .command('extract')
  .description('Extract translation keys from source files and update resource files.')
  .option('-w, --watch', 'Watch for file changes and re-run the extractor.')
  .option('--ci', 'Exit with a non-zero status code if any files are updated.')
  .option('--dry-run', 'Run the extractor without writing any files to disk.')
  .option('--sync-primary', 'Sync primary language values with default values from code.')
  .action(async (options) => {
    try {
      const config = await ensureConfig()

      const runExtract = async () => {
        const success = await runExtractor(config, {
          isWatchMode: !!options.watch,
          isDryRun: !!options.dryRun,
          syncPrimaryWithDefaults: !!options.syncPrimary
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
        // Respect configured ignore patterns and pass the original glob(s) to chokidar
        const ignoredPatterns = [
          /node_modules/,
          ...(Array.isArray(config.extract.ignore) ? config.extract.ignore : (config.extract.ignore ? [config.extract.ignore] : [])),
        ]
        const watchTargets = config.extract.input || []
        const watcher = chokidar.watch(watchTargets, {
          ignored: ignoredPatterns,
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
    let config = await loadConfig()
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
    const config = await ensureConfig()

    const run = () => runTypesGenerator(config)
    await run()

    if (options.watch) {
      console.log('\nWatching for changes...')
      // Use the configured input patterns and respect extract.ignore if present
      const ignoredPatterns = [
        /node_modules/,
        ...(Array.isArray(config.extract?.ignore) ? config.extract.ignore : (config.extract?.ignore ? [config.extract?.ignore] : [])),
      ]
      const watchTargets = config.types?.input || []
      const watcher = chokidar.watch(watchTargets, {
        ignored: ignoredPatterns,
        persistent: true,
      })
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
    const config = await ensureConfig()
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
    const loadAndRunLinter = async () => {
      // The existing logic for loading the config or detecting it is now inside this function
      let config = await loadConfig()
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
      await runLinter(config)
    }

    // Run the linter once initially
    await loadAndRunLinter()

    // If in watch mode, set up the chokidar watcher
    if (options.watch) {
      console.log('\nWatching for changes...')
      // Re-load the config to get the correct input paths for the watcher
      const config = await loadConfig()
      if (config?.extract?.input) {
        const ignoredPatterns = [
          /node_modules/,
          ...(Array.isArray(config.extract.ignore) ? config.extract.ignore : (config.extract.ignore ? [config.extract.ignore] : [])),
        ]
        const watchTargets = config.extract.input || []
        const watcher = chokidar.watch(watchTargets, {
          ignored: ignoredPatterns,
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
    const config = await ensureConfig()
    await runLocizeSync(config, options)
  })

program
  .command('locize-download')
  .description('Download all translations from your locize project.')
  .action(async (options) => {
    const config = await ensureConfig()
    await runLocizeDownload(config, options)
  })

program
  .command('locize-migrate')
  .description('Migrate local translation files to a new locize project.')
  .action(async (options) => {
    const config = await ensureConfig()
    await runLocizeMigrate(config, options)
  })

program.parse(process.argv)
