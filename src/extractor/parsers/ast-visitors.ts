import type { Module, Node, CallExpression, VariableDeclarator, JSXElement, ArrowFunctionExpression, ObjectExpression } from '@swc/core'
import type { PluginContext, I18nextToolkitConfig, Logger } from '../../types'
import { extractFromTransComponent } from './jsx-parser'

/**
 * Represents variable scope information tracked during AST traversal.
 * Used to maintain context about translation functions and their configuration.
 */
interface ScopeInfo {
  /** Default namespace for translation calls in this scope */
  defaultNs?: string;
  /** Key prefix to prepend to all translation keys in this scope */
  keyPrefix?: string;
}

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
  private readonly config: I18nextToolkitConfig
  private readonly logger: Logger
  private scopeStack: Array<Map<string, ScopeInfo>> = []

  /**
   * Creates a new AST visitor instance.
   *
   * @param config - Toolkit configuration with extraction settings
   * @param pluginContext - Context for adding discovered translation keys
   * @param logger - Logger for warnings and debug information
   */
  constructor (
    config: I18nextToolkitConfig,
    pluginContext: PluginContext,
    logger: Logger
  ) {
    this.pluginContext = pluginContext
    this.config = config
    this.logger = logger
  }

  /**
   * Main entry point for AST traversal.
   * Creates a root scope and begins the recursive walk through the syntax tree.
   *
   * @param node - The root module node to traverse
   */
  public visit (node: Module): void {
    this.enterScope() // Create the root scope for the file
    this.walk(node)
    this.exitScope()  // Clean up the root scope
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
      this.enterScope()
      isNewScope = true
    }

    // --- VISIT LOGIC ---
    // Handle specific node types
    switch (node.type) {
      case 'VariableDeclarator':
        this.handleVariableDeclarator(node)
        break
      case 'CallExpression':
        this.handleCallExpression(node)
        break
      case 'JSXElement':
        this.handleJSXElement(node)
        break
    }
    // --- END VISIT LOGIC ---

    // --- RECURSION ---
    // Recurse into the children of the current node
    for (const key in node) {
      if (key === 'span') continue

      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            this.walk(item)
          }
        }
      } else if (child && child.type) {
        this.walk(child)
      }
    }
    // --- END RECURSION ---

    // LEAVE SCOPE for functions
    if (isNewScope) {
      this.exitScope()
    }
  }

  /**
   * Enters a new variable scope by pushing a new scope map onto the stack.
   * Used when entering functions to isolate variable declarations.
   *
   * @private
   */
  private enterScope (): void {
    this.scopeStack.push(new Map())
  }

  /**
   * Exits the current variable scope by popping the top scope map.
   * Used when leaving functions to clean up variable tracking.
   *
   * @private
   */
  private exitScope (): void {
    this.scopeStack.pop()
  }

  /**
   * Stores variable information in the current scope.
   * Used to track translation functions and their configuration.
   *
   * @param name - Variable name to store
   * @param info - Scope information about the variable
   *
   * @private
   */
  private setVarInScope (name: string, info: ScopeInfo): void {
    if (this.scopeStack.length > 0) {
      this.scopeStack[this.scopeStack.length - 1].set(name, info)
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
  private getVarFromScope (name: string): ScopeInfo | undefined {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].has(name)) {
        return this.scopeStack[i].get(name)
      }
    }
    return undefined
  }

  /**
   * Handles variable declarations that might define translation functions.
   *
   * Processes two patterns:
   * 1. `const { t } = useTranslation(...)` - React i18next pattern
   * 2. `const t = i18next.getFixedT(...)` - Core i18next pattern
   *
   * Extracts namespace and key prefix information for later use.
   *
   * @param node - Variable declarator node to process
   *
   * @private
   */
  private handleVariableDeclarator (node: VariableDeclarator): void {
    if (node.init?.type !== 'CallExpression') return

    const callee = node.init.callee

    // Handle: const { t } = useTranslation(...)
    if (callee.type === 'Identifier' && (this.config.extract.useTranslationNames || ['useTranslation']).indexOf(callee.value) > -1) {
      this.handleUseTranslationDeclarator(node)
      return
    }

    // Handle: const t = i18next.getFixedT(...)
    if (
      callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    callee.property.value === 'getFixedT'
    ) {
      this.handleGetFixedTDeclarator(node)
    }
  }

  /**
   * Processes useTranslation hook declarations to extract scope information.
   *
   * Handles various destructuring patterns:
   * - `const [t] = useTranslation('ns')` - Array destructuring
   * - `const { t } = useTranslation('ns')` - Object destructuring
   * - `const { t: myT } = useTranslation('ns')` - Aliased destructuring
   *
   * Extracts namespace from the first argument and keyPrefix from options.
   *
   * @param node - Variable declarator with useTranslation call
   *
   * @private
   */
  private handleUseTranslationDeclarator (node: VariableDeclarator): void {
    if (!node.init || node.init.type !== 'CallExpression') return

    let variableName: string | undefined

    // Handle array destructuring: const [t, i18n] = useTranslation()
    if (node.id.type === 'ArrayPattern') {
      const firstElement = node.id.elements[0]
      if (firstElement?.type === 'Identifier') {
        variableName = firstElement.value
      }
    }

    // Handle object destructuring: const { t } or { t: t1 } = useTranslation()
    if (node.id.type === 'ObjectPattern') {
      for (const prop of node.id.properties) {
        if (prop.type === 'AssignmentPatternProperty' && prop.key.type === 'Identifier' && prop.key.value === 't') {
          variableName = 't'
          break
        }
        if (prop.type === 'KeyValuePatternProperty' && prop.key.type === 'Identifier' && prop.key.value === 't' && prop.value.type === 'Identifier') {
          variableName = prop.value.value
          break
        }
      }
    }

    // If we couldn't find a `t` function being declared, exit
    if (!variableName) return

    // Find the namespace and keyPrefix from the useTranslation call arguments
    const nsArg = node.init.arguments?.[0]?.expression
    let defaultNs: string | undefined
    if (nsArg?.type === 'StringLiteral') {
      defaultNs = nsArg.value
    } else if (nsArg?.type === 'ArrayExpression' && nsArg.elements[0]?.expression.type === 'StringLiteral') {
      defaultNs = nsArg.elements[0].expression.value
    }

    const optionsArg = node.init.arguments?.[1]?.expression
    let keyPrefix: string | undefined
    if (optionsArg?.type === 'ObjectExpression') {
      keyPrefix = this.getObjectPropValue(optionsArg, 'keyPrefix')
    }

    // Store the scope info for the declared variable
    this.setVarInScope(variableName, { defaultNs, keyPrefix })
  }

  /**
   * Processes getFixedT function declarations to extract scope information.
   *
   * Handles the pattern: `const t = i18next.getFixedT(lng, ns, keyPrefix)`
   * - Ignores the first argument (language)
   * - Extracts namespace from the second argument
   * - Extracts key prefix from the third argument
   *
   * @param node - Variable declarator with getFixedT call
   *
   * @private
   */
  private handleGetFixedTDeclarator (node: VariableDeclarator): void {
  // Ensure we are assigning to a simple variable, e.g., const t = ...
    if (node.id.type !== 'Identifier' || !node.init || node.init.type !== 'CallExpression') return

    const variableName = node.id.value
    const args = node.init.arguments

    // getFixedT(lng, ns, keyPrefix)
    // We ignore the first argument (lng) for key extraction.
    const nsArg = args[1]?.expression
    const keyPrefixArg = args[2]?.expression

    const defaultNs = (nsArg?.type === 'StringLiteral') ? nsArg.value : undefined
    const keyPrefix = (keyPrefixArg?.type === 'StringLiteral') ? keyPrefixArg.value : undefined

    if (defaultNs || keyPrefix) {
      this.setVarInScope(variableName, { defaultNs, keyPrefix })
    }
  }

  /**
   * Processes function call expressions to extract translation keys.
   *
   * This is the core extraction method that handles:
   * - Standard t() calls with string literals
   * - Selector API calls with arrow functions: `t($ => $.path.to.key)`
   * - Namespace resolution from multiple sources
   * - Default value extraction from various argument patterns
   * - Pluralization and context handling
   * - Key prefix application from scope
   *
   * @param node - Call expression node to process
   *
   * @private
   */
  private handleCallExpression (node: CallExpression): void {
    const callee = node.callee
    if (callee.type !== 'Identifier') return

    const isConfiguredFunction = (this.config.extract.functions || []).includes(callee.value)
    const scopeInfo = this.getVarFromScope(callee.value)
    const isScopedFunction = scopeInfo !== undefined

    if (!isConfiguredFunction && !isScopedFunction) return
    if (node.arguments.length === 0) return

    const firstArg = node.arguments[0].expression
    let key: string | null = null

    if (firstArg.type === 'StringLiteral') {
      key = firstArg.value
    } else if (firstArg.type === 'ArrowFunctionExpression') {
      key = this.extractKeyFromSelector(firstArg)
    }

    if (!key) return // Could not statically extract a key

    let ns: string | undefined
    let finalKey = key
    const options = node.arguments.length > 1 ? node.arguments[1].expression : undefined

    // Determine namespace (explicit ns > scope ns > ns:key > default)
    if (options?.type === 'ObjectExpression') ns = this.getObjectPropValue(options, 'ns')
    if (!ns && scopeInfo?.defaultNs) ns = scopeInfo.defaultNs

    const nsSeparator = this.config.extract.nsSeparator ?? ':'
    const contextSeparator = this.config.extract.contextSeparator ?? '_'
    if (!ns && nsSeparator && key.includes(nsSeparator)) {
      const parts = key.split(nsSeparator)
      ns = parts.shift()
      key = parts.join(nsSeparator)
      finalKey = key
    }
    if (!ns) ns = this.config.extract.defaultNS

    // Prepend keyPrefix from scope if it exists
    if (scopeInfo?.keyPrefix) {
      const keySeparator = this.config.extract.keySeparator ?? '.'
      finalKey = `${scopeInfo.keyPrefix}${keySeparator}${key}`
    }

    // For selectors, defaultValue is the key. For strings, parse it.
    const defaultValue = (firstArg.type === 'StringLiteral') ? this.getDefaultValue(node, key) : key

    // Plural/Context logic
    if (options?.type === 'ObjectExpression') {
      const contextValue = this.getObjectPropValue(options, 'context')
      if (contextValue) {
        this.pluginContext.addKey({ key: `${finalKey}${contextSeparator}${contextValue}`, ns, defaultValue })
        return
      }
      if (this.getObjectPropValue(options, 'count') !== undefined) {
        this.handlePluralKeys(finalKey, defaultValue, ns)
        return
      }
    }

    // Standard key
    this.pluginContext.addKey({ key: finalKey, ns, defaultValue })
  }

  /**
   * Generates plural form keys based on the primary language's plural rules.
   *
   * Uses Intl.PluralRules to determine the correct plural categories
   * for the configured primary language and generates suffixed keys
   * for each category (e.g., 'item_one', 'item_other').
   *
   * @param key - Base key name for pluralization
   * @param defaultValue - Default value to use for all plural forms
   * @param ns - Namespace for the keys
   *
   * @private
   */
  private handlePluralKeys (key: string, defaultValue: string | undefined, ns: string | undefined): void {
    try {
      const pluralCategories = new Intl.PluralRules(this.config.extract?.primaryLanguage).resolvedOptions().pluralCategories
      const pluralSeparator = this.config.extract.pluralSeparator ?? '_'

      for (const category of pluralCategories) {
        this.pluginContext.addKey({
          key: `${key}${pluralSeparator}${category}`,
          ns,
          defaultValue,
          hasCount: true
        })
      }
    } catch (e) {
      this.logger.warn(`Could not determine plural rules for language "${this.config.extract?.primaryLanguage}". Falling back to simple key extraction.`)
      this.pluginContext.addKey({ key, defaultValue, ns })
    }
  }

  /**
   * Extracts default value from translation function call arguments.
   *
   * Supports multiple patterns:
   * - String as second argument: `t('key', 'Default')`
   * - Object with defaultValue: `t('key', { defaultValue: 'Default' })`
   * - Falls back to the key itself if no default found
   *
   * @param node - Call expression node
   * @param fallback - Fallback value if no default found
   * @returns Extracted default value
   *
   * @private
   */
  private getDefaultValue (node: CallExpression, fallback: string): string {
    if (node.arguments.length <= 1) return fallback

    const secondArg = node.arguments[1].expression

    if (secondArg.type === 'StringLiteral') {
      return secondArg.value || fallback
    }

    if (secondArg.type === 'ObjectExpression') {
      return this.getObjectPropValue(secondArg, 'defaultValue') || fallback
    }

    return fallback
  }

  /**
   * Processes JSX elements to extract translation keys from Trans components.
   *
   * Identifies configured Trans components and delegates to the JSX parser
   * for complex children serialization and attribute extraction.
   *
   * @param node - JSX element node to process
   *
   * @private
   */
  private handleJSXElement (node: JSXElement): void {
    const elementName = this.getElementName(node)

    if (elementName && (this.config.extract.transComponents || ['Trans']).includes(elementName)) {
      const extractedKey = extractFromTransComponent(node, this.config)
      if (extractedKey) {
      // If ns is not explicitly set on the component, try to find it from the `t` prop
        if (!extractedKey.ns) {
          const tProp = node.opening.attributes?.find(
            attr =>
              attr.type === 'JSXAttribute' &&
            attr.name.type === 'Identifier' &&
            attr.name.value === 't'
          )

          // Check if the prop value is an identifier (e.g., t={t})
          if (
            tProp?.type === 'JSXAttribute' &&
          tProp.value?.type === 'JSXExpressionContainer' &&
          tProp.value.expression.type === 'Identifier'
          ) {
            const tIdentifier = tProp.value.expression.value
            const scopeInfo = this.getVarFromScope(tIdentifier)
            if (scopeInfo?.defaultNs) {
              extractedKey.ns = scopeInfo.defaultNs
            }
          }
        }

        // Apply defaultNS from config if no namespace was found on the component
        if (!extractedKey.ns) {
          extractedKey.ns = this.config.extract.defaultNS
        }

        // If the component has a `count` prop, use the plural handler
        if (extractedKey.hasCount) {
          this.handlePluralKeys(extractedKey.key, extractedKey.defaultValue, extractedKey.ns)
        } else {
        // Otherwise, add the key as-is
          this.pluginContext.addKey(extractedKey)
        }
      // The duplicated addKey call has been removed.
      }
    }
  }

  /**
   * Extracts element name from JSX opening tag.
   *
   * Handles both simple identifiers and member expressions:
   * - `<Trans>` → 'Trans'
   * - `<React.Trans>` → 'React.Trans'
   *
   * @param node - JSX element node
   * @returns Element name or undefined if not extractable
   *
   * @private
   */
  private getElementName (node: JSXElement): string | undefined {
    if (node.opening.name.type === 'Identifier') {
      return node.opening.name.value
    } else if (node.opening.name.type === 'JSXMemberExpression') {
      let curr: any = node.opening.name
      const names: string[] = []
      while (curr.type === 'JSXMemberExpression') {
        if (curr.property.type === 'Identifier') names.unshift(curr.property.value)
        curr = curr.object
      }
      if (curr.type === 'Identifier') names.unshift(curr.value)
      return names.join('.')
    }
    return undefined
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
  private getObjectPropValue (object: ObjectExpression, propName: string): string | undefined {
    const prop = (object.properties).find(
      (p) =>
        p.type === 'KeyValueProperty' &&
        (
          (p.key?.type === 'Identifier' && p.key.value === propName) ||
          (p.key?.type === 'StringLiteral' && p.key.value === propName)
        )
    )

    if (prop?.type === 'KeyValueProperty') {
      const val = prop.value
      // Only return the value if it's a string, otherwise we just care that it exists (for `count`)
      if (val.type === 'StringLiteral') {
        return val.value
      }
      // For properties like `count`, the value could be a number, but we just need to know it's there.
      // So we return a non-undefined value. An empty string is fine.
      return ''
    }
    return undefined
  }

  /**
   * Extracts translation key from selector API arrow function.
   *
   * Processes selector expressions like:
   * - `$ => $.path.to.key` → 'path.to.key'
   * - `$ => $.app['title'].main` → 'app.title.main'
   * - `$ => { return $.nested.key; }` → 'nested.key'
   *
   * Handles both dot notation and bracket notation, respecting
   * the configured key separator or flat key structure.
   *
   * @param node - Arrow function expression from selector call
   * @returns Extracted key path or null if not statically analyzable
   *
   * @private
   */
  private extractKeyFromSelector (node: ArrowFunctionExpression): string | null {
    let body = node.body

    // Handle block bodies, e.g., $ => { return $.key; }
    if (body.type === 'BlockStatement') {
      const returnStmt = body.stmts.find(s => s.type === 'ReturnStatement')
      if (returnStmt?.type === 'ReturnStatement' && returnStmt.argument) {
        body = returnStmt.argument
      } else {
        return null
      }
    }

    let current = body
    const parts: string[] = []

    // Recursively walk down MemberExpressions
    while (current.type === 'MemberExpression') {
      const prop = current.property

      if (prop.type === 'Identifier') {
      // This handles dot notation: .key
        parts.unshift(prop.value)
      } else if (prop.type === 'Computed' && prop.expression.type === 'StringLiteral') {
      // This handles bracket notation: ['key']
        parts.unshift(prop.expression.value)
      } else {
      // This is a dynamic property like [myVar] or a private name, which we cannot resolve.
        return null
      }

      current = current.object
    }

    if (parts.length > 0) {
      const keySeparator = this.config.extract.keySeparator
      const joiner = typeof keySeparator === 'string' ? keySeparator : '.'
      return parts.join(joiner)
    }

    return null
  }
}
