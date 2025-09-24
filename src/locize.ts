import { execa } from 'execa'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { resolve } from 'node:path'
import type { I18nextToolkitConfig } from './types'

/**
 * Verifies that the locize-cli tool is installed and accessible.
 *
 * @throws Exits the process with error code 1 if locize-cli is not found
 *
 * @example
 * ```typescript
 * await checkLocizeCliExists()
 * // Continues execution if locize-cli is available
 * // Otherwise exits with installation instructions
 * ```
 */
async function checkLocizeCliExists (): Promise<void> {
  try {
    await execa('locize', ['--version'])
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.error(chalk.red('Error: `locize-cli` command not found.'))
      console.log(chalk.yellow('Please install it globally to use the locize integration:'))
      console.log(chalk.cyan('npm install -g locize-cli'))
      process.exit(1)
    }
  }
}

/**
 * Interactive setup wizard for configuring Locize credentials.
 *
 * This function guides users through setting up their Locize integration when
 * configuration is missing or invalid. It:
 * 1. Prompts for Project ID, API Key, and version
 * 2. Validates required fields
 * 3. Temporarily sets credentials for the current run
 * 4. Provides security recommendations for storing credentials
 * 5. Shows code examples for proper configuration
 *
 * @param config - Configuration object to update with new credentials
 * @returns Promise resolving to the Locize configuration or undefined if setup was cancelled
 *
 * @example
 * ```typescript
 * const locizeConfig = await interactiveCredentialSetup(config)
 * if (locizeConfig) {
 *   // Proceed with sync using the new credentials
 * }
 * ```
 */
async function interactiveCredentialSetup (config: I18nextToolkitConfig): Promise<{ projectId?: string, apiKey?: string, version?: string } | undefined> {
  console.log(chalk.yellow('\nLocize configuration is missing or invalid. Let\'s set it up!'))

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectId',
      message: 'What is your locize Project ID? (Find this in your project settings on www.locize.app)',
      validate: input => !!input || 'Project ID cannot be empty.',
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'What is your locize API key? (Create or use one in your project settings > "API Keys")',
      validate: input => !!input || 'API Key cannot be empty.',
    },
    {
      type: 'input',
      name: 'version',
      message: 'What version do you want to sync with?',
      default: 'latest',
    },
  ])

  if (!answers.projectId) {
    console.error(chalk.red('Project ID is required to continue.'))
    return undefined
  }

  // Use the entered credentials for the current run
  config.locize = {
    projectId: answers.projectId,
    apiKey: answers.apiKey,
    version: answers.version,
  }

  const { save } = await inquirer.prompt([{
    type: 'confirm',
    name: 'save',
    message: 'Would you like to see how to save these credentials for future use?',
    default: true,
  }])

  if (save) {
    const envSnippet = `
# Add this to your .env file (and ensure .env is in your .gitignore!)
LOCIZE_API_KEY=${answers.apiKey}
`
    const configSnippet = `
  // Add this to your i18next.config.ts file
  locize: {
    projectId: '${answers.projectId}',
    // For security, apiKey is best set via an environment variable
    apiKey: process.env.LOCIZE_API_KEY,
    version: '${answers.version}',
  },`

    console.log(chalk.cyan('\nGreat! For the best security, we recommend using environment variables for your API key.'))
    console.log(chalk.bold('\nRecommended approach (.env file):'))
    console.log(chalk.green(envSnippet))
    console.log(chalk.bold('Then, in your i18next.config.ts:'))
    console.log(chalk.green(configSnippet))
  }

  return config.locize
}

/**
 * Converts CLI options and configuration into locize-cli command arguments.
 *
 * Maps toolkit configuration and CLI flags to the appropriate locize-cli arguments:
 * - `updateValues` → `--update-values`
 * - `sourceLanguageOnly` → `--reference-language-only`
 * - `compareModificationTime` → `--compare-modification-time`
 * - `dryRun` → `--dry`
 *
 * @param command - The locize command being executed
 * @param cliOptions - CLI options passed to the command
 * @param locizeConfig - Locize configuration from the config file
 * @returns Array of command-line arguments
 *
 * @example
 * ```typescript
 * const args = cliOptionsToArgs('sync', { updateValues: true }, { dryRun: false })
 * // Returns: ['--update-values', 'true']
 * ```
 */
function cliOptionsToArgs (command: 'sync' | 'download' | 'migrate', cliOptions: any = {}, locizeConfig: any = {}) {
  const commandArgs: string[] = []

  // Pass-through options
  if (command === 'sync') {
    const updateValues = cliOptions.updateValues ?? locizeConfig.updateValues
    if (updateValues) commandArgs.push('--update-values', 'true')
    const srcLngOnly = cliOptions.srcLngOnly ?? locizeConfig.sourceLanguageOnly
    if (srcLngOnly) commandArgs.push('--reference-language-only', 'true')
    const compareMtime = cliOptions.compareMtime ?? locizeConfig.compareModificationTime
    if (compareMtime) commandArgs.push('--compare-modification-time', 'true')
    const dryRun = cliOptions.dryRun ?? locizeConfig.dryRun
    if (dryRun) commandArgs.push('--dry', 'true')
  }

  return commandArgs
}

/**
 * Executes a locize-cli command with proper error handling and credential management.
 *
 * This is the core function that:
 * 1. Validates that locize-cli is installed
 * 2. Builds command arguments from configuration and CLI options
 * 3. Executes the locize command with proper credential handling
 * 4. Provides interactive credential setup on authentication errors
 * 5. Handles retries with new credentials
 * 6. Reports success or failure with appropriate exit codes
 *
 * @param command - The locize command to execute ('sync', 'download', or 'migrate')
 * @param config - The toolkit configuration with locize settings
 * @param cliOptions - Additional options passed from CLI arguments
 *
 * @example
 * ```typescript
 * // Sync local files to Locize
 * await runLocizeCommand('sync', config, { updateValues: true })
 *
 * // Download translations from Locize
 * await runLocizeCommand('download', config)
 *
 * // Migrate local files to a new Locize project
 * await runLocizeCommand('migrate', config)
 * ```
 */
async function runLocizeCommand (command: 'sync' | 'download' | 'migrate', config: I18nextToolkitConfig, cliOptions: any = {}) {
  await checkLocizeCliExists()

  const locizeConfig = config.locize || {}
  const { projectId, apiKey, version } = locizeConfig
  let commandArgs: string[] = [command]

  if (projectId) commandArgs.push('--project-id', projectId)
  if (apiKey) commandArgs.push('--api-key', apiKey)
  if (version) commandArgs.push('--ver', version)
  // TODO: there might be more configurable locize-cli options in future

  commandArgs.push(...cliOptionsToArgs(command, cliOptions, locizeConfig))

  const basePath = resolve(process.cwd(), config.extract.output.split('/{{language}}/')[0])
  commandArgs.push('--path', basePath)

  try {
    console.log(chalk.cyan(`\nRunning 'locize ${commandArgs.join(' ')}'...`))
    const result = await execa('locize', commandArgs, { stdio: 'pipe' })
    if (result?.stdout) console.log(result.stdout) // Print captured output on success
  } catch (error: any) {
    const stderr = error.stderr || ''
    if (stderr.includes('missing required argument')) {
      // Fallback to interactive setup
      const newCredentials = await interactiveCredentialSetup(config)
      if (newCredentials) {
        // Retry the command with the new credentials
        commandArgs = [command]
        if (newCredentials.projectId) commandArgs.push('--project-id', newCredentials.projectId)
        if (newCredentials.apiKey) commandArgs.push('--api-key', newCredentials.apiKey)
        if (newCredentials.version) commandArgs.push('--ver', newCredentials.version)
        // TODO: there might be more configurable locize-cli options in future
        commandArgs.push(...cliOptionsToArgs(command, cliOptions, locizeConfig))
        commandArgs.push('--path', basePath)
        try {
          console.log(chalk.cyan('\nRetrying with new credentials...'))
          const result = await execa('locize', commandArgs, { stdio: 'pipe' })
          if (result?.stdout) console.log(result.stdout) // Print captured output on success
        } catch (retryError: any) {
          console.error(chalk.red('\nError during retry:'))
          console.error(retryError.stderr || retryError.message)
          process.exit(1)
        }
      } else {
        process.exit(1) // User aborted the prompt
      }
    } else {
      // Handle other errors
      console.error(chalk.red(`\nError executing 'locize ${command}':`))
      console.error(stderr || error.message)
      process.exit(1)
    }
  }
  console.log(chalk.green(`\n✅ 'locize ${command}' completed successfully.`))
}

export const runLocizeSync = (config: I18nextToolkitConfig, cliOptions?: any) => runLocizeCommand('sync', config, cliOptions)
export const runLocizeDownload = (config: I18nextToolkitConfig, cliOptions?: any) => runLocizeCommand('download', config, cliOptions)
export const runLocizeMigrate = (config: I18nextToolkitConfig, cliOptions?: any) => runLocizeCommand('migrate', config, cliOptions)
