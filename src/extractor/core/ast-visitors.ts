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

  private readonly scopeManager: ScopeManager
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
      () => this.getCurrentCode()
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
            if (ns) {
              this.scopeManager.setVarInScope(paramKey, { defaultNs: ns })
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

    // --- RECURSION ---
    // Recurse into the children of the current node
    for (const key in node) {
      if (key === 'span') continue

      const child = node[key]
      if (Array.isArray(child)) {
        // Pre-scan array children to register VariableDeclarator-based scopes
        // (e.g., `const { t } = useTranslation(...)`) before walking the rest
        // of the items. This ensures that functions/arrow-functions defined
        // earlier in the same block that reference t will resolve to the
        // correct scope even if the `useTranslation` declarator appears later.
        for (const item of child) {
          if (!item || typeof item !== 'object') continue

          // Direct declarator present in arrays (rare)
          if (item.type === 'VariableDeclarator') {
            this.scopeManager.handleVariableDeclarator(item)
            this.expressionResolver.captureVariableDeclarator(item)
            continue
          }
          // enum declarations can appear as ExportDeclaration.declaration earlier; be permissive
          if (item && item.id && Array.isArray(item.members)) {
            this.expressionResolver.captureEnumDeclaration(item)
            // continue to allow further traversal
          }
          // Common case: VariableDeclaration which contains .declarations (VariableDeclarator[])
          if (item.type === 'VariableDeclaration' && Array.isArray(item.declarations)) {
            for (const decl of item.declarations) {
              if (decl && typeof decl === 'object' && decl.type === 'VariableDeclarator') {
                this.scopeManager.handleVariableDeclarator(decl)
                this.expressionResolver.captureVariableDeclarator(decl)
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

    // LEAVE SCOPE for functions
    if (isNewScope) {
      this.scopeManager.exitScope()
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
   * Also resets the search index for location tracking.
   */
  public setCurrentFile (file: string, code: string): void {
    this.currentFile = file
    this.currentCode = code
    // Reset search indexes when processing a new file
    this.callExpressionHandler.resetSearchIndex()
    this.jsxHandler.resetSearchIndex()
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
