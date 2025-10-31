import type { Expression, TsType, TemplateLiteral, TsTemplateLiteralType } from '@swc/core'
import type { ASTVisitorHooks } from '../../types'

export class ExpressionResolver {
  private hooks: ASTVisitorHooks
  // Simple per-file symbol table for statically analyzable variables.
  // Maps variableName -> either:
  //  - string[] (possible string values)
  //  - Record<string, string> (object of static string properties)
  private symbolTable: Map<string, string[] | Record<string, string>> = new Map()

  constructor (hooks: ASTVisitorHooks) {
    this.hooks = hooks
  }

  /**
   * Capture a VariableDeclarator node to record simple statically analyzable
   * initializers (string literals, object expressions of string literals,
   * template literals and simple concatenations).
   *
   * This is called during AST traversal before deeper walking so later
   * identifier/member-expression usage can be resolved.
   *
   * @param node - VariableDeclarator-like node (has .id and .init)
   */
  captureVariableDeclarator (node: any): void {
    try {
      if (!node || !node.id || !node.init) return
      // only handle simple identifier bindings like `const x = ...`
      if (node.id.type !== 'Identifier') return
      const name = node.id.value
      const init = node.init

      // ObjectExpression -> map of string props
      if (init.type === 'ObjectExpression' && Array.isArray(init.properties)) {
        const map: Record<string, string> = {}
        for (const p of init.properties as any[]) {
          if (!p || p.type !== 'KeyValueProperty') continue
          const keyNode = p.key
          const keyName = keyNode?.type === 'Identifier' ? keyNode.value : keyNode?.type === 'StringLiteral' ? keyNode.value : undefined
          if (!keyName) continue
          const valExpr = p.value
          const vals = this.resolvePossibleStringValuesFromExpression(valExpr)
          // Only capture properties that we can statically resolve to a single string.
          if (vals.length === 1) {
            map[keyName] = vals[0]
          }
        }
        // If at least one property was resolvable, record the partial map.
        if (Object.keys(map).length > 0) {
          this.symbolTable.set(name, map)
          return
        }
      }

      // For other initializers, try to resolve to one-or-more strings
      const vals = this.resolvePossibleStringValuesFromExpression(init)
      if (vals.length > 0) {
        this.symbolTable.set(name, vals)
      }
    } catch {
      // be silent - conservative only
    }
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

    // MemberExpression: try to resolve object identifier to an object map in the symbol table
    if (expression.type === 'MemberExpression') {
      try {
        const obj = expression.object
        const prop = expression.property
        // only handle simple identifier base + simple property (Identifier or computed StringLiteral)
        if (obj.type === 'Identifier') {
          const base = this.symbolTable.get(obj.value)
          if (base && typeof base !== 'string' && !Array.isArray(base)) {
            let propName: string | undefined
            if (prop.type === 'Identifier') propName = prop.value
            else if (prop.type === 'Computed' && prop.expression?.type === 'StringLiteral') propName = prop.expression.value
            if (propName && base[propName] !== undefined) return [base[propName]]
          }
        }
      } catch {}
    }

    // Binary concatenation support (e.g., a + '_' + b)
    // SWC binary expr can be represented as `BinExpr` with left/right; be permissive:
    if ((expression as any).left && (expression as any).right) {
      try {
        const leftVals = this.resolvePossibleStringValuesFromExpression((expression as any).left, returnEmptyStrings)
        const rightVals = this.resolvePossibleStringValuesFromExpression((expression as any).right, returnEmptyStrings)
        if (leftVals.length > 0 && rightVals.length > 0) {
          const combos: string[] = []
          for (const L of leftVals) {
            for (const R of rightVals) {
              combos.push(`${L}${R}`)
            }
          }
          return combos
        }
      } catch {}
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

    // Identifier resolution via captured symbol table
    if (expression.type === 'Identifier') {
      const v = this.symbolTable.get(expression.value)
      if (!v) return []
      if (Array.isArray(v)) return v
      // object map - cannot be used directly as key, so return empty
      return []
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
