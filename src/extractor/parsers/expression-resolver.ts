import type { Expression, TsType, TemplateLiteral, TsTemplateLiteralType } from '@swc/core'
import type { ASTVisitorHooks } from '../../types.js'

export class ExpressionResolver {
  private hooks: ASTVisitorHooks
  // Per-file symbol table for statically analyzable variables.
  // Maps variableName -> either:
  //  - string[] (possible string values)
  //  - Record<string, string> (object of static string properties)
  private variableTable: Map<string, string[] | Record<string, string>> = new Map()

  // Shared (cross-file) table for enums / exported object maps that should persist
  private sharedEnumTable: Map<string, Record<string, string>> = new Map()

  // Per-file table for type aliases: Maps typeName -> string[]
  // e.g. `type ChangeType = 'all' | 'next' | 'this'` -> { ChangeType: ['all', 'next', 'this'] }
  private typeAliasTable: Map<string, string[]> = new Map()

  // Shared (cross-file) table for string-array constants (e.g. `as const` arrays).
  // Persists across resetFileSymbols() so exported arrays are visible to importers.
  private sharedVariableTable: Map<string, string[]> = new Map()

  // Shared (cross-file) table for type aliases — populated alongside typeAliasTable.
  // Persists across resetFileSymbols() so exported type aliases are visible to importers.
  private sharedTypeAliasTable: Map<string, string[]> = new Map()

  // Shared (cross-file) table for function return-value sets. Populated from
  // both explicit return-type annotations and body-inferred return values so
  // that `t(fn())` / `const x = fn(); t(\`...${x}...\`)` work across files.
  // Persists across resetFileSymbols() just like the other shared tables.
  private sharedFunctionReturnTable: Map<string, string[]> = new Map()

  // Temporary per-scope variable overrides, used to inject .map() / .forEach()
  // callback parameters while the callback body is being walked.
  private temporaryVariables: Map<string, string[]> = new Map()

  constructor (hooks: ASTVisitorHooks) {
    this.hooks = hooks
  }

  /**
   * Clear per-file captured variables. Enums / shared maps are kept.
   */
  public resetFileSymbols (): void {
    this.variableTable.clear()
    this.typeAliasTable.clear()
    this.temporaryVariables.clear()
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
      if (!node || !node.id) return

      // ── ArrayPattern id: `const [x, y] = fn<T>(...)` ────────────────────────
      // Handles `const [state] = useState<'a'|'b'>('a')` or similar generic calls
      // where the type argument is a finite string-literal union.
      if (node.id.type === 'ArrayPattern' && node.init) {
        const init = node.init
        // Unwrap await / as-expressions
        let callExpr: any = init
        while (callExpr?.type === 'AwaitExpression') callExpr = callExpr.argument
        while (
          callExpr?.type === 'TsConstAssertion' ||
          callExpr?.type === 'TsAsExpression' ||
          callExpr?.type === 'TsSatisfiesExpression'
        ) callExpr = callExpr.expression

        if (callExpr?.type === 'CallExpression') {
          const typeArgs =
            callExpr.typeArguments?.params ??
            callExpr.typeParameters?.params ??
            []
          if (typeArgs.length > 0) {
            const vals = this.resolvePossibleStringValuesFromType(typeArgs[0])
            if (vals.length > 0) {
              // Bind each array-pattern element: first element is the state variable
              for (const el of node.id.elements) {
                if (!el) continue
                const ident = el.type === 'Identifier' ? el : (el.type === 'AssignmentPattern' && el.left?.type === 'Identifier' ? el.left : null)
                if (ident) {
                  this.variableTable.set(ident.value, vals)
                }
                break // only bind the first element (the state value, not the setter)
              }
            }
          }
        }
        return
      }

      // only handle simple identifier bindings like `const x = ...`
      if (node.id.type !== 'Identifier') return
      const name = node.id.value

      // pattern 1:
      // Handle `declare const x: 'a' | 'b'` and `declare const x: SomeUnion`
      // where there is no initializer but a TypeScript type annotation.
      if (!node.init) {
        const typeAnnotation = this.extractTypeAnnotation(node.id)
        if (typeAnnotation) {
          const vals = this.resolvePossibleStringValuesFromType(typeAnnotation)
          if (vals.length > 0) {
            this.variableTable.set(name, vals)
          }
        }
        return
      }

      const init = node.init

      // Unwrap TS type assertion wrappers before inspecting the shape of the initializer.
      // `{ ... } as const` → TsConstAssertion; `x as Type` → TsAsExpression; etc.
      // We need the raw expression to detect ObjectExpression and ArrowFunctionExpression.
      let unwrappedInit = init
      while (
        unwrappedInit?.type === 'TsConstAssertion' ||
        unwrappedInit?.type === 'TsAsExpression' ||
        unwrappedInit?.type === 'TsSatisfiesExpression'
      ) {
        unwrappedInit = unwrappedInit.expression
      }

      // ObjectExpression -> map of string props
      if (unwrappedInit.type === 'ObjectExpression' && Array.isArray(unwrappedInit.properties)) {
        const map: Record<string, string> = {}
        for (const p of unwrappedInit.properties as any[]) {
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
          this.variableTable.set(name, map)
          return
        }
      }

      // ArrayExpression -> list of string values
      // Handles `const OPTS = ['a', 'b', 'c'] as const`
      if (unwrappedInit.type === 'ArrayExpression' && Array.isArray(unwrappedInit.elements)) {
        const vals: string[] = []
        for (const elem of unwrappedInit.elements as any[]) {
          if (!elem || !elem.expression) continue
          const resolved = this.resolvePossibleStringValuesFromExpression(elem.expression)
          if (resolved.length === 1) vals.push(resolved[0])
        }
        if (vals.length > 0) {
          this.variableTable.set(name, vals)
          // Also share so importing files can see this array
          this.sharedVariableTable.set(name, vals)
          return
        }
      }

      // For other initializers, try to resolve to one-or-more strings.
      // Also check the type annotation: when the type resolves to a broader set
      // (e.g. an enum type), prefer it over the single initializer value.
      // Example: `const status: Status = Status.New` — the init resolves to ["new"]
      // but the type annotation `Status` resolves to ["new", "active", "done"].
      const vals = this.resolvePossibleStringValuesFromExpression(init)
      const typeAnnotation = this.extractTypeAnnotation(node.id)
      if (typeAnnotation) {
        const typeVals = this.resolvePossibleStringValuesFromType(typeAnnotation)
        if (typeVals.length > vals.length) {
          this.variableTable.set(name, typeVals)
          return
        }
      }
      if (vals.length > 0) {
        this.variableTable.set(name, vals)
        return
      }

      // pattern 3 (arrow function variant):
      // `const fn = (): 'a' | 'b' => ...` — capture the explicit return type annotation,
      // OR fall back to walking the body's return expressions / expression body
      // when no annotation is present (mirrors TS's own return-type inference).
      if (unwrappedInit.type === 'ArrowFunctionExpression' || unwrappedInit.type === 'FunctionExpression') {
        let returnVals: string[] = []
        const rawReturnType = unwrappedInit.returnType ?? unwrappedInit.typeAnnotation
        if (rawReturnType) {
          // Explicit annotation — trust it even when it resolves to [].
          const tsType = rawReturnType.typeAnnotation ?? rawReturnType
          returnVals = this.resolvePossibleStringValuesFromType(tsType)
        } else {
          returnVals = this.inferReturnValuesFromFunctionBody(unwrappedInit)
        }
        if (returnVals.length > 0) {
          this.variableTable.set(name, returnVals)
          this.sharedFunctionReturnTable.set(name, returnVals)
        }
      }
    } catch {
      // be silent - conservative only
    }
  }

  /**
   * Capture a TypeScript type alias so that `declare const x: AliasName` can
   * be resolved to its string union members later.
   *
   * Handles: `type Foo = 'a' | 'b' | 'c'`
   *
   * SWC node shapes: `TsTypeAliasDeclaration` / `TsTypeAliasDecl`
   */
  captureTypeAliasDeclaration (node: any): void {
    try {
      const name: string | undefined = node?.id?.type === 'Identifier' ? node.id.value : undefined
      if (!name) return
      // SWC puts the actual type in `.typeAnnotation`
      const tsType = node.typeAnnotation ?? node.typeAnn
      if (!tsType) return
      const vals = this.resolvePossibleStringValuesFromType(tsType)
      if (vals.length > 0) {
        this.typeAliasTable.set(name, vals)
        // Also share so importing files can resolve this alias by name
        this.sharedTypeAliasTable.set(name, vals)
      }
    } catch {
      // noop
    }
  }

  /**
   * Capture the return-type annotation of a function declaration so that
   * `t(fn())` calls can be expanded to all union members.
   *
   * Handles both `function f(): 'a' | 'b' { ... }` and
   * `const f = (): 'a' | 'b' => ...` (the arrow-function form is captured
   * via captureVariableDeclarator when the init is an ArrowFunctionExpression).
   *
   * SWC node shapes: `FunctionDeclaration` / `FnDecl`
   */
  captureFunctionDeclaration (node: any): void {
    try {
      const name: string | undefined = node?.identifier?.value ?? node?.id?.value
      if (!name) return
      // SWC places the return type annotation in `.function.returnType` (FunctionDeclaration)
      // or directly in `.returnType` (FunctionExpression / ArrowFunctionExpression).
      const fn = node.function ?? node
      const rawReturnType = fn.returnType ?? fn.typeAnnotation

      let vals: string[] = []
      if (rawReturnType) {
        // Unwrap TsTypeAnnotation wrapper if present. Explicit annotations are
        // authoritative: if the author declared the return type we trust it,
        // even when it resolves to [] (e.g. plain `string`). Falling back to
        // body inference in that case would invent keys the author deliberately
        // opted out of.
        const tsType = rawReturnType.typeAnnotation ?? rawReturnType
        vals = this.resolvePossibleStringValuesFromType(tsType)
      } else {
        // No annotation — infer from body. Mirrors TS's own return-type
        // inference for functions like:
        //   function getCurrentAppType() {
        //     if (...) return OrganizationType.ROUTING;
        //     if (...) return OrganizationType.CONTRACTOR;
        //   }
        vals = this.inferReturnValuesFromFunctionBody(fn)
      }

      if (vals.length > 0) {
        this.variableTable.set(name, vals)
        this.sharedFunctionReturnTable.set(name, vals)
      }
    } catch {
      // noop
    }
  }

  /**
   * Walk a function body's ReturnStatements and union the statically-resolvable
   * string values of their argument expressions. Does NOT descend into nested
   * function declarations (their returns belong to the inner function, not us).
   *
   * This is how we mirror TypeScript's implicit return-type inference for the
   * purpose of extracting translation keys — we don't need exhaustiveness, just
   * the set of string values any return statement could produce.
   */
  private inferReturnValuesFromFunctionBody (fn: any): string[] {
    const body = fn?.body
    if (!body) return []

    const collected: string[] = []
    const visit = (n: any): void => {
      if (!n || typeof n !== 'object') return
      // Don't descend into nested function bodies — their returns aren't ours.
      if (
        n !== body && (
          n.type === 'FunctionDeclaration' ||
          n.type === 'FunctionExpression' ||
          n.type === 'ArrowFunctionExpression'
        )
      ) return

      if (n.type === 'ReturnStatement' && n.argument) {
        const vals = this.resolvePossibleStringValuesFromExpression(n.argument)
        if (vals.length > 0) collected.push(...vals)
      }

      for (const key of Object.keys(n)) {
        const child = (n as any)[key]
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object') visit(item)
          }
        } else if (child && typeof child === 'object' && typeof child.type === 'string') {
          visit(child)
        }
      }
    }

    // Arrow functions with an expression body (no BlockStatement) — `() => expr` —
    // have their return expression directly as `body`.
    if (body.type !== 'BlockStatement') {
      const vals = this.resolvePossibleStringValuesFromExpression(body)
      if (vals.length > 0) return Array.from(new Set(vals))
      return []
    }

    visit(body)
    return Array.from(new Set(collected))
  }

  /**
   * Extract a raw TsType node from an identifier's type annotation.
   * SWC may wrap it in a `TsTypeAnnotation` node — this unwraps it.
   */
  private extractTypeAnnotation (idNode: any): any | undefined {
    const raw = idNode?.typeAnnotation
    if (!raw) return undefined
    // TsTypeAnnotation wrapper -> .typeAnnotation holds the actual TsType
    if (raw.type === 'TsTypeAnnotation') return raw.typeAnnotation
    return raw
  }

  /**
   * Temporarily bind a variable name to a set of string values.
   * Used by ast-visitors to inject .map()/.forEach() callback parameters.
   * Call deleteTemporaryVariable() after walking the callback body.
   */
  public setTemporaryVariable (name: string, values: string[]): void {
    this.temporaryVariables.set(name, values)
  }

  /**
   * Remove a previously-injected temporary variable binding.
   */
  public deleteTemporaryVariable (name: string): void {
    this.temporaryVariables.delete(name)
  }

  /**
   * Resolve a TypeScript type annotation to its possible string values.
   * Used by ast-visitors to capture function parameter type annotations
   * (e.g. `field: "name" | "age"`) as temporary variable bindings.
   */
  public resolveTypeToStringValues (tsType: any): string[] {
    try {
      return this.resolvePossibleStringValuesFromType(tsType)
    } catch {
      return []
    }
  }

  /**
   * Return the array values stored for a variable name, checking all tables.
   * Returns undefined if the name is not a known string array.
   */
  public getVariableValues (name: string): string[] | undefined {
    const tmp = this.temporaryVariables.get(name)
    if (tmp) return tmp
    const v = this.variableTable.get(name)
    if (Array.isArray(v)) return v
    return this.sharedVariableTable.get(name)
  }

  /**
   * Return the as-const object map stored for a variable name.
   * Returns undefined if the name is not a known object map.
   * Checks per-file variableTable first, then sharedEnumTable (for enums).
   */
  public getObjectMap (name: string): Record<string, string> | undefined {
    const v = this.variableTable.get(name)
    if (v && !Array.isArray(v) && typeof v === 'object') return v as Record<string, string>
    const ev = this.sharedEnumTable.get(name)
    if (ev) return ev
    return undefined
  }

  /**
   * Capture a TypeScript enum declaration so members can be resolved later.
   * Accepts SWC node shapes like `TsEnumDeclaration` / `TSEnumDeclaration`.
   *
   * Enums are stored in the shared table so they are available across files.
   */
  captureEnumDeclaration (node: any): void {
    try {
      if (!node || !node.id || !Array.isArray(node.members)) return
      const name = node.id.type === 'Identifier' ? node.id.value : undefined
      if (!name) return
      const map: Record<string, string> = {}
      for (const m of node.members) {
        if (!m || !m.id) continue
        const keyNode = m.id
        const memberName = keyNode.type === 'Identifier' ? keyNode.value : keyNode.type === 'StringLiteral' ? keyNode.value : undefined
        if (!memberName) continue
        const init = (m as any).init ?? (m as any).initializer
        if (init && init.type === 'StringLiteral') {
          map[memberName] = init.value
        }
      }
      if (Object.keys(map).length > 0) {
        this.sharedEnumTable.set(name, map)
      }
    } catch {
      // noop
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
    // Support selector-style arrow functions used by the selector API:
    // e.g. ($) => $.path.to.key  ->  ['path.to.key']
    // e.g. ($) => $.table.columns[field]  ->  ['table.columns.name', 'table.columns.age']
    //   (when `field` resolves to "name" | "age")
    if (expression.type === 'ArrowFunctionExpression') {
      try {
        let body: any = expression.body
        // Handle block body with return statement
        if (body.type === 'BlockStatement') {
          const returnStmt = body.stmts.find((s: any) => s.type === 'ReturnStatement')
          if (returnStmt?.type === 'ReturnStatement' && returnStmt.argument) {
            body = returnStmt.argument
          } else {
            return []
          }
        }

        let current: any = body
        // Each element is an array of possible values for that position
        const parts: string[][] = []

        while (current && current.type === 'MemberExpression') {
          const prop = current.property
          if (prop.type === 'Identifier') {
            parts.unshift([prop.value])
          } else if (prop.type === 'Computed' && prop.expression && prop.expression.type === 'StringLiteral') {
            parts.unshift([prop.expression.value])
          } else if (prop.type === 'Computed' && prop.expression) {
            // Dynamic bracket: try to resolve the expression to possible string values
            const resolved = this.resolvePossibleStringValuesFromExpression(prop.expression, returnEmptyStrings)
            if (resolved.length > 0) {
              parts.unshift(resolved)
            } else {
              return []
            }
          } else {
            return []
          }
          current = current.object
        }

        if (parts.length > 0) {
          // Compute cartesian product of all parts
          let combinations: string[][] = [[]]
          for (const part of parts) {
            const newCombinations: string[][] = []
            for (const combo of combinations) {
              for (const value of part) {
                newCombinations.push([...combo, value])
              }
            }
            combinations = newCombinations
          }
          return combinations.map(combo => combo.join('.'))
        }
      } catch {
        return []
      }
    }

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
          const baseVar = this.variableTable.get(obj.value)
          const baseShared = this.sharedEnumTable.get(obj.value)
          const base = baseVar ?? baseShared
          if (base && typeof base !== 'string' && !Array.isArray(base)) {
            let propName: string | undefined
            if (prop.type === 'Identifier') propName = prop.value
            else if (prop.type === 'Computed' && prop.expression?.type === 'StringLiteral') propName = prop.expression.value
            if (propName && base[propName] !== undefined) {
              return [base[propName]]
            }

            // pattern 4:
            // `map[identifierVar]` where identifierVar resolves to a known set of keys.
            // Try to enumerate which map values are reachable.
            if (prop.type === 'Computed' && prop.expression) {
              const keyVals = this.resolvePossibleStringValuesFromExpression(prop.expression, returnEmptyStrings)
              if (keyVals.length > 0) {
                // Return only the map values for the known keys (subset access)
                return keyVals.map(k => (base as Record<string, string>)[k]).filter((v): v is string => v !== undefined)
              }
              // Cannot narrow the key at all — return all map values as a conservative fallback
              return Object.values(base) as string[]
            }
          }
        }
      } catch {}
    }

    // pattern 3:
    // `t(fn())` — resolve to the function's known return-value set (either
    // from an explicit annotation or inferred from the function body). Check
    // the per-file variable table first (same-file capture) and fall back to
    // the shared cross-file table populated during pre-scan.
    if (expression.type === 'CallExpression') {
      try {
        const callee = (expression as any).callee
        if (callee?.type === 'Identifier') {
          const v = this.variableTable.get(callee.value)
          if (Array.isArray(v) && v.length > 0) return v
          const sv = this.sharedFunctionReturnTable.get(callee.value)
          if (sv && sv.length > 0) return sv
        }
      } catch {}
    }

    // Binary concatenation support (e.g., a + '_' + b)
    // SWC binary expr can be represented as `BinExpr` with left/right; be permissive:
    if ((expression as any).left && (expression as any).right) {
      try {
        const exprAny = expression as any
        const leftNode = exprAny.left
        const rightNode = exprAny.right

        // Detect explicit binary concatenation (plus) nodes and only then produce concatenated combos.
        const isBinaryConcat =
          // SWC older shape: BinExpr with op === '+'
          (exprAny.type === 'BinExpr' && exprAny.op === '+') ||
          // Standard AST: BinaryExpression with operator === '+'
          (exprAny.type === 'BinaryExpression' && exprAny.operator === '+') ||
          // Fallbacks
          exprAny.operator === '+' || exprAny.op === '+'

        if (isBinaryConcat) {
          const leftVals = this.resolvePossibleStringValuesFromExpression(leftNode, returnEmptyStrings)
          const rightVals = this.resolvePossibleStringValuesFromExpression(rightNode, returnEmptyStrings)
          if (leftVals.length > 0 && rightVals.length > 0) {
            const combos: string[] = []
            for (const L of leftVals) {
              for (const R of rightVals) {
                combos.push(`${L}${R}`)
              }
            }
            return combos
          }
        }

        // Handle logical nullish coalescing (a ?? b): result is either left (when not null/undefined) OR right.
        // Represent this conservatively as the union of possible left and right values.
        const isNullishCoalesce =
          // SWC may emit as BinaryExpression with operator '??'
          (exprAny.type === 'BinaryExpression' && exprAny.operator === '??') ||
          (exprAny.type === 'LogicalExpression' && exprAny.operator === '??') ||
          exprAny.operator === '??' || exprAny.op === '??'

        if (isNullishCoalesce) {
          const leftVals = this.resolvePossibleStringValuesFromExpression(leftNode, returnEmptyStrings)
          const rightVals = this.resolvePossibleStringValuesFromExpression(rightNode, returnEmptyStrings)
          if (leftVals.length > 0 || rightVals.length > 0) {
            return Array.from(new Set([...leftVals, ...rightVals]))
          }
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

    // `expr as const` — delegate to the underlying expression (the type annotation is
    // just `const`, which carries no union information, so we want the value side).
    if (expression.type === 'TsConstAssertion') {
      return this.resolvePossibleStringValuesFromExpression(expression.expression, returnEmptyStrings)
    }

    // Identifier resolution via captured per-file variable table only
    if (expression.type === 'Identifier') {
      // Check temporary (callback param) overrides first
      const tmp = this.temporaryVariables.get(expression.value)
      if (tmp) return tmp
      const v = this.variableTable.get(expression.value)
      if (!v) {
        // Fall back to shared cross-file array table
        const sv = this.sharedVariableTable.get(expression.value)
        if (sv) return sv
        return []
      }
      if (Array.isArray(v)) return v
      // object map - cannot be used directly as key, so return empty
      return []
    }

    // We can't statically determine the value of other expressions (e.g., variables, function calls)
    return []
  }

  private resolvePossibleStringValuesFromType (type: TsType, returnEmptyStrings = false): string[] {
    // Unwrap TsParenthesizedType — SWC explicitly emits these for grouped types like
    // `(typeof X)[number]` where `(typeof X)` becomes TsParenthesizedType { typeAnnotation: TsTypeQuery }
    if ((type as any).type === 'TsParenthesizedType') {
      return this.resolvePossibleStringValuesFromType((type as any).typeAnnotation, returnEmptyStrings)
    }

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

    // pattern 2:
    // Resolve a named type alias reference: `declare const x: ChangeType`
    // where `type ChangeType = 'all' | 'next' | 'this'` was captured earlier.
    // Also handles `declare const d: SomeEnum` where SomeEnum is a TS enum with string values.
    if (type.type === 'TsTypeReference') {
      const typeName: string | undefined =
        (type as any).typeName?.type === 'Identifier'
          ? (type as any).typeName.value
          : undefined
      if (typeName) {
        // 1. Check type alias table first (exact match for string-literal unions)
        const aliasVals = this.typeAliasTable.get(typeName) ?? this.sharedTypeAliasTable.get(typeName)
        if (aliasVals && aliasVals.length > 0) return aliasVals

        // 2. Fall back to enum: `declare const d: Direction` where Direction is a string enum.
        //    sharedEnumTable maps enum-name → { MemberName: value }.
        //    A variable typed as the enum can take any of the enum's string values.
        const enumMap = this.sharedEnumTable.get(typeName)
        if (enumMap) {
          const enumVals = Object.values(enumMap) as string[]
          if (enumVals.length > 0) return enumVals
        }
      }
    }

    // `(typeof ACCESS_OPTIONS)[number]` — resolve through the shared array variable table.
    // SWC emits: TsIndexedAccessType {
    //   objectType: TsParenthesizedType { typeAnnotation: TsTypeQuery { exprName: Identifier } }
    //   indexType: TsKeywordType
    // }
    // The parens around `typeof X` produce a TsParenthesizedType wrapper that we must unwrap.
    if (type.type === 'TsIndexedAccessType') {
      try {
        let objType = (type as any).objectType
        // Unwrap TsParenthesizedType wrapper (SWC preserves explicit parens in type positions)
        while (objType?.type === 'TsParenthesizedType') {
          objType = objType.typeAnnotation
        }
        if (objType?.type === 'TsTypeQuery' || objType?.type === 'TSTypeQuery') {
          // SWC: TsTypeQuery.exprName is TsEntityName (Identifier | TsQualifiedName)
          const exprName = objType.exprName ?? objType.expr ?? objType.entityName
          // access .value (Identifier) or fall back to .name for alternate SWC builds
          const varName: string | undefined = exprName?.value ?? exprName?.name
          if (varName) {
            const vals = this.getVariableValues(varName)
            if (vals && vals.length > 0) return vals
          }
        }
      } catch {}
    }

    // `keyof typeof MAP` — resolve to the keys of a known as-const object map.
    // SWC emits: TsTypeOperator {
    //   operator: 'keyof',
    //   typeAnnotation: TsTypeQuery { exprName: Identifier }
    // }
    // This is the type of a variable that iterates over map keys:
    //   declare const k: keyof typeof LABELS; t(LABELS[k])
    //   Object.keys(MAP).forEach(k => t(MAP[k]))
    if ((type as any).type === 'TsTypeOperator') {
      try {
        const op = (type as any).operator
        if (op === 'keyof') {
          let inner = (type as any).typeAnnotation
          while (inner?.type === 'TsParenthesizedType') inner = inner.typeAnnotation
          if (inner?.type === 'TsTypeQuery' || inner?.type === 'TSTypeQuery') {
            const exprName = inner.exprName ?? inner.expr ?? inner.entityName
            const varName: string | undefined = exprName?.value ?? exprName?.name
            if (varName) {
              // Look up in variableTable (local) or sharedVariableTable (cross-file) for object maps
              const v = this.variableTable.get(varName) ?? this.sharedVariableTable.get(varName)
              if (v && !Array.isArray(v) && typeof v === 'object') {
                return Object.keys(v as Record<string, string>)
              }
              // Also check sharedEnumTable (enum keys)
              const ev = this.sharedEnumTable.get(varName)
              if (ev) return Object.keys(ev)
            }
          }
        }
      } catch {}
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
