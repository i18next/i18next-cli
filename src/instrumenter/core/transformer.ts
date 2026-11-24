import MagicString from 'magic-string'
import type { I18nextToolkitConfig, CandidateString, TransformResult, ComponentBoundary, ImportDeclarationSpan, LanguageChangeSite, MemoHookSpan, PluralHelperImport } from '../../types.js'
import { generateKeyFromContent } from './key-generator.js'
import type { NextFileKind } from './next-files.js'

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
  /** A file of a next-i18next app: where it renders, and the module its Server Components import `getT` from */
  next?: { kind: NextFileKind, serverModule: string }
}

/** The hook a component gets `t` from, and where `useTranslation`/`useT`/`getT` and `Trans` are imported from. */
function bindingsFor (next: TransformerOptions['next']): { hook: string, hookModule: string, transModule: string, call: (args: string) => string } {
  switch (next?.kind) {
    case 'server': return { hook: 'getT', hookModule: next.serverModule, transModule: 'react-i18next/TransWithoutContext', call: args => `await getT(${args})` }
    // its `t` is a prop: no hook; a <Trans> without context works on both sides
    case 'shared':
    case 'unknown': return { hook: 'useT', hookModule: 'next-i18next/client', transModule: 'react-i18next/TransWithoutContext', call: args => `useT(${args})` }
    case 'client': return { hook: 'useT', hookModule: 'next-i18next/client', transModule: 'next-i18next/client', call: args => `useT(${args})` }
    case 'pages': return { hook: 'useTranslation', hookModule: 'next-i18next/pages', transModule: 'next-i18next/pages', call: args => `useTranslation(${args})` }
    default: return { hook: 'useTranslation', hookModule: 'react-i18next', transModule: 'react-i18next', call: args => `useTranslation(${args})` }
  }
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

  const bindings = bindingsFor(options.next)
  // A <Trans> in a Server Component has no React context: it takes `t` and `i18n` from getT()
  // (and in a component that Server and Client Components both render, from its props)
  const transProps = ['server', 'shared', 'unknown'].includes(options.next?.kind ?? '') ? ' t={t} i18n={i18n}' : ''

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
  const wrappedGetters = new Set<number>()

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
      let replacement = buildReplacement(candidate, key, useHookStyle, nsForReplacement, jsxQuote, transProps)
      if (candidate.type === 'jsx-mixed') replacement = layOutTrans(replacement, content, candidate)

      if (replacement) {
        s.overwrite(candidate.offset, candidate.endOffset, replacement)
        // a module-scope property's text is read when it is used: `label: 'X'` → `get label () { return i18next.t(…) }`
        const getter = candidate.getter
        if (getter && !wrappedGetters.has(getter.keyStart)) {
          wrappedGetters.add(getter.keyStart)
          // (a comment between the colon and the value stays)
          s.appendLeft(getter.keyStart, 'get ')
          s.overwrite(getter.colon, getter.colon + 1, ' () { return')
          s.appendLeft(getter.valueEnd, ' }')
        }
        transformCount++
        if (candidate.pluralHelper) rewrittenHelperCalls.set(candidate.pluralHelper, (rewrittenHelperCalls.get(candidate.pluralHelper) ?? 0) + 1)

        if (candidate.type === 'jsx-mixed') {
          hasTransCandidates = true
        }

        // jsx-mixed candidates use <Trans>, not t(), so they need neither useTranslation nor i18next (but in a
        // Server Component its `t` and `i18n`)
        if (candidate.type !== 'jsx-mixed' || (transProps && candidate.insideComponent)) {
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
      const addHookLine = (comp: ComponentBoundary, line: string) => {
        const indent = comp.expressionBody ? lineIndent(content, comp.bodyStart) + '  ' : detectIndent(content, comp.bodyStart)
        if (comp.expressionBody) {
          // `() => <p>…</p>` becomes `() => { const { t } = useTranslation(); return <p>…</p> }`
          s.prependLeft(comp.bodyStart, `{\n${indent}${line}\n${indent}return `)
          s.appendRight(comp.bodyEnd, `\n${indent.slice(2)}}`)
        } else {
          // a body on one line (`function App () { return <h1>…</h1> }`): the statement after it gets a line of its own
          const sameLine = !/^[ \t]*(?:\r?\n|$)/.test(content.slice(comp.bodyStart + 1))
          s.appendRight(comp.bodyStart + 1, `\n${indent}${line}${sameLine ? `\n${indent}` : ''}`)
        }
        // getT() is awaited: a Server Component becomes async, and `export const metadata = {…}` the function
        // Next.js calls instead, `export async function generateMetadata () { …; return {…} }`
        if (comp.metadataHead) {
          const { start, end, type } = comp.metadataHead
          // contentOnly: the block that wraps the object starts at `end`, and stays
          s.overwrite(start, end, `async function generateMetadata ()${type ? `: Promise<${type}>` : ''} `, { contentOnly: true })
        } else if (options.next?.kind === 'server' && !comp.isAsync && comp.start !== undefined) {
          s.appendLeft(comp.start, 'async ')
          // an async function returns a promise: `(): JSX.Element` becomes `(): Promise<JSX.Element>`
          const type = comp.returnType
          if (type && !/^Promise\s*</.test(content.slice(type.start, type.end))) {
            s.appendLeft(type.start, 'Promise<')
            s.appendRight(type.end, '>')
          }
        }
        injections.hookInjected = true
      }

      // Components in reverse order of bodyStart to avoid offset shifts
      for (const comp of components.filter(c => transformedComponents.has(c.name)).sort((a, b) => b.bodyStart - a.bodyStart)) {
        const defaultNS = options.config.extract?.defaultNS ?? 'translation'
        const nsArg = (options.namespace && options.namespace !== defaultNS) ? `'${options.namespace}'` : ''
        // `t` for its t() calls (and a <Trans> in a Server Component), `i18n` for a language change (and that <Trans>)
        const own = highConfidenceCandidates.filter(c => c.insideComponent === comp.name)
        const needsT = !comp.hasUseTranslation && own.some(c => c.type !== 'jsx-mixed' || transProps)
        const needsI18n = componentsNeedingI18n.has(comp.name) || (!!transProps && !comp.i18nParam && own.some(c => c.type === 'jsx-mixed'))
        const missing = [needsT && 't', needsI18n && !comp.hookPattern?.names.includes('i18n') && 'i18n'].filter(Boolean)
        if (!missing.length) continue
        // that call gives `t` only to the code after it: a text before it would read `t` before its declaration
        const before = (offset: number) => offset < comp.hookPattern!.statement
        const usedBefore = comp.hookPattern && (own.some(c => before(c.offset)) ||
          languageChangeSites.some(site => site.insideComponent === comp.name && before(site.callStart)))
        if (comp.hookPattern && !usedBefore && (comp.hasUseTranslation || !comp.hookPattern.names.includes('t'))) {
          // it calls a translation hook already (`const { i18n } = useT('ns')`): that call gives them, from its
          // namespace (`{ t, i18n }`)
          if (missing.includes('t')) s.appendLeft(comp.hookPattern.first, 't, ')
          if (missing.includes('i18n')) s.appendRight(comp.hookPattern.last, ', i18n')
        } else {
          addHookLine(comp, `const { ${missing.join(', ')} } = ${bindings.call(missing.includes('t') ? nsArg : '')}`)
        }
      }
    }

    // Add import statements
    addImportStatements(s, content, [
      // only for a hook injected here: a component with a `t` of its own (a prop) needs none
      ...(injections.hookInjected ? [{ name: bindings.hook, module: bindings.hookModule }] : []),
      ...(hasTransCandidates && options.hasReact ? [{ name: 'Trans', module: bindings.transModule }] : [])
    ], hasNonComponentCandidates || !options.hasReact, options.imports)
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
 * A <Trans> around text written over several lines gets lines of its own, its text one step in, as JSX is
 * written; what it renders stays the same (JSX drops the line breaks and indents at the edges of a text).
 * Left inline when the text shares its first line with other code or holds a string over several lines.
 */
function layOutTrans (replacement: string, code: string, candidate: CandidateString): string {
  const text = candidate.content
  const indent = code.slice(code.lastIndexOf('\n', candidate.offset - 1) + 1, candidate.offset)
  // a string over several lines (a template literal, an attribute's value) would change with the indent
  const multiLineString = [...text.matchAll(/`[^`]*`|="[^"]*"|='[^']*'/g)].some(m => m[0].includes('\n'))
  if (!text.includes('\n') || /\S/.test(indent) || multiLineString || !replacement.endsWith(`${text}</Trans>`)) return replacement
  const open = replacement.slice(0, replacement.length - text.length - '</Trans>'.length)
  const [first, ...rest] = text.split('\n')
  return `${open}\n${indent}  ${first}${rest.map(line => `\n  ${line}`).join('')}\n${indent}</Trans>`
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
  jsxQuote = '"',
  transProps = ''
): string {
  const tFunc = useHookStyle ? 't' : 'i18next.t'
  const nsOption = !useHookStyle && namespace ? `, { ns: '${namespace}' }` : ''
  // a placeholder's value with words of its own: each a t() call (`name: name || t('items', 'items')`)
  type Interpolation = NonNullable<CandidateString['interpolations']>[number]
  const valueOf = (interp: Interpolation) => (interp.texts ?? []).reduceRight((expr, text) =>
    text.key ? `${expr.slice(0, text.start)}${tFunc}('${text.key}', '${escapeString(text.value)}'${nsOption})${expr.slice(text.end)}` : expr,
  interp.expression)
  const entry = (interp: Interpolation) => {
    const value = valueOf(interp)
    return interp.name === value ? interp.name : `${interp.name}: ${value}`
  }

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
    for (const interp of candidate.interpolations ?? []) optionEntries.push(entry(interp))
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

  // The call, with the optional third argument: { interpolationVars..., ns? }
  const call = (k: string, text: string, interpolations: CandidateString['interpolations']) => {
    const optionEntries = (interpolations ?? []).map(entry)
    if (!useHookStyle && namespace) optionEntries.push(`ns: '${namespace}'`)
    const optionsArg = optionEntries.length > 0 ? `, { ${optionEntries.join(', ')} }` : ''
    return `${tFunc}('${k}', '${escapeString(text)}'${optionsArg})`
  }
  let tCall = call(key, candidate.content, candidate.interpolations)
  // a text with an optional part: the two texts, chosen as the code chose the part
  const alternative = candidate.alternative
  if (alternative?.key) {
    const other = call(alternative.key, alternative.content, alternative.interpolations)
    tCall = alternative.mainWhen ? `(${alternative.test} ? ${tCall} : ${other})` : `(${alternative.test} ? ${other} : ${tCall})`
  }

  switch (candidate.type) {
    case 'jsx-text':
    case 'jsx-attribute':
      return `{${tCall}}`

    case 'jsx-mixed': {
      const nsAttr = namespace ? ` ns=${jsxQuote}${namespace}${jsxQuote}` : ''
      return `<Trans i18nKey=${jsxQuote}${key}${jsxQuote}${nsAttr}${transProps}>${candidate.content}</Trans>`
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
 * Adds the import statements the rewrite needs: the named imports `needed` (a hook, `Trans`), each from its module
 * (added to an import of that module the file has), and `i18next` for `i18next.t()`.
 */
function addImportStatements (
  s: MagicString,
  content: string,
  needed: Array<{ name: string, module: string }>,
  needsI18next: boolean,
  imports?: ImportDeclarationSpan[]
): void {
  let importStatement = ''
  const imported = (moduleName: string) => imports
    ? imports.some(i => i.source === moduleName) || new RegExp(`require\\(['"]${moduleName}['"]\\)`).test(content)
    : hasImport(content, moduleName)
  // A name the file imports already, from any module (`useTranslation` re-exported by a shared package)
  const bound = (name: string) => !!imports?.some(i => i.locals?.includes(name))

  const byModule = new Map<string, string[]>()
  for (const { name, module } of needed) {
    if (!bound(name)) byModule.set(module, [...(byModule.get(module) ?? []), name])
  }
  for (const [module, names] of byModule) {
    if (!imported(module)) {
      importStatement += `import { ${names.join(', ')} } from '${module}'\n`
    } else {
      // the module is imported already: augment it with the missing named exports
      const existing = imports?.find(i => i.source === module)
      augmentNamedImport(s, content, module, names, existing?.start ?? 0)
    }
  }

  // `i18next.t()` needs that name: with the AST, an import of i18next under another name does not count
  if (needsI18next && (imports ? !bound('i18next') : !imported('i18next'))) {
    importStatement += "import i18next from 'i18next'\n"
  }

  if (!importStatement) return

  // Insert after the last existing import statement, or at the top of the file
  let insertPos = 0

  // Skip shebang if present
  if (content.startsWith('#!')) {
    insertPos = content.indexOf('\n') + 1
  }
  // and the directives (`'use client'`), which must stay the first statements
  const directives = DIRECTIVES_RE.exec(content.slice(insertPos))
  if (directives) {
    insertPos += directives[0].length
    if (content[insertPos - 1] !== '\n') importStatement = `\n${importStatement}`
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

/** The directive prologue: `'use client'`, `'use strict'` and the like, with the comments around them, to the line end. */
const DIRECTIVES_RE = /^(?:(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use [\w ]+\1;?[^\S\n]*(?:\/\/[^\n]*)?(?:\n|$))+/

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
 * Augments an existing `import { ... } from '<module>'` with any missing
 * named exports (e.g. adds `Trans` when only `useTranslation` is imported).
 * A module imported without braces (`import i18n from …`) gets its own import.
 */
function augmentNamedImport (
  s: MagicString,
  content: string,
  module: string,
  needed: string[],
  from = 0
): void {
  const quoted = module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const importRegex = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${quoted}['"]`, 'g')
  importRegex.lastIndex = from
  const importMatch = importRegex.exec(content)
  if (!importMatch) {
    s.prependLeft(from, `import { ${needed.join(', ')} } from '${module}'\n`)
    return
  }

  const existingImports = importMatch[1].split(',').map(x => x.trim()).filter(Boolean)
  const toAdd = needed.filter(n => !existingImports.includes(n))
  if (toAdd.length === 0) return

  const newImports = [...existingImports, ...toAdd].join(', ')
  const newImportStatement = `import { ${newImports} } from '${module}'`
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
