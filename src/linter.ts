import { glob } from 'glob'
import { readFile } from 'node:fs/promises'
import { parse } from '@swc/core'
import { extname } from 'node:path'
import { EventEmitter } from 'node:events'
import chalk from 'chalk'
import ora from 'ora'
import type { I18nextToolkitConfig } from './types'

type LinterEventMap = {
  progress: [{
    message: string;
  }];
  done: [{
    success: boolean;
    message: string;
    files: Record<string, HardcodedString[]>;
  }];
  error: [error: Error];
}

const recommendedAcceptedTags = [
  'a', 'abbr', 'address', 'article', 'aside', 'bdi', 'bdo', 'blockquote', 'button', 'caption', 'cite', 'code', 'data', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dt', 'em', 'figcaption', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'img', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'nav', 'option', 'output', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'td', 'textarea', 'th', 'time', 'title', 'var'
].map(s => s.toLowerCase())
const recommendedAcceptedAttributes = ['abbr', 'accesskey', 'alt', 'aria-description', 'aria-label', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'content', 'label', 'placeholder', 'summary', 'title'].map(s => s.toLowerCase())
const defaultIgnoredAttributes = ['className', 'key', 'id', 'style', 'href', 'i18nKey', 'defaults', 'type', 'target'].map(s => s.toLowerCase())
const defaultIgnoredTags = ['script', 'style', 'code']

export class Linter extends EventEmitter<LinterEventMap> {
  private config: I18nextToolkitConfig

  constructor (config: I18nextToolkitConfig) {
    super({ captureRejections: true })
    this.config = config
  }

  wrapError (error: unknown) {
    const prefix = 'Linter failed to run: '
    if (error instanceof Error) {
      if (error.message.startsWith(prefix)) {
        return error
      }
      const wrappedError = new Error(`${prefix}${error.message}`)
      wrappedError.stack = error.stack
      return wrappedError
    }
    return new Error(`${prefix}${String(error)}`)
  }

  async run () {
    const { config } = this
    try {
      this.emit('progress', { message: 'Finding source files to analyze...' })
      const defaultIgnore = ['node_modules/**']
      const extractIgnore = Array.isArray(config.extract.ignore)
        ? config.extract.ignore
        : config.extract.ignore ? [config.extract.ignore] : []
      const lintIgnore = Array.isArray(config.lint?.ignore)
        ? config.lint.ignore
        : config.lint?.ignore ? [config.lint.ignore] : []

      const sourceFiles = await glob(config.extract.input, {
        ignore: [...defaultIgnore, ...extractIgnore, ...lintIgnore]
      })
      this.emit('progress', { message: `Analyzing ${sourceFiles.length} source files...` })
      let totalIssues = 0
      const issuesByFile = new Map<string, HardcodedString[]>()

      for (const file of sourceFiles) {
        const code = await readFile(file, 'utf-8')

        // Determine parser options from file extension so .ts is not parsed as TSX
        const fileExt = extname(file).toLowerCase()
        const isTypeScriptFile = fileExt === '.ts' || fileExt === '.tsx' || fileExt === '.mts' || fileExt === '.cts'
        const isTSX = fileExt === '.tsx'
        const isJSX = fileExt === '.jsx'

        let ast: any
        try {
          ast = await parse(code, {
            syntax: isTypeScriptFile ? 'typescript' : 'ecmascript',
            tsx: isTSX,
            jsx: isJSX,
            decorators: true
          })
        } catch (err) {
          // Fallback for .ts files with JSX
          if (fileExt === '.ts' && !isTSX) {
            try {
              ast = await parse(code, {
                syntax: 'typescript',
                tsx: true,
                decorators: true
              })
              this.emit('progress', { message: `Parsed ${file} using TSX fallback` })
            } catch (err2) {
              const wrapped = this.wrapError(err2)
              this.emit('error', wrapped)
              continue
            }
          // Fallback for .js files with JSX
          } else if (fileExt === '.js' && !isJSX) {
            try {
              ast = await parse(code, {
                syntax: 'ecmascript',
                jsx: true,
                decorators: true
              })
              this.emit('progress', { message: `Parsed ${file} using JSX fallback` })
            } catch (err2) {
              const wrapped = this.wrapError(err2)
              this.emit('error', wrapped)
              continue
            }
          } else {
            const wrapped = this.wrapError(err)
            this.emit('error', wrapped)
            continue
          }
        }

        const hardcodedStrings = findHardcodedStrings(ast, code, config)

        if (hardcodedStrings.length > 0) {
          totalIssues += hardcodedStrings.length
          issuesByFile.set(file, hardcodedStrings)
        }
      }

      const files = Object.fromEntries(issuesByFile.entries())
      const data = { success: totalIssues === 0, message: totalIssues > 0 ? `Linter found ${totalIssues} potential issues.` : 'No issues found.', files }
      this.emit('done', data)
      return data
    } catch (error) {
      const wrappedError = this.wrapError(error)
      this.emit('error', wrappedError)
      throw wrappedError
    }
  }
}

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
 * ```
 */
export async function runLinter (config: I18nextToolkitConfig) {
  return new Linter(config).run()
}

export async function runLinterCli (config: I18nextToolkitConfig) {
  const linter = new Linter(config)
  const spinner = ora().start()
  linter.on('progress', (event) => {
    spinner.text = event.message
  })
  try {
    const { success, message, files } = await linter.run()
    if (!success) {
      spinner.fail(chalk.red.bold(message))

      // Print detailed report after spinner fails
      for (const [file, issues] of Object.entries(files)) {
        console.log(chalk.yellow(`\n${file}`))
        issues.forEach(({ text, line }) => {
          console.log(`  ${chalk.gray(`${line}:`)} ${chalk.red('Error:')} Found hardcoded string: "${text}"`)
        })
      }
      process.exit(1)
    } else {
      spinner.succeed(chalk.green.bold(message))
    }
  } catch (error) {
    const wrappedError = linter.wrapError(error)
    spinner.fail(wrappedError.message)
    console.error(wrappedError)
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
 * ```
 */
function findHardcodedStrings (ast: any, code: string, config: I18nextToolkitConfig): HardcodedString[] {
  const issues: HardcodedString[] = []
  // A list of AST nodes that have been identified as potential issues.
  const nodesToLint: any[] = []

  const getLineNumber = (pos: number): number => {
    return code.substring(0, pos).split('\n').length
  }

  const transComponents = (config.extract.transComponents || ['Trans']).map((s: string) => s.toLowerCase())
  const customIgnoredTags = (config?.lint?.ignoredTags || config.extract.ignoredTags || []).map((s: string) => s.toLowerCase())
  const allIgnoredTags = new Set([...transComponents, ...defaultIgnoredTags.map(s => s.toLowerCase()), ...customIgnoredTags])
  const customIgnoredAttributes = (config?.lint?.ignoredAttributes || config.extract.ignoredAttributes || []).map((s: string) => s.toLowerCase())
  const ignoredAttributes = new Set([...defaultIgnoredAttributes, ...customIgnoredAttributes])
  const lintAcceptedTags = config?.lint?.acceptedTags ? config.lint.acceptedTags : null
  const extractAcceptedTags = config?.extract?.acceptedTags ? config.extract.acceptedTags : null
  const acceptedTagsList = (lintAcceptedTags ?? extractAcceptedTags ?? recommendedAcceptedTags)?.map((s: string) => s.toLowerCase()) ?? null
  const lintAcceptedAttrs = config?.lint?.acceptedAttributes ? config.lint.acceptedAttributes : null
  const extractAcceptedAttrs = config?.extract?.acceptedAttributes ? config.extract.acceptedAttributes : null
  const acceptedAttributesList = (lintAcceptedAttrs ?? extractAcceptedAttrs ?? recommendedAcceptedAttributes)?.map((s: string) => s.toLowerCase()) ?? null
  const acceptedTagsSet = acceptedTagsList && acceptedTagsList.length > 0 ? new Set(acceptedTagsList) : null
  const acceptedAttributesSet = acceptedAttributesList && acceptedAttributesList.length > 0 ? new Set(acceptedAttributesList) : null

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

    const rawName = fromIdentifier(nameNode)
    return rawName ? String(rawName) : null
  }

  // Helper: extract attribute name from a JSXAttribute.name node
  const extractAttrName = (nameNode: any): string | null => {
    if (!nameNode) return null

    // Direct string (unlikely, but be defensive)
    if (typeof nameNode === 'string') return nameNode

    // Common SWC shapes:
    // JSXIdentifier: { type: 'JSXIdentifier', value: 'alt' } or { name: 'alt' }
    if (nameNode.type === 'JSXIdentifier' || nameNode.type === 'Identifier') {
      const n = (nameNode.name ?? nameNode.value ?? nameNode.raw ?? null)
      return n ? String(n) : null
    }

    // JSXNamespacedName: { type: 'JSXNamespacedName', namespace: {...}, name: {...} }
    if (nameNode.type === 'JSXNamespacedName') {
      // prefer the local name (after the colon)
      return extractAttrName(nameNode.name) ?? extractAttrName(nameNode.namespace)
    }

    // Member-like expressions (defensive)
    if (nameNode.type === 'JSXMemberExpression') {
      const left = extractAttrName(nameNode.object)
      const right = extractAttrName(nameNode.property)
      if (left && right) return `${left}.${right}`
      return right ?? left
    }

    // Some AST variants put the identifier under `.name` or `.value`
    if (nameNode.name || nameNode.value || nameNode.property) {
      return (nameNode.name ?? nameNode.value ?? nameNode.property?.name ?? nameNode.property?.value ?? null)
    }

    // Last-resort: try to stringify and extract an identifier-looking token
    try {
      const s = JSON.stringify(nameNode)
      const m = /"?(?:name|value)"?\s*:\s*"?([a-zA-Z0-9_\-:.$]+)"?/.exec(s)
      return m ? m[1] : null
    } catch {
      return null
    }
  }

  // Helper: return true if any JSX ancestor is in the ignored tags set
  const isWithinIgnoredElement = (ancestors: any[]): boolean => {
    // First: if ANY ancestor is in the ignored set -> ignore (ignored always wins)
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const an = ancestors[i]
      if (!an || typeof an !== 'object') continue
      if (an.type === 'JSXElement' || an.type === 'JSXOpeningElement' || an.type === 'JSXSelfClosingElement') {
        const name = extractJSXName(an)
        if (!name) continue
        if (allIgnoredTags.has(String(name).toLowerCase())) return true
      }
    }

    // If acceptedTags is set: use nearest enclosing JSX element to decide acceptance
    if (acceptedTagsSet) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const an = ancestors[i]
        if (!an || typeof an !== 'object') continue
        if (an.type === 'JSXElement' || an.type === 'JSXOpeningElement' || an.type === 'JSXSelfClosingElement') {
          const name = extractJSXName(an)
          if (!name) continue
          return !acceptedTagsSet.has(String(name).toLowerCase())
        }
      }
      // no enclosing element found -> treat as ignored
      return true
    }

    // Default: not inside an ignored element
    return false
  }

  // --- PHASE 1: Collect all potentially problematic nodes ---
  const walk = (node: any, ancestors: any[]) => {
    if (!node || typeof node !== 'object') return

    const currentAncestors = [...ancestors, node]

    if (node.type === 'JSXText') {
      // If acceptedAttributesSet exists but acceptedTagsSet does not, we're in attribute-only mode:
      // do not collect JSXText nodes when attribute-only mode is active.
      if (acceptedAttributesSet && !acceptedTagsSet) {
        // attribute-only mode: skip JSXText
      } else {
        const isIgnored = isWithinIgnoredElement(currentAncestors)
        if (!isIgnored) {
          const text = node.value.trim()
          if (text && text.length > 1 && text !== '...' && !isUrlOrPath(text) && isNaN(Number(text)) && !text.startsWith('{{')) {
            nodesToLint.push(node)
          }
        }
      }
    }

    if (node.type === 'StringLiteral') {
      const parent = currentAncestors[currentAncestors.length - 2]
      // Determine whether this attribute is inside any ignored element (handles nested Trans etc.)
      const insideIgnored = isWithinIgnoredElement(currentAncestors)

      if (parent?.type === 'JSXAttribute' && !insideIgnored) {
        const rawAttrName = extractAttrName(parent.name)
        const attrNameLower = rawAttrName ? String(rawAttrName).toLowerCase() : null
        // Check tag-level acceptance if acceptedTagsSet provided: attributes should only be considered
        // when the nearest enclosing element is accepted.
        const parentElement = currentAncestors.slice(0, -2).reverse().find(a => a && typeof a === 'object' && (a.type === 'JSXElement' || a.type === 'JSXOpeningElement' || a.type === 'JSXSelfClosingElement'))
        if (acceptedTagsSet && parentElement) {
          const parentName = extractJSXName(parentElement)
          if (!parentName || !acceptedTagsSet.has(String(parentName).toLowerCase())) {
            // attribute is inside a non-accepted tag -> skip
            return
          }
        } else if (acceptedTagsSet && !parentElement) {
          // no enclosing element -> skip
          return
        }

        // If acceptedAttributesSet exists, only lint attributes explicitly accepted.
        const shouldLintAttribute = acceptedAttributesSet
          ? (attrNameLower != null && acceptedAttributesSet.has(attrNameLower))
          : (attrNameLower != null ? !ignoredAttributes.has(attrNameLower) : false)
        if (shouldLintAttribute) {
          const text = node.value.trim()
          // Filter out: empty strings, URLs, numbers, and ellipsis
          if (text && text !== '...' && !isUrlOrPath(text) && isNaN(Number(text))) {
            nodesToLint.push(node) // Collect the node
          }
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
