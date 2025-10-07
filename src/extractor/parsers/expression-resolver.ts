import type { Expression, TsType, TemplateLiteral, TsTemplateLiteralType } from '@swc/core'
import type { ASTVisitorHooks } from '../../types'

export class ExpressionResolver {
  private hooks: ASTVisitorHooks

  constructor (hooks: ASTVisitorHooks) {
    this.hooks = hooks
  }

  /**
   * Resolves an expression to one or more possible context string values that can be
   * determined statically from the AST. This is a wrapper around the plugin hook
   * `extractContextFromExpression` and {@link resolvePossibleStringValuesFromExpression}.
   *
   * @param expression - The SWC AST expression node to resolve
   * @returns An array of possible context string values that the expression may produce.
   */
  resolvePossibleContextStringValues (expression: Expression): string[] {
    const strings = this.hooks.resolvePossibleContextStringValues?.(expression) ?? []
    return [...strings, ...this.resolvePossibleStringValuesFromExpression(expression)]
  }

  /**
   * Resolves an expression to one or more possible key string values that can be
   * determined statically from the AST. This is a wrapper around the plugin hook
   * `extractKeysFromExpression` and {@link resolvePossibleStringValuesFromExpression}.
   *
   * @param expression - The SWC AST expression node to resolve
   * @returns An array of possible key string values that the expression may produce.
   */
  resolvePossibleKeyStringValues (expression: Expression): string[] {
    const strings = this.hooks.resolvePossibleKeyStringValues?.(expression) ?? []
    return [...strings, ...this.resolvePossibleStringValuesFromExpression(expression)]
  }

  /**
   * Resolves an expression to one or more possible string values that can be
   * determined statically from the AST.
   *
   * Supports:
   * - StringLiteral -> single value (filtered to exclude empty strings for context)
   * - NumericLiteral -> single value
   * - BooleanLiteral -> single value
   * - ConditionalExpression (ternary) -> union of consequent and alternate resolved values
   * - TemplateLiteral -> union of all possible string values
   * - The identifier `undefined` -> empty array
   *
   * For any other expression types (identifiers, function calls, member expressions,
   * etc.) the value cannot be determined statically and an empty array is returned.
   *
   * @param expression - The SWC AST expression node to resolve
   * @param returnEmptyStrings - Whether to include empty strings in the result
   * @returns An array of possible string values that the expression may produce.
   */
  private resolvePossibleStringValuesFromExpression (expression: Expression, returnEmptyStrings = false): string[] {
    if (expression.type === 'StringLiteral') {
      // Filter out empty strings as they should be treated as "no context" like i18next does
      return expression.value || returnEmptyStrings ? [expression.value] : []
    }

    if (expression.type === 'ConditionalExpression') { // This is a ternary operator
      const consequentValues = this.resolvePossibleStringValuesFromExpression(expression.consequent, returnEmptyStrings)
      const alternateValues = this.resolvePossibleStringValuesFromExpression(expression.alternate, returnEmptyStrings)
      return [...consequentValues, ...alternateValues]
    }

    if (expression.type === 'Identifier' && expression.value === 'undefined') {
      return [] // Handle the `undefined` case
    }

    if (expression.type === 'TemplateLiteral') {
      return this.resolvePossibleStringValuesFromTemplateString(expression)
    }

    if (expression.type === 'NumericLiteral' || expression.type === 'BooleanLiteral') {
      return [`${expression.value}`] // Handle literals like 5 or true
    }

    // Support building translation keys for
    // `variable satisfies 'coaching' | 'therapy'`
    if (expression.type === 'TsSatisfiesExpression' || expression.type === 'TsAsExpression') {
      const annotation = expression.typeAnnotation
      return this.resolvePossibleStringValuesFromType(annotation, returnEmptyStrings)
    }

    // We can't statically determine the value of other expressions (e.g., variables, function calls)
    return []
  }

  private resolvePossibleStringValuesFromType (type: TsType, returnEmptyStrings = false): string[] {
    if (type.type === 'TsUnionType') {
      return type.types.flatMap((t) => this.resolvePossibleStringValuesFromType(t, returnEmptyStrings))
    }

    if (type.type === 'TsLiteralType') {
      if (type.literal.type === 'StringLiteral') {
        // Filter out empty strings as they should be treated as "no context" like i18next does
        return type.literal.value || returnEmptyStrings ? [type.literal.value] : []
      }

      if (type.literal.type === 'TemplateLiteral') {
        return this.resolvePossibleStringValuesFromTemplateLiteralType(type.literal)
      }

      if (type.literal.type === 'NumericLiteral' || type.literal.type === 'BooleanLiteral') {
        return [`${type.literal.value}`] // Handle literals like 5 or true
      }
    }

    // We can't statically determine the value of other expressions (e.g., variables, function calls)
    return []
  }

  /**
   * Resolves a template literal string to one or more possible strings that can be
   * determined statically from the AST.
   *
   * @param templateString - The SWC AST template literal string to resolve
   * @returns An array of possible string values that the template may produce.
   */
  private resolvePossibleStringValuesFromTemplateString (templateString: TemplateLiteral): string[] {
    // If there are no expressions, we can just return the cooked value
    if (templateString.quasis.length === 1 && templateString.expressions.length === 0) {
      // Ex. `translation.key.no.substitution`
      return [templateString.quasis[0].cooked || '']
    }

    // Ex. `translation.key.with.expression.${x ? 'title' : 'description'}`
    const [firstQuasis, ...tails] = templateString.quasis

    const stringValues = templateString.expressions.reduce(
      (heads, expression, i) => {
        return heads.flatMap((head) => {
          const tail = tails[i]?.cooked ?? ''
          return this.resolvePossibleStringValuesFromExpression(expression, true).map(
            (expressionValue) => `${head}${expressionValue}${tail}`
          )
        })
      },
      [firstQuasis.cooked ?? '']
    )

    return stringValues
  }

  /**
   * Resolves a template literal type to one or more possible strings that can be
   * determined statically from the AST.
   *
   * @param templateLiteralType - The SWC AST template literal type to resolve
   * @returns An array of possible string values that the template may produce.
   */
  private resolvePossibleStringValuesFromTemplateLiteralType (templateLiteralType: TsTemplateLiteralType): string[] {
    // If there are no types, we can just return the cooked value
    if (templateLiteralType.quasis.length === 1 && templateLiteralType.types.length === 0) {
      // Ex. `translation.key.no.substitution`
      return [templateLiteralType.quasis[0].cooked || '']
    }

    // Ex. `translation.key.with.expression.${'title' | 'description'}`
    const [firstQuasis, ...tails] = templateLiteralType.quasis

    const stringValues = templateLiteralType.types.reduce(
      (heads, type, i) => {
        return heads.flatMap((head) => {
          const tail = tails[i]?.cooked ?? ''
          return this.resolvePossibleStringValuesFromType(type, true).map(
            (expressionValue) => `${head}${expressionValue}${tail}`
          )
        })
      },
      [firstQuasis.cooked ?? '']
    )

    return stringValues
  }
}
