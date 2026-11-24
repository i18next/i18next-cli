import type { I18nextToolkitConfig, CandidateString } from '../../types.js'
import { lineColumnFromOffset } from '../../extractor/parsers/ast-utils.js'
import { translatableAttributeSet, translatablePropertySet } from '../../utils/jsx-attributes.js'

/**
 * Detects if a string is a candidate for translation based on confidence heuristics.
 * Returns null if the string should be skipped, otherwise returns a CandidateString
 * with a confidence score.
 *
 * When a custom scorer is provided via `config.extract.instrumentScorer`, it is
 * called after the built-in skip checks. The scorer can:
 * - Return a number (0-1) to override the confidence score
 * - Return `null` to force-skip the candidate
 * - Return `undefined` to fall back to the built-in heuristic
 *
 * **Important:** This uses heuristic-based detection and will not catch 100% of cases.
 * False positives and false negatives are expected. The results serve as a starting point
 * for manual review and refinement. Always review the generated transformations before
 * committing them to your codebase.
 *
 * @param content - The string content to evaluate
 * @param offset - Byte offset in file (normalized)
 * @param endOffset - End byte offset in file
 * @param file - Source file path
 * @param code - Full source code for context
 * @param config - Toolkit configuration
 * @param translatableAttributes - Lower-cased attribute names that hold text on the enclosing JSX element
 *   (from the per-element `extract.acceptedAttributes` rules); defaults to the built-in list
 * @param isJsxText - The string is JSX text, where a single lower-case word (`<Tag>expired</Tag>`) is text
 *   rather than an identifier
 * @returns CandidateString with confidence score, or null if should be skipped
 */
export function detectCandidate (
  content: string,
  offset: number,
  endOffset: number,
  file: string,
  code: string,
  config: Omit<I18nextToolkitConfig, 'plugins'>,
  translatableAttributes: ReadonlySet<string> = translatableAttributeSet,
  isJsxText = false
): CandidateString | null {
  const skipReason = shouldSkip(content, file, code, offset, translatableAttributes, isJsxText)
  if (skipReason) {
    return null
  }

  const position = lineColumnFromOffset(code, offset) ?? { line: 0, column: 0 }
  const { line, column } = position

  // If a custom scorer is provided, call it first
  const customScorer = config.extract?.instrumentScorer
  if (customScorer) {
    const beforeContext = code.substring(Math.max(0, offset - 100), offset)
    const afterContext = code.substring(endOffset, Math.min(code.length, endOffset + 100))
    const customResult = customScorer(content, { file, offset, code, beforeContext, afterContext })

    if (customResult === null) {
      return null // Custom scorer says skip
    }

    if (typeof customResult === 'number') {
      return {
        content,
        confidence: Math.max(0, Math.min(1, customResult)),
        offset,
        endOffset,
        type: 'string-literal',
        file,
        line,
        column
      }
    }

    // customResult === undefined → fall through to built-in heuristic
  }

  const confidence = calculateConfidence(content, code, offset, translatableAttributes)

  return {
    content,
    confidence,
    offset,
    endOffset,
    type: 'string-literal',
    file,
    line,
    column
  }
}

/** An HTML character reference in JSX text: `&nbsp;`, `&#8212;`, `&#x2014;`. */
export const HTML_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi

/**
 * Determines if a string should be skipped from instrumentation.
 *
 * @returns Skip reason if should be skipped, null otherwise
 */
function shouldSkip (
  content: string,
  file: string,
  code: string,
  offset: number,
  translatableAttributes: ReadonlySet<string>,
  isJsxText: boolean
): string | null {
  // Skip test files
  if (file.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/i)) {
    return 'Test file'
  }

  // Skip empty strings and single characters
  if (!content || content.length <= 1) {
    return 'Empty or single character'
  }

  // Skip pure whitespace
  if (/^\s+$/.test(content)) {
    return 'Whitespace only'
  }

  // Skip separators, symbols and numbers with units: no letter outside HTML entities and a component's own
  // `{name}` placeholders (` / `, `·`, `100%`, `"{name}",`)
  if (!/\p{L}/u.test(content.replace(HTML_ENTITY_RE, '').replace(/(?<!\{)\{\s*[\w.]+\s*\}(?!\})/g, ''))) {
    return 'No letters'
  }

  // Skip pure numbers (including decimals and negative numbers)
  if (/^-?\d+(\.\d+)?$/.test(content)) {
    return 'Pure number'
  }

  // Skip URL-like strings
  if (isURLLike(content)) {
    return 'URL or path'
  }

  // Skip technical strings: attribute values, class names, technical IDs; in a text slot (JSX text, a
  // translatable attribute) a single word is text (`<Tag>expired</Tag>`, `aria-label='actions'`)
  const textSlot = isJsxText || translatableAttributes.has(attributeNameBefore(code, offset) ?? '')
  if (isTechnicalString(content) && !(textSlot && /^\p{L}+$/u.test(content) && !/\p{Ll}\p{Lu}/u.test(content))) {
    return 'Technical string'
  }

  if (isCodeSnippet(content)) {
    return 'Code snippet'
  }

  // A region code and acronyms (`EU OSS VAT`, `CA GST/HST`, `CA PST (BC)`): names of tax ids and the like, the same
  // in every language; a phrase in capitals (`SIGN IN`, `ADD TO CART`) and one word (`FAQ`) stay text
  const tokens = content.trim().split(/\s+/)
  if (tokens.length > 1 && /^[A-Z]{2}$/.test(tokens[0]) && tokens.every(t => t.replace(/[()]/g, '').split('/').every(p => /^[A-Z][A-Z0-9]{0,4}$/.test(p)))) {
    return 'Acronyms'
  }

  // Skip developer-facing error codes (all-caps, underscore-delimited)
  if (isErrorCode(content)) {
    return 'Error code pattern'
  }

  // Skip strings that are already wrapped in t() or Trans components
  if (isAlreadyInstrumented(code, offset)) {
    return 'Already instrumented'
  }

  // Skip console.log/warn/error arguments
  if (isConsoleArgument(code, offset)) {
    return 'Console argument'
  }

  // Skip HTML/JSX attribute values that are clearly technical
  if (isAttributeValue(code, offset, translatableAttributes)) {
    return 'HTML attribute value'
  }

  return null
}

/**
 * Checks if a string looks like a URL or file path.
 */
function isURLLike (str: string): boolean {
  // URLs: http://, https://, ftp://, file://, mailto:, etc.
  if (/^(https?|ftp|file|mailto|data):/.test(str)) return true

  // File paths: ./path, ../path, /absolute/path, C:\windows\path
  if (/^(\.\.?\/|\/|[A-Za-z]:\\)/.test(str)) return true

  // Import paths and module ids (`react-dom/client`, `lodash.debounce`): no spaces, a `/` or a `.` inside;
  // a word that ends a sentence (`Done.`, `first.`) is not one
  if (/^['"]?[@a-z][\w-]*/.test(str) && !str.includes(' ') && /[./][\w@]/.test(str)) {
    return true
  }

  return false
}

/**
 * Checks if a string is technical (class name, HTML attribute, IDs, etc).
 */
function isTechnicalString (str: string): boolean {
  // kebab-case or snake_case, or one lowercase word: a CSS class or a technical ID, however long
  if (/^[a-z0-9-_]+$/.test(str)) {
    return true
  }

  // HTML attribute patterns like type="text", role="button", etc.
  if (/^(type|role|aria-|data-|href|src|id|class|name)$/i.test(str)) {
    return true
  }

  // Very short all-uppercase abbreviations (CSS, DOM, API, URL, etc.)
  if (/^[A-Z]{2,3}$/.test(str)) {
    return true
  }

  // camelCase identifiers: object keys, event and feature names (`aiReview`, `apiKeys`)
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(str)) {
    return true
  }

  if (isCSSValue(str)) {
    return true
  }

  // An HTTP authorization value (`Bearer ${token}`)
  if (/^(?:Bearer|Basic|Digest|Token) \{\{\w+\}\}$/.test(str)) {
    return true
  }

  // One token holding `|`, `=` or an inner `:` is a rule, query or key path (`required|min:2`, `max:50`, `a=b`);
  // a trailing colon is a label (`Note:`)
  if (/^\S+$/.test(str) && /[|=]|:(?!$)/.test(str)) {
    return true
  }

  return false
}

/** A CSS keyword or named color, the words a CSS value may hold besides numbers, colors and functions. */
const CSS_WORDS = new Set([
  'inset', 'solid', 'dashed', 'dotted', 'double', 'none', 'auto', 'inherit', 'initial', 'unset', 'transparent',
  'currentcolor', 'bold', 'normal', 'italic', 'center', 'left', 'right', 'top', 'bottom', 'flex', 'grid', 'block',
  'inline', 'absolute', 'relative', 'fixed', 'sticky', 'hidden', 'visible', 'ease', 'ease-in', 'ease-out',
  'ease-in-out', 'linear', 'black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'yellow', 'purple'
])

/**
 * Checks if a string is a CSS value: `var(--brand)`, `inset 0 0 5px 1px var(--shadow)`, `1px solid #ccc`. Only
 * numbers (with a unit), colors, CSS functions and CSS keywords, at least one of them no keyword.
 */
function isCSSValue (str: string): boolean {
  let rest = str.trim()
  // CSS functions, nested ones from the inside out: var(--a, calc(1px + 2px))
  for (let before = ''; before !== rest;) {
    before = rest
    rest = rest.replace(/[a-z-]+\([^()]*\)/gi, ' \u0001 ')
  }
  const tokens = rest.split(/[\s,/]+/).filter(Boolean)
  const valueToken = (t: string) => t === '\u0001' || /^#[\da-f]{3,8}$/i.test(t) ||
    /^-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|pt|s|ms|deg|fr)?$/i.test(t)
  return tokens.length > 0 &&
    tokens.every(t => valueToken(t) || CSS_WORDS.has(t.toLowerCase()) || t === '!important') &&
    tokens.some(t => valueToken(t) && !/^-?\d*\.?\d+$/.test(t))
}

/**
 * Checks if a string is a code or shell snippet shown to the user as is: several lines, one of them code
 * (a statement, a block brace or semicolon at its end, a comment, a command-line flag).
 */
function isCodeSnippet (str: string): boolean {
  if (!str.includes('\n')) return false
  return str.split('\n').some(line =>
    /[{};]\s*$|^\s*(import|export|const|let|var|function|return|npm|npx|yarn|pnpm)\s|^\s*\/\/|\s--[a-z]/.test(line))
}

/**
 * Checks if a string looks like a developer-facing error code.
 * Examples: ERROR_NOT_FOUND, ERR_INVALID_TOKEN, etc.
 */
function isErrorCode (str: string): boolean {
  // All uppercase with underscores, typically error codes
  if (/^[A-Z][A-Z0-9_]*$/.test(str) && str.includes('_') && str.length > 3) {
    return true
  }

  return false
}

/**
 * Checks if a string is already wrapped in a t() call or Trans component.
 */
function isAlreadyInstrumented (code: string, offset: number): boolean {
  // The string is the first argument of t(), $t(), i18next.t(), props.t(): `t(` right before it, not just any
  // name ending in t (`alert(`, `toast(`, `format(`). The instrumenter's AST walk skips whole t() calls and
  // <Trans> elements, so their other arguments and children never get here.
  const beforeStr = code.substring(Math.max(0, offset - 20), offset)
  return /(?:^|[^\w$])\$?t\(\s*$/.test(beforeStr)
}

/**
 * Checks if this string is inside a console.log/warn/error call.
 */
function isConsoleArgument (code: string, offset: number): boolean {
  const beforeStr = code.substring(Math.max(0, offset - 100), offset)
  return /console\.(log|warn|error|info|debug|trace)\s*\(\s*["']?\s*$/.test(beforeStr)
}

// Translatable attribute and property sets are defined in
// utils/jsx-attributes.ts and shared with the linter.
// lower-cased, as the property name is looked up lower-cased (`helpText` → `helptext`)
const TRANSLATABLE_PROPERTIES = new Set([...translatablePropertySet].map(p => p.toLowerCase()))

/** Object property names whose values are not text: headers, addresses, identifiers, styling. */
const TECHNICAL_PROPERTIES = new Set([
  'authorization', 'url', 'uri', 'href', 'src', 'path', 'pathname', 'endpoint', 'route', 'id', 'key',
  'class', 'classname', 'classes', 'cls', 'style', 'styles', 'method', 'mimetype', 'contenttype', 'accept', 'encoding',
  'icon', 'variant', 'color', 'type', 'code',
  // formats, styles and events: `format: 'MMM D, YYYY'`, `transition: 'all 0.3s ease'`, `event: 'Sign Up Completed'`
  'format', 'dateformat', 'font', 'fontfamily', 'transition', 'animation', 'event', 'eventname', 'mime', 'query',
  'shortcut', 'hotkey', 'pattern', 'regex', 'locale', 'lng'
])

/**
 * A property name for an id, a path, a class, an icon, a type, a format or an event: its value is no text
 * (`Authorization`, `iconName`, `dateFormat`). Case and dashes do not count (`Content-Type`).
 */
export function isTechnicalPropertyName (name: string): boolean {
  return TECHNICAL_PROPERTIES.has(name.toLowerCase().replace(/-/g, '')) ||
    /[a-z0-9](?:Id|ID|Key|Url|URL|Path|Class|ClassName|Classes|Icon|Type|Format|Event|Pattern)$/.test(name)
}

/** The lower-cased name of the JSX attribute whose value starts at `offset` (`title='…'`), or null. */
function attributeNameBefore (code: string, offset: number): string | null {
  return code.substring(Math.max(0, offset - 50), offset).match(/([\w-]+)=$/)?.[1].toLowerCase() ?? null
}

/**
 * Checks if the string appears to be an HTML/JSX attribute value.
 * Returns true only for *technical* attribute values that should be skipped.
 * Translatable attributes (placeholder, title, alt, aria-label, etc.) are
 * allowed through so they can be instrumented.
 */
function isAttributeValue (code: string, offset: number, translatableAttributes: ReadonlySet<string>): boolean {
  // Note: offset points at the opening quote character, so beforeStr goes up to
  // (but does not include) that quote. We check for `attr=` at the end.
  const beforeStr = code.substring(Math.max(0, offset - 50), offset)

  // Pattern: attributeName="..." or attributeName='...'
  // Require `=` immediately before the quote (no trailing space) to
  // distinguish JSX attributes (`placeholder="..."`  — no space) from JS
  // variable assignments (`const x = "..."`  — space before quote).
  const match = beforeStr.match(/([\w-]+)\s*=$/)
  if (match) {
    const attrName = match[1].toLowerCase()
    // Allow translatable attributes to pass through
    if (translatableAttributes.has(attrName)) {
      return false
    }
    return true
  }

  return false
}

/**
 * Calculates a confidence score (0-1) for a candidate string.
 * Higher scores indicate higher likelihood of being user-facing content.
 *
 * **Note:** This is a heuristic-based approach and won't be 100% accurate.
 * High-confidence strings should still be reviewed by developers before final deployment.
 * Use this as a first pass to identify candidates, not as an authoritative decision.
 */
function calculateConfidence (content: string, code: string, offset: number, translatableAttributes: ReadonlySet<string>): number {
  let confidence = 0.5 // Base confidence

  // Longer sentences are more likely to be translatable
  const wordCount = content.split(/\s+/).length
  if (wordCount >= 3) {
    confidence += 0.2
  } else if (wordCount === 2) {
    confidence += 0.1
  }

  // Contains common sentence starters (user-facing)
  if (/^(the|a|an|you|your|we|our|hello|welcome|please|thank|sorry)\b/i.test(content)) {
    confidence += 0.15
  }

  // Contains punctuation (sentences)
  if (/[.!?]$/.test(content)) {
    confidence += 0.1
  }

  // Contains mixed case (likely English, not technical)
  if (/[A-Z].*[a-z].*[A-Z]/.test(content) || /[a-z].*[A-Z]/.test(content)) {
    confidence += 0.05
  }

  // Contains numbers mixed with words (like "Step 1")
  if (/\d.*[a-z]|[a-z].*\d/i.test(content)) {
    confidence += 0.05
  }

  // Contains action verb (likely a button or instruction)
  if (/^(click|save|delete|create|update|submit|continue|back|next|yes|no|ok|close|open|download|upload|add|edit|remove|cancel|confirm|send|search|find|apply|reset|clear|done|finish|start|stop|retry|sign|log)\b/i.test(content)) {
    confidence += 0.1
  }

  // Reduce confidence if appears in specific technical contexts
  const beforeContext = code.substring(Math.max(0, offset - 40), offset)
  const afterContext = code.substring(offset, Math.min(code.length, offset + 20))

  // Import paths, requires, etc.
  if (/from\s+$|require\s*\(\s*$|import\s+$/.test(beforeContext)) {
    confidence -= 0.3
  }

  // HTML/JSX attribute values (offset is at opening quote, so beforeContext ends with `=`)
  const attrCtxMatch = beforeContext.match(/([\w-]+)\s*=$/)
  if (attrCtxMatch) {
    const attrName = attrCtxMatch[1].toLowerCase()
    if (translatableAttributes.has(attrName)) {
      confidence += 0.2 // Translatable attribute: its value is text, a single word too (`title='Publishing'`)
    } else {
      confidence -= 0.2
    }
  }

  // Object-property context:  { label: 'All', description: 'Some text' }
  // When the property name is a translatable-sounding key, boost confidence;
  // a technical one ({ Authorization: `Bearer ${token}` }, { iconName: 'Lock' }) lowers it
  // …and so does a variable a technical name is given (`const classes = …`, `cls = …`)
  // (a quoted key has both quotes: `'…API key' :`, a ternary's string before its `:`, names no property)
  const keyMatch = beforeContext.match(/(?:(['"])([\w-]+)\1|([A-Za-z_$][\w$]*))\s*:\s*$/)
  const rawName = keyMatch ? (keyMatch[2] ?? keyMatch[3]) : beforeContext.match(/(\w+)\s+=\s*$/)?.[1]
  if (rawName && !attrCtxMatch) {
    const propName = rawName.toLowerCase().replace(/-/g, '') // 'Content-Type' → contenttype
    if (TRANSLATABLE_PROPERTIES.has(propName)) {
      confidence += 0.25
    } else if (isTechnicalPropertyName(rawName)) {
      confidence -= 0.3
    }
  }

  // Regular expressions or patterns
  if (/\//.test(content) && /regex|pattern|match|search/i.test(beforeContext + afterContext)) {
    confidence -= 0.15
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, confidence))
}
