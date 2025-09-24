import inquirer from 'inquirer'
import { writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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
 * Interactive setup wizard for creating a new i18next-toolkit configuration file.
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
  console.log('Welcome to the i18next-toolkit setup wizard!')

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
      default: 'en,de,fr',
      filter: (input: string) => input.split(',').map(s => s.trim()),
    },
    {
      type: 'input',
      name: 'input',
      message: 'What is the glob pattern for your source files?',
      default: 'src/**/*.{js,jsx,ts,tsx}',
    },
    {
      type: 'input',
      name: 'output',
      message: 'What is the path for your output resource files?',
      default: 'public/locales/{{language}}/{{namespace}}.json',
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

  let fileContent = ''
  if (isTypeScript) {
    fileContent = `import { defineConfig } from 'i18next-toolkit';

export default defineConfig(${JSON.stringify(configObject, null, 2)});`
  } else if (isEsm) {
    fileContent = `import { defineConfig } from 'i18next-toolkit';

/** @type {import('i18next-toolkit').I18nextToolkitConfig} */
export default defineConfig(${JSON.stringify(configObject, null, 2)});`
  } else { // CJS
    fileContent = `const { defineConfig } = require('i18next-toolkit');

/** @type {import('i18next-toolkit').I18nextToolkitConfig} */
module.exports = defineConfig(${JSON.stringify(configObject, null, 2)});`
  }

  const outputPath = resolve(process.cwd(), fileName)
  await writeFile(outputPath, fileContent.trim())

  console.log(`✅ Configuration file created at: ${outputPath}`)
}
