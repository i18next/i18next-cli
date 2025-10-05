#!/usr/bin/env node

import { Command } from 'commander'
import chokidar from 'chokidar'
import { glob } from 'glob'
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
  .version('1.5.9')

program
  .command('extract')
  .description('Extract translation keys from source files and update resource files.')
  .option('-w, --watch', 'Watch for file changes and re-run the extractor.')
  .option('--ci', 'Exit with a non-zero status code if any files are updated.')
  .option('--dry-run', 'Run the extractor without writing any files to disk.')
  .action(async (options) => {
    const config = await ensureConfig()

    const run = async () => {
      const filesWereUpdated = await runExtractor(config, { isWatchMode: options.watch, isDryRun: options.dryRun })
      if (options.ci && filesWereUpdated) {
        console.error(chalk.red.bold('\n[CI Mode] Error: Translation files were updated. Please commit the changes.'))
        console.log(chalk.yellow('💡 Tip: Tired of committing JSON files? locize syncs your team automatically => https://www.locize.com/docs/getting-started'))
        console.log(`   Learn more: ${chalk.cyan('npx i18next-cli locize-sync')}`)
        process.exit(1)
      }
    }
    await run()

    if (options.watch) {
      console.log('\nWatching for changes...')
      const watcher = chokidar.watch(await glob(config.extract.input), {
        ignored: /node_modules/,
        persistent: true,
      })
      watcher.on('change', path => {
        console.log(`\nFile changed: ${path}`)
        run()
      })
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
      const watcher = chokidar.watch(await glob(config.types?.input || []), {
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
        const watcher = chokidar.watch(await glob(config.extract.input), {
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
