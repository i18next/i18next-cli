import MagicString from 'magic-string'
import type { I18nextToolkitConfig, CandidateString, TransformResult, ComponentBoundary, ImportDeclarationSpan, LanguageChangeSite, MemoHookSpan, PluralHelperImport } from '../../types.js'
import { generateKeyFromContent } from './key-generator.js'

interface TransformerOptions {
  isDryRun?: boolean
  hasReact: boolean
  isPrimaryLanguageFile: boolean
  config: Omit<I18nextToolkitConfig, 'plugins'>
  /** Detected React function component boundaries (used for hook injection) */
  components?: ComponentBoundary[]
  /** Target namespace for extracted keys (omit to use defaultNS) */
  namespace?: string
  /** Detected language-change call sites to augment with i18n.changeLanguage() */
  languageChangeSites?: LanguageChangeSite[]
  /**
   * The file's import declarations from its AST. Without them imports are found by their text, which also
   * matches an `import … from` inside a string (a code snippet the page shows).
   */
  imports?: ImportDeclarationSpan[]
  /** The file's `useMemo`/`useCallback` calls: one whose callback gets a `t()` call gets `t` in its dependencies */
  memoHooks?: MemoHookSpan[]
  /** The imported plural helpers the candidates call: an import whose every use was rewritten goes */
  pluralHelperImports?: PluralHelperImport[]
}

/**
 * Transforms a source file, replacing candidate strings with instrumented code.
 * Also injects useTranslation() hooks into React function components that
 * contain transformed strings.
 *
 * @param content - Original source code
 * @param file - File path
 * @param candidates - Candidate strings to transform
 * @param options - Transformation options
 * @returns TransformResult with modified content and diff
 */
export function transformFile (
  content: string,
  file: string,
  candidates: CandidateString[],
  options: TransformerOptions
): TransformResult {
  const s = new MagicString(content)
  const errors: string[] = []
  const warnings: string[] = []
  let transformCount = 0
  const injections = {
    importAdded: false,
    hookInjected: false
  }

  // <Trans> attributes in the quotes the file's JSX attributes use (`title='…'` or `title="…"`)
  // (a file without quoted attributes: the quotes of its imports)
  const singleQuoted = (single: RegExp, double: RegExp) => Math.sign((content.match(single)?.length ?? 0) - (content.match(double)?.length ?? 0))
  const jsxQuote = (singleQuoted(/\s[\w-]+='/g, /\s[\w-]+="/g) || singleQuoted(/\sfrom '/g, /\sfrom "/g)) > 0 ? "'" : '"'

  // Filter high-confidence candidates
  const highConfidenceCandidates = candidates.filter(c => c.confidence >= 0.7)

  // Track which components have transformed candidates
  const transformedComponents = new Set<string>()
  let hasNonComponentCandidates = false
  let hasTransCandidates = false

  // ── Language-change site injections ────────────────────────────────────
  const languageChangeSites = options.languageChangeSites || []
  // Track components that need `i18n` from useTranslation()
  const componentsNeedingI18n = new Set<string>()
  let languageChangeCount = 0

  // Apply language-change injections in reverse order (to preserve offsets)
  const sortedSites = [...languageChangeSites].sort((a, b) => b.callStart - a.callStart)
  for (const site of sortedSites) {
    try {
      const changeCall = site.insideComponent
        ? `i18n.changeLanguage(${site.languageExpression})`
        : `i18next.changeLanguage(${site.languageExpression})`

      // Check if the call is the expression body of an arrow function (no braces):
      //   () => updateSettings({ language: code })
      // We need to wrap it:
      //   () => { i18n.changeLanguage(code); updateSettings({ language: code }); }
      const beforeCall = content.slice(0, site.callStart)
      const arrowMatch = beforeCall.match(/=>\s*$/)

      if (arrowMatch) {
        // Arrow function expression body → wrap in block
        const originalCall = content.slice(site.callStart, site.callEnd)
        s.overwrite(site.callStart, site.callEnd, `{ ${changeCall}; ${originalCall}; }`)
      } else {
        // Already in a block → prepend as a statement
        s.appendLeft(site.callStart, `${changeCall}; `)
      }

      languageChangeCount++

      if (site.insideComponent) {
        componentsNeedingI18n.add(site.insideComponent)
        transformedComponents.add(site.insideComponent)
      } else {
        hasNonComponentCandidates = true
      }
    } catch (err) {
      errors.push(`Failed to inject changeLanguage at offset ${site.callStart}: ${err}`)
    }
  }

  const rewrittenHelperCalls = new Map<string, number>()

  // Apply transformations in reverse order (to maintain correct offsets)
  for (let i = highConfidenceCandidates.length - 1; i >= 0; i--) {
    const candidate = highConfidenceCandidates[i]

    try {
      const key = candidate.key || generateKeyFromContent(candidate.content)
      const useHookStyle = !!candidate.insideComponent
      const defaultNS = options.config.extract?.defaultNS ?? 'translation'
      const nsForReplacement = (options.namespace && options.namespace !== defaultNS) ? options.namespace : undefined
      // <Trans> works in any render code, a helper outside a component too; without React the text stays
      if (candidate.type === 'jsx-mixed' && !options.hasReact) continue
      const replacement = buildReplacement(candidate, key, useHookStyle, nsForReplacement, jsxQuote)

      if (replacement) {
        s.overwrite(candidate.offset, candidate.endOffset, replacement)
        transformCount++
        if (candidate.pluralHelper) rewrittenHelperCalls.set(candidate.pluralHelper, (rewrittenHelperCalls.get(candidate.pluralHelper) ?? 0) + 1)

        if (candidate.type === 'jsx-mixed') {
          hasTransCandidates = true
        }

        // jsx-mixed candidates use <Trans>, not t(), so they need neither useTranslation nor i18next
        if (candidate.type !== 'jsx-mixed') {
          if (candidate.insideComponent) {
            transformedComponents.add(candidate.insideComponent)
          } else {
            hasNonComponentCandidates = true
          }
        }
      }
    } catch (err) {
      errors.push(`Failed to transform candidate at offset ${candidate.offset}: ${err}`)
    }
  }

  // A plural helper whose every call became a plural t() is no longer used: its import goes
  for (const helper of options.pluralHelperImports ?? []) {
    const rewritten = rewrittenHelperCalls.get(helper.name) ?? 0
    if (rewritten > 0 && rewritten === helper.references) s.remove(helper.removeStart, helper.removeEnd)
  }

  // A memoized callback that now calls t() must run again when the language changes: `t` joins its dependencies
  for (const hook of options.memoHooks ?? []) {
    const usesT = highConfidenceCandidates.some(c => c.insideComponent && c.type !== 'jsx-mixed' &&
      c.offset >= hook.callbackStart && c.endOffset <= hook.callbackEnd)
    if (usesT && !hook.hasT) s.appendLeft(hook.insertAt, hook.hasDeps ? ', t' : 't')
  }

  // Add necessary imports and hooks if any transformations were made
  if (transformCount > 0 || languageChangeCount > 0) {
    const components = options.components || []

    // Inject useTranslation() hooks into affected React components
    if (options.hasReact && transformedComponents.size > 0) {
      // Process components in reverse order of bodyStart to avoid offset shifts
      const affectedComponents = components
        .filter(c => transformedComponents.has(c.name) && !c.hasUseTranslation)
        .sort((a, b) => b.bodyStart - a.bodyStart)

      const addHookLine = (comp: ComponentBoundary, line: string) => {
        const indent = comp.expressionBody ? lineIndent(content, comp.bodyStart) + '  ' : detectIndent(content, comp.bodyStart)
        if (comp.expressionBody) {
          // `() => <p>…</p>` becomes `() => { const { t } = useTranslation(); return <p>…</p> }`
          s.prependLeft(comp.bodyStart, `{\n${indent}${line}\n${indent}return `)
          s.appendRight(comp.bodyEnd, `\n${indent.slice(2)}}`)
        } else {
          s.appendRight(comp.bodyStart + 1, `\n${indent}${line}`)
        }
        injections.hookInjected = true
      }

      for (const comp of affectedComponents) {
        const defaultNS = options.config.extract?.defaultNS ?? 'translation'
        const nsArg = (options.namespace && options.namespace !== defaultNS) ? `'${options.namespace}'` : ''
        // Build destructuring: include `t` if the component has string candidates
        // (but not jsx-mixed which use <Trans>),
        // include `i18n` if the component has language-change sites.
        const needsT = highConfidenceCandidates.some(c => c.insideComponent === comp.name && c.type !== 'jsx-mixed')
        const needsI18n = componentsNeedingI18n.has(comp.name)
        const parts: string[] = []
        if (needsT) parts.push('t')
        if (needsI18n) parts.push('i18n')
        // Skip if component needs neither t nor i18n
        // (e.g. component only has jsx-mixed / <Trans> candidates)
        if (!needsT && !needsI18n) continue
        addHookLine(comp, `const { ${parts.join(', ')} } = useTranslation(${nsArg})`)
      }

      // For components that already have useTranslation but need i18n added,
      // try to upgrade `const { t } = useTranslation(...)` → `const { t, i18n } = useTranslation(...)`
      if (componentsNeedingI18n.size > 0) {
        const compsWithExistingHook = components.filter(c =>
          componentsNeedingI18n.has(c.name) && c.hasUseTranslation
        )
        for (const comp of compsWithExistingHook) {
          // Search for the destructuring pattern within the component body
          const bodyText = content.slice(comp.bodyStart, comp.bodyEnd)
          // Skip if i18n is already destructured
          if (/const\s*\{[^}]*\bi18n\b[^}]*\}\s*=\s*useTranslation/.test(bodyText)) continue
          // Match `{ t }` or `{ t, ... }` in `const { t } = useTranslation`
          const hookRe = /const\s*\{\s*t\s*\}\s*=\s*useTranslation/
          const hookMatch = hookRe.exec(bodyText)
          if (hookMatch) {
            const absStart = comp.bodyStart + hookMatch.index
            const absEnd = absStart + hookMatch[0].length
            const upgraded = hookMatch[0].replace(/\{\s*t\s*\}/, '{ t, i18n }')
            s.overwrite(absStart, absEnd, upgraded)
          } else {
            // its `t` is a prop or comes from another hook: `i18n` needs a hook of its own
            addHookLine(comp, 'const { i18n } = useTranslation()')
          }
        }
      }
    }

    // Add import statements
    addImportStatements(s, content, {
      // only for a hook injected here: a component with a `t` of its own (a prop) needs none
      needsUseTranslation: injections.hookInjected,
      needsI18next: hasNonComponentCandidates || !options.hasReact,
      needsTrans: hasTransCandidates && options.hasReact
    }, options.imports)
    injections.importAdded = true
  }

  // Warn when i18next.t() is used in React projects (translations may not be loaded yet)
  if (options.hasReact && hasNonComponentCandidates && transformCount > 0) {
    warnings.push(
      `${file}: i18next.t() was added outside of a React component. ` +
      'If translation resources are loaded asynchronously, i18next.t() may return the key instead of the translation. ' +
      'Consider moving this text into a component and using the useTranslation() hook, or ensure i18next is fully initialized before this code runs. ' +
      'See: https://www.locize.com/blog/how-to-use-i18next-t-outside-react-components/'
    )
  }

  const newContent = s.toString()
  const diff = generateDiff(content, newContent, file)
  const totalChanges = transformCount + languageChangeCount

  return {
    modified: totalChanges > 0,
    newContent: !options.isDryRun ? newContent : undefined,
    diff,
    errors,
    warnings,
    transformCount,
    languageChangeCount,
    injections
  }
}

/**
 * Builds the replacement code for a candidate string.
 *
 * @param candidate - The candidate to replace
 * @param key - The i18n key to use
 * @param useHookStyle - If true, uses t() (from useTranslation hook); otherwise uses i18next.t()
 * @param namespace - Optional namespace (only set when different from defaultNS)
 */
function buildReplacement (
  candidate: CandidateString,
  key: string,
  useHookStyle: boolean,
  namespace?: string,
  jsxQuote = '"'
): string {
  const tFunc = useHookStyle ? 't' : 'i18next.t'
  const escapedContent = escapeString(candidate.content)

  // ── Plural form: t('key', { defaultValue_zero: '…', …, count: expr }) ──
  if (candidate.pluralForms) {
    const pf = candidate.pluralForms
    const optionEntries: string[] = []
    if (pf.zero !== undefined) {
      optionEntries.push(`defaultValue_zero: '${escapeString(pf.zero)}'`)
    }
    if (pf.one !== undefined) {
      optionEntries.push(`defaultValue_one: '${escapeString(pf.one)}'`)
    }
    optionEntries.push(`defaultValue_other: '${escapeString(pf.other)}'`)
    optionEntries.push(`count: ${pf.countExpression}`)
    // Add extra interpolation variables (e.g. from JSX sibling merging with plurals)
    if (candidate.interpolations?.length) {
      for (const interp of candidate.interpolations) {
        optionEntries.push(
          interp.name === interp.expression ? interp.name : `${interp.name}: ${interp.expression}`
        )
      }
    }
    if (!useHookStyle && namespace) {
      optionEntries.push(`ns: '${namespace}'`)
    }
    const tCall = `${tFunc}('${key}', { ${optionEntries.join(', ')} })`

    switch (candidate.type) {
      case 'jsx-text':
      case 'jsx-attribute':
        return `{${tCall}}`
      default:
        return tCall
    }
  }

  // Build the optional third argument: { interpolationVars..., ns? }
  const optionEntries: string[] = []
  if (candidate.interpolations?.length) {
    for (const interp of candidate.interpolations) {
      optionEntries.push(
        interp.name === interp.expression ? interp.name : `${interp.name}: ${interp.expression}`
      )
    }
  }
  if (!useHookStyle && namespace) {
    optionEntries.push(`ns: '${namespace}'`)
  }
  const optionsArg = optionEntries.length > 0 ? `, { ${optionEntries.join(', ')} }` : ''

  const tCall = `${tFunc}('${key}', '${escapedContent}'${optionsArg})`

  switch (candidate.type) {
    case 'jsx-text':
    case 'jsx-attribute':
      return `{${tCall}}`

    case 'jsx-mixed': {
      const nsAttr = namespace ? ` ns=${jsxQuote}${namespace}${jsxQuote}` : ''
      return `<Trans i18nKey=${jsxQuote}${key}${jsxQuote}${nsAttr}>${candidate.content}</Trans>`
    }

    case 'template-literal':
    case 'string-literal':
    default:
      return tCall
  }
}

/**
 * Escapes a string for use in generated code.
 */
function escapeString (str: string): string {
  return str
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/'/g, "\\'") // Escape single quotes
    .replace(/\n/g, '\\n') // Escape newlines
    .replace(/\r/g, '\\r') // Escape carriage returns
    .replace(/\t/g, '\\t') // Escape tabs
}

/**
 * Checks if an import statement for a module already exists.
 */
function hasImport (content: string, moduleName: string): boolean {
  const importRegex = new RegExp(`import\\s+.*from\\s+['"]${moduleName}['"]`, 'g')
  const requireRegex = new RegExp(`require\\(['"]${moduleName}['"]\\)`, 'g')

  return importRegex.test(content) || requireRegex.test(content)
}

/**
 * Detects the indentation level used after an opening brace.
 * Skips blank lines and reads the whitespace of the first line that has actual content.
 */
/** The indentation of the line `offset` is on. */
function lineIndent (content: string, offset: number): string {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(content.slice(lineStart))![0]
}

function detectIndent (content: string, braceOffset: number): string {
  let searchFrom = braceOffset
  while (searchFrom < content.length) {
    const newlinePos = content.indexOf('\n', searchFrom)
    if (newlinePos === -1) return '  '

    let indent = ''
    let i = newlinePos + 1
    while (i < content.length && (content[i] === ' ' || content[i] === '\t')) {
      indent += content[i]
      i++
    }
    // If this line has actual content (not just empty / blank), use its indentation
    if (i < content.length && content[i] !== '\n' && content[i] !== '\r') {
      return indent || '  '
    }
    // Empty line — continue looking at the next line
    searchFrom = i
  }
  return '  '
}

/**
 * Adds necessary import statements (useTranslation, Trans, and/or i18next).
 */
function addImportStatements (
  s: MagicString,
  content: string,
  needs: { needsUseTranslation: boolean; needsI18next: boolean; needsTrans: boolean },
  imports?: ImportDeclarationSpan[]
): void {
  let importStatement = ''
  const imported = (moduleName: string) => imports
    ? imports.some(i => i.source === moduleName) || new RegExp(`require\\(['"]${moduleName}['"]\\)`).test(content)
    : hasImport(content, moduleName)
  // A name the file imports already, from any module (`useTranslation` re-exported by a shared package)
  const bound = (name: string) => !!imports?.some(i => i.locals?.includes(name))

  // Build a combined react-i18next import
  const reactI18nextImports: string[] = []
  if (needs.needsUseTranslation && !bound('useTranslation')) reactI18nextImports.push('useTranslation')
  if (needs.needsTrans && !bound('Trans')) reactI18nextImports.push('Trans')

  if (reactI18nextImports.length > 0) {
    if (!imported('react-i18next')) {
      importStatement += `import { ${reactI18nextImports.join(', ')} } from 'react-i18next'\n`
    } else {
      // react-i18next is already imported — augment with any missing named exports
      const existing = imports?.find(i => i.source === 'react-i18next')
      augmentReactI18nextImport(s, content, reactI18nextImports, existing?.start ?? 0)
    }
  }

  // `i18next.t()` needs that name: with the AST, an import of i18next under another name does not count
  if (needs.needsI18next && (imports ? !bound('i18next') : !imported('i18next'))) {
    importStatement += "import i18next from 'i18next'\n"
  }

  if (!importStatement) return

  // Insert after the last existing import statement, or at the top of the file
  let insertPos = 0

  // Skip shebang if present
  if (content.startsWith('#!')) {
    insertPos = content.indexOf('\n') + 1
  }

  if (imports) {
    // After the last import declaration's line
    const lastEnd = Math.max(...imports.map(i => i.end), -1)
    if (lastEnd >= 0) {
      const newline = content.indexOf('\n', lastEnd)
      insertPos = newline === -1 ? content.length : newline + 1
    }
    if (insertPos > 0 && content[insertPos - 1] !== '\n') importStatement = `\n${importStatement}`
    s.appendRight(insertPos, importStatement)
    return
  }

  // Find the end of the last import statement. Imports may span multiple lines
  // (e.g. `import {\n  CCol,\n} from '...'`), so we can't treat each `import`
  // line as a complete statement — we scan to the real end of each declaration.
  const importStartRegex = /^import\b/gm
  let match: RegExpExecArray | null
  while ((match = importStartRegex.exec(content)) !== null) {
    const endOfImport = findImportStatementEnd(content, match.index)
    if (endOfImport > insertPos) insertPos = endOfImport
    // Skip past this statement so we don't match `import` lines inside it.
    importStartRegex.lastIndex = endOfImport
  }

  // Last import may end at EOF without a trailing newline
  if (insertPos > 0 && content[insertPos - 1] !== '\n') importStatement = `\n${importStatement}`

  s.appendRight(insertPos, importStatement)
}

/**
 * Returns the offset just past the end of the import statement that begins at
 * `start`, handling multi-line imports with `{ ... }` clauses. The statement
 * ends at the first newline or `;` at brace depth 0, after its module-specifier
 * string has been closed.
 */
function findImportStatementEnd (content: string, start: number): number {
  let depth = 0
  let stringChar: string | null = null
  let sawString = false
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (stringChar !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === stringChar) {
        stringChar = null
        if (depth === 0) sawString = true
      }
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { stringChar = ch; continue }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; continue }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; continue }
    if (depth === 0 && sawString && (ch === '\n' || ch === ';')) {
      if (ch === '\n') return i + 1
      // Terminated by `;` — consume the rest of the line so the next statement
      // is inserted on its own line rather than appended after the semicolon.
      const newlinePos = content.indexOf('\n', i)
      return newlinePos === -1 ? content.length : newlinePos + 1
    }
  }
  return content.length
}

/**
 * Augments an existing `import { ... } from 'react-i18next'` with any missing
 * named exports (e.g. adds `Trans` when only `useTranslation` is imported).
 */
function augmentReactI18nextImport (
  s: MagicString,
  content: string,
  needed: string[],
  from = 0
): void {
  const importRegex = /import\s*\{([^}]*)\}\s*from\s*['"]react-i18next['"]/g
  importRegex.lastIndex = from
  const importMatch = importRegex.exec(content)
  if (!importMatch) return

  const existingImports = importMatch[1].split(',').map(x => x.trim()).filter(Boolean)
  const toAdd = needed.filter(n => !existingImports.includes(n))
  if (toAdd.length === 0) return

  const newImports = [...existingImports, ...toAdd].join(', ')
  const newImportStatement = `import { ${newImports} } from 'react-i18next'`
  const matchStart = importMatch.index
  const matchEnd = matchStart + importMatch[0].length
  s.overwrite(matchStart, matchEnd, newImportStatement)
}

/**
 * Generates a unified diff showing what changed.
 */
export function generateDiff (original: string, modified: string, filePath: string): string {
  if (original === modified) {
    return ''
  }

  const originalLines = original.split('\n')
  const modifiedLines = modified.split('\n')

  let diff = `--- a/${filePath}\n`
  diff += `+++ b/${filePath}\n`

  // Simple line-by-line diff
  for (let i = 0; i < Math.max(originalLines.length, modifiedLines.length); i++) {
    if (originalLines[i] !== modifiedLines[i]) {
      if (originalLines[i] !== undefined) {
        diff += `-${originalLines[i]}\n`
      }
      if (modifiedLines[i] !== undefined) {
        diff += `+${modifiedLines[i]}\n`
      }
    }
  }

  return diff
}
