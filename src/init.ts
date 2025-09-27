import inquirer from 'inquirer'
import { writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { detectConfig } from './heuristic-config'

/**
 * Determines if the current project is configured as an ESM project.
 * Checks the package.json file for `"type": "module"`.
 *
 * @returns Promise resolving to true if ESM, false if CommonJS
 *
 * @example
 * ```typescript
 * const isESM = await isEsmProject()
 * if (isESM) {
 *   // Generate ESM syntax
 * } else {
 *   // Generate CommonJS syntax
 * }
 * ```
 */
async function isEsmProject (): Promise<boolean> {
  try {
    const packageJsonPath = resolve(process.cwd(), 'package.json')
    const content = await readFile(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(content)
    return packageJson.type === 'module'
  } catch {
    return true // Default to ESM if package.json is not found or readable
  }
}

/**
 * Interactive setup wizard for creating a new i18next-cli configuration file.
 *
 * This function provides a guided setup experience that:
 * 1. Asks the user for their preferred configuration file type (TypeScript or JavaScript)
 * 2. Collects basic project settings (locales, input patterns, output paths)
 * 3. Detects the project module system (ESM vs CommonJS) for JavaScript files
 * 4. Generates an appropriate configuration file with proper syntax
 * 5. Provides helpful defaults for common use cases
 *
 * The generated configuration includes:
 * - Locale specification
 * - Input file patterns for source scanning
 * - Output path templates with placeholders
 * - Proper imports and exports for the detected module system
 * - JSDoc type annotations for JavaScript files
 *
 * @example
 * ```typescript
 * // Run the interactive setup
 * await runInit()
 *
 * // This will create either:
 * // - i18next.config.ts (TypeScript)
 * // - i18next.config.js (JavaScript ESM/CommonJS)
 * ```
 */
export async function runInit () {
  console.log('Welcome to the i18next-cli setup wizard!')
  console.log('Scanning your project for a recommended configuration...')

  const detectedConfig = await detectConfig()
  if (detectedConfig) {
    console.log('✅ Found a potential project structure. Using it for suggestions.')
  } else {
    console.log('Could not detect a project structure. Using standard defaults.')
  }
  if (typeof detectedConfig?.extract?.input === 'string') detectedConfig.extract.input = [detectedConfig?.extract?.input]

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'fileType',
      message: 'What kind of configuration file do you want?',
      choices: ['TypeScript (i18next.config.ts)', 'JavaScript (i18next.config.js)'],
    },
    {
      type: 'input',
      name: 'locales',
      message: 'What locales does your project support? (comma-separated)',
      default: detectedConfig?.locales?.join(',') || 'en,de,fr',
      filter: (input: string) => input.split(',').map(s => s.trim()),
    },
    {
      type: 'input',
      name: 'input',
      message: 'What is the glob pattern for your source files?',
      default: detectedConfig?.extract?.input ? (detectedConfig.extract.input || [])[0] : 'src/**/*.{js,jsx,ts,tsx}',
    },
    {
      type: 'input',
      name: 'output',
      message: 'What is the path for your output resource files?',
      default: detectedConfig?.extract?.output || 'public/locales/{{language}}/{{namespace}}.json',
    },
  ])

  const isTypeScript = answers.fileType.includes('TypeScript')
  const isEsm = await isEsmProject()
  const fileName = isTypeScript ? 'i18next.config.ts' : 'i18next.config.js'

  const configObject = {
    locales: answers.locales,
    extract: {
      input: answers.input,
      output: answers.output,
    },
  }

  // Helper to serialize a JS value as a JS literal:
  function toJs (value: any, indent = 2, level = 0): string {
    const pad = (n: number) => ' '.repeat(n * indent)
    const currentPad = pad(level)
    const nextPad = pad(level + 1)

    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return JSON.stringify(value)
    }
    if (typeof value === 'string') {
      return JSON.stringify(value) // keeps double quotes and proper escaping
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]'
      const items = value.map(v => `${nextPad}${toJs(v, indent, level + 1)}`).join(',\n')
      return `[\n${items}\n${currentPad}]`
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value)
      if (keys.length === 0) return '{}'
      const entries = keys.map(key => {
        // Use unquoted key if it's a valid identifier otherwise JSON.stringify(key)
        const validId = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        const printedKey = validId ? key : JSON.stringify(key)
        return `${nextPad}${printedKey}: ${toJs(value[key], indent, level + 1)}`
      }).join(',\n')
      return `{\n${entries}\n${currentPad}}`
    }

    // Fallback
    return JSON.stringify(value)
  }

  let fileContent = ''
  if (isTypeScript) {
    fileContent = `import { defineConfig } from 'i18next-cli';

export default defineConfig(${toJs(configObject)});`
  } else if (isEsm) {
    fileContent = `import { defineConfig } from 'i18next-cli';

/** @type {import('i18next-cli').I18nextToolkitConfig} */
export default defineConfig(${toJs(configObject)});`
  } else { // CJS
    fileContent = `const { defineConfig } = require('i18next-cli');

/** @type {import('i18next-cli').I18nextToolkitConfig} */
module.exports = defineConfig(${toJs(configObject)});`
  }

  const outputPath = resolve(process.cwd(), fileName)
  await writeFile(outputPath, fileContent.trim())

  console.log(`✅ Configuration file created at: ${outputPath}`)
}
