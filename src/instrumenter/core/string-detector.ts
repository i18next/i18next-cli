import type { I18nextToolkitConfig, CandidateString } from '../../types'
import { lineColumnFromOffset } from '../../extractor/parsers/ast-utils'
import { translatableAttributeSet, translatablePropertySet } from '../../utils/jsx-attributes'

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
 * @returns CandidateString with confidence score, or null if should be skipped
 */
export function detectCandidate (
  content: string,
  offset: number,
  endOffset: number,
  file: string,
  code: string,
  config: Omit<I18nextToolkitConfig, 'plugins'>
): CandidateString | null {
  const skipReason = shouldSkip(content, file, code, offset, endOffset, config)
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

  const confidence = calculateConfidence(content, code, offset)

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
  endOffset: number,
  config: Omit<I18nextToolkitConfig, 'plugins'>
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

  // Skip pure numbers (including decimals and negative numbers)
  if (/^-?\d+(\.\d+)?$/.test(content)) {
    return 'Pure number'
  }

  // Skip URL-like strings
  if (isURLLike(content)) {
    return 'URL or path'
  }

  // Skip technical strings: attribute values, class names, technical IDs
  if (isTechnicalString(content)) {
    return 'Technical string'
  }

  // Skip developer-facing error codes (all-caps, underscore-delimited)
  if (isErrorCode(content)) {
    return 'Error code pattern'
  }

  // Skip strings that are already wrapped in t() or Trans components
  if (isAlreadyInstrumented(code, offset, endOffset)) {
    return 'Already instrumented'
  }

  // Skip console.log/warn/error arguments
  if (isConsoleArgument(code, offset)) {
    return 'Console argument'
  }

  // Skip HTML/JSX attribute values that are clearly technical
  if (isAttributeValue(code, offset)) {
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

  // Import paths (common patterns) — must have no spaces to avoid false positives on sentences
  if (/^['"]?[@a-z][\w-]*/.test(str.toLowerCase()) && !str.includes(' ') && (str.includes('/') || str.includes('.'))) {
    return true
  }

  return false
}

/**
 * Checks if a string is technical (class name, HTML attribute, IDs, etc).
 */
function isTechnicalString (str: string): boolean {
  // kebab-case or camelCase all lowercase suggests CSS class or technical ID
  if (/^[a-z0-9-_]+$/.test(str) && str.length < 30) {
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

  return false
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
function isAlreadyInstrumented (code: string, offset: number, endOffset: number): boolean {
  // Look backwards for t( — use 20 chars to cover patterns like `i18next.t(`
  const beforeStr = code.substring(Math.max(0, offset - 20), offset)
  if (beforeStr.includes('t(') || beforeStr.includes('.t(')) {
    return true
  }

  // Look forward for ) or Trans opening
  const afterStr = code.substring(endOffset, Math.min(code.length, endOffset + 20))
  if (afterStr.startsWith(')') || afterStr.includes('Trans')) {
    return true
  }

  return false
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
const TRANSLATABLE_ATTRIBUTES = translatableAttributeSet
const TRANSLATABLE_PROPERTIES = translatablePropertySet

/**
 * Checks if the string appears to be an HTML/JSX attribute value.
 * Returns true only for *technical* attribute values that should be skipped.
 * Translatable attributes (placeholder, title, alt, aria-label, etc.) are
 * allowed through so they can be instrumented.
 */
function isAttributeValue (code: string, offset: number): boolean {
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
    if (TRANSLATABLE_ATTRIBUTES.has(attrName)) {
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
function calculateConfidence (content: string, code: string, offset: number): number {
  let confidence = 0.5 // Base confidence

  // Longer sentences are more likely to be translatable
  const wordCount = content.split(/\s+/).length
  if (wordCount >= 3) {
    confidence += 0.2
  } else if (wordCount === 2) {
    confidence += 0.1
  }

  // Contains common sentence starters (user-facing)
  if (/^(the|a|an|you|your|we|our|hello|welcome|please|thank|sorry)/i.test(content)) {
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
  if (/^(click|save|delete|create|update|submit|continue|back|next|yes|no|ok|close|open|download|upload|add|edit|remove|cancel|confirm|send|search|find|apply|reset|clear|done|finish|start|stop|retry|sign|log)/i.test(content)) {
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
    if (TRANSLATABLE_ATTRIBUTES.has(attrName)) {
      confidence += 0.15 // Translatable attribute — boost
    } else {
      confidence -= 0.2
    }
  }

  // Object-property context:  { label: 'All', description: 'Some text' }
  // When the property name is a translatable-sounding key, boost confidence
  const propMatch = beforeContext.match(/(\w+)\s*:\s*$/)
  if (propMatch && !attrCtxMatch) {
    const propName = propMatch[1].toLowerCase()
    if (TRANSLATABLE_PROPERTIES.has(propName)) {
      confidence += 0.25
    }
  }

  // Regular expressions or patterns
  if (/\//.test(content) && /regex|pattern|match|search/i.test(beforeContext + afterContext)) {
    confidence -= 0.15
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, confidence))
}
