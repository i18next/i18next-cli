import type { Module, Node, CallExpression, VariableDeclarator, JSXElement, ArrowFunctionExpression, ObjectExpression, Expression } from '@swc/core'
import type { PluginContext, I18nextToolkitConfig, Logger } from '../../types'
import { extractFromTransComponent } from './jsx-parser'
import { getObjectProperty, getObjectPropValue } from './ast-utils'

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

interface UseTranslationHookConfig {
  name: string;
  nsArg: number;
  keyPrefixArg: number;
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

  public objectKeys = new Set<string>()

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
    const init = node.init
    if (!init) return

    // Determine the actual call expression, looking inside AwaitExpressions.
    const callExpr =
    init.type === 'AwaitExpression' && init.argument.type === 'CallExpression'
      ? init.argument
      : init.type === 'CallExpression'
        ? init
        : null

    if (!callExpr) return

    const callee = callExpr.callee

    // Handle: const { t } = useTranslation(...)
    if (callee.type === 'Identifier') {
      const hookConfig = this.getUseTranslationConfig(callee.value)
      if (hookConfig) {
        this.handleUseTranslationDeclarator(node, callExpr, hookConfig)
        return
      }
    }

    // Handle: const t = i18next.getFixedT(...)
    if (
      callee.type === 'MemberExpression' &&
      callee.property.type === 'Identifier' &&
      callee.property.value === 'getFixedT'
    ) {
      this.handleGetFixedTDeclarator(node, callExpr)
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
   * @param callExpr - The CallExpression node representing the useTranslation invocation
   * @param hookConfig - Configuration describing argument positions for namespace and keyPrefix
   *
   * @private
   */
  private handleUseTranslationDeclarator (node: VariableDeclarator, callExpr: CallExpression, hookConfig: UseTranslationHookConfig): void {
    let variableName: string | undefined

    // Handle simple assignment: let t = useTranslation()
    if (node.id.type === 'Identifier') {
      variableName = node.id.value
    }

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
          // This handles { t = defaultT }
          variableName = 't'
          break
        }
        if (prop.type === 'KeyValuePatternProperty' && prop.key.type === 'Identifier' && prop.key.value === 't' && prop.value.type === 'Identifier') {
          // This handles { t: myT }
          variableName = prop.value.value
          break
        }
      }
    }

    // If we couldn't find a `t` function being declared, exit
    if (!variableName) return

    // Use the configured argument indices from hookConfig
    const nsArg = callExpr.arguments?.[hookConfig.nsArg]?.expression

    let defaultNs: string | undefined
    if (nsArg?.type === 'StringLiteral') {
      defaultNs = nsArg.value
    } else if (nsArg?.type === 'ArrayExpression' && nsArg.elements[0]?.expression.type === 'StringLiteral') {
      defaultNs = nsArg.elements[0].expression.value
    }

    const optionsArg = callExpr.arguments?.[hookConfig.keyPrefixArg]?.expression
    let keyPrefix: string | undefined
    if (optionsArg?.type === 'ObjectExpression') {
      const kp = getObjectPropValue(optionsArg, 'keyPrefix')
      keyPrefix = typeof kp === 'string' ? kp : undefined
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
   * @param callExpr - The CallExpression node representing the getFixedT invocation
   *
   * @private
   */
  private handleGetFixedTDeclarator (node: VariableDeclarator, callExpr: CallExpression): void {
  // Ensure we are assigning to a simple variable, e.g., const t = ...
    if (node.id.type !== 'Identifier' || !node.init || node.init.type !== 'CallExpression') return

    const variableName = node.id.value
    const args = callExpr.arguments

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
    const functionName = this.getFunctionName(node.callee)
    if (!functionName) return

    // The scope lookup will only work for simple identifiers, which is okay for this fix.
    const scopeInfo = this.getVarFromScope(functionName)
    const configuredFunctions = this.config.extract.functions || ['t', '*.t']
    let isFunctionToParse = scopeInfo !== undefined // A scoped variable (from useTranslation, etc.) is always parsed.
    if (!isFunctionToParse) {
      for (const pattern of configuredFunctions) {
        if (pattern.startsWith('*.')) {
        // Handle wildcard suffix (e.g., '*.t' matches 'i18n.t')
          if (functionName.endsWith(pattern.substring(1))) {
            isFunctionToParse = true
            break
          }
        } else {
        // Handle exact match
          if (pattern === functionName) {
            isFunctionToParse = true
            break
          }
        }
      }
    }
    if (!isFunctionToParse || node.arguments.length === 0) return

    const firstArg = node.arguments[0].expression
    let keysToProcess: string[] = []

    if (firstArg.type === 'StringLiteral') {
      keysToProcess.push(firstArg.value)
    } else if (firstArg.type === 'ArrowFunctionExpression') {
      const key = this.extractKeyFromSelector(firstArg)
      if (key) keysToProcess.push(key)
    } else if (firstArg.type === 'ArrayExpression') {
      for (const element of firstArg.elements) {
        // We only extract static string literals from the array
        if (element?.expression.type === 'StringLiteral') {
          keysToProcess.push(element.expression.value)
        }
      }
    }

    keysToProcess = keysToProcess.filter(key => !!key)
    if (keysToProcess.length === 0) return

    let isOrdinalByKey = false
    const pluralSeparator = this.config.extract.pluralSeparator ?? '_'

    for (let i = 0; i < keysToProcess.length; i++) {
      if (keysToProcess[i].endsWith(`${pluralSeparator}ordinal`)) {
        isOrdinalByKey = true
        // Normalize the key by stripping the suffix
        keysToProcess[i] = keysToProcess[i].slice(0, -8)
      }
    }

    let defaultValue: string | undefined
    let options: ObjectExpression | undefined

    if (node.arguments.length > 1) {
      const arg2 = node.arguments[1].expression
      if (arg2.type === 'ObjectExpression') {
        options = arg2
      } else if (arg2.type === 'StringLiteral') {
        defaultValue = arg2.value
      }
    }
    if (node.arguments.length > 2) {
      const arg3 = node.arguments[2].expression
      if (arg3.type === 'ObjectExpression') {
        options = arg3
      }
    }
    const defaultValueFromOptions = options ? getObjectPropValue(options, 'defaultValue') : undefined
    const finalDefaultValue = (typeof defaultValueFromOptions === 'string' ? defaultValueFromOptions : defaultValue)

    // Loop through each key found (could be one or more) and process it
    for (let i = 0; i < keysToProcess.length; i++) {
      let key = keysToProcess[i]
      let ns: string | undefined

      // Determine namespace (explicit ns > scope ns > ns:key > default)
      if (options) {
        const nsVal = getObjectPropValue(options, 'ns')
        if (typeof nsVal === 'string') ns = nsVal
      }
      if (!ns && scopeInfo?.defaultNs) ns = scopeInfo.defaultNs

      const nsSeparator = this.config.extract.nsSeparator ?? ':'
      if (!ns && nsSeparator && key.includes(nsSeparator)) {
        const parts = key.split(nsSeparator)
        ns = parts.shift()
        key = parts.join(nsSeparator)
      }
      if (!ns) ns = this.config.extract.defaultNS

      let finalKey = key
      if (scopeInfo?.keyPrefix) {
        const keySeparator = this.config.extract.keySeparator ?? '.'
        finalKey = `${scopeInfo.keyPrefix}${keySeparator}${key}`
      }

      const isLastKey = i === keysToProcess.length - 1
      const dv = isLastKey ? (finalDefaultValue || key) : key

      // Handle plurals, context, and returnObjects
      if (options) {
        const contextProp = getObjectProperty(options, 'context')

        // 1. Handle Dynamic Context (Ternary) first
        if (contextProp?.value?.type === 'ConditionalExpression') {
          const contextValues = this.resolvePossibleStringValues(contextProp.value)
          const contextSeparator = this.config.extract.contextSeparator ?? '_'

          if (contextValues.length > 0) {
            contextValues.forEach(context => {
              this.pluginContext.addKey({ key: `${finalKey}${contextSeparator}${context}`, ns, defaultValue: dv })
            })
            // For dynamic context, also add the base key as a fallback
            this.pluginContext.addKey({ key: finalKey, ns, defaultValue: dv })
            continue // This key is fully handled, move to the next in the array
          }
        }

        // 2. Handle Static Context
        const contextValue = getObjectPropValue(options, 'context')
        if (typeof contextValue === 'string' && contextValue) {
          const contextSeparator = this.config.extract.contextSeparator ?? '_'
          this.pluginContext.addKey({ key: `${finalKey}${contextSeparator}${contextValue}`, ns, defaultValue: dv })
          continue // This key is fully handled
        }

        // 3. Handle Plurals
        const hasCount = getObjectPropValue(options, 'count') !== undefined
        const isOrdinalByOption = getObjectPropValue(options, 'ordinal') === true
        if (hasCount || isOrdinalByKey) {
          // Pass the combined ordinal flag to the handler
          this.handlePluralKeys(finalKey, ns, options, isOrdinalByOption || isOrdinalByKey)
          continue
        }

        // 4. Handle returnObjects
        if (getObjectPropValue(options, 'returnObjects') === true) {
          this.objectKeys.add(finalKey)
          // Fall through to add the base key itself
        }
      }

      // 5. Default case: Add the simple key
      this.pluginContext.addKey({ key: finalKey, ns, defaultValue: dv })
    }
  }

  /**
   * Generates plural form keys based on the primary language's plural rules.
   *
   * Uses Intl.PluralRules to determine the correct plural categories
   * for the configured primary language and generates suffixed keys
   * for each category (e.g., 'item_one', 'item_other').
   *
   * @param key - Base key name for pluralization
   * @param ns - Namespace for the keys
   * @param options - object expression options
   * @param isOrdinal - isOrdinal flag
   *
   * @private
   */
  private handlePluralKeys (key: string, ns: string | undefined, options: ObjectExpression, isOrdinal: boolean): void {
    try {
      const type = isOrdinal ? 'ordinal' : 'cardinal'

      const pluralCategories = new Intl.PluralRules(this.config.extract?.primaryLanguage, { type }).resolvedOptions().pluralCategories
      const pluralSeparator = this.config.extract.pluralSeparator ?? '_'

      // Get all possible default values once at the start
      const defaultValue = getObjectPropValue(options, 'defaultValue')
      const otherDefault = getObjectPropValue(options, `defaultValue${pluralSeparator}other`)
      const ordinalOtherDefault = getObjectPropValue(options, `defaultValue${pluralSeparator}ordinal${pluralSeparator}other`)

      for (const category of pluralCategories) {
        // 1. Look for the most specific default value (e.g., defaultValue_ordinal_one)
        const specificDefaultKey = isOrdinal ? `defaultValue${pluralSeparator}ordinal${pluralSeparator}${category}` : `defaultValue${pluralSeparator}${category}`
        const specificDefault = getObjectPropValue(options, specificDefaultKey)

        // 2. Determine the final default value using a clear fallback chain
        let finalDefaultValue: string | undefined
        if (typeof specificDefault === 'string') {
          // 1. Use the most specific default if it exists (e.g., defaultValue_one)
          finalDefaultValue = specificDefault
        } else if (category === 'one' && typeof defaultValue === 'string') {
          // 2. SPECIAL CASE: The 'one' category falls back to the main 'defaultValue' prop
          finalDefaultValue = defaultValue
        } else if (isOrdinal && typeof ordinalOtherDefault === 'string') {
          // 3a. Other ordinal categories fall back to 'defaultValue_ordinal_other'
          finalDefaultValue = ordinalOtherDefault
        } else if (!isOrdinal && typeof otherDefault === 'string') {
          // 3b. Other cardinal categories fall back to 'defaultValue_other'
          finalDefaultValue = otherDefault
        } else if (typeof defaultValue === 'string') {
          // 4. If no '_other' is found, all categories can fall back to the main 'defaultValue'
          finalDefaultValue = defaultValue
        } else {
          // 5. Final fallback to the base key itself
          finalDefaultValue = key
        }

        // 3. Construct the final plural key
        const finalKey = isOrdinal
          ? `${key}${pluralSeparator}ordinal${pluralSeparator}${category}`
          : `${key}${pluralSeparator}${category}`

        this.pluginContext.addKey({
          key: finalKey,
          ns,
          defaultValue: finalDefaultValue,
          hasCount: true,
          isOrdinal
        })
      }
    } catch (e) {
      this.logger.warn(`Could not determine plural rules for language "${this.config.extract?.primaryLanguage}". Falling back to simple key extraction.`)
      // Fallback to a simple key if Intl API fails
      const defaultValue = getObjectPropValue(options, 'defaultValue')
      this.pluginContext.addKey({ key, ns, defaultValue: typeof defaultValue === 'string' ? defaultValue : key })
    }
  }

  /**
   * Generates simple plural keys, typically for a <Trans> component.
   *
   * @param key - Base key name for which plural keys should be generated
   * @param defaultValue - Optional default value to associate with each plural variant
   * @param ns - Optional namespace to use for the generated keys
   *
   * @private
   */
  private handleSimplePluralKeys (key: string, defaultValue: string | undefined, ns: string | undefined): void {
    try {
      const pluralCategories = new Intl.PluralRules(this.config.extract?.primaryLanguage).resolvedOptions().pluralCategories
      const pluralSeparator = this.config.extract.pluralSeparator ?? '_'
      for (const category of pluralCategories) {
        this.pluginContext.addKey({
          key: `${key}${pluralSeparator}${category}`,
          ns,
          defaultValue,
          hasCount: true,
        })
      }
    } catch (e) {
      this.logger.warn(`Could not determine plural rules for language "${this.config.extract?.primaryLanguage}".`)
      this.pluginContext.addKey({ key, ns, defaultValue })
    }
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

        if (extractedKey.contextExpression) {
          const contextValues = this.resolvePossibleStringValues(extractedKey.contextExpression)
          const contextSeparator = this.config.extract.contextSeparator ?? '_'

          if (contextValues.length > 0) {
            for (const context of contextValues) {
              this.pluginContext.addKey({ key: `${extractedKey.key}${contextSeparator}${context}`, ns: extractedKey.ns, defaultValue: extractedKey.defaultValue })
            }
            // Only add the base key as a fallback if the context is dynamic (i.e., not a simple string).
            if (extractedKey.contextExpression.type !== 'StringLiteral') {
              this.pluginContext.addKey(extractedKey)
            }
          }
        } else if (extractedKey.hasCount) {
          // Find isOrdinal prop on the <Trans> component
          const ordinalAttr = node.opening.attributes?.find(
            (attr) =>
              attr.type === 'JSXAttribute' &&
              attr.name.type === 'Identifier' &&
              attr.name.value === 'ordinal'
          )
          const isOrdinal = !!ordinalAttr

          // If tOptions are provided, use the advanced plural handler
          const optionsNode = extractedKey.optionsNode ?? { type: 'ObjectExpression', properties: [], span: { start: 0, end: 0, ctxt: 0 } }

          // Inject the defaultValue from children into the options object
          optionsNode.properties.push({
            type: 'KeyValueProperty',
            key: { type: 'Identifier', value: 'defaultValue', optional: false, span: { start: 0, end: 0, ctxt: 0 } },
            value: { type: 'StringLiteral', value: extractedKey.defaultValue!, span: { start: 0, end: 0, ctxt: 0 } }
          })

          this.handlePluralKeys(extractedKey.key, extractedKey.ns, optionsNode, isOrdinal)
        } else {
          this.pluginContext.addKey(extractedKey)
        }
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

  /**
   * Resolves an expression to one or more possible string values that can be
   * determined statically from the AST.
   *
   * Supports:
   * - StringLiteral -> single value
   * - ConditionalExpression (ternary) -> union of consequent and alternate resolved values
   * - The identifier `undefined` -> empty array
   *
   * For any other expression types (identifiers, function calls, member expressions,
   * etc.) the value cannot be determined statically and an empty array is returned.
   *
   * @private
   * @param expression - The SWC AST expression node to resolve
   * @returns An array of possible string values that the expression may produce.
   */
  private resolvePossibleStringValues (expression: Expression): string[] {
    if (expression.type === 'StringLiteral') {
      return [expression.value]
    }

    if (expression.type === 'ConditionalExpression') { // This is a ternary operator
      const consequentValues = this.resolvePossibleStringValues(expression.consequent)
      const alternateValues = this.resolvePossibleStringValues(expression.alternate)
      return [...consequentValues, ...alternateValues]
    }

    if (expression.type === 'Identifier' && expression.value === 'undefined') {
      return [] // Handle the `undefined` case
    }

    // We can't statically determine the value of other expressions (e.g., variables, function calls)
    return []
  }

  /**
   * Finds the configuration for a given useTranslation function name.
   * Applies default argument positions if none are specified.
   *
   * @param name - The identifier name to look up in the configured useTranslationNames
   * @returns The resolved UseTranslationHookConfig when a match is found, otherwise undefined
   */
  private getUseTranslationConfig (name: string): UseTranslationHookConfig | undefined {
    const useTranslationNames = this.config.extract.useTranslationNames || ['useTranslation']

    for (const item of useTranslationNames) {
      if (typeof item === 'string' && item === name) {
        // Default behavior for simple string entries
        return { name, nsArg: 0, keyPrefixArg: 1 }
      }
      if (typeof item === 'object' && item.name === name) {
        // Custom configuration with specified or default argument positions
        return {
          name: item.name,
          nsArg: item.nsArg ?? 0,
          keyPrefixArg: item.keyPrefixArg ?? 1,
        }
      }
    }
    return undefined
  }

  /**
   * Serializes a callee node (Identifier or MemberExpression) into a string.
   *
   * Produces a dotted name for simple callees that can be used for scope lookups
   * or configuration matching.
   *
   * Supported inputs:
   * - Identifier: returns the identifier name (e.g., `t` -> "t")
   * - MemberExpression with Identifier parts: returns a dotted path of identifiers
   *   (e.g., `i18n.t` -> "i18n.t", `i18n.getFixedT` -> "i18n.getFixedT")
   *
   * Behavior notes:
   * - Computed properties are not supported and cause this function to return null
   *   (e.g., `i18n['t']` -> null).
   * - The base of a MemberExpression must be a simple Identifier. More complex bases
   *   (other expressions, `this`, etc.) will result in null.
   * - This function does not attempt to resolve or evaluate expressions — it only
   *   serializes static identifier/member chains.
   *
   * Examples:
   * - Identifier callee: { type: 'Identifier', value: 't' } -> "t"
   * - Member callee: { type: 'MemberExpression', object: { type: 'Identifier', value: 'i18n' }, property: { type: 'Identifier', value: 't' } } -> "i18n.t"
   *
   * @param callee - The CallExpression callee node to serialize
   * @returns A dotted string name for supported callees, or null when the callee
   *          is a computed/unsupported expression.
   *
   * @private
   */
  private getFunctionName (callee: CallExpression['callee']): string | null {
    if (callee.type === 'Identifier') {
      return callee.value
    }
    if (callee.type === 'MemberExpression') {
      const parts: string[] = []
      let current: any = callee
      while (current.type === 'MemberExpression') {
        if (current.property.type === 'Identifier') {
          parts.unshift(current.property.value)
        } else {
          return null // Cannot handle computed properties like i18n['t']
        }
        current = current.object
      }
      // Handle `this` as the base of the expression (e.g., this._i18n.t)
      if (current.type === 'ThisExpression') {
        parts.unshift('this')
      } else if (current.type === 'Identifier') {
        parts.unshift(current.value)
      } else {
        return null // Base of the expression is not a simple identifier
      }
      return parts.join('.')
    }
    return null
  }
}
