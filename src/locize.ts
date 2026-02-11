import { execa } from 'execa'
import { styleText } from 'node:util'
import ora from 'ora'
import inquirer from 'inquirer'
import { resolve, sep } from 'node:path'
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
      console.error(styleText('red', 'Error: `locize-cli` command not found.'))
      console.log(styleText('yellow', 'Please install it globally to use the Locize integration:'))
      console.log(styleText('cyan', 'npm install -g locize-cli'))
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
  console.log(styleText('yellow', '\nLocize configuration is missing or invalid. Let\'s set it up!'))

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectId',
      message: 'What is your Locize Project ID? (Find this in your project settings on www.locize.app)',
      validate: input => !!input || 'Project ID cannot be empty.',
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'What is your Locize API key? (Create or use one in your project settings > "API Keys")',
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
    console.error(styleText('red', 'Project ID is required to continue.'))
    return undefined
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

    console.log(styleText('cyan', '\nGreat! For the best security, we recommend using environment variables for your API key.'))
    console.log(styleText('bold', '\nRecommended approach (.env file):'))
    console.log(styleText('green', envSnippet))
    console.log(styleText('bold', 'Then, in your i18next.config.ts:'))
    console.log(styleText('green', configSnippet))
  }

  return {
    projectId: answers.projectId,
    apiKey: answers.apiKey,
    version: answers.version,
  }
}

/**
 * Helper function to build the array of arguments for the execa call.
 * This ensures the logic is consistent for both the initial run and the retry.
 */
function buildArgs (command: string, config: I18nextToolkitConfig, cliOptions: any): string[] {
  const { locize: locizeConfig = {}, extract } = config

  const commandArgs: string[] = [command]

  const projectId = cliOptions.projectId ?? locizeConfig.projectId
  if (projectId) commandArgs.push('--project-id', projectId)
  const apiKey = cliOptions.apiKey ?? locizeConfig.apiKey
  if (apiKey) commandArgs.push('--api-key', apiKey)
  const version = cliOptions.version ?? locizeConfig.version
  if (version) commandArgs.push('--ver', version)
  const cdnType = cliOptions.cdnType ?? locizeConfig.cdnType
  if (cdnType) commandArgs.push('--cdn-type', cdnType)
  // TODO: there might be more configurable locize-cli options in future

  // Pass-through options from the CLI
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

  // Derive a sensible base path for locize from the configured output.
  // If output is a string template we can strip the language placeholder.
  // If output is a function we cannot reliably infer the base; fall back to cwd.
  let basePath: string
  try {
    if (typeof extract.output === 'string') {
      const outputNormalized = extract.output.replace(/\\/g, '/')
      const baseCandidate = outputNormalized.includes('/{{language}}/')
        ? outputNormalized.split('/{{language}}/')[0]
        : outputNormalized.replace('{{language}}', '')
      const baseCandidateWithSep = baseCandidate.split('/').join(sep)
      basePath = resolve(process.cwd(), baseCandidateWithSep)
    } else if (typeof extract.output === 'function') {
      // Try calling the function with the primary language to get an example path,
      // then strip the language folder if present. If that fails, fallback to cwd.
      try {
        const sample = extract.output(config.extract.primaryLanguage || 'en')
        const sampleNormalized = String(sample).replace(/\\/g, '/')
        const baseCandidate = sampleNormalized.includes('/' + (config.extract.primaryLanguage || 'en') + '/')
          ? sampleNormalized.split('/' + (config.extract.primaryLanguage || 'en') + '/')[0]
          : sampleNormalized.replace(config.extract.primaryLanguage || 'en', '')
        basePath = resolve(process.cwd(), baseCandidate.split('/').join(sep))
      } catch {
        basePath = resolve(process.cwd(), '.')
      }
    } else {
      basePath = resolve(process.cwd(), '.')
    }
  } catch {
    basePath = resolve(process.cwd(), '.')
  }

  commandArgs.push('--path', basePath)

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

  const spinner = ora(`Running 'locize ${command}'...\n`).start()

  let effectiveConfig = config

  try {
    // 1. First attempt
    const initialArgs = buildArgs(command, effectiveConfig, cliOptions)
    console.log(styleText('cyan', `\nRunning 'locize ${initialArgs.join(' ')}'...`))
    const result = await execa('locize', initialArgs, { stdio: 'pipe' })

    spinner.succeed(styleText('green', `'locize ${command}' completed successfully.`))
    if (result?.stdout) console.log(result.stdout) // Print captured output on success
  } catch (error: any) {
    const stderr = error.stderr || ''
    if (stderr.includes('missing required argument')) {
      // 2. Auth failure, trigger interactive setup
      const newCredentials = await interactiveCredentialSetup(effectiveConfig)
      if (newCredentials) {
        effectiveConfig = { ...effectiveConfig, locize: newCredentials }

        spinner.start('Retrying with new credentials...')
        try {
          // 3. Retry attempt, rebuilding args with the NOW-UPDATED currentConfig object
          const retryArgs = buildArgs(command, effectiveConfig, cliOptions)
          console.log(styleText('cyan', `\nRunning 'locize ${retryArgs.join(' ')}'...`))
          const result = await execa('locize', retryArgs, { stdio: 'pipe' })

          spinner.succeed(styleText('green', 'Retry successful!'))
          if (result?.stdout) console.log(result.stdout)
        } catch (retryError: any) {
          spinner.fail(styleText('red', 'Error during retry.'))
          console.error(retryError.stderr || retryError.message)
          process.exit(1)
        }
      } else {
        spinner.fail('Operation cancelled.')
        process.exit(1) // User aborted the prompt
      }
    } else {
      // Handle other errors
      spinner.fail(styleText('red', `Error executing 'locize ${command}'.`))
      console.error(stderr || error.message)
      process.exit(1)
    }
  }
  console.log(styleText('green', `\n✅ 'locize ${command}' completed successfully.`))
}

export const runLocizeSync = (config: I18nextToolkitConfig, cliOptions?: any) => runLocizeCommand('sync', config, cliOptions)
export const runLocizeDownload = (config: I18nextToolkitConfig, cliOptions?: any) => runLocizeCommand('download', config, cliOptions)
export const runLocizeMigrate = (config: I18nextToolkitConfig, cliOptions?: any) => runLocizeCommand('migrate', config, cliOptions)
