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
