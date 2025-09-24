#!/usr/bin/env node

import { Command } from 'commander'
import chokidar from 'chokidar'
import { glob } from 'glob'
import chalk from 'chalk'
import { loadConfig } from './config'
import { runExtractor } from './extractor'
import { runTypesGenerator } from './types-generator'
import { runSyncer } from './syncer'
import { runMigrator } from './migrator'
import { runInit } from './init'
import { runLinter } from './linter'
import { runStatus } from './status'
import { runLocizeSync, runLocizeDownload, runLocizeMigrate } from './locize'

const calledDirectly = import.meta.url.startsWith(`file://${process.argv[1]}`)

if (calledDirectly) {
  const program = new Command()

  program
    .name('i18next-toolkit')
    .description('A unified, high-performance i18next CLI.')
    .version('0.9.0')

  program
    .command('extract')
    .description('Extract translation keys from source files and update resource files.')
    .option('-w, --watch', 'Watch for file changes and re-run the extractor.')
    .option('--ci', 'Exit with a non-zero status code if any files are updated.')
    .action(async (options) => {
      const config = await loadConfig()
      if (!config) {
        process.exit(1)
      }

      const run = async () => {
        const filesWereUpdated = await runExtractor(config)
        if (options.ci && filesWereUpdated) {
          console.error(chalk.red.bold('\n[CI Mode] Error: Translation files were updated. Please commit the changes.'))
          console.log(chalk.yellow('💡 Tip: Tired of committing JSON files? locize syncs your team automatically => https://www.locize.com/docs/getting-started'))
          console.log(`   Learn more: ${chalk.cyan('npx i18next-toolkit locize-sync')}`)
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
    .command('status')
    .description('Display the translation status of your project.')
    .action(async () => {
      const config = await loadConfig()
      if (!config) process.exit(1)
      await runStatus(config)
    })

  program
    .command('types')
    .description('Generate TypeScript definitions from translation resource files.')
    .option('-w, --watch', 'Watch for file changes and re-run the type generator.')
    .action(async (options) => {
      const config = await loadConfig()
      if (!config) {
        process.exit(1)
      }

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
      const config = await loadConfig()
      if (!config) {
        process.exit(1)
      }
      await runSyncer(config)
    })

  program
    .command('migrate-config')
    .description('Migrate a legacy i18next-parser.config.js to the new format.')
    .action(async () => {
      await runMigrator()
    })

  program
    .command('init')
    .description('Create a new i18next.config.ts/js file with an interactive setup wizard.')
    .action(runInit)

  program
    .command('lint')
    .description('Find potential issues like hardcoded strings in your codebase.')
    .action(async () => {
      const config = await loadConfig()
      if (!config) process.exit(1)
      await runLinter(config)
    })

  program
    .command('locize-sync')
    .description('Synchronize local translations with your locize project.')
    .option('--update-values', 'Update values of existing translations on locize.')
    .option('--src-lng-only', 'Check for changes in source language only.')
    .option('--compare-mtime', 'Compare modification times when syncing.')
    .option('--dry-run', 'Run the command without making any changes.')
    .action(async (options) => {
      const config = await loadConfig()
      if (!config) process.exit(1)
      await runLocizeSync(config, options)
    })

  program
    .command('locize-download')
    .description('Download all translations from your locize project.')
    .action(async (options) => {
      const config = await loadConfig()
      if (!config) process.exit(1)
      await runLocizeDownload(config, options)
    })

  program
    .command('locize-migrate')
    .description('Migrate local translation files to a new locize project.')
    .action(async (options) => {
      const config = await loadConfig()
      if (!config) process.exit(1)
      await runLocizeMigrate(config, options)
    })

  program.parse(process.argv)
}
