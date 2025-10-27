import { glob } from 'glob'
import { readFile } from 'node:fs/promises'
import { parse } from '@swc/core'
import chalk from 'chalk'
import ora from 'ora'
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
  const spinner = ora('Analyzing source files...\n').start()

  try {
    const defaultIgnore = ['node_modules/**']
    const userIgnore = Array.isArray(config.extract.ignore)
      ? config.extract.ignore
      : config.extract.ignore ? [config.extract.ignore] : []

    const sourceFiles = await glob(config.extract.input, {
      ignore: [...defaultIgnore, ...userIgnore]
    })
    let totalIssues = 0
    const issuesByFile = new Map<string, HardcodedString[]>()

    for (const file of sourceFiles) {
      const code = await readFile(file, 'utf-8')
      const ast = await parse(code, {
        syntax: 'typescript',
        tsx: true,
        decorators: true
      })
      const hardcodedStrings = findHardcodedStrings(ast, code, config)

      if (hardcodedStrings.length > 0) {
        totalIssues += hardcodedStrings.length
        issuesByFile.set(file, hardcodedStrings)
      }
    }

    if (totalIssues > 0) {
      spinner.fail(chalk.red.bold(`Linter found ${totalIssues} potential issues.`))

      // Print detailed report after spinner fails
      for (const [file, issues] of issuesByFile.entries()) {
        console.log(chalk.yellow(`\n${file}`))
        issues.forEach(({ text, line }) => {
          console.log(`  ${chalk.gray(`${line}:`)} ${chalk.red('Error:')} Found hardcoded string: "${text}"`)
        })
      }
      process.exit(1)
    } else {
      spinner.succeed(chalk.green.bold('No issues found.'))
    }
  } catch (error) {
    spinner.fail(chalk.red('Linter failed to run.'))
    console.error(error)
    process.exit(1)
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

const isUrlOrPath = (text: string) => /^(https|http|\/\/|^\/)/.test(text)

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
 * - Filters out ellipsis/spread operator notation `...`
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
  // A list of AST nodes that have been identified as potential issues.
  const nodesToLint: any[] = []

  const getLineNumber = (pos: number): number => {
    return code.substring(0, pos).split('\n').length
  }

  const transComponents = config.extract.transComponents || ['Trans']
  const defaultIgnoredAttributes = ['className', 'key', 'id', 'style', 'href', 'i18nKey', 'defaults', 'type', 'target']
  const defaultIgnoredTags = ['script', 'style', 'code']
  const customIgnoredTags = config.extract.ignoredTags || []
  const allIgnoredTags = new Set([...transComponents, ...defaultIgnoredTags, ...customIgnoredTags])
  const customIgnoredAttributes = config.extract.ignoredAttributes || []
  const ignoredAttributes = new Set([...defaultIgnoredAttributes, ...customIgnoredAttributes])

  // Helper: robustly extract a JSX element name from different node shapes
  const extractJSXName = (node: any): string | null => {
    if (!node) return null
    // node might be JSXOpeningElement / JSXSelfClosingElement (has .name)
    const nameNode = node.name ?? node.opening?.name ?? node.opening?.name
    if (!nameNode) {
      // maybe this node is a full JSXElement with opening.name
      if (node.opening?.name) return extractJSXName({ name: node.opening.name })
      return null
    }

    const fromIdentifier = (n: any): string | null => {
      if (!n) return null
      if (n.type === 'JSXIdentifier' && (n.name || n.value)) return (n.name ?? n.value)
      if (n.type === 'Identifier' && (n.name || n.value)) return (n.name ?? n.value)
      if (n.type === 'JSXMemberExpression') {
        const object = fromIdentifier(n.object)
        const property = fromIdentifier(n.property)
        return object && property ? `${object}.${property}` : (property ?? object)
      }
      // fallback attempts
      return n.name ?? n.value ?? n.property?.name ?? n.property?.value ?? null
    }

    return fromIdentifier(nameNode)
  }

  // Helper: return true if any JSX ancestor is in the ignored tags set
  const isWithinIgnoredElement = (ancestors: any[]): boolean => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const an = ancestors[i]
      if (!an || typeof an !== 'object') continue
      if (an.type === 'JSXElement' || an.type === 'JSXOpeningElement' || an.type === 'JSXSelfClosingElement') {
        const name = extractJSXName(an)
        if (name && allIgnoredTags.has(name)) return true
      }
    }
    return false
  }

  // --- PHASE 1: Collect all potentially problematic nodes ---
  const walk = (node: any, ancestors: any[]) => {
    if (!node || typeof node !== 'object') return

    const currentAncestors = [...ancestors, node]

    if (node.type === 'JSXText') {
      const isIgnored = isWithinIgnoredElement(currentAncestors)

      if (!isIgnored) {
        const text = node.value.trim()
        // Filter out: empty strings, single chars, URLs, numbers, interpolations, and ellipsis
        if (text && text.length > 1 && text !== '...' && !isUrlOrPath(text) && isNaN(Number(text)) && !text.startsWith('{{')) {
          nodesToLint.push(node) // Collect the node
        }
      }
    }

    if (node.type === 'StringLiteral') {
      const parent = currentAncestors[currentAncestors.length - 2]
      // Determine whether this attribute is inside any ignored element (handles nested Trans etc.)
      const insideIgnored = isWithinIgnoredElement(currentAncestors)

      if (parent?.type === 'JSXAttribute' && !ignoredAttributes.has(parent.name.value) && !insideIgnored) {
        const text = node.value.trim()
        // Filter out: empty strings, URLs, numbers, and ellipsis
        if (text && text !== '...' && !isUrlOrPath(text) && isNaN(Number(text))) {
          nodesToLint.push(node) // Collect the node
        }
      }
    }

    // Recurse into children
    for (const key of Object.keys(node)) {
      if (key === 'span') continue
      const child = node[key]
      if (Array.isArray(child)) {
        child.forEach(item => walk(item, currentAncestors))
      } else if (child && typeof child === 'object') {
        walk(child, currentAncestors)
      }
    }
  }

  walk(ast, []) // Run the walk to collect nodes

  // --- PHASE 2: Find line numbers using a tracked search on the raw source code ---
  let lastSearchIndex = 0
  for (const node of nodesToLint) {
    // For StringLiterals, the `raw` property includes the quotes ("..."), which is
    // much more unique for searching than the plain `value`.
    const searchText = node.raw ?? node.value

    const position = code.indexOf(searchText, lastSearchIndex)

    if (position > -1) {
      issues.push({
        text: node.value.trim(),
        line: getLineNumber(position),
      })
      lastSearchIndex = position + searchText.length
    }
  }

  return issues
}
