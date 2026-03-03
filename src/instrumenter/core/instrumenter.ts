import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { glob } from 'glob'
import { extname, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { parse } from '@swc/core'
import type { Module } from '@swc/types'
import type { StringLiteral } from '@swc/core'
import inquirer from 'inquirer'
import { styleText } from 'node:util'
import type { Logger, I18nextToolkitConfig, InstrumenterOptions, CandidateString, FileInstrumentationResult, InstrumentationResults, ComponentBoundary, FileScanResult, LanguageChangeSite, Plugin } from '../../types'
import { detectCandidate } from './string-detector'
import { transformFile as performTransformation } from './transformer'
import { generateKeyFromContent, createKeyRegistry } from './key-generator'
import { createSpinnerLike } from '../../utils/wrap-ora'
import { ConsoleLogger } from '../../utils/logger'
import { ignoredAttributeSet } from '../../utils/jsx-attributes'
import { normalizeASTSpans, findFirstTokenIndex } from '../../extractor/parsers/ast-utils'
import { getOutputPath } from '../../utils/file-utils'

/**
 * Main orchestrator for the instrument command.
 * Scans source files for hardcoded strings and instruments them with i18next calls.
 *
 * @param config - Toolkit configuration
 * @param options - Instrumentation options (dry-run, interactive, etc.)
 * @param logger - Logger instance
 * @returns Instrumentation results
 */
export async function runInstrumenter (
  config: I18nextToolkitConfig,
  options: InstrumenterOptions,
  logger: Logger = new ConsoleLogger()
): Promise<InstrumentationResults> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)

  const spinner = createSpinnerLike('Scanning for hardcoded strings...\n', { quiet: !!options.quiet, logger })

  try {
    // Get list of source files
    const sourceFiles = await getSourceFilesForInstrumentation(config)
    spinner.text = `Scanning ${sourceFiles.length} files for hardcoded strings...`

    // Scan files for candidate strings
    const results: FileInstrumentationResult[] = []
    const keyRegistry = createKeyRegistry()
    let totalCandidates = 0
    let totalTransformed = 0
    let totalSkipped = 0
    let totalLanguageChanges = 0
    let usesI18nextT = false

    // Detect framework and language
    const hasReact = await isProjectUsingReact()
    const hasTypeScript = await isProjectUsingTypeScript()

    // Initialize plugins
    const plugins = config.plugins || []
    await initializeInstrumentPlugins(plugins, { config, logger })

    // Resolve target namespace
    let targetNamespace = options.namespace
    if (!targetNamespace && options.isInteractive) {
      const defaultNS = config.extract.defaultNS ?? 'translation'
      const { ns } = await inquirer.prompt([
        {
          type: 'input',
          name: 'ns',
          message: 'Target namespace for extracted keys:',
          default: typeof defaultNS === 'string' ? defaultNS : 'translation'
        }
      ])
      if (ns && ns !== defaultNS) {
        targetNamespace = ns
      }
    }

    for (const file of sourceFiles) {
      try {
        let content = await readFile(file, 'utf-8')

        // Run instrumentOnLoad plugin pipeline
        const loadResult = await runInstrumentOnLoadPipeline(content, file, plugins, logger)
        if (loadResult === null) continue // plugin says skip this file
        content = loadResult

        const scanResult = await scanFileForCandidates(content, file, config)
        let { candidates } = scanResult
        const { components, languageChangeSites } = scanResult

        // Run instrumentOnResult plugin pipeline
        candidates = await runInstrumentOnResultPipeline(file, candidates, plugins, logger)

        if (candidates.length === 0 && languageChangeSites.length === 0) {
          continue
        }

        totalCandidates += candidates.length

        // Handle interactive mode
        if (options.isInteractive) {
          // Ask user about each candidate
          for (const candidate of candidates) {
            const { action } = await inquirer.prompt([
              {
                type: 'list',
                name: 'action',
                message: `Translate: "${candidate.content}" (${candidate.line}:${candidate.column})?`,
                choices: [
                  { name: 'Approve', value: 'approve' },
                  { name: 'Skip', value: 'skip' },
                  { name: 'Edit key', value: 'edit-key' },
                  { name: 'Edit value', value: 'edit-value' }
                ]
              }
            ])

            switch (action) {
              case 'approve':
                candidate.key = generateKeyFromContent(candidate.content)
                break
              case 'skip':
                candidate.skipReason = 'User skipped'
                break
              case 'edit-key': {
                const { key } = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'key',
                    message: 'New key:',
                    default: generateKeyFromContent(candidate.content)
                  }
                ])
                candidate.key = key
                break
              }
              case 'edit-value': {
                const { value } = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'value',
                    message: 'New value:',
                    default: candidate.content
                  }
                ])
                candidate.content = value
                candidate.key = generateKeyFromContent(value)
                break
              }
            }
          }
        }

        // Filter candidates that were skipped by user
        const approvedCandidates = candidates.filter(c => !c.skipReason)

        if (approvedCandidates.length > 0 || languageChangeSites.length > 0) {
          // Generate keys for approved candidates
          for (const candidate of approvedCandidates) {
            if (!candidate.key) {
              candidate.key = keyRegistry.add(
                generateKeyFromContent(candidate.content),
                candidate.content
              )
            }
          }

          // Transform the file
          const transformResult = performTransformation(
            content,
            file,
            approvedCandidates,
            {
              isDryRun: options.isDryRun,
              hasReact,
              isPrimaryLanguageFile: true,
              config,
              components,
              namespace: targetNamespace,
              languageChangeSites
            }
          )

          if (!options.isDryRun && transformResult.modified) {
            // Write the transformed file
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, transformResult.newContent || content)
          }

          totalTransformed += transformResult.transformCount
          totalLanguageChanges += transformResult.languageChangeCount
          totalSkipped += candidates.length - approvedCandidates.length

          // Track whether any non-component candidate was transformed (i.e. i18next.t() was used)
          if (!usesI18nextT && approvedCandidates.some(c => !c.insideComponent && c.confidence >= 0.7)) {
            usesI18nextT = true
          }

          // Log any warnings (e.g. i18next.t() in React files)
          if (transformResult.warnings?.length) {
            for (const warning of transformResult.warnings) {
              logger.warn(warning)
            }
          }

          results.push({
            file,
            candidates: approvedCandidates,
            result: transformResult
          })
        } else {
          totalSkipped += candidates.length
        }
      } catch (err) {
        logger.warn(`Error processing ${file}:`, err)
      }
    }

    const langChangeSuffix = totalLanguageChanges > 0 ? `, ${totalLanguageChanges} language-change site(s)` : ''
    spinner.succeed(
      styleText('bold', `Scanned complete: ${totalCandidates} candidates, ${totalTransformed} approved${langChangeSuffix}`)
    )

    // Generate i18n init file if needed and any transformations were made
    if ((totalTransformed > 0 || totalLanguageChanges > 0) && !options.isDryRun) {
      const initFilePath = await ensureI18nInitFile(hasReact, hasTypeScript, config, logger, usesI18nextT)
      if (initFilePath) {
        await injectI18nImportIntoEntryFile(initFilePath, logger)
      }
    }

    // Return summary
    return {
      files: results,
      totalCandidates,
      totalTransformed,
      totalSkipped,
      totalLanguageChanges,
      extractedKeys: new Map()
    }
  } catch (error) {
    spinner.fail(styleText('red', 'Instrumentation failed'))
    throw error
  }
}

/**
 * Scans a source file for hardcoded string candidates and React component boundaries.
 */
async function scanFileForCandidates (
  content: string,
  file: string,
  config: I18nextToolkitConfig
): Promise<FileScanResult> {
  const candidates: CandidateString[] = []
  const components: ComponentBoundary[] = []
  const languageChangeSites: LanguageChangeSite[] = []
  const fileExt = extname(file).toLowerCase()
  const isTypeScriptFile = ['.ts', '.tsx', '.mts', '.cts'].includes(fileExt)
  const isTSX = fileExt === '.tsx'
  const isJSX = fileExt === '.jsx'

  try {
    // Parse the file
    let ast: Module
    try {
      ast = await parse(content, {
        syntax: isTypeScriptFile ? 'typescript' : 'ecmascript',
        tsx: isTSX,
        jsx: isJSX,
        decorators: true,
        dynamicImport: true,
        comments: true
      })
    } catch (err) {
      // Fallback parsing for .ts with JSX
      if (fileExt === '.ts' && !isTSX) {
        ast = await parse(content, {
          syntax: 'typescript',
          tsx: true,
          decorators: true,
          dynamicImport: true,
          comments: true
        })
      } else if (fileExt === '.js' && !isJSX) {
        ast = await parse(content, {
          syntax: 'ecmascript',
          jsx: true,
          decorators: true,
          dynamicImport: true,
          comments: true
        })
      } else {
        throw err
      }
    }

    // Normalize spans
    const firstTokenIdx = findFirstTokenIndex(content)
    const spanBase = ast.span.start - firstTokenIdx
    normalizeASTSpans(ast, spanBase)

    // Convert byte offsets → char indices for files with multi-byte characters.
    // SWC reports spans as UTF-8 byte offsets, but JavaScript strings and
    // MagicString use UTF-16 code-unit indices. Without this conversion,
    // every emoji / accented char / CJK char shifts all subsequent offsets.
    const byteToChar = buildByteToCharMap(content)
    if (byteToChar) {
      convertSpansToCharIndices(ast, byteToChar)
    }

    // Detect React function component boundaries
    detectComponentBoundaries(ast, content, components)

    // Visit AST to find string literals
    visitNodeForStrings(ast, content, file, config, candidates)

    // Detect JSX interpolation patterns (merge adjacent text + expression children)
    detectJSXInterpolation(ast, content, file, config, candidates)

    // Detect plural conditional patterns (ternary chains checking count === 0/1/other)
    detectPluralPatterns(ast, content, file, config, candidates)

    // Detect language-change call sites (e.g. updateSettings({ language: code }))
    detectLanguageChangeSites(ast, content, languageChangeSites)

    // Annotate candidates with their enclosing component (if any)
    for (const candidate of candidates) {
      for (const comp of components) {
        if (candidate.offset >= comp.bodyStart && candidate.endOffset <= comp.bodyEnd) {
          candidate.insideComponent = comp.name
          break
        }
      }
    }

    // Annotate language change sites with their enclosing component (if any)
    for (const site of languageChangeSites) {
      for (const comp of components) {
        if (site.callStart >= comp.bodyStart && site.callEnd <= comp.bodyEnd) {
          site.insideComponent = comp.name
          break
        }
      }
    }

    // Filter out candidates suppressed by ignore-comment directives.
    // Supported comments (line or block):
    //   // i18next-instrument-ignore-next-line
    //   // i18next-instrument-ignore
    //   /* i18next-instrument-ignore-next-line */
    //   /* i18next-instrument-ignore */
    const ignoredLines = collectIgnoredLines(content)
    if (ignoredLines.size > 0) {
      const keep: CandidateString[] = []
      for (const c of candidates) {
        const line = lineOfOffset(content, c.offset)
        if (!ignoredLines.has(line)) {
          keep.push(c)
        }
      }
      candidates.length = 0
      candidates.push(...keep)
    }
  } catch (err) {
    // Silently skip files that can't be parsed
  }

  return { candidates, components, languageChangeSites }
}

// ─── Ignore-comment helpers ──────────────────────────────────────────────────

/**
 * Regex that matches a directive comment requesting the instrumenter to skip
 * the **next** line. Works with both line comments (`// ...`) and block
 * comments. The supported directives are:
 *
 *   i18next-instrument-ignore-next-line
 *   i18next-instrument-ignore
 */
const IGNORE_RE = /i18next-instrument-ignore(?:-next-line)?/

/**
 * Scans `content` for ignore-directive comments and returns a Set of 1-based
 * line numbers whose strings should be excluded from instrumentation.
 */
function collectIgnoredLines (content: string): Set<number> {
  const ignored = new Set<number>()
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (IGNORE_RE.test(lines[i])) {
      // Directive on line i → suppress the *following* line (i + 1)
      // We store 1-based line numbers, so the suppressed line is i + 2
      ignored.add(i + 2)
    }
  }
  return ignored
}

/**
 * Returns the 1-based line number for a character offset.
 */
function lineOfOffset (content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

// ─── Component boundary detection ───────────────────────────────────────────

/**
 * Recursively detects React function component boundaries in the AST.
 *
 * Identifies:
 * - FunctionDeclaration with uppercase name: `function Greeting() { ... }`
 * - FunctionExpression with uppercase name: `export default function Greeting() { ... }`
 * - VariableDeclarator with uppercase name + arrow/function expression:
 *   `const Greeting = () => { ... }` or `const Greeting = function() { ... }`
 * - forwardRef wrappers: `const Greeting = React.forwardRef((props, ref) => { ... })`
 * - memo wrappers: `const Greeting = React.memo(() => { ... })`
 */
function detectComponentBoundaries (
  node: any,
  content: string,
  components: ComponentBoundary[]
): void {
  if (!node) return

  // FunctionDeclaration with uppercase name
  if (node.type === 'FunctionDeclaration' && node.identifier?.value && /^[A-Z]/.test(node.identifier.value)) {
    const body = node.body
    if (body?.type === 'BlockStatement' && body.span) {
      components.push({
        name: node.identifier.value,
        bodyStart: body.span.start,
        bodyEnd: body.span.end,
        hasUseTranslation: content.slice(body.span.start, body.span.end).includes('useTranslation')
      })
    }
  }

  // FunctionExpression with uppercase name.
  // Covers `export default function TasksPage() { ... }` — SWC represents the
  // function inside ExportDefaultDeclaration as a FunctionExpression, not a
  // FunctionDeclaration. Deduplicate against bodies already registered by the
  // VariableDeclarator path (e.g. `const Foo = function Foo() {}`).
  if (node.type === 'FunctionExpression' && node.identifier?.value && /^[A-Z]/.test(node.identifier.value)) {
    const body = node.body
    if (body?.type === 'BlockStatement' && body.span) {
      const alreadyRegistered = components.some(
        c => c.bodyStart === body.span.start && c.bodyEnd === body.span.end
      )
      if (!alreadyRegistered) {
        components.push({
          name: node.identifier.value,
          bodyStart: body.span.start,
          bodyEnd: body.span.end,
          hasUseTranslation: content.slice(body.span.start, body.span.end).includes('useTranslation')
        })
      }
    }
  }

  // VariableDeclarator with uppercase name
  if (node.type === 'VariableDeclarator' && node.id?.value && /^[A-Z]/.test(node.id.value)) {
    const init = node.init
    if (init) {
      // Direct arrow/function expression: const Greeting = () => { ... }
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        addComponentFromFunctionNode(node.id.value, init, content, components)
      }
      // Wrapped in a call: React.memo(...), React.forwardRef(...), memo(...), forwardRef(...)
      if (init.type === 'CallExpression') {
        const callee = init.callee
        const isWrapper =
          // React.forwardRef, React.memo
          (callee?.type === 'MemberExpression' &&
            (callee.property?.value === 'forwardRef' || callee.property?.value === 'memo')) ||
          // forwardRef, memo (direct import)
          (callee?.type === 'Identifier' &&
            (callee.value === 'forwardRef' || callee.value === 'memo'))

        if (isWrapper && init.arguments?.length > 0) {
          const arg = init.arguments[0]?.expression || init.arguments[0]
          if (arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) {
            addComponentFromFunctionNode(node.id.value, arg, content, components)
          }
        }
      }
    }
  }

  // Recurse into children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => detectComponentBoundaries(item, content, components))
      } else {
        detectComponentBoundaries(value, content, components)
      }
    }
  }
}

/**
 * Helper: extracts a ComponentBoundary from an ArrowFunctionExpression or FunctionExpression
 * that has a BlockStatement body.
 */
function addComponentFromFunctionNode (
  name: string,
  fnNode: any,
  content: string,
  components: ComponentBoundary[]
): void {
  const body = fnNode.body
  if (body?.type === 'BlockStatement' && body.span) {
    components.push({
      name,
      bodyStart: body.span.start,
      bodyEnd: body.span.end,
      hasUseTranslation: content.slice(body.span.start, body.span.end).includes('useTranslation')
    })
  }
}

// Non-translatable JSX attributes are defined in utils/jsx-attributes.ts
// and shared with the linter. The instrumenter uses `ignoredAttributeSet`
// to skip recursing into non-translatable attribute values.

/**
 * Returns true when the AST node is a `t(...)` or `i18next.t(...)` call
 * expression — i.e. code that was already instrumented.
 */
function isTranslationCall (node: any): boolean {
  const callee = node.callee
  if (!callee) return false
  // t(...)
  if (callee.type === 'Identifier' && callee.value === 't') return true
  // i18next.t(...)
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property?.type === 'Identifier' &&
    callee.property.value === 't' &&
    callee.object?.type === 'Identifier' &&
    callee.object.value === 'i18next'
  ) return true
  return false
}

/**
 * Recursively visits AST nodes to find string literals.
 */
function visitNodeForStrings (
  node: any,
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  candidates: CandidateString[]
): void {
  if (!node) return

  // Skip already-instrumented t() / i18next.t() calls entirely so that
  // strings inside the options object (defaultValue_one, etc.) are not
  // picked up as new candidates on a second run.
  if (node.type === 'CallExpression' && isTranslationCall(node)) return

  // Skip <Trans> elements (already instrumented)
  if (node.type === 'JSXElement' && isTransComponent(node)) return

  // Skip non-translatable JSX attributes entirely (e.g. className={...})
  if (node.type === 'JSXAttribute') {
    const nameNode = node.name
    let attrName: string | null = null
    if (nameNode?.type === 'Identifier') {
      attrName = nameNode.value
    } else if (nameNode?.type === 'JSXNamespacedName') {
      // e.g. data-testid
      attrName = `${nameNode.namespace?.value ?? ''}:${nameNode.name?.value ?? ''}`
    }
    if (attrName && ignoredAttributeSet.has(attrName)) return
    // For hyphenated names (data-testid), also check with the raw text
    if (attrName?.includes(':')) {
      const hyphenated = attrName.replace(':', '-')
      if (ignoredAttributeSet.has(hyphenated)) return
    }
  }

  // Check if this is a string literal
  if (node.type === 'StringLiteral') {
    const stringNode = node as StringLiteral
    if (stringNode.span && typeof stringNode.span.start === 'number') {
      const candidate = detectCandidate(
        stringNode.value,
        stringNode.span.start,
        stringNode.span.end,
        file,
        content,
        config
      )
      if (candidate && candidate.confidence >= 0.7) {
        // Detect JSX attribute context: in JSX, attr="value" has = right before the opening quote
        if (stringNode.span.start > 0 && content[stringNode.span.start - 1] === '=') {
          candidate.type = 'jsx-attribute'
        }
        candidates.push(candidate)
      }
    }
  }

  // Template literals
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis
    const expressions = node.expressions

    if (quasis?.length === 1 && (!expressions || expressions.length === 0)) {
      // Static template literal (no interpolation), e.g. `Welcome back`
      const raw = quasis[0].raw || quasis[0].cooked || ''
      const trimmed = raw.trim()
      if (trimmed && node.span && typeof node.span.start === 'number') {
        const candidate = detectCandidate(
          trimmed,
          node.span.start,
          node.span.end,
          file,
          content,
          config
        )
        if (candidate && candidate.confidence >= 0.7) {
          candidate.type = 'template-literal'
          if (node.span.start > 0 && content[node.span.start - 1] === '=') {
            candidate.type = 'jsx-attribute'
          }
          candidates.push(candidate)
        }
      }
    } else if (quasis?.length > 1 && expressions?.length > 0 && node.span) {
      // Template literal with interpolation, e.g. `${count}-day streak`
      const result = buildInterpolatedTemplate(quasis, expressions, content)
      if (result) {
        const trimmed = result.text.trim()
        if (trimmed) {
          const candidate = detectCandidate(
            trimmed,
            node.span.start,
            node.span.end,
            file,
            content,
            config
          )
          if (candidate) {
            candidate.content = trimmed
            candidate.type = 'template-literal'
            candidate.interpolations = result.interpolations
            // Template literals mixing text + expressions are likely user-facing
            candidate.confidence = Math.min(1, candidate.confidence + 0.15)
            if (node.span.start > 0 && content[node.span.start - 1] === '=') {
              candidate.type = 'jsx-attribute'
            }
            if (candidate.confidence >= 0.7) {
              candidates.push(candidate)
            }
          }
        }
      }
    }
  }

  // Check if this is JSX text content (e.g. <h1>Hello World</h1>)
  if (node.type === 'JSXText') {
    if (node.span && typeof node.span.start === 'number') {
      const raw = content.slice(node.span.start, node.span.end)
      const trimmed = raw.trim()
      if (trimmed) {
        const trimmedStart = raw.indexOf(trimmed)
        const offset = node.span.start + trimmedStart
        const endOffset = offset + trimmed.length
        const candidate = detectCandidate(
          trimmed,
          offset,
          endOffset,
          file,
          content,
          config
        )
        if (candidate) {
          candidate.type = 'jsx-text'
          // JSXText is almost always user-visible content; boost confidence
          candidate.confidence = Math.min(1, candidate.confidence + 0.2)
          if (candidate.confidence >= 0.7) {
            candidates.push(candidate)
          }
        }
      }
    }
  }

  // Recursively visit children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => visitNodeForStrings(item, content, file, config, candidates))
      } else {
        visitNodeForStrings(value, content, file, config, candidates)
      }
    }
  }
}

// ─── Template-literal interpolation helpers ──────────────────────────────────

/**
 * Builds a merged text with `{{var}}` placeholders from a template literal's
 * quasis and expressions arrays.
 */
function buildInterpolatedTemplate (
  quasis: any[],
  expressions: any[],
  content: string
): { text: string, interpolations: Array<{ name: string, expression: string }> } | null {
  const interpolations: Array<{ name: string, expression: string }> = []
  const usedNames = new Set<string>()
  let text = ''

  for (let i = 0; i < quasis.length; i++) {
    const quasi = quasis[i]
    text += quasi.cooked ?? quasi.raw ?? ''

    if (i < expressions.length) {
      const info = resolveExpressionName(expressions[i], content, usedNames)
      if (!info) return null // un-resolvable expression — bail
      text += `{{${info.name}}}`
      interpolations.push(info)
    }
  }

  return interpolations.length > 0 ? { text, interpolations } : null
}

/**
 * Resolves a human-friendly interpolation name from an AST expression node.
 *
 * - `Identifier`        → uses the identifier value (`count`)
 * - `MemberExpression`  → uses the deepest property name (`profile.name` → `name`)
 * - anything else       → generated placeholder (`val`, `val2`, ...)
 */
function resolveExpressionName (
  expr: any,
  content: string,
  usedNames: Set<string>
): { name: string, expression: string } | null {
  if (!expr?.span) return null

  const expression = content.slice(expr.span.start, expr.span.end)
  let baseName: string

  if (expr.type === 'Identifier') {
    baseName = expr.value
  } else if (expr.type === 'MemberExpression' && !expr.computed && expr.property?.type === 'Identifier') {
    baseName = expr.property.value
  } else {
    baseName = 'val'
  }

  let name = baseName
  let counter = 2
  while (usedNames.has(name)) {
    name = `${baseName}${counter++}`
  }
  usedNames.add(name)

  return { name, expression }
}

// ─── JSX sibling interpolation merging ───────────────────────────────────────

/**
 * Walks the AST looking for JSXElement / JSXFragment nodes whose children
 * contain a mergeable mix of `JSXText` and `JSXExpressionContainer` with simple
 * expressions (Identifier / MemberExpression).  When found, a single merged
 * `CandidateString` is created and any overlapping individual candidates are
 * removed.
 */
function detectJSXInterpolation (
  node: any,
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  candidates: CandidateString[]
): void {
  if (!node) return

  // Skip <Trans> elements (already instrumented)
  if (node.type === 'JSXElement' && isTransComponent(node)) return

  const children = (node.type === 'JSXElement' || node.type === 'JSXFragment') ? node.children : null

  if (children?.length > 1) {
    // Build "runs" of consecutive JSXText + simple-expression containers
    const runs: any[][] = []
    let currentRun: any[] = []

    for (const child of children) {
      if (child.type === 'JSXText') {
        currentRun.push(child)
      } else if (child.type === 'JSXExpressionContainer' && isSimpleJSXExpression(child.expression)) {
        currentRun.push(child)
      } else if (
        child.type === 'JSXExpressionContainer' &&
        child.expression?.type === 'ConditionalExpression' &&
        tryParsePluralTernary(child.expression, content)
      ) {
        // Plural ternary expression — include in the run for merged handling
        currentRun.push(child)
      } else if (child.type === 'JSXElement' && isSimpleJSXElement(child)) {
        // Simple HTML element — include in the run for Trans detection
        currentRun.push(child)
      } else {
        // JSXElement, complex expression, etc. — break the run
        if (currentRun.length > 0) {
          runs.push(currentRun)
          currentRun = []
        }
      }
    }
    if (currentRun.length > 0) {
      runs.push(currentRun)
    }

    for (const run of runs) {
      const hasText = run.some(c => c.type === 'JSXText' && c.value?.trim())
      const hasExpr = run.some(c => c.type === 'JSXExpressionContainer')
      const hasElement = run.some(c => c.type === 'JSXElement')
      // Require at least one text node plus either an expression or element
      if (!hasText || run.length < 2) continue
      if (!hasExpr && !hasElement) continue

      // Check if any expression container in this run is a plural ternary
      let pluralChild: any = null
      let pluralData: ReturnType<typeof tryParsePluralTernary> = null
      for (const child of run) {
        if (
          child.type === 'JSXExpressionContainer' &&
          child.expression?.type === 'ConditionalExpression'
        ) {
          const p = tryParsePluralTernary(child.expression, content)
          if (p) {
            pluralChild = child
            pluralData = p
            break // only one plural ternary per run
          }
        }
      }

      if (hasElement) {
        // ── JSX sibling run with nested HTML elements → <Trans> ──
        const spanStart = run[0].span.start
        const spanEnd = run[run.length - 1].span.end

        // Build the translation string (with indexed tags) and text-only version (for scoring)
        const usedNames = new Set<string>()
        const interpolations: Array<{ name: string, expression: string }> = []
        let transValue = ''
        let textOnly = ''
        let transContent = ''
        let childIndex = 0
        let valid = true

        for (const child of run) {
          if (child.type === 'JSXText') {
            const raw = content.slice(child.span.start, child.span.end)
            transValue += raw
            textOnly += raw
            transContent += raw
            childIndex++
          } else if (child.type === 'JSXExpressionContainer') {
            const info = resolveExpressionName(child.expression, content, usedNames)
            if (!info) { valid = false; break }
            transValue += `{{${info.name}}}`
            textOnly += info.name
            // In <Trans> children, simple expressions become {{ obj }} syntax
            const objExpr = info.name === info.expression ? info.name : `${info.name}: ${info.expression}`
            transContent += `{{ ${objExpr} }}`
            interpolations.push(info)
            childIndex++
          } else if (child.type === 'JSXElement') {
            const innerText = getJSXElementTextContent(child, content)
            transValue += `<${childIndex}>${innerText}</${childIndex}>`
            textOnly += innerText
            // Keep the original JSX element source for the <Trans> children
            transContent += content.slice(child.span.start, child.span.end)
            childIndex++
          }
        }

        if (!valid) continue

        const trimmedText = textOnly.trim()
        const trimmedTransValue = transValue.trim()
        if (!trimmedText || !trimmedTransValue) continue

        const candidate = detectCandidate(trimmedText, spanStart, spanEnd, file, content, config)
        if (candidate) {
          candidate.type = 'jsx-mixed'
          candidate.content = transContent.trim()
          candidate.transValue = trimmedTransValue
          if (interpolations.length > 0) {
            candidate.interpolations = interpolations
          }
          // Mixed text + elements in JSX is almost always user-facing
          candidate.confidence = Math.min(1, candidate.confidence + 0.25)

          if (candidate.confidence >= 0.7) {
            // Remove individual candidates that overlap with the merged span
            for (let i = candidates.length - 1; i >= 0; i--) {
              if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
                candidates.splice(i, 1)
              }
            }
            candidates.push(candidate)
          }
        }
      } else if (pluralChild && pluralData) {
        // ── JSX sibling run with embedded plural ternary ──
        const countExpr = pluralData.countExpression

        // Resolve names for non-count, non-plural expressions
        const usedNames = new Set<string>()
        const extraInterpolations: Array<{ name: string, expression: string }> = []
        const exprNameMap = new Map<any, string>()
        let valid = true

        for (const child of run) {
          if (child.type === 'JSXExpressionContainer' && child !== pluralChild) {
            const exprText = content.slice(child.expression.span.start, child.expression.span.end)
            if (exprText === countExpr) {
              exprNameMap.set(child, 'count')
            } else {
              const info = resolveExpressionName(child.expression, content, usedNames)
              if (!info) { valid = false; break }
              exprNameMap.set(child, info.name)
              extraInterpolations.push(info)
            }
          }
        }

        if (!valid) continue

        // Build merged text for each plural form
        const forms = [
          ...(pluralData.zero !== undefined ? ['zero' as const] : []),
          ...(pluralData.one !== undefined ? ['one' as const] : []),
          'other' as const
        ]
        const formTexts: Record<string, string> = {}

        for (const form of forms) {
          let text = ''
          for (const child of run) {
            if (child.type === 'JSXText') {
              text += content.slice(child.span.start, child.span.end)
            } else if (child === pluralChild) {
              const formText = form === 'zero'
                ? pluralData.zero!
                : form === 'one'
                  ? pluralData.one!
                  : pluralData.other
              text += formText
            } else {
              const name = exprNameMap.get(child)!
              text += `{{${name}}}`
            }
          }
          formTexts[form] = text.trim()
        }

        const spanStart = run[0].span.start
        const spanEnd = run[run.length - 1].span.end
        const otherText = formTexts.other
        if (!otherText) continue

        const candidate = detectCandidate(otherText, spanStart, spanEnd, file, content, config)
        if (candidate) {
          candidate.type = 'jsx-text'
          candidate.content = otherText
          candidate.pluralForms = {
            countExpression: countExpr,
            zero: formTexts.zero,
            one: formTexts.one,
            other: otherText
          }
          if (extraInterpolations.length > 0) {
            candidate.interpolations = extraInterpolations
          }
          // Plural + JSX merge is always user-facing
          candidate.confidence = Math.min(1, candidate.confidence + 0.3)

          if (candidate.confidence >= 0.7) {
            // Remove individual candidates that overlap with the merged span
            for (let i = candidates.length - 1; i >= 0; i--) {
              if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
                candidates.splice(i, 1)
              }
            }
            candidates.push(candidate)
          }
        }
      } else {
        // ── Original JSX sibling merging (text + expressions, no elements) ──
        // Build the interpolated text from the run
        const usedNames = new Set<string>()
        const interpolations: Array<{ name: string, expression: string }> = []
        let text = ''
        let valid = true

        for (const child of run) {
          if (child.type === 'JSXText') {
            text += content.slice(child.span.start, child.span.end)
          } else {
            const info = resolveExpressionName(child.expression, content, usedNames)
            if (!info) { valid = false; break }
            text += `{{${info.name}}}`
            interpolations.push(info)
          }
        }

        if (!valid) continue

        const trimmed = text.trim()
        if (!trimmed || interpolations.length === 0) continue

        const spanStart = run[0].span.start
        const spanEnd = run[run.length - 1].span.end

        const candidate = detectCandidate(trimmed, spanStart, spanEnd, file, content, config)
        if (candidate) {
          candidate.type = 'jsx-text'
          candidate.content = trimmed
          candidate.interpolations = interpolations
          // Mixed text + expressions in JSX is almost always user-facing
          candidate.confidence = Math.min(1, candidate.confidence + 0.2)

          if (candidate.confidence >= 0.7) {
            // Remove individual candidates that overlap with the merged span
            for (let i = candidates.length - 1; i >= 0; i--) {
              if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
                candidates.splice(i, 1)
              }
            }
            candidates.push(candidate)
          }
        }
      }
    }
  }

  // Recurse into children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => detectJSXInterpolation(item, content, file, config, candidates))
      } else {
        detectJSXInterpolation(value, content, file, config, candidates)
      }
    }
  }
}

/**
 * Returns true when the expression is a simple Identifier or non-computed
 * MemberExpression (i.e. dot notation like `profile.name`).
 */
function isSimpleJSXExpression (expr: any): boolean {
  if (!expr) return false
  if (expr.type === 'Identifier') return true
  if (expr.type === 'MemberExpression' && !expr.computed && expr.property?.type === 'Identifier') return true
  return false
}

/**
 * Returns true when a JSXElement is "simple" enough to be included in a
 * `<Trans>` JSX sibling run.  Accepts:
 * - Self-closing elements (`<br />`, `<img />`)
 * - Elements whose only children are `JSXText` nodes
 * Only HTML-like elements (lowercase tag name) are accepted; React
 * components (uppercase, e.g. `<Button />`) break the run.
 */
function isSimpleJSXElement (node: any): boolean {
  if (node.type !== 'JSXElement') return false
  const namePart = node.opening?.name
  if (!namePart) return false
  // Only include HTML-like elements (lowercase first char)
  let tagName: string | null = null
  if (namePart.type === 'Identifier') {
    tagName = namePart.value
  }
  if (!tagName || tagName[0] !== tagName[0].toLowerCase()) return false
  // Self-closing elements are simple
  if (node.opening?.selfClosing) return true
  // Elements with only text children (or empty) are simple
  const children = node.children || []
  return children.length === 0 || children.every((c: any) => c.type === 'JSXText')
}

/**
 * Returns the text content of a simple JSXElement's children.
 */
function getJSXElementTextContent (node: any, content: string): string {
  const children = node.children || []
  return children
    .filter((c: any) => c.type === 'JSXText')
    .map((c: any) => content.slice(c.span.start, c.span.end))
    .join('')
}

/**
 * Returns true when a JSXElement is a `<Trans>` component
 * (already instrumented content).
 */
function isTransComponent (node: any): boolean {
  const opening = node.opening
  if (!opening) return false
  const name = opening.name
  if (name?.type === 'Identifier' && name.value === 'Trans') return true
  if (name?.type === 'JSXMemberExpression' && name.property?.type === 'Identifier' && name.property.value === 'Trans') return true
  return false
}

// ─── Plural conditional pattern detection ────────────────────────────────────

/**
 * Extracts the text value from a string literal or static template literal node.
 * Returns `null` for anything else.
 */
function extractStaticText (node: any): string | null {
  if (!node) return null
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis
    if (quasis?.length === 1 && (!node.expressions || node.expressions.length === 0)) {
      return quasis[0].cooked ?? quasis[0].raw ?? null
    }
  }
  return null
}

/**
 * Extracts text from a node that may contain the count variable as an
 * interpolation (e.g. `${activeTasks} tasks left`).  The count variable
 * is replaced with `{{count}}` in the returned text.
 * Returns `null` when the node isn't a recognised textual form.
 */
function extractTextWithCount (node: any, countIdentifier: string, content: string): string | null {
  // Static text (no variable at all — still valid for zero/one forms)
  const staticText = extractStaticText(node)
  if (staticText !== null) return staticText

  // Template literal with interpolation
  if (node?.type === 'TemplateLiteral') {
    const quasis = node.quasis ?? []
    const expressions = node.expressions ?? []
    if (quasis.length === 0 || expressions.length === 0) return null

    let text = ''
    for (let i = 0; i < quasis.length; i++) {
      text += quasis[i].cooked ?? quasis[i].raw ?? ''
      if (i < expressions.length) {
        const expr = expressions[i]
        const exprText = content.slice(expr.span.start, expr.span.end)
        if (exprText === countIdentifier) {
          text += '{{count}}'
        } else {
          // Unknown expression — bail
          return null
        }
      }
    }
    return text
  }

  return null
}

/**
 * Resolves the count variable name from a `BinaryExpression` test of the form
 * `identifier === <number>`.  Returns `{ identifier, number }` or `null`.
 */
function parseCountTest (test: any, content: string): { identifier: string, value: number } | null {
  if (test?.type !== 'BinaryExpression') return null
  if (test.operator !== '===' && test.operator !== '==') return null

  let identSide: any
  let numSide: any

  if (test.left?.type === 'NumericLiteral') {
    numSide = test.left
    identSide = test.right
  } else if (test.right?.type === 'NumericLiteral') {
    numSide = test.right
    identSide = test.left
  } else {
    return null
  }

  if (!identSide?.span) return null
  const identifier = content.slice(identSide.span.start, identSide.span.end)

  return { identifier, value: numSide.value }
}

/**
 * Walks the AST looking for conditional (ternary) expression chains that
 * correspond to a count-based pluralisation pattern, e.g.
 *
 * ```
 * tasks === 0
 *   ? 'No tasks'
 *   : tasks === 1
 *     ? 'One task'
 *     : `${tasks} tasks`
 * ```
 *
 * When such a pattern is detected a single `CandidateString` is emitted with
 * `pluralForms` populated and any individual candidates that overlap with the
 * ternary's span are removed.
 */
function detectPluralPatterns (
  node: any,
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  candidates: CandidateString[]
): void {
  if (!node) return

  if (node.type === 'ConditionalExpression') {
    const plural = tryParsePluralTernary(node, content)
    if (plural) {
      // Use the "other" form as the candidate content (with {{count}})
      const spanStart = node.span.start
      const spanEnd = node.span.end

      // Skip if this ternary is already covered by a wider candidate
      // (e.g. a JSX sibling run that merged surrounding text with this plural)
      const alreadyHandled = candidates.some(c =>
        c.pluralForms && c.offset <= spanStart && c.endOffset >= spanEnd
      )
      if (alreadyHandled) return

      const candidate = detectCandidate(
        plural.other,
        spanStart,
        spanEnd,
        file,
        content,
        config
      )
      if (candidate) {
        candidate.type = 'string-literal'
        candidate.content = plural.other
        candidate.pluralForms = {
          countExpression: plural.countExpression,
          zero: plural.zero,
          one: plural.one,
          other: plural.other
        }
        // Plural patterns are always user-facing text — boost confidence
        candidate.confidence = Math.min(1, candidate.confidence + 0.3)

        if (candidate.confidence >= 0.7) {
          // Remove individual candidates that overlap with the ternary span
          for (let i = candidates.length - 1; i >= 0; i--) {
            if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
              candidates.splice(i, 1)
            }
          }
          candidates.push(candidate)
          // Don't recurse into children — we already consumed the whole ternary
          return
        }
      }
    }
  }

  // Recurse into children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => detectPluralPatterns(item, content, file, config, candidates))
      } else {
        detectPluralPatterns(value, content, file, config, candidates)
      }
    }
  }
}

/**
 * Attempts to parse a `ConditionalExpression` tree into a plural pattern.
 *
 * Supported shapes:
 *   count === 0 ? zeroText : count === 1 ? oneText : otherText   (3-way)
 *   count === 1 ? oneText  : otherText                           (2-way)
 *
 * Returns `null` when the node doesn't match any recognised plural shape.
 */
function tryParsePluralTernary (
  node: any,
  content: string
): { countExpression: string, zero?: string, one?: string, other: string } | null {
  if (node?.type !== 'ConditionalExpression') return null

  const outerTest = parseCountTest(node.test, content)
  if (!outerTest) return null

  const countExpr = outerTest.identifier

  // ──── 3-way:  count === 0 ? zero : count === 1 ? one : other ──────────
  if (outerTest.value === 0) {
    const zeroText = extractTextWithCount(node.consequent, countExpr, content)
    if (zeroText === null) return null

    const alt = node.alternate
    if (alt?.type === 'ConditionalExpression') {
      const innerTest = parseCountTest(alt.test, content)
      if (!innerTest || innerTest.identifier !== countExpr || innerTest.value !== 1) return null

      const oneText = extractTextWithCount(alt.consequent, countExpr, content)
      const otherText = extractTextWithCount(alt.alternate, countExpr, content)
      if (oneText === null || otherText === null) return null

      return { countExpression: countExpr, zero: zeroText, one: oneText, other: otherText }
    }

    // 2-way zero/other:  count === 0 ? zero : other
    const otherText = extractTextWithCount(node.alternate, countExpr, content)
    if (otherText === null) return null
    return { countExpression: countExpr, zero: zeroText, other: otherText }
  }

  // ──── 2-way:  count === 1 ? one : other ───────────────────────────────
  if (outerTest.value === 1) {
    const oneText = extractTextWithCount(node.consequent, countExpr, content)
    const otherText = extractTextWithCount(node.alternate, countExpr, content)
    if (oneText === null || otherText === null) return null

    return { countExpression: countExpr, one: oneText, other: otherText }
  }

  return null
}

// ─── Language-change detection ───────────────────────────────────────────────

/**
 * Property names that indicate a "language" value in an object literal.
 * When a function call passes an object with one of these keys, we treat
 * the call as a language-change site.
 */
const LANGUAGE_PROP_NAMES = new Set(['language', 'lang', 'locale', 'lng'])

/**
 * Function-name patterns that indicate a direct language setter.
 * Matched against the full function name (case-insensitive).
 *
 * Examples: `setLanguage(code)`, `setLocale(lng)`, `changeLanguage(x)`
 */
const LANGUAGE_SETTER_RE = /^(?:set|change|update|select)(?:Language|Lang|Locale|Lng)$/i

/**
 * Walks the AST looking for call expressions that appear to change the
 * application language.  Detected sites will later be augmented with an
 * `i18n.changeLanguage()` call by the transformer.
 *
 * Recognised patterns:
 *
 * 1. Object-property setters:
 *    `updateSettings({ language: lang.code })`
 *    `setState({ locale: selectedLng })`
 *
 * 2. Direct setters:
 *    `setLanguage(code)`
 *    `setLocale(lng)`
 *    `changeLanguage(selectedLng)`
 */
function detectLanguageChangeSites (
  node: any,
  content: string,
  sites: LanguageChangeSite[]
): void {
  if (!node) return

  if (node.type === 'CallExpression' && node.span) {
    const detected = tryParseLanguageChangeCall(node, content)
    if (detected) {
      // Check if changeLanguage() already exists nearby (e.g. same arrow body)
      const lookbackStart = Math.max(0, detected.callStart - 200)
      const nearbyBefore = content.slice(lookbackStart, detected.callStart)
      if (nearbyBefore.includes('changeLanguage')) {
        // Already instrumented — skip this site
      } else {
        // Compute 1-based line and 0-based column from offset
        let line = 1
        let lastNewline = -1
        for (let i = 0; i < detected.callStart && i < content.length; i++) {
          if (content[i] === '\n') {
            line++
            lastNewline = i
          }
        }
        sites.push({
          ...detected,
          line,
          column: detected.callStart - lastNewline - 1
        })
      }
      // Don't return — keep recursing for nested calls
    }
  }

  // Recurse into children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => detectLanguageChangeSites(item, content, sites))
      } else {
        detectLanguageChangeSites(value, content, sites)
      }
    }
  }
}

/**
 * Inspects a single CallExpression node to determine if it is a language-change
 * call.  Returns the detected site data (without line/column) or `null`.
 */
function tryParseLanguageChangeCall (
  node: any,
  content: string
): { languageExpression: string, callStart: number, callEnd: number } | null {
  if (node.type !== 'CallExpression') return null
  if (!node.arguments?.length) return null

  const calleeName = getCalleeName(node.callee)

  // Skip calls that are already i18next API calls (e.g. i18n.changeLanguage())
  if (node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier') {
    const objName = node.callee.object.value
    if (objName === 'i18n' || objName === 'i18next') return null
  }

  // ── Pattern 1: direct setter — setLanguage(expr), changeLocale(expr) etc. ──
  if (calleeName && LANGUAGE_SETTER_RE.test(calleeName)) {
    const firstArg = node.arguments[0]?.expression
    if (firstArg?.span) {
      const langExpr = content.slice(firstArg.span.start, firstArg.span.end)
      // Skip if the argument is already an i18next.changeLanguage call
      if (langExpr.includes('changeLanguage')) return null
      return {
        languageExpression: langExpr,
        callStart: node.span.start,
        callEnd: node.span.end
      }
    }
  }

  // ── Pattern 2: object with language property — fn({ language: expr }) ──
  for (const arg of node.arguments) {
    const expr = arg.expression ?? arg
    if (expr?.type !== 'ObjectExpression') continue
    if (!Array.isArray(expr.properties)) continue

    for (const prop of expr.properties) {
      if (prop.type !== 'KeyValueProperty') continue
      const keyName = (prop.key?.type === 'Identifier' && prop.key.value) ||
                      (prop.key?.type === 'StringLiteral' && prop.key.value)
      if (typeof keyName !== 'string') continue
      if (!LANGUAGE_PROP_NAMES.has(keyName.toLowerCase())) continue

      // Found a language property — extract the value expression
      const valNode = prop.value
      if (valNode?.span) {
        const langExpr = content.slice(valNode.span.start, valNode.span.end)
        // Skip if value is a static string (e.g. `{ language: 'en' }` in a config)
        if (valNode.type === 'StringLiteral') continue
        // Skip if already contains changeLanguage
        if (langExpr.includes('changeLanguage')) continue
        return {
          languageExpression: langExpr,
          callStart: node.span.start,
          callEnd: node.span.end
        }
      }
    }
  }

  return null
}

/**
 * Extracts a simple function name from a CallExpression callee.
 * Handles `Identifier` (e.g. `setLanguage`) and `MemberExpression`
 * (extracts the final property, e.g. `settings.setLanguage` → `setLanguage`).
 */
function getCalleeName (callee: any): string | null {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.value
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
    return callee.property.value
  }
  return null
}

/**
 * Gets the list of source files to instrument.
 */
async function getSourceFilesForInstrumentation (config: I18nextToolkitConfig): Promise<string[]> {
  const defaultIgnore = ['node_modules/**', 'dist/**', 'build/**', '.next/**']

  const userIgnore = Array.isArray(config.extract.ignore)
    ? config.extract.ignore
    : config.extract.ignore ? [config.extract.ignore] : []

  return await glob(config.extract.input, {
    ignore: [...defaultIgnore, ...userIgnore],
    cwd: process.cwd()
  })
}

/**
 * Checks if the project uses React.
 */
async function isProjectUsingReact (): Promise<boolean> {
  try {
    const packageJsonPath = process.cwd() + '/package.json'
    const content = await readFile(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(content)
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }
    return !!deps.react || !!deps['react-i18next']
  } catch {
    return false
  }
}

// ── Project environment detection ───────────────────────────────────────

type ProjectEnvironment = 'browser' | 'node-server' | 'edge' | 'unknown'

/** Well-known frontend framework packages (presence → browser environment). */
const FRONTEND_FRAMEWORKS = [
  'react', 'react-i18next', 'vue', 'vue-i18next',
  '@angular/core', 'angular-i18next',
  'svelte', 'svelte-i18next',
  'preact', 'solid-js', 'jquery', 'lit', 'ember-source', 'stimulus',
  'next', 'nuxt', 'gatsby', '@remix-run/react', 'astro'
]

/** Well-known bundlers whose presence implies a browser build target. */
const BUNDLERS = [
  'webpack', 'vite', '@vitejs/plugin-react', 'rollup', 'parcel',
  'esbuild', 'turbopack', 'snowpack'
]

/** Edge/serverless markers (no filesystem access). */
const EDGE_MARKERS = [
  '@cloudflare/workers-types', 'wrangler', '@cloudflare/next-on-pages',
  '@vercel/edge', '@netlify/edge-functions', '@deno/kv'
]

/** Well-known Node.js server frameworks. */
const SERVER_FRAMEWORKS = [
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi',
  '@nestjs/core', 'restify', 'micro', 'polka', 'h3'
]

/**
 * Analyses `package.json` dependencies (and a few project-root files) to
 * classify the project's runtime environment.
 *
 * Priority order:
 *   1. Edge / serverless markers  → `'edge'`   (no filesystem)
 *   2. Frontend framework or bundler → `'browser'`
 *   3. Node.js server framework   → `'node-server'`
 *   4. Fallback                   → `'unknown'`
 */
async function detectProjectEnvironment (): Promise<ProjectEnvironment> {
  try {
    const packageJsonPath = process.cwd() + '/package.json'
    const raw = await readFile(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(raw)
    const allDeps: Record<string, string> = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    }
    const has = (list: string[]) => list.some(dep => !!allDeps[dep])

    // 1. Edge / serverless (check first — these projects may also list a
    //    bundler or even a framework, but they have no filesystem)
    if (has(EDGE_MARKERS)) return 'edge'
    // Also check for wrangler.toml / wrangler.json
    const cwd = process.cwd()
    if (await fileExists(join(cwd, 'wrangler.toml')) || await fileExists(join(cwd, 'wrangler.json'))) {
      return 'edge'
    }

    // 2. Browser / frontend
    if (has(FRONTEND_FRAMEWORKS) || has(BUNDLERS)) return 'browser'

    // 3. Node.js server
    if (has(SERVER_FRAMEWORKS)) return 'node-server'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Checks if the project uses TypeScript (looks for tsconfig.json).
 */
async function isProjectUsingTypeScript (): Promise<boolean> {
  try {
    await access(process.cwd() + '/tsconfig.json')
    return true
  } catch {
    return false
  }
}

/**
 * Checks if a file exists.
 */
async function fileExists (filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Common i18n init file names to check for.
 */
const I18N_INIT_FILE_NAMES = [
  'i18n.ts', 'i18n.js', 'i18n.mjs', 'i18n.mts',
  'i18next.ts', 'i18next.js', 'i18next.mjs', 'i18next.mts',
  'i18n/index.ts', 'i18n/index.js', 'i18n/index.mjs',
  'i18next/index.ts', 'i18next/index.js'
]

/**
 * Computes a POSIX-style relative path from the init-file directory to the
 * output template path (which still contains {{language}} / {{namespace}} placeholders).
 */
function buildDynamicImportPath (outputTemplate: string, initDir: string): string {
  const cwd = process.cwd()
  const absTemplate = isAbsolute(outputTemplate) ? outputTemplate : resolve(cwd, outputTemplate)
  let rel = relative(initDir, absTemplate)
  if (!rel.startsWith('.')) {
    rel = './' + rel
  }
  return rel.replace(/\\/g, '/')
}

/**
 * Ensures that an i18n initialization file exists in the project.
 * If no existing init file is found, generates a sensible default.
 *
 * The generated file's backend strategy depends on the project context:
 * - React app without i18next.t() → `i18next-resources-to-backend` (async dynamic imports)
 * - React app with i18next.t()    → bundled resources (static imports, synchronous)
 * - Server-side (no React)        → `i18next-fs-backend` (filesystem, initImmediate: false + preload)
 */
async function ensureI18nInitFile (
  hasReact: boolean,
  hasTypeScript: boolean,
  config: I18nextToolkitConfig,
  logger: Logger,
  usesI18nextT: boolean
): Promise<string | null> {
  const cwd = process.cwd()

  // Check for existing init files in common locations
  const searchDirs = ['src', '.']
  for (const dir of searchDirs) {
    for (const name of I18N_INIT_FILE_NAMES) {
      if (await fileExists(join(cwd, dir, name))) {
        return null // Init file already exists
      }
    }
  }

  // Check if i18next.init() is called anywhere in the source
  try {
    const sourceFiles = await getSourceFilesForInstrumentation(config)
    for (const file of sourceFiles) {
      try {
        const content = await readFile(file, 'utf-8')
        if (content.includes('i18next.init') || content.includes('.init(') || content.includes('i18n.init')) {
          return null // Init is already present somewhere
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Skip if file scanning fails
  }

  // Determine output location — prefer src/ if it exists
  const srcExists = await fileExists(join(cwd, 'src'))
  const initDir = srcExists ? join(cwd, 'src') : cwd
  const initFileExt = hasTypeScript ? '.ts' : '.js'
  const initFilePath = join(initDir, 'i18n' + initFileExt)

  const environment = await detectProjectEnvironment()
  const strategy = determineBackendStrategy(environment, usesI18nextT)
  const outputTemplate = typeof config.extract.output === 'string' ? config.extract.output : null

  const initContent = buildInitFileContent({
    strategy,
    hasReact,
    hasTypeScript,
    config,
    initDir,
    outputTemplate
  })

  try {
    await mkdir(initDir, { recursive: true })
    await writeFile(initFilePath, initContent)
    logger.info(`Generated i18n init file: ${initFilePath}`)
    return initFilePath
  } catch (err) {
    logger.warn(`Failed to generate i18n init file: ${err}`)
    return null
  }
}

// ── Backend strategy helpers ─────────────────────────────────────────────

type BackendStrategy = 'resources-to-backend' | 'bundled-resources' | 'fs-backend'

/**
 * Determines which backend strategy to use for the i18n init file.
 *
 * Decision logic:
 *   1. Node.js server with filesystem → `fs-backend`
 *      (synchronous with `initImmediate: false` + `preload`)
 *   2. Browser / edge / unknown with `i18next.t()` outside React components →
 *      `bundled-resources` (static imports so resources are available synchronously)
 *   3. Otherwise → `resources-to-backend` (async dynamic imports, lazy-loaded)
 */
function determineBackendStrategy (environment: ProjectEnvironment, usesI18nextT: boolean): BackendStrategy {
  if (environment === 'node-server') return 'fs-backend'
  if (usesI18nextT) return 'bundled-resources'
  return 'resources-to-backend'
}

/**
 * Builds the full i18n init file content from composable parts,
 * avoiding repetition across different strategies.
 */
function buildInitFileContent (opts: {
  strategy: BackendStrategy
  hasReact: boolean
  hasTypeScript: boolean
  config: I18nextToolkitConfig
  initDir: string
  outputTemplate: string | null
}): string {
  const { strategy, hasReact, hasTypeScript, config, initDir, outputTemplate } = opts
  const primaryLang = config.extract.primaryLanguage ?? config.locales[0] ?? 'en'
  const defaultNS = config.extract.defaultNS !== false ? (config.extract.defaultNS || 'translation') : null
  const ns = defaultNS || 'translation'

  // ── Dependencies for the install hint ──
  const deps: string[] = ['i18next']
  if (hasReact) deps.push('react-i18next')
  if (strategy === 'resources-to-backend' && outputTemplate) deps.push('i18next-resources-to-backend')
  if (strategy === 'fs-backend' && outputTemplate) deps.push('i18next-fs-backend')

  const lines: string[] = []

  // ── Header comment ──
  lines.push(
    "// Generated by i18next-cli — review and adapt to your project's needs.",
    `// You may need to install dependencies: npm install ${deps.join(' ')}`,
    '//',
    '// Other translation loading approaches:',
    '//   • Static imports or bundled JSON: https://www.i18next.com/how-to/add-or-load-translations',
    '//   • Lazy-load from a server: https://github.com/i18next/i18next-http-backend',
    '//   • Manage translations with your team via Locize: https://www.locize.com',
    '//     (see i18next-locize-backend: https://github.com/locize/i18next-locize-backend)'
  )

  // ── Import declarations ──
  lines.push("import i18next from 'i18next'")
  if (hasReact) lines.push("import { initReactI18next } from 'react-i18next'")

  if (outputTemplate) {
    switch (strategy) {
      case 'resources-to-backend':
        lines.push("import resourcesToBackend from 'i18next-resources-to-backend'")
        break
      case 'bundled-resources':
        for (const locale of config.locales) {
          const importPath = buildResourceImportPath(outputTemplate, initDir, locale, ns)
          lines.push(`import ${toResourceVarName(locale, ns)} from '${importPath}'`)
        }
        break
      case 'fs-backend':
        lines.push("import Backend from 'i18next-fs-backend'")
        lines.push("import { resolve, dirname } from 'node:path'")
        lines.push("import { fileURLToPath } from 'node:url'")
        break
    }
  }

  // ── Pre-init statements ──
  lines.push('')
  if (strategy === 'fs-backend' && outputTemplate) {
    lines.push('const __dirname = dirname(fileURLToPath(import.meta.url))')
    lines.push('')
  }

  // ── .use() chain entries ──
  const useEntries: string[] = []
  if (hasReact) useEntries.push('  .use(initReactI18next)')
  if (outputTemplate) {
    if (strategy === 'resources-to-backend') {
      const dynamicPath = buildDynamicImportPath(outputTemplate, initDir)
      const importPathTemplate = dynamicPath
        // eslint-disable-next-line no-template-curly-in-string
        .replace(/\{\{language\}\}|\{\{lng\}\}/g, '${language}')
        // eslint-disable-next-line no-template-curly-in-string
        .replace(/\{\{namespace\}\}/g, '${namespace}')
      const hasNamespace = outputTemplate.includes('{{namespace}}')
      const cbParams = hasNamespace
        ? (hasTypeScript ? 'language: string, namespace: string' : 'language, namespace')
        : (hasTypeScript ? 'language: string' : 'language')
      useEntries.push(`  .use(resourcesToBackend((${cbParams}) => import(\`${importPathTemplate}\`)))`)
    } else if (strategy === 'fs-backend') {
      useEntries.push('  .use(Backend)')
    }
  }

  // Emit the i18next chain — use compact form if no .use() calls
  const awaitPrefix = (strategy === 'fs-backend' && outputTemplate) ? 'await ' : ''
  if (useEntries.length > 0) {
    lines.push(`${awaitPrefix}i18next`)
    lines.push(...useEntries)
    lines.push('  .init({')
  } else {
    lines.push(`${awaitPrefix}i18next.init({`)
  }

  // ── .init() options ──
  const initOpts: string[] = []

  if (strategy === 'fs-backend' && outputTemplate) {
    initOpts.push('    initImmediate: false,')
  }
  initOpts.push('    returnEmptyString: false, // allows empty string as valid translation')
  initOpts.push(`    // lng: '${config.locales.at(-1)}', // or add a language detector to detect the preferred language of your user`)
  initOpts.push(`    fallbackLng: '${primaryLang}',`)
  if (defaultNS) {
    initOpts.push(`    defaultNS: '${ns}',`)
  }

  // Strategy-specific init options
  if (outputTemplate) {
    if (strategy === 'bundled-resources') {
      initOpts.push('    resources: {')
      for (const locale of config.locales) {
        const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(locale) ? locale : `'${locale}'`
        initOpts.push(`      ${key}: { ${ns}: ${toResourceVarName(locale, ns)} },`)
      }
      initOpts.push('    },')
    } else if (strategy === 'fs-backend') {
      const loadPath = buildFsBackendLoadPath(outputTemplate, initDir)
      initOpts.push(`    preload: [${config.locales.map(l => `'${l}'`).join(', ')}],`)
      initOpts.push('    backend: {')
      initOpts.push(`      loadPath: resolve(__dirname, '${loadPath}'),`)
      initOpts.push('    },')
    }
  } else {
    // No concrete output path — user needs to configure loading manually
    initOpts.push('    // resources: { ... }  — or use a backend plugin to load translations')
  }

  lines.push(initOpts.join('\n'))
  lines.push('  })')
  lines.push('')
  lines.push('export default i18next')
  lines.push('')

  return lines.join('\n')
}

/**
 * Resolves the import path for a specific locale/namespace resource file
 * (used by the bundled-resources strategy).
 */
function buildResourceImportPath (outputTemplate: string, initDir: string, locale: string, namespace: string): string {
  const rel = buildDynamicImportPath(outputTemplate, initDir)
  return rel
    .replace(/\{\{language\}\}|\{\{lng\}\}/g, locale)
    .replace(/\{\{namespace\}\}|\{\{ns\}\}/g, namespace)
}

/**
 * Resolves the loadPath for i18next-fs-backend, using i18next's `{{lng}}`
 * and `{{ns}}` interpolation syntax.
 */
function buildFsBackendLoadPath (outputTemplate: string, initDir: string): string {
  const rel = buildDynamicImportPath(outputTemplate, initDir)
  return rel
    .replace(/\{\{language\}\}/g, '{{lng}}')
    .replace(/\{\{namespace\}\}/g, '{{ns}}')
}

/**
 * Converts a locale + namespace pair to a valid JS variable name.
 * E.g. ('en', 'translation') → 'enTranslation', ('zh-CN', 'common') → 'zhCNCommon'
 */
function toResourceVarName (locale: string, namespace: string): string {
  const sanitizedLocale = locale.replace(/[^a-zA-Z0-9]/g, '')
  return sanitizedLocale + namespace.charAt(0).toUpperCase() + namespace.slice(1)
}

/**
 * Common entry-point file names, checked in priority order.
 */
const ENTRY_FILE_CANDIDATES = [
  'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js',
  'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js',
  'src/App.tsx', 'src/App.ts', 'src/App.jsx', 'src/App.js',
  'pages/_app.tsx', 'pages/_app.ts', 'pages/_app.jsx', 'pages/_app.js',
  'app/layout.tsx', 'app/layout.ts', 'app/layout.jsx', 'app/layout.js',
  'index.tsx', 'index.ts', 'index.jsx', 'index.js',
  'main.tsx', 'main.ts', 'main.jsx', 'main.js'
]

/**
 * Attempts to inject a side-effect import of the i18n init file into the
 * project's main entry file.  If no recognisable entry file is found, or the
 * import already exists, the function silently returns.
 */
async function injectI18nImportIntoEntryFile (
  initFilePath: string,
  logger: Logger
): Promise<void> {
  const cwd = process.cwd()

  // 1. Find the first existing entry file
  let entryFilePath: string | null = null
  for (const candidate of ENTRY_FILE_CANDIDATES) {
    const abs = join(cwd, candidate)
    if (await fileExists(abs)) {
      entryFilePath = abs
      break
    }
  }
  if (!entryFilePath) {
    logger.info('No recognisable entry file found — please import the i18n init file manually.')
    return
  }

  // 2. Compute the relative import path (POSIX-style, without extension)
  const entryDir = dirname(entryFilePath)
  let rel = relative(entryDir, initFilePath).replace(/\\/g, '/')
  // Strip file extension for a cleaner import
  rel = rel.replace(/\.(tsx?|jsx?|mjs|mts)$/, '')
  if (!rel.startsWith('.')) {
    rel = './' + rel
  }

  // 3. Check whether the import is already present
  let content: string
  try {
    content = await readFile(entryFilePath, 'utf-8')
  } catch {
    logger.warn(`Could not read entry file: ${entryFilePath}`)
    return
  }

  // Check for existing import of the i18n init file (with or without extension)
  const importBase = rel.replace(/^\.\//, '')
  const importPatterns = [
    `import '${rel}'`, `import "${rel}"`,
    `import './${importBase}'`, `import "./${importBase}"`,
    `import '${rel}.`, `import "${rel}.`,
    // Also check for require or named imports
    `from '${rel}'`, `from "${rel}"`,
    `from './${importBase}'`, `from "./${importBase}"`,
    // Bare 'i18n' import
    "import './i18n'", 'import "./i18n"',
    "import '../i18n'", 'import "../i18n"',
    "from './i18n'", 'from "./i18n"',
    "from '../i18n'", 'from "../i18n"'
  ]
  for (const pattern of importPatterns) {
    if (content.includes(pattern)) {
      return // Already imported
    }
  }

  // 4. Insert the import at the top, right after any existing import block
  const importStatement = `import '${rel}'\n`

  // Find the best insertion point: after the last top-level import statement
  const lines = content.split('\n')
  let lastImportLine = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('import ') || trimmed.startsWith('import\t') || trimmed.startsWith('import{')) {
      // Walk past multi-line imports
      lastImportLine = i
    }
  }

  let newContent: string
  if (lastImportLine >= 0) {
    // Insert after the last import line
    lines.splice(lastImportLine + 1, 0, importStatement.trimEnd())
    newContent = lines.join('\n')
  } else {
    // No imports found — prepend at the very top
    newContent = importStatement + content
  }

  try {
    await writeFile(entryFilePath, newContent)
    logger.info(`Injected i18n import into entry file: ${entryFilePath}`)
  } catch (err) {
    logger.warn(`Failed to inject i18n import into entry file: ${err}`)
  }
}

/**
 * Extracts and writes translation keys discovered during instrumentation.
 */
export async function writeExtractedKeys (
  candidates: CandidateString[],
  config: I18nextToolkitConfig,
  namespace?: string,
  logger: Logger = new ConsoleLogger()
): Promise<void> {
  if (candidates.length === 0) return

  const primaryLanguage = config.extract.primaryLanguage ?? config.locales[0] ?? 'en'
  const ns = namespace ?? config.extract.defaultNS ?? 'translation'

  // Build a map of keys from candidates
  const translations: Record<string, string> = {}
  for (const candidate of candidates) {
    if (candidate.key) {
      if (candidate.pluralForms) {
        // Write separate plural-suffix entries for i18next
        const pf = candidate.pluralForms
        if (pf.zero != null) {
          translations[`${candidate.key}_zero`] = pf.zero
        }
        if (pf.one != null) {
          translations[`${candidate.key}_one`] = pf.one
        }
        translations[`${candidate.key}_other`] = pf.other
      } else {
        translations[candidate.key] = candidate.transValue ?? candidate.content
      }
    }
  }

  if (Object.keys(translations).length === 0) return

  // Get the output path
  const outputPath = getOutputPath(config.extract.output, primaryLanguage, typeof ns === 'string' ? ns : 'translation')

  try {
    // Load existing translations
    let existingContent: Record<string, any> = {}
    try {
      const content = await readFile(outputPath, 'utf-8')
      existingContent = JSON.parse(content)
    } catch {
      existingContent = {}
    }

    // Merge with new translations
    const merged = { ...existingContent, ...translations }

    // Write the file
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, JSON.stringify(merged, null, 2))

    logger.info(`Updated ${outputPath}`)
  } catch (err) {
    logger.warn(`Failed to write translated keys: ${err}`)
  }
}

// ─── Plugin pipeline helpers ───────────────────────────────────────────────

/**
 * Normalizes a file extension to lowercase with a leading dot.
 */
function normalizeExtension (ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

/**
 * Checks whether an instrument plugin should run for a given file,
 * based on its `instrumentExtensions` hint.
 */
function shouldRunInstrumentPluginForFile (plugin: Plugin, filePath: string): boolean {
  const hints = plugin.instrumentExtensions
  if (!hints || hints.length === 0) return true
  const fileExt = normalizeExtension(extname(filePath))
  if (!fileExt) return false
  const normalizedHints = hints.map(h => normalizeExtension(h)).filter(Boolean)
  if (normalizedHints.length === 0) return true
  return normalizedHints.includes(fileExt)
}

/**
 * Runs `instrumentSetup` for every plugin that implements it.
 */
async function initializeInstrumentPlugins (
  plugins: Plugin[],
  context: { config: I18nextToolkitConfig; logger: Logger }
): Promise<void> {
  for (const plugin of plugins) {
    try {
      await plugin.instrumentSetup?.(context)
    } catch (err) {
      context.logger.warn(`Plugin ${plugin.name} instrumentSetup failed:`, err)
    }
  }
}

/**
 * Runs the `instrumentOnLoad` pipeline for a file.
 * Returns `null` if a plugin wants to skip the file, otherwise the
 * (possibly transformed) source code.
 */
async function runInstrumentOnLoadPipeline (
  initialCode: string,
  filePath: string,
  plugins: Plugin[],
  logger: Logger
): Promise<string | null> {
  let code = initialCode
  for (const plugin of plugins) {
    if (!shouldRunInstrumentPluginForFile(plugin, filePath)) continue
    try {
      const result = await plugin.instrumentOnLoad?.(code, filePath)
      if (result === null) return null
      if (typeof result === 'string') code = result
    } catch (err) {
      logger.warn(`Plugin ${plugin.name} instrumentOnLoad failed:`, err)
    }
  }
  return code
}

/**
 * Runs the `instrumentOnResult` pipeline for a file's candidates.
 * Returns the (possibly modified) array of candidates.
 */
async function runInstrumentOnResultPipeline (
  filePath: string,
  initialCandidates: CandidateString[],
  plugins: Plugin[],
  logger: Logger
): Promise<CandidateString[]> {
  let candidates = initialCandidates
  for (const plugin of plugins) {
    if (!shouldRunInstrumentPluginForFile(plugin, filePath)) continue
    try {
      const result = await plugin.instrumentOnResult?.(filePath, candidates)
      if (Array.isArray(result)) {
        candidates = result
      }
    } catch (err) {
      logger.warn(`Plugin ${plugin.name} instrumentOnResult failed:`, err)
    }
  }
  return candidates
}

// ─── Byte → char offset helpers ────────────────────────────────────────────

/**
 * Builds a lookup table from UTF-8 byte offsets to JavaScript string character
 * indices (UTF-16 code-unit positions).
 *
 * SWC internally represents source as UTF-8 and reports AST spans as byte
 * offsets into that representation.  MagicString and all JavaScript String
 * methods operate on UTF-16 code-unit indices.  For files that contain only
 * ASCII characters the two coincide, so this function returns `null` as a
 * fast path.  For files with multi-byte characters (emoji, accented letters,
 * CJK, etc.) the returned array allows O(1) conversion of any byte offset.
 */
function buildByteToCharMap (content: string): number[] | null {
  // Fast path: pure ASCII means byte offset ≡ char index
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(content)) return null

  const map: number[] = []
  let byteIdx = 0

  for (let charIdx = 0; charIdx < content.length;) {
    const cp = content.codePointAt(charIdx)!
    const byteLen = cp <= 0x7F ? 1 : cp <= 0x7FF ? 2 : cp <= 0xFFFF ? 3 : 4
    const charLen = cp > 0xFFFF ? 2 : 1 // surrogate pair

    // Every byte belonging to this character maps to the same char index
    for (let b = 0; b < byteLen; b++) {
      map[byteIdx + b] = charIdx
    }

    byteIdx += byteLen
    charIdx += charLen
  }

  // Sentinel so that span.end (one-past-the-last-byte) resolves correctly
  map[byteIdx] = content.length

  return map
}

/**
 * Recursively converts every `span.start` / `span.end` in an SWC AST from
 * UTF-8 byte offsets to JavaScript string character indices using the
 * pre-built lookup table.
 */
function convertSpansToCharIndices (node: any, byteToChar: number[]): void {
  if (!node || typeof node !== 'object') return

  if (node.span && typeof node.span.start === 'number') {
    const charStart = byteToChar[node.span.start]
    const charEnd = byteToChar[node.span.end]
    if (charStart !== undefined && charEnd !== undefined) {
      node.span = { ...node.span, start: charStart, end: charEnd }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'span') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object') {
          convertSpansToCharIndices(item, byteToChar)
        }
      }
    } else if (child && typeof child === 'object') {
      convertSpansToCharIndices(child, byteToChar)
    }
  }
}
