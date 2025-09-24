import { glob } from 'glob'
import { readFile } from 'node:fs/promises'
import { parse } from '@swc/core'
import { ancestor } from 'swc-walk'
import chalk from 'chalk'
import type { I18nextToolkitConfig } from './types'

/**
 * Runs the i18next linter to detect hardcoded strings and other potential issues.
 *
 * This function performs static analysis on source files to identify:
 * - Hardcoded text strings in JSX elements
 * - Hardcoded strings in JSX attributes (like alt text, titles, etc.)
 * - Text that should be extracted for translation
 *
 * The linter respects configuration settings:
 * - Uses the same input patterns as the extractor
 * - Ignores content inside configured Trans components
 * - Skips technical content like script/style tags
 * - Identifies numeric values and interpolation syntax to avoid false positives
 *
 * @param config - The toolkit configuration with input patterns and component names
 *
 * @example
 * ```typescript
 * const config = {
 *   extract: {
 *     input: ['src/**\/*.{ts,tsx}'],
 *     transComponents: ['Trans', 'Translation']
 *   }
 * }
 *
 * await runLinter(config)
 * // Outputs issues found or success message
 * // Exits with code 1 if issues found, 0 if clean
 * ```
 */
export async function runLinter (config: I18nextToolkitConfig) {
  console.log('Running i18next linter...')
  const sourceFiles = await glob(config.extract.input)
  let totalIssues = 0

  for (const file of sourceFiles) {
    const code = await readFile(file, 'utf-8')
    const ast = await parse(code, { syntax: 'typescript', tsx: true })

    const hardcodedStrings = findHardcodedStrings(ast, code, config)

    if (hardcodedStrings.length > 0) {
      console.log(chalk.yellow(`\n${file}`))
      hardcodedStrings.forEach(({ text, line }) => {
        totalIssues++
        console.log(`  ${chalk.gray(`${line}:`)} ${chalk.red('Error:')} Found hardcoded string: "${text}"`)
      })
    }
  }

  if (totalIssues > 0) {
    console.log(chalk.red.bold(`\n✖ Found ${totalIssues} potential issues.`))
    process.exit(1)
  } else {
    console.log(chalk.green.bold('\n✅ No issues found.'))
  }
}

/**
 * Represents a found hardcoded string with its location information.
 */
interface HardcodedString {
  /** The hardcoded text content */
  text: string;
  /** Line number where the string was found */
  line: number;
}

/**
 * Analyzes an AST to find potentially hardcoded strings that should be translated.
 *
 * This function traverses the syntax tree looking for:
 * 1. JSX text nodes with translatable content
 * 2. String literals in JSX attributes that might need translation
 *
 * It applies several filters to reduce false positives:
 * - Ignores content inside Trans components (already handled)
 * - Skips script and style tag content (technical, not user-facing)
 * - Filters out numeric values (usually not translatable)
 * - Ignores interpolation syntax starting with `{{`
 * - Only reports non-empty, trimmed strings
 *
 * @param ast - The parsed AST to analyze
 * @param code - Original source code for line number calculation
 * @param config - Configuration containing Trans component names
 * @returns Array of found hardcoded strings with location info
 *
 * @example
 * ```typescript
 * const issues = findHardcodedStrings(ast, sourceCode, config)
 * issues.forEach(issue => {
 *   console.log(`Line ${issue.line}: "${issue.text}"`)
 * })
 * ```
 */
function findHardcodedStrings (ast: any, code: string, config: I18nextToolkitConfig): HardcodedString[] {
  const issues: HardcodedString[] = []
  const lineStarts: number[] = [0]
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') lineStarts.push(i + 1)
  }

  /**
   * Converts a character position to a line number.
   *
   * @param pos - Character position in the source code
   * @returns Line number (1-based)
   */
  const getLineNumber = (pos: number): number => {
    let line = 1
    for (const start of lineStarts) {
      if (pos > start) line++; else break
    }
    return line - 1
  }

  const transComponents = config.extract.transComponents || ['Trans']

  ancestor(ast, {
    /**
     * Processes JSX text nodes to identify hardcoded content.
     *
     * @param node - JSX text node
     * @param ancestors - Array of ancestor nodes for context
     */
    JSXText (node: any, ancestors: any[]) {
      const parent = ancestors[ancestors.length - 2]
      const parentName = parent?.opening?.name?.value

      if (parentName && (transComponents.includes(parentName) || parentName === 'script' || parentName === 'style')) {
        return
      }

      const text = node.value.trim()
      if (text && isNaN(Number(text)) && !text.startsWith('{{')) {
        issues.push({ text, line: getLineNumber(node.span.start) })
      }
    },

    /**
     * Processes string literals in JSX attributes.
     *
     * @param node - String literal node
     * @param ancestors - Array of ancestor nodes for context
     */
    StringLiteral (node: any, ancestors: any[]) {
      const parent = ancestors[ancestors.length - 2]

      if (parent?.type === 'JSXAttribute') {
        const text = node.value.trim()
        if (text && isNaN(Number(text))) {
          issues.push({ text, line: getLineNumber(node.span.start) })
        }
      }
    },
  })
  return issues
}
