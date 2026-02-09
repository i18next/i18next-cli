import type { Expression, Identifier, ObjectExpression, TemplateLiteral } from '@swc/core'

/**
 * Recursively normalizes all SWC span offsets in an AST by subtracting a base
 * offset. SWC's `parse()` accumulates byte offsets across successive calls in
 * the same process, so `span.start`/`span.end` values can exceed the length of
 * the source file. Call this once on the root `Module` node right after parsing
 * to make every span file-relative.
 *
 * @param node  - Any AST node (or the root Module)
 * @param base  - The base offset to subtract (`ast.span.start`)
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

/**
 * Extracts string value from object property.
 *
 * Looks for properties by name and returns their string values.
 * Used for extracting options like 'ns', 'defaultValue', 'context', etc.
 *
 * @param object - Object expression to search
 * @param propName - Property name to find
 * @returns String value if found, empty string if property exists but isn't a string, undefined if not found
 *
 * @private
 */
export function getObjectPropValue (object: ObjectExpression, propName: string): string | boolean | number | undefined {
  const prop = getObjectProperty(object, propName)

  if (prop?.type === 'KeyValueProperty') {
    const val = prop.value
    if (val.type === 'StringLiteral') return val.value
    if (val.type === 'TemplateLiteral' && isSimpleTemplateLiteral(val)) return val.quasis[0].cooked
    if (val.type === 'BooleanLiteral') return val.value
    if (val.type === 'NumericLiteral') return val.value
    return '' // Indicate presence for other types
  }
  return undefined
}
