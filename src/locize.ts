import { execa } from 'execa'
import { styleText } from 'node:util'
import ora from 'ora'
import inquirer from 'inquirer'
import { resolve, sep } from 'node:path'
import type { I18nextToolkitConfig } from './types.js'

/**
 * Resolves the locize-cli executable to use.
 *
 * Tries, in order:
 * 1. A locally / globally installed `locize` binary
 * 2. Falls back to `npx locize-cli` so it can be fetched on demand
 *
 * If neither works the process exits with an error.
 *
 * @returns An object with `cmd` (the executable) and `prefixArgs` (extra args
 *          to prepend before the locize sub-command, e.g. `['locize-cli']`
 *          when running through npx).
 */
async function resolveLocizeBin (): Promise<{ cmd: string, prefixArgs: string[] } | null> {
  // 1. Try a locally / globally installed binary
  try {
    await execa('locize', ['--version'])
    return { cmd: 'locize', prefixArgs: [] }
  } catch {
    // not found – continue
  }

  // 2. Fall back to npx
  try {
    console.log(styleText('yellow', '`locize` command not found – trying npx...'))
    await execa('npx', ['locize-cli', '--version'])
    return { cmd: 'npx', prefixArgs: ['locize-cli'] }
  } catch {
    // npx also failed
  }

  return null
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
      message: 'Enter your Locize API key (Project settings → API → API Keys). If your project has no languages yet, use an API key with admin role.',
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
 * Masks an API key for safe console output, preserving only the first
 * and last 3 characters while replacing everything in between.
 */
function maskApiKey (apiKey: string): string {
  if (!apiKey || apiKey.length <= 6) return apiKey
  const first3 = apiKey.substring(0, 3)
  const last3 = apiKey.substring(apiKey.length - 3)
  const middle = apiKey.substring(3, apiKey.length - 3)
  return `${first3}${middle.replace(/[0-9a-zA-Z]/g, '*')}${last3}`
}

/**
 * Returns a display-safe copy of args with the `--api-key` value masked.
 */
function maskArgs (args: string[]): string[] {
  return args.map((arg, i) => {
    if (i > 0 && args[i - 1] === '--api-key') return maskApiKey(arg)
    return arg
  })
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

  if (command === 'migrate') {
    commandArgs.push('--download', 'true')
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
  const resolved = await resolveLocizeBin()
  if (!resolved) {
    console.error(styleText('red', 'Error: `locize-cli` command not found.'))
    console.log(styleText('yellow', 'Please install it to use the Locize integration:'))
    console.log(styleText('cyan', '  npm install -g locize-cli'))
    console.log(styleText('yellow', 'Or make sure npx is available so it can be fetched on demand.'))
    process.exit(1)
    return
  }
  const { cmd, prefixArgs } = resolved

  const spinner = ora(`Running 'locize ${command}'...\n`).start()

  let effectiveConfig = config

  try {
    // 1. First attempt
    const initialArgs = [...prefixArgs, ...buildArgs(command, effectiveConfig, cliOptions)]
    console.log(styleText('cyan', `\nRunning 'locize ${maskArgs(initialArgs.slice(prefixArgs.length)).join(' ')}'...`))
    const result = await execa(cmd, initialArgs, { stdio: 'pipe' })

    spinner.succeed(styleText('green', `'locize ${command}' completed successfully.`))
    if (result?.stdout) console.log(result.stdout) // Print captured output on success
  } catch (error: any) {
    const stderr = error.stderr || ''
    if (stderr.includes('missing required argument')) {
      // 2. Auth failure, trigger interactive setup
      spinner.stop()
      const newCredentials = await interactiveCredentialSetup(effectiveConfig)
      if (newCredentials) {
        effectiveConfig = { ...effectiveConfig, locize: newCredentials }

        spinner.start('Retrying with new credentials...')
        try {
          // 3. Retry attempt, rebuilding args with the NOW-UPDATED currentConfig object
          const retryArgs = [...prefixArgs, ...buildArgs(command, effectiveConfig, cliOptions)]
          console.log(styleText('cyan', `\nRunning 'locize ${maskArgs(retryArgs.slice(prefixArgs.length)).join(' ')}'...`))
          const result = await execa(cmd, retryArgs, { stdio: 'pipe' })

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
