import type { ObjectExpression, TemplateLiteral } from '@swc/core'

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
