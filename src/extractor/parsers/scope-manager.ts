import type { VariableDeclarator, CallExpression } from '@swc/core'
import type { ScopeInfo, UseTranslationHookConfig, I18nextToolkitConfig } from '../../types'
import { getObjectPropValue } from './ast-utils'

export class ScopeManager {
  private scopeStack: Array<Map<string, ScopeInfo>> = []
  private config: Omit<I18nextToolkitConfig, 'plugins'>
  private scope: Map<string, { defaultNs?: string; keyPrefix?: string }> = new Map()

  constructor (config: Omit<I18nextToolkitConfig, 'plugins'>) {
    this.config = config
  }

  /**
   * Reset per-file scope state.
   *
   * This clears both the scope stack and the legacy scope map. It should be
   * called at the start of processing each file so that scope info does not
   * leak between files.
   */
  public reset (): void {
    this.scopeStack = []
    this.scope = new Map()
  }

  /**
   * Enters a new variable scope by pushing a new scope map onto the stack.
   * Used when entering functions to isolate variable declarations.
   */
  enterScope (): void {
    this.scopeStack.push(new Map())
  }

  /**
   * Exits the current variable scope by popping the top scope map.
   * Used when leaving functions to clean up variable tracking.
   */
  exitScope (): void {
    this.scopeStack.pop()
  }

  /**
   * Stores variable information in the current scope.
   * Used to track translation functions and their configuration.
   *
   * @param name - Variable name to store
   * @param info - Scope information about the variable
   */
  setVarInScope (name: string, info: ScopeInfo): void {
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
   */
  getVarFromScope (name: string): ScopeInfo | undefined {
    // First check the proper scope stack (this is the primary source of truth)
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].has(name)) {
        const scopeInfo = this.scopeStack[i].get(name)
        return scopeInfo
      }
    }

    // Then check the legacy scope tracking for useTranslation calls (for comment parsing)
    const legacyScope = this.scope.get(name)
    if (legacyScope) {
      return legacyScope
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
   */
  handleVariableDeclarator (node: VariableDeclarator): void {
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

        // ALSO store in the legacy scope for comment parsing compatibility
        this.handleUseTranslationForComments(node, callExpr, hookConfig)
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
   * Handles useTranslation calls for comment scope resolution.
   * This is a separate method to store scope info in the legacy scope map
   * that the comment parser can access.
   *
   * @param node - Variable declarator with useTranslation call
   * @param callExpr - The CallExpression node representing the useTranslation invocation
   * @param hookConfig - Configuration describing argument positions for namespace and keyPrefix
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
   */
  private handleUseTranslationForComments (node: VariableDeclarator, callExpr: CallExpression, hookConfig: UseTranslationHookConfig): void {
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

    // Extract namespace from useTranslation arguments
    const nsArg = callExpr.arguments?.[hookConfig.nsArg]?.expression
    const optionsArg = callExpr.arguments?.[hookConfig.keyPrefixArg]?.expression

    let defaultNs: string | undefined
    let keyPrefix: string | undefined

    // Parse namespace argument
    if (nsArg?.type === 'StringLiteral') {
      defaultNs = nsArg.value
    } else if (nsArg?.type === 'ArrayExpression' && nsArg.elements[0]?.expression.type === 'StringLiteral') {
      defaultNs = nsArg.elements[0].expression.value
    }

    // Parse keyPrefix from options object
    if (optionsArg?.type === 'ObjectExpression') {
      const keyPrefixProp = optionsArg.properties.find(
        prop => prop.type === 'KeyValueProperty' &&
                prop.key.type === 'Identifier' &&
                prop.key.value === 'keyPrefix'
      )
      if (keyPrefixProp?.type === 'KeyValueProperty' && keyPrefixProp.value.type === 'StringLiteral') {
        keyPrefix = keyPrefixProp.value.value
      }
    }

    // Store in the legacy scope map for comment parsing
    if (defaultNs || keyPrefix) {
      this.scope.set(variableName, { defaultNs, keyPrefix })
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
}
