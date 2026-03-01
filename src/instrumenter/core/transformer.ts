import MagicString from 'magic-string'
import type { I18nextToolkitConfig, CandidateString, TransformResult, ComponentBoundary, LanguageChangeSite } from '../../types'
import { generateKeyFromContent } from './key-generator'

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

  // Filter high-confidence candidates
  const highConfidenceCandidates = candidates.filter(c => c.confidence >= 0.7)

  // Track which components have transformed candidates
  const transformedComponents = new Set<string>()
  let hasComponentCandidates = false
  let hasNonComponentCandidates = false

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
        hasComponentCandidates = true
      } else {
        hasNonComponentCandidates = true
      }
    } catch (err) {
      errors.push(`Failed to inject changeLanguage at offset ${site.callStart}: ${err}`)
    }
  }

  // Apply transformations in reverse order (to maintain correct offsets)
  for (let i = highConfidenceCandidates.length - 1; i >= 0; i--) {
    const candidate = highConfidenceCandidates[i]

    try {
      const key = candidate.key || generateKeyFromContent(candidate.content)
      const useHookStyle = !!candidate.insideComponent
      const defaultNS = options.config.extract?.defaultNS ?? 'translation'
      const nsForReplacement = (options.namespace && options.namespace !== defaultNS) ? options.namespace : undefined
      const replacement = buildReplacement(candidate, key, useHookStyle, nsForReplacement)

      if (replacement) {
        s.overwrite(candidate.offset, candidate.endOffset, replacement)
        transformCount++

        if (candidate.insideComponent) {
          transformedComponents.add(candidate.insideComponent)
          hasComponentCandidates = true
        } else {
          hasNonComponentCandidates = true
        }
      }
    } catch (err) {
      errors.push(`Failed to transform candidate at offset ${candidate.offset}: ${err}`)
    }
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

      for (const comp of affectedComponents) {
        const indent = detectIndent(content, comp.bodyStart)
        const defaultNS = options.config.extract?.defaultNS ?? 'translation'
        const nsArg = (options.namespace && options.namespace !== defaultNS) ? `'${options.namespace}'` : ''
        // Build destructuring: include `t` if the component has string candidates,
        // include `i18n` if the component has language-change sites.
        const needsT = highConfidenceCandidates.some(c => c.insideComponent === comp.name)
        const needsI18n = componentsNeedingI18n.has(comp.name)
        const parts: string[] = []
        if (needsT) parts.push('t')
        if (needsI18n) parts.push('i18n')
        if (parts.length === 0) parts.push('t') // fallback
        const destructured = `{ ${parts.join(', ')} }`
        s.appendRight(comp.bodyStart + 1, `\n${indent}const ${destructured} = useTranslation(${nsArg})`)
        injections.hookInjected = true
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
          }
        }
      }
    }

    // Add import statements
    addImportStatements(s, content, {
      needsUseTranslation: hasComponentCandidates && options.hasReact,
      needsI18next: hasNonComponentCandidates || !options.hasReact
    })
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
  namespace?: string
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

    case 'jsx-mixed':
      if (useHookStyle) {
        return `<Trans i18nKey="${key}">${candidate.content}</Trans>`
      }
      return candidate.content

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
 * Adds necessary import statements (useTranslation and/or i18next).
 */
function addImportStatements (
  s: MagicString,
  content: string,
  needs: { needsUseTranslation: boolean; needsI18next: boolean }
): void {
  let importStatement = ''

  if (needs.needsUseTranslation && !hasImport(content, 'react-i18next')) {
    importStatement += "import { useTranslation } from 'react-i18next'\n"
  }

  if (needs.needsI18next && !hasImport(content, 'i18next')) {
    importStatement += "import i18next from 'i18next'\n"
  }

  if (!importStatement) return

  // Insert after the last existing import statement, or at the top of the file
  let insertPos = 0

  // Skip shebang if present
  if (content.startsWith('#!')) {
    insertPos = content.indexOf('\n') + 1
  }

  // Find the end of the last import statement
  const importRegex = /^import\s.+$/gm
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(content)) !== null) {
    const endOfImport = match.index + match[0].length
    if (endOfImport > insertPos) {
      const nextNewline = content.indexOf('\n', endOfImport)
      insertPos = nextNewline !== -1 ? nextNewline + 1 : endOfImport
    }
  }

  s.appendRight(insertPos, importStatement)
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
