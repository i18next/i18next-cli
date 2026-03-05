import type { Module, Node } from '@swc/core'
import type { PluginContext, I18nextToolkitConfig, Logger, ASTVisitorHooks, ScopeInfo } from '../../types'
import { ScopeManager } from '../parsers/scope-manager'
import { ExpressionResolver } from '../parsers/expression-resolver'
import { CallExpressionHandler } from '../parsers/call-expression-handler'
import { JSXHandler } from '../parsers/jsx-handler'

/**
 * AST visitor class that traverses JavaScript/TypeScript syntax trees to extract translation keys.
 *
 * This class implements a manual recursive walker that:
 * - Maintains scope information for tracking useTranslation and getFixedT calls
 * - Extracts keys from t() function calls with various argument patterns
 * - Handles JSX Trans components with complex children serialization
 * - Supports both string literals and selector API for type-safe keys
 * - Processes pluralization and context variants
 * - Manages namespace resolution from multiple sources
 *
 * The visitor respects configuration options for separators, function names,
 * component names, and other extraction settings.
 *
 * @example
 * ```typescript
 * const visitors = new ASTVisitors(config, pluginContext, logger)
 * visitors.visit(parsedAST)
 *
 * // The pluginContext will now contain all extracted keys
 * ```
 */
export class ASTVisitors {
  private readonly pluginContext: PluginContext
  private readonly config: Omit<I18nextToolkitConfig, 'plugins'>
  private readonly logger: Logger
  private hooks: ASTVisitorHooks

  public get objectKeys () {
    return this.callExpressionHandler.objectKeys
  }

  public readonly scopeManager: ScopeManager
  private readonly expressionResolver: ExpressionResolver
  private readonly callExpressionHandler: CallExpressionHandler
  private readonly jsxHandler: JSXHandler
  private currentFile: string = ''
  private currentCode: string = ''

  /**
   * Creates a new AST visitor instance.
   *
   * @param config - Toolkit configuration with extraction settings
   * @param pluginContext - Context for adding discovered translation keys
   * @param logger - Logger for warnings and debug information
   */
  constructor (
    config: Omit<I18nextToolkitConfig, 'plugins'>,
    pluginContext: PluginContext,
    logger: Logger,
    hooks?: ASTVisitorHooks,
    expressionResolver?: ExpressionResolver
  ) {
    this.pluginContext = pluginContext
    this.config = config
    this.logger = logger
    this.hooks = {
      onBeforeVisitNode: hooks?.onBeforeVisitNode,
      onAfterVisitNode: hooks?.onAfterVisitNode,
      resolvePossibleKeyStringValues: hooks?.resolvePossibleKeyStringValues,
      resolvePossibleContextStringValues: hooks?.resolvePossibleContextStringValues
    }

    this.scopeManager = new ScopeManager(config)
    // use shared resolver when provided so captured enums/objects are visible across files
    this.expressionResolver = expressionResolver ?? new ExpressionResolver(this.hooks)
    this.callExpressionHandler = new CallExpressionHandler(
      config,
      pluginContext,
      logger,
      this.expressionResolver,
      () => this.getCurrentFile(),
      () => this.getCurrentCode(),
      (name: string) => this.scopeManager.resolveSimpleStringIdentifier(name)
    )
    this.jsxHandler = new JSXHandler(
      config,
      pluginContext,
      this.expressionResolver,
      () => this.getCurrentFile(),
      () => this.getCurrentCode()
    )
  }

  /**
   * Main entry point for AST traversal.
   * Creates a root scope and begins the recursive walk through the syntax tree.
   *
   * @param node - The root module node to traverse
   */
  public visit (node: Module): void {
    // Reset any per-file scope state to avoid leaking scopes between files.
    this.scopeManager.reset()
    // Reset per-file captured variables in the expression resolver so variables from other files don't leak.
    this.expressionResolver.resetFileSymbols()
    this.scopeManager.enterScope() // Create the root scope for the file
    this.walk(node)
    this.scopeManager.exitScope()  // Clean up the root scope
  }

  /**
   * Recursively walks through AST nodes, handling scoping and visiting logic.
   *
   * This is the core traversal method that:
   * 1. Manages function scopes (enter/exit)
   * 2. Dispatches to specific handlers based on node type
   * 3. Recursively processes child nodes
   * 4. Maintains proper scope cleanup
   *
   * @param node - The current AST node to process
   *
   * @private
   */
  private walk (node: Node | any): void {
    if (!node) return

    let isNewScope = false
    // ENTER SCOPE for functions
    // Accept many SWC/TS AST variants for function-like nodes (declarations, expressions, arrow functions)
    if (
      node.type === 'Function' ||
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionDecl' ||
      node.type === 'FnDecl' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' ||
      node.type === 'MethodDefinition' ||
      node.type === 'ClassMethod' ||
      node.type === 'ObjectMethod'
    ) {
      this.scopeManager.enterScope()
      isNewScope = true

      const params = (node.params && Array.isArray(node.params)) ? node.params : (node.params || [])
      for (const p of params) {
        // handle common param shapes: Identifier, AssignmentPattern (default), RestElement ignored
        let ident: any
        if (!p) continue
        // direct identifier (arrow fn params etc)
        if (p.type === 'Identifier') ident = p
        // default params: (x = ...) -> AssignmentPattern.left
        else if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier') ident = p.left
        // rest: (...args)
        else if (p.type === 'RestElement' && p.argument && p.argument.type === 'Identifier') ident = p.argument
        // SWC/TS often wrap params: { pat: Identifier } or { pattern: Identifier } or FnParam/Param
        else if ((p.type === 'Param' || p.type === 'FnParam' || p.type === 'Arg') && p.pat && p.pat.type === 'Identifier') ident = p.pat
        else if ((p.type === 'Param' || p.type === 'FnParam' || p.type === 'Arg') && p.pattern && p.pattern.type === 'Identifier') ident = p.pattern
        else if (p.pat && p.pat.type === 'Identifier') ident = p.pat
        else if (p.pattern && p.pattern.type === 'Identifier') ident = p.pattern
        // some parsers expose .param or .left.param shapes
        else if ((p.left && p.left.param && p.left.param.type === 'Identifier')) ident = p.left.param
        else if ((p.param && p.param.type === 'Identifier')) ident = p.param

        if (!ident) continue
        const paramKey = (ident.value ?? ident.name) as string | undefined
        if (!paramKey) continue

        // Try to locate TypeScript type node carried on the identifier.
        const rawTypeAnn: any = (ident.typeAnnotation ?? p.typeAnnotation ?? (p.left && p.left.typeAnnotation)) as any
        let typeAnn: any | undefined
        if (rawTypeAnn) {
          // SWC may wrap the actual TS type in a wrapper like TsTypeAnn / TsTypeAnnotation
          if (rawTypeAnn.type === 'TsTypeAnn' || rawTypeAnn.type === 'TsTypeAnnotation') {
            typeAnn = rawTypeAnn.typeAnnotation ?? rawTypeAnn
          } else {
            typeAnn = rawTypeAnn
          }
        } else {
          typeAnn = undefined
        }

        // Small helpers to robustly extract the referenced type name and literal string
        const extractTypeName = (ta: any): string | undefined => {
          if (!ta) return undefined
          // Identifier style: { type: 'Identifier', value: 'TFunction' } OR { name: 'TFunction' }
          if (ta.typeName && (ta.typeName.type === 'Identifier')) return ta.typeName.value ?? ta.typeName.name
          if (ta.typeName && ta.typeName.type === 'TsQualifiedName') {
            // Qualified like Foo.TFunction -> try right side
            const right = (ta.typeName.right ?? ta.typeName)
            return right?.value ?? right?.name
          }
          if (ta.typeName && typeof ta.typeName === 'string') return ta.typeName
          if (ta.type === 'Identifier') return ta.value ?? ta.name
          if (ta.id) return ta.id?.value ?? ta.id?.name ?? ta.id
          return undefined
        }

        const extractStringLiteralValue = (node: any): string | undefined => {
          if (!node) return undefined
          // Handle: typeof SomeConst  → TsTypeQuery { exprName: { value: 'SomeConst' } }
          if (node?.type === 'TsTypeQuery') {
            const name = node.exprName?.value ?? node.exprName?.name
            if (name) return this.scopeManager.resolveSimpleStringIdentifier(name)
          }
          // shapes: TsLiteralType -> { literal: { type: 'StringLiteral', value: 'x' } }
          if (node.type === 'TsLiteralType' && node.literal) return node.literal.value ?? node.literal.raw
          if (node.type === 'StringLiteral' || node.type === 'Str' || node.type === 'Literal') return node.value ?? node.raw ?? node.value
          if (node.literal && (node.literal.type === 'StringLiteral' || node.literal.type === 'Str')) return node.literal.value
          // some SWC builds put the string directly on .value
          if (typeof node.value === 'string') return node.value
          // handle wrapped parameter like { params: [ ... ] } where a literal might be one level deeper
          if (node.params && Array.isArray(node.params) && node.params[0]) return extractStringLiteralValue(node.params[0])
          if (node.typeArguments && Array.isArray(node.typeArguments) && node.typeArguments[0]) return extractStringLiteralValue(node.typeArguments[0])
          if (node.typeParameters && Array.isArray(node.typeParameters) && node.typeParameters[0]) return extractStringLiteralValue(node.typeParameters[0])
          if (node.typeParams && Array.isArray(node.typeParams) && node.typeParams[0]) return extractStringLiteralValue(node.typeParams[0])
          return undefined
        }

        // Detect TsTypeReference like: TFunction<"my-custom-namespace">
        if (typeAnn && (typeAnn.type === 'TsTypeReference' || typeAnn.type === 'TsTypeRef' || typeAnn.type === 'TsTypeReference')) {
          const finalTypeName = extractTypeName(typeAnn)
          if (finalTypeName === 'TFunction') {
            // support multiple AST shapes for type parameters:
            // - typeAnn.typeParameters?.params?.[0]
            // - typeAnn.typeArguments?.params?.[0]
            // - typeAnn.typeParams?.[0] / typeAnn.params?.[0]
            const candidates = [
              typeAnn.typeParameters?.params?.[0],
              typeAnn.typeParameters?.[0],
              typeAnn.typeArguments?.params?.[0],
              typeAnn.typeArguments?.[0],
              typeAnn.typeParams?.params?.[0],
              typeAnn.typeParams?.[0],
              typeAnn.params?.[0],
              typeAnn.args?.[0],
              typeAnn.typeParameters, // fallback if it's directly the literal
              typeAnn.typeArguments,
              typeAnn.typeParams,
            ]
            let tp: any | undefined
            for (const c of candidates) {
              if (c) { tp = c; break }
            }
            const ns = extractStringLiteralValue(tp)

            // Extract the second type parameter for KPrefix
            // We need to find the second element from the same type parameter list
            const typeParams =
              typeAnn.typeParameters?.params ??
              typeAnn.typeArguments?.params ??
              typeAnn.typeParams?.params ??
              undefined

            let kpFromType: string | undefined
            if (typeParams && typeParams.length >= 2) {
              kpFromType = extractStringLiteralValue(typeParams[1])
            }

            if (ns || kpFromType) {
              this.scopeManager.setVarInScope(paramKey, {
                defaultNs: ns,
                keyPrefix: kpFromType // honour TFunction<Ns, KPrefix>
              })
            }
          }
        }
      }
    }

    this.hooks.onBeforeVisitNode?.(node)

    // --- VISIT LOGIC ---
    // Handle specific node types
    switch (node.type) {
      case 'VariableDeclarator':
        this.scopeManager.handleVariableDeclarator(node)
        // Capture simple variable initializers so the expressionResolver can
        // resolve identifiers / member expressions that reference them.
        this.expressionResolver.captureVariableDeclarator(node)
        break
      case 'TSEnumDeclaration':
      case 'TsEnumDeclaration':
      case 'TsEnumDecl':
        // capture enums into resolver symbol table
        this.expressionResolver.captureEnumDeclaration(node)
        break
      // pattern 2: capture type aliases so `declare const x: Alias` can be resolved
      case 'TsTypeAliasDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TsTypeAliasDecl':
        this.expressionResolver.captureTypeAliasDeclaration(node)
        break
      // pattern 3: capture function return types so `t(fn())` can be resolved
      case 'FunctionDeclaration':
      case 'FnDecl':
        this.expressionResolver.captureFunctionDeclaration(node)
        break
      case 'CallExpression':
        this.callExpressionHandler.handleCallExpression(node, this.scopeManager.getVarFromScope.bind(this.scopeManager))
        break
      case 'NewExpression':
        // Handle NewExpression similarly to CallExpression (e.g., new TranslatedError(...))
        // NewExpression has the same structure: callee and arguments
        this.callExpressionHandler.handleCallExpression(
          {
            ...node,
            arguments: node.arguments || []
          },
          this.scopeManager.getVarFromScope.bind(this.scopeManager)
        )
        break
      case 'JSXElement':
        this.jsxHandler.handleJSXElement(node, this.scopeManager.getVarFromScope.bind(this.scopeManager))
        break
    }

    this.hooks.onAfterVisitNode?.(node)

    // --- END VISIT LOGIC ---

    // Detect array iteration calls (.map / .forEach / .flatMap etc.) on a known
    // as-const array so the callback parameter is bound to the array values while
    // the callback body is walked.  We inject the binding BEFORE generic recursion
    // and remove it AFTER, so the whole subtree sees the correct value.
    let arrayCallbackCleanup: (() => void) | undefined
    if (node.type === 'CallExpression') {
      const info = this.tryGetArrayIterationCallbackInfo(node)
      if (info) {
        this.expressionResolver.setTemporaryVariable(info.paramName, info.values)
        arrayCallbackCleanup = () => this.expressionResolver.deleteTemporaryVariable(info.paramName)
      }
    }

    // --- RECURSION ---
    // Recurse into the children of the current node
    for (const key in node) {
      if (key === 'span') continue

      const child = node[key]
      if (Array.isArray(child)) {
        // Pre-scan array children in THREE passes:
        //   Pass 1 — variables WITH init (arrays, objects, strings, fns) + enums
        //   Pass 2 — type aliases + functions (may depend on pass-1 arrays)
        //   Pass 3 — `declare const x: Type` (no init; depends on pass-2 type aliases)
        // This ordering ensures e.g.:
        //   const OPTS = ['a','b'] as const          → pass 1
        //   type T = (typeof OPTS)[number]            → pass 2 (resolves OPTS)
        //   declare const v: T                        → pass 3 (resolves T)

        // ── Pass 1: variables with init ──────────────────────────────────────
        for (const item of child) {
          if (!item || typeof item !== 'object') continue

          // Direct declarator (rare)
          if (item.type === 'VariableDeclarator' && item.init) {
            this.scopeManager.handleVariableDeclarator(item)
            this.expressionResolver.captureVariableDeclarator(item)
            continue
          }
          // enum declarations
          if (item.id && Array.isArray(item.members)) {
            this.expressionResolver.captureEnumDeclaration(item)
          }
          // Bare VariableDeclaration — only declarators that have an init
          if (item.type === 'VariableDeclaration' && Array.isArray(item.declarations)) {
            for (const decl of item.declarations) {
              if (decl?.type === 'VariableDeclarator' && decl.init) {
                this.scopeManager.handleVariableDeclarator(decl)
                this.expressionResolver.captureVariableDeclarator(decl)
              }
            }
          }
          // ExportDeclaration wrapping VariableDeclaration — only inited declarators
          if ((item.type === 'ExportDeclaration' || item.type === 'ExportNamedDeclaration') && item.declaration) {
            const inner = item.declaration
            if (inner.type === 'VariableDeclaration' && Array.isArray(inner.declarations)) {
              for (const vd of inner.declarations) {
                if (vd?.type === 'VariableDeclarator' && vd.init) {
                  this.scopeManager.handleVariableDeclarator(vd)
                  this.expressionResolver.captureVariableDeclarator(vd)
                }
              }
            }
          }
        }

        // ── Pass 2: type aliases + functions ─────────────────────────────────
        for (const item of child) {
          if (!item || typeof item !== 'object') continue

          if (item.type === 'TsTypeAliasDeclaration' || item.type === 'TSTypeAliasDeclaration' || item.type === 'TsTypeAliasDecl') {
            this.expressionResolver.captureTypeAliasDeclaration(item)
          }
          if (item.type === 'FunctionDeclaration' || item.type === 'FnDecl') {
            this.expressionResolver.captureFunctionDeclaration(item)
          }
          if ((item.type === 'ExportDeclaration' || item.type === 'ExportNamedDeclaration') && item.declaration) {
            const inner = item.declaration
            if (inner.type === 'TsTypeAliasDeclaration' || inner.type === 'TSTypeAliasDeclaration' || inner.type === 'TsTypeAliasDecl') {
              this.expressionResolver.captureTypeAliasDeclaration(inner)
            }
            if (inner.type === 'FunctionDeclaration' || inner.type === 'FnDecl') {
              this.expressionResolver.captureFunctionDeclaration(inner)
            }
          }
        }

        // ── Pass 3: `declare const x: Type` — no init, depends on type aliases ─
        // Also re-processes ArrayPattern destructuring (e.g. useState<T>) whose
        // type argument resolution failed in Pass 1 because typeAliasTable was empty.
        for (const item of child) {
          if (!item || typeof item !== 'object') continue

          // Direct declarator with no init
          if (item.type === 'VariableDeclarator' && !item.init) {
            this.scopeManager.handleVariableDeclarator(item)
            this.expressionResolver.captureVariableDeclarator(item)
            continue
          }
          // ArrayPattern destructuring with init — re-run now that type aliases are populated
          if (item.type === 'VariableDeclarator' && item.init && item.id?.type === 'ArrayPattern') {
            this.expressionResolver.captureVariableDeclarator(item)
            continue
          }
          // VariableDeclaration — process no-init declarators and re-process ArrayPattern ones
          if (item.type === 'VariableDeclaration' && Array.isArray(item.declarations)) {
            for (const decl of item.declarations) {
              if (!decl.init) {
                this.scopeManager.handleVariableDeclarator(decl)
                this.expressionResolver.captureVariableDeclarator(decl)
              } else if (decl.id?.type === 'ArrayPattern') {
                this.expressionResolver.captureVariableDeclarator(decl)
              }
            }
          }
          // ExportDeclaration wrapping — same logic
          if ((item.type === 'ExportDeclaration' || item.type === 'ExportNamedDeclaration') && item.declaration) {
            const inner = item.declaration
            if (inner.type === 'VariableDeclaration' && Array.isArray(inner.declarations)) {
              for (const vd of inner.declarations) {
                if (!vd.init) {
                  this.scopeManager.handleVariableDeclarator(vd)
                  this.expressionResolver.captureVariableDeclarator(vd)
                } else if (vd.id?.type === 'ArrayPattern') {
                  this.expressionResolver.captureVariableDeclarator(vd)
                }
              }
            }
          }
        }
        for (const item of child) {
          // Be less strict: if it's a non-null object, walk it.
          // This allows traversal into nodes that might not have a `.type` property
          // but still contain other valid AST nodes.
          if (item && typeof item === 'object') {
            this.walk(item)
          }
        }
      } else if (child && typeof child === 'object') {
        // The condition for single objects should be the same as for array items.
        // Do not require `child.type`. This allows traversal into class method bodies.
        this.walk(child)
      }
    }
    // --- END RECURSION ---

    // Remove temporary callback param binding if one was injected for this node
    arrayCallbackCleanup?.()

    // LEAVE SCOPE for functions
    if (isNewScope) {
      this.scopeManager.exitScope()
    }
  }

  /**
   * If `node` is a call like `ARRAY.map(param => ...)` where ARRAY is a known
   * string-array constant, returns the callback's first parameter name and the
   * array values so the caller can inject a temporary variable binding.
   */
  private tryGetArrayIterationCallbackInfo (node: any): { paramName: string; values: string[] } | undefined {
    try {
      const callee = node.callee
      if (callee?.type !== 'MemberExpression') return undefined
      const prop = callee.property
      if (prop?.type !== 'Identifier') return undefined
      if (!['map', 'forEach', 'flatMap', 'filter', 'find', 'some', 'every'].includes(prop.value)) return undefined

      // The object must be an identifier whose value is a known string array
      const obj = callee.object
      if (obj?.type !== 'Identifier') return undefined
      const values = this.expressionResolver.getVariableValues(obj.value)
      if (!values || values.length === 0) return undefined

      // First argument must be a callback with at least one parameter
      const callbackArg = node.arguments?.[0]?.expression
      if (!callbackArg) return undefined

      // Normalise param across SWC shapes: ArrowFunctionExpression / FunctionExpression
      const params: any[] = callbackArg.params ?? callbackArg.parameters ?? []
      const firstParam = params[0]
      if (!firstParam) return undefined

      // SWC wraps params in `Param { pat: Identifier }` or exposes them directly
      const ident: any =
        firstParam.type === 'Identifier'
          ? firstParam
          : firstParam.type === 'Param' && firstParam.pat?.type === 'Identifier'
            ? firstParam.pat
            : firstParam.type === 'AssignmentPattern' && firstParam.left?.type === 'Identifier'
              ? firstParam.left
              : null

      if (!ident) return undefined
      return { paramName: ident.value, values }
    } catch {
      return undefined
    }
  }

  /**
   * Retrieves variable information from the scope chain.
   * Searches from innermost to outermost scope.
   *
   * @param name - Variable name to look up
   * @returns Scope information if found, undefined otherwise
   *
   * @private
   */
  public getVarFromScope (name: string): ScopeInfo | undefined {
    return this.scopeManager.getVarFromScope(name)
  }

  /**
   * Sets the current file path and code used by the extractor.
   */
  public setCurrentFile (file: string, code: string): void {
    this.currentFile = file
    this.currentCode = code
  }

  /**
   * Returns the currently set file path.
   *
   * @returns The current file path as a string, or `undefined` if no file has been set.
   * @remarks
   * Use this to retrieve the file context that was previously set via `setCurrentFile`.
   */
  public getCurrentFile (): string {
    return this.currentFile
  }

  /**
   * @returns The full source code string for the file currently under processing.
   */
  public getCurrentCode (): string {
    return this.currentCode
  }
}
