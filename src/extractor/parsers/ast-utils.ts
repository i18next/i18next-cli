import type { Expression, Identifier, ObjectExpression, TemplateLiteral } from '@swc/core'

/**
 * Returns the 0-based index of the first real token in the source code,
 * skipping leading whitespace, single-line comments (`//`), multi-line
 * comments, and hashbang lines (`#!`).
 *
 * This is needed because SWC's `Module.span.start` points to the first
 * token, not to byte 0 of the source. Knowing the first token's index
 * lets us compute the true base offset for span normalisation:
 * `base = ast.span.start - findFirstTokenIndex(code)`.
 */
export function findFirstTokenIndex (code: string): number {
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue }
    // Skip hashbang (only at very start of file)
    if (i === 0 && ch === '#' && code[1] === '!') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    // Skip single-line comment
    if (ch === '/' && code[i + 1] === '/') {
      i += 2
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    // Skip multi-line comment
    if (ch === '/' && code[i + 1] === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }
    return i
  }
  return 0
}

/**
 * Recursively normalizes all SWC span offsets in an AST by subtracting a base
 * offset. SWC's `parse()` accumulates byte offsets across successive calls in
 * the same process, so `span.start`/`span.end` values can exceed the length of
 * the source file. Call this once on the root `Module` node right after parsing
 * to make every span file-relative (0-based index into the source string).
 *
 * The correct base is `ast.span.start - findFirstTokenIndex(code)` because
 * SWC uses 1-based byte positions and `Module.span.start` points to the first
 * token, not to byte 0 of the source.
 *
 * @param node  - Any AST node (or the root Module)
 * @param base  - The base offset to subtract
 */
export function normalizeASTSpans (node: any, base: number): void {
  if (!node || typeof node !== 'object' || base === 0) return

  // Normalize this node's own span
  if (node.span && typeof node.span.start === 'number') {
    node.span = {
      ...node.span,
      start: node.span.start - base,
      end: node.span.end - base
    }
  }

  // Recurse into every property (skip span itself to avoid double-processing)
  for (const key of Object.keys(node)) {
    if (key === 'span') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object') {
          normalizeASTSpans(item, base)
        }
      }
    } else if (child && typeof child === 'object') {
      normalizeASTSpans(child, base)
    }
  }
}

/**
 * Computes 1-based line and 0-based column numbers from a byte offset in source code.
 *
 * @param code   - The full source code string
 * @param offset - A character offset (e.g. from a normalised `node.span.start`)
 * @returns `{ line, column }` or `undefined` when the offset is out of range
 */
export function lineColumnFromOffset (code: string, offset: number): { line: number, column: number } | undefined {
  if (offset < 0 || offset > code.length) return undefined
  const upTo = code.substring(0, offset)
  const lines = upTo.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1].length
  }
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
export function buildByteToCharMap (content: string): number[] | null {
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
export function convertSpansToCharIndices (node: any, byteToChar: number[]): void {
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

// ─── Ignore-comment helpers ──────────────────────────────────────────────────

/**
 * Matches the shared ignore directive used by both the instrumenter and the
 * linter. The optional `-next-line` suffix is captured in group 1:
 *
 *   i18next-instrument-ignore-next-line  → suppress only the single next line
 *   i18next-instrument-ignore            → suppress the whole next JSX element
 *
 * Works in line-comment (`// ...`) and block-comment form, including the JSX
 * `{ /* ... * / }` form.
 */
const IGNORE_DIRECTIVE_RE = /i18next-instrument-ignore(-next-line)?/

/**
 * Scans `code` for ignore-directive comments and returns a Set of 1-based line
 * numbers whose issues/strings should be suppressed.
 *
 * A directive on line `D` targets the following line `D + 1`. The behaviour
 * depends on the directive variant:
 *
 *   - `i18next-instrument-ignore-next-line` suppresses only line `D + 1`.
 *   - `i18next-instrument-ignore` suppresses the **entire JSX element** that
 *     begins on line `D + 1` — i.e. every line from its opening tag through its
 *     closing tag, including nested children. This makes a single directive
 *     cover multi-line elements (e.g. `<div … css={…}>…</div>`) and elements
 *     with nested children, instead of just the one physical line after it.
 *
 * When no AST node begins on the targeted line (e.g. the next line is a plain
 * `t()` call rather than a JSX element), block scope falls back to suppressing
 * the single targeted line, preserving the original line-based behaviour.
 *
 * `ast` spans must already be normalised to file-relative character indices
 * (see {@link normalizeASTSpans} / {@link convertSpansToCharIndices}).
 */
export function collectIgnoredLineRanges (ast: any, code: string): Set<number> {
  const ignored = new Set<number>()
  const lines = code.split('\n')

  // 1-based target lines, split by directive variant.
  const blockTargets = new Set<number>()
  const lineTargets = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const match = IGNORE_DIRECTIVE_RE.exec(lines[i])
    if (!match) continue
    const target = i + 2 // directive on line i+1 (1-based) → target line i+2
    if (match[1]) lineTargets.add(target) // `-next-line` variant
    else blockTargets.add(target)
  }
  if (blockTargets.size === 0 && lineTargets.size === 0) return ignored

  // Always suppress the directly targeted line. For `-next-line` this is the
  // whole effect; for block directives it is the fallback when no element is
  // found, and otherwise the start of the suppressed range.
  for (const target of lineTargets) ignored.add(target)
  for (const target of blockTargets) ignored.add(target)

  if (blockTargets.size === 0) return ignored

  // For block directives, find the widest AST node that begins on the targeted
  // line and expand suppression to cover its full line span. Multiple nodes can
  // start on the same line (e.g. a JSXElement and its JSXOpeningElement); taking
  // the largest end line picks the outermost element.
  const widestEndLineByStartLine = new Map<number, number>()
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.span && typeof node.span.start === 'number') {
      const start = lineColumnFromOffset(code, node.span.start)
      if (start && blockTargets.has(start.line)) {
        const end = lineColumnFromOffset(code, node.span.end)
        if (end) {
          const prev = widestEndLineByStartLine.get(start.line)
          if (prev === undefined || end.line > prev) {
            widestEndLineByStartLine.set(start.line, end.line)
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'span') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) visit(item)
      } else if (child && typeof child === 'object') {
        visit(child)
      }
    }
  }
  visit(ast)

  for (const target of blockTargets) {
    const endLine = widestEndLineByStartLine.get(target) ?? target
    for (let line = target; line <= endLine; line++) ignored.add(line)
  }
  return ignored
}

/**
 * Finds and returns the full property node (KeyValueProperty) for the given
 * property name from an ObjectExpression.
 *
 * Matches both identifier keys (e.g., { ns: 'value' }) and string literal keys
 * (e.g., { 'ns': 'value' }).
 *
 * This helper returns the full property node rather than just its primitive
 * value so callers can inspect expression types (ConditionalExpression, etc.).
 *
 * @private
 * @param object - The SWC ObjectExpression to search
 * @param propName - The property name to locate
 * @returns The matching KeyValueProperty node if found, otherwise undefined.
 */
export function getObjectProperty (object: ObjectExpression, propName: string) {
  return (object.properties).filter(
    (p) => p.type === 'KeyValueProperty')
    .find(
      (p) =>
        (
          (p.key?.type === 'Identifier' && p.key.value === propName) ||
          (p.key?.type === 'StringLiteral' && p.key.value === propName)
        )
    )
}

/**
 * Finds and returns the value node for the given property name from an ObjectExpression.
 *
 * Matches both identifier keys (e.g., { ns: 'value' }), string literal keys
 * (e.g., { 'ns': 'value' }) and shorthand properties (e.g., { ns }).
 *
 * This helper returns the full value node rather than just its primitive
 * value so callers can inspect expression types (ConditionalExpression, etc.).
 *
 * @private
 * @param object - The SWC ObjectExpression to search
 * @param propName - The property name to locate
 * @returns The matching value node if found, otherwise undefined.
 */
export function getObjectPropValueExpression (object: ObjectExpression, propName: string): Expression | undefined {
  return getObjectProperty(object, propName)?.value ?? (object.properties).find(
    // For shorthand properties like { ns }.
    (p): p is Identifier => p.type === 'Identifier' && p.value === propName
  )
}

/**
 * Checks if the given template literal has no interpolation expressions
 *
 * @param literal - Template literal to check
 * @returns Boolean true if the literal has no expressions and can be parsed (no invalid escapes), false otherwise
 *
 * @private
 */
export function isSimpleTemplateLiteral (literal: TemplateLiteral): boolean {
  return literal.quasis.length === 1 && literal.expressions.length === 0 && literal.quasis[0].cooked != null
}

type IdentifierResolver = (name: string) => string | boolean | number | undefined

/**
 * Extracts string value from object property.
 *
 * Looks for properties by name and returns their string values.
 * Used for extracting options like 'ns', 'defaultValue', 'context', etc.
 *
 * @param object - Object expression to search
 * @param propName - Property name to find
 * @param identifierResolver - callback to resolve Identifier type values when needed
 * @returns String value if found, empty string if property exists but isn't a string, undefined if not found
 *
 * @private
 */
export function getObjectPropValue (object: ObjectExpression, propName: string, identifierResolver?: IdentifierResolver): string | boolean | number | undefined {
  const prop = getObjectProperty(object, propName)

  if (prop?.type === 'KeyValueProperty') {
    const val = prop.value
    if (val.type === 'StringLiteral') return val.value
    if (val.type === 'Identifier') {
      if (identifierResolver) {
        return identifierResolver(val.value)
      }
      return ''
    }
    if (val.type === 'TemplateLiteral' && isSimpleTemplateLiteral(val)) return val.quasis[0].cooked
    if (val.type === 'BooleanLiteral') return val.value
    if (val.type === 'NumericLiteral') return val.value
    return '' // Indicate presence for other types
  }
  return undefined
}
