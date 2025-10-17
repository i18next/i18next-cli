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
    hooks?: ASTVisitorHooks
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
    this.expressionResolver = new ExpressionResolver(this.hooks)
    this.callExpressionHandler = new CallExpressionHandler(config, pluginContext, logger, this.expressionResolver)
    this.jsxHandler = new JSXHandler(config, pluginContext, this.expressionResolver)
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
    if (node.type === 'Function' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      this.scopeManager.enterScope()
      isNewScope = true
    }

    this.hooks.onBeforeVisitNode?.(node)

    // --- VISIT LOGIC ---
    // Handle specific node types
    switch (node.type) {
      case 'VariableDeclarator':
        this.scopeManager.handleVariableDeclarator(node)
        break
      case 'CallExpression':
        this.callExpressionHandler.handleCallExpression(node, this.scopeManager.getVarFromScope.bind(this.scopeManager))
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
            continue
          }

          // Common case: VariableDeclaration which contains .declarations (VariableDeclarator[])
          if (item.type === 'VariableDeclaration' && Array.isArray(item.declarations)) {
            for (const decl of item.declarations) {
              if (decl && typeof decl === 'object' && decl.type === 'VariableDeclarator') {
                this.scopeManager.handleVariableDeclarator(decl)
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
}
