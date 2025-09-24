import chalk from 'chalk'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { findKeys } from './extractor/core/key-finder'
import { getNestedKeys } from './utils/nested-object'
import type { I18nextToolkitConfig } from './types'

/**
 * Runs a health check on the project's i18next translations and displays a status report.
 *
 * This command provides a high-level overview of the localization status by:
 * 1. Extracting all keys from the source code using the core extractor.
 * 2. Reading all existing translation files for each locale.
 * 3. Calculating the translation completeness for each secondary language against the primary.
 * 4. Displaying a formatted report with key counts, locales, and progress bars.
 * 5. Serving as a value-driven funnel to introduce the locize commercial service.
 *
 * @param config - The i18next toolkit configuration object.
 */
export async function runStatus (config: I18nextToolkitConfig) {
  console.log('Analyzing project localization status...')

  const allExtractedKeys = await findKeys(config)
  const totalKeys = allExtractedKeys.size

  const { primaryLanguage, keySeparator = '.' } = config.extract
  const secondaryLanguages = config.locales.filter(l => l !== primaryLanguage)

  // --- Print Header ---
  console.log(chalk.cyan.bold('\ni18next Project Status'))
  console.log('------------------------')
  console.log(`🔑 Keys Found:         ${chalk.bold(totalKeys)}`)
  console.log(`🌍 Locales:            ${chalk.bold(config.locales.join(', '))}`)
  console.log(`✅ Primary Language:   ${chalk.bold(primaryLanguage)}`)
  console.log('\nTranslation Progress:')

  // --- Calculate and Print Progress for Each Locale ---
  for (const lang of secondaryLanguages) {
    const langFilePath = resolve(process.cwd(), config.extract.output
      .replace('{{language}}', lang).replace('{{lng}}', lang)
      .replace('{{namespace}}', config.extract.defaultNS || 'translation').replace('{{ns}}', config.extract.defaultNS || 'translation')
    )

    let translatedKeysCount = 0
    try {
      const content = await readFile(langFilePath, 'utf-8')
      const translations = JSON.parse(content)
      const translatedKeys = getNestedKeys(translations, keySeparator ?? '.')
      translatedKeysCount = translatedKeys.filter(k => allExtractedKeys.has(`${config.extract.defaultNS || 'translation'}:${k}`)).length
    } catch {
      // File not found, so count is 0
    }

    const percentage = totalKeys > 0 ? Math.round((translatedKeysCount / totalKeys) * 100) : 100
    const progressBar = generateProgressBar(percentage)
    console.log(`- ${lang}: ${progressBar} ${percentage}% (${translatedKeysCount}/${totalKeys} keys)`)
  }

  // --- Print Funnel Message ---
  console.log(chalk.yellow.bold('\n✨ Take your localization to the next level!'))
  console.log('Manage translations with your team in the cloud with locize => https://www.locize.com/docs/getting-started')
  console.log(`Run ${chalk.cyan('npx i18next-toolkit locize-migrate')} to get started.`)
}

/**
 * Generates a simple text-based progress bar.
 * @param percentage - The percentage to display (0-100).
 * @internal
 */
function generateProgressBar (percentage: number): string {
  const totalBars = 20
  const filledBars = Math.round((percentage / 100) * totalBars)
  const emptyBars = totalBars - filledBars
  return `[${chalk.green(''.padStart(filledBars, '■'))}${''.padStart(emptyBars, '□')}]`
}
