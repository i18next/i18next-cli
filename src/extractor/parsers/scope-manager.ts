import type { VariableDeclarator, CallExpression, TemplateLiteral } from '@swc/core'
import type { ScopeInfo, UseTranslationHookConfig, I18nextToolkitConfig } from '../../types'
import { getObjectPropValue } from './ast-utils'

export class ScopeManager {
  private scopeStack: Array<Map<string, ScopeInfo>> = []
  private config: Omit<I18nextToolkitConfig, 'plugins'>
  private scope: Map<string, { defaultNs?: string; keyPrefix?: string }> = new Map()

  // Track simple local constants with string literal values to resolve identifier args
  private simpleConstants: Map<string, string> = new Map()

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
    this.simpleConstants.clear()
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
    } else {
      // No active scope (top-level). Preserve in legacy scope map so lookups work
      // for top-level variables (e.g., const { getFixedT } = useTranslate(...))
      this.scope.set(name, info)
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
   * Resolve simple identifier declared in-file to its string literal value, if known.
   */
  private resolveSimpleStringIdentifier (name: string): string | undefined {
    return this.simpleConstants.get(name)
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

    // Record simple const/let string initializers for later resolution
    if (node.id.type === 'Identifier' && init.type === 'StringLiteral') {
      this.simpleConstants.set(node.id.value, init.value)
      // continue processing; still may be a useTranslation/getFixedT call below
    }

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

    // Handle: const t = getFixedT(...) where getFixedT is a previously declared variable
    // (e.g., `const { getFixedT } = useTranslate('helloservice')`)
    if (callee.type === 'Identifier') {
      const sourceScope = this.getVarFromScope(callee.value)
      if (sourceScope) {
        // Propagate the source scope (keyPrefix/defaultNs) and augment it with
        // arguments passed to this call (e.g., namespace argument).
        this.handleGetFixedTFromVariableDeclarator(node, callExpr, callee.value)
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
        // Support both 't' and 'getFixedT' (and preserve existing behavior for 't').
        if (prop.type === 'AssignmentPatternProperty' && prop.key.type === 'Identifier' && (prop.key.value === 't' || prop.key.value === 'getFixedT')) {
          variableName = prop.key.value
          break
        }
        if (prop.type === 'KeyValuePatternProperty' && prop.key.type === 'Identifier' && (prop.key.value === 't' || prop.key.value === 'getFixedT') && prop.value.type === 'Identifier') {
          variableName = prop.value.value
          break
        }
      }
    }

    // If we couldn't find a `t` function being declared, exit
    if (!variableName) return

    // Position-driven extraction: respect hookConfig positions (nsArg/keyPrefixArg).
    // nsArg === -1 means "no namespace arg"; keyPrefixArg === -1 means "no keyPrefix arg".
    const nsArgIndex = hookConfig.nsArg ?? 0
    const kpArgIndex = hookConfig.keyPrefixArg ?? 1

    let defaultNs: string | undefined
    let keyPrefix: string | undefined

    // Early detection of react-i18next common form: useTranslation(lng, ns)
    // Only apply for the built-in hook name to avoid interfering with custom hooks.
    const first = callExpr.arguments?.[0]?.expression
    const second = callExpr.arguments?.[1]?.expression
    const third = callExpr.arguments?.[2]?.expression
    const looksLikeLanguage = (s: string) => /^[a-z]{2,3}([-_][A-Za-z0-9-]+)?$/i.test(s)
    const isBuiltInLngNsForm = hookConfig.name === 'useTranslation' &&
      first?.type === 'StringLiteral' &&
      second?.type === 'StringLiteral' &&
      looksLikeLanguage(first.value)

    let kpArg
    if (isBuiltInLngNsForm) {
      // treat as useTranslation(lng, ns, [options])
      defaultNs = second.value
      // prefer third arg as keyPrefix (may be undefined)
      kpArg = third
    } else {
      // Position-driven extraction: respect hookConfig positions (nsArg/keyPrefixArg).
      if (nsArgIndex !== -1) {
        const nsNode = callExpr.arguments?.[nsArgIndex]?.expression
        if (nsNode?.type === 'StringLiteral') {
          defaultNs = nsNode.value
        } else if (nsNode?.type === 'ArrayExpression' && nsNode.elements[0]?.expression?.type === 'StringLiteral') {
          defaultNs = nsNode.elements[0].expression.value
        }
      }
      kpArg = kpArgIndex === -1 ? undefined : callExpr.arguments?.[kpArgIndex]?.expression
    }

    if (kpArg?.type === 'ObjectExpression') {
      const kp = getObjectPropValue(kpArg, 'keyPrefix')
      keyPrefix = typeof kp === 'string' ? kp : undefined
    } else if (kpArg?.type === 'StringLiteral') {
      keyPrefix = kpArg.value
    } else if (kpArg?.type === 'Identifier') {
      keyPrefix = this.resolveSimpleStringIdentifier(kpArg.value)
    } else if (kpArg?.type === 'TemplateLiteral') {
      const tpl = kpArg as TemplateLiteral
      if ((tpl.expressions || []).length === 0) {
        keyPrefix = tpl.quasis?.[0]?.cooked ?? undefined
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
    // Position-driven extraction: respect hookConfig positions (nsArg/keyPrefixArg).
    const nsArgIndex = hookConfig.nsArg ?? 0
    const kpArgIndex = hookConfig.keyPrefixArg ?? 1

    let defaultNs: string | undefined
    let keyPrefix: string | undefined

    // Early detect useTranslation(lng, ns) for built-in hook name only
    const first = callExpr.arguments?.[0]?.expression
    const second = callExpr.arguments?.[1]?.expression
    const third = callExpr.arguments?.[2]?.expression
    const looksLikeLanguage = (s: string) => /^[a-z]{2,3}([-_][A-Za-z0-9-]+)?$/i.test(s)
    const isBuiltInLngNsForm = hookConfig.name === 'useTranslation' &&
      first?.type === 'StringLiteral' &&
      second?.type === 'StringLiteral' &&
      looksLikeLanguage(first.value)

    let kpArg
    if (isBuiltInLngNsForm) {
      defaultNs = second.value
      kpArg = third
    } else {
      if (nsArgIndex !== -1) {
        const nsNode = callExpr.arguments?.[nsArgIndex]?.expression
        if (nsNode?.type === 'StringLiteral') defaultNs = nsNode.value
        else if (nsNode?.type === 'ArrayExpression' && nsNode.elements[0]?.expression?.type === 'StringLiteral') {
          defaultNs = nsNode.elements[0].expression.value
        }
      }
      kpArg = kpArgIndex === -1 ? undefined : callExpr.arguments?.[kpArgIndex]?.expression
    }

    if (kpArg?.type === 'ObjectExpression') {
      const kp = getObjectPropValue(kpArg, 'keyPrefix')
      keyPrefix = typeof kp === 'string' ? kp : undefined
    } else if (kpArg?.type === 'StringLiteral') {
      keyPrefix = kpArg.value
    } else if (kpArg?.type === 'Identifier') {
      keyPrefix = this.resolveSimpleStringIdentifier(kpArg.value)
    } else if (kpArg?.type === 'TemplateLiteral') {
      const tpl = kpArg as TemplateLiteral
      if ((tpl.expressions || []).length === 0) {
        keyPrefix = tpl.quasis?.[0]?.cooked ?? undefined
      }
    }

    // Attach scope info to all destructured properties (custom functions, t, getFixedT, etc.)
    if (node.id.type === 'ObjectPattern') {
      for (const prop of node.id.properties) {
        if (prop.type === 'AssignmentPatternProperty' && prop.key.type === 'Identifier') {
          this.setVarInScope(prop.key.value, { defaultNs, keyPrefix })
        }
        if (prop.type === 'KeyValuePatternProperty' && prop.value.type === 'Identifier') {
          this.setVarInScope(prop.value.value, { defaultNs, keyPrefix })
        }
      }
    } else if (node.id.type === 'Identifier') {
      this.setVarInScope(node.id.value, { defaultNs, keyPrefix })
    } else if (node.id.type === 'ArrayPattern') {
      const firstElement = node.id.elements[0]
      if (firstElement?.type === 'Identifier') {
        this.setVarInScope(firstElement.value, { defaultNs, keyPrefix })
      }
    }
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

  /**
   * Handles cases where a getFixedT-like function is a variable (from a custom hook)
   * and is invoked to produce a bound `t` function, e.g.:
   *   const { getFixedT } = useTranslate('prefix')
   *   const t = getFixedT('en', 'ns')
   *
   * We combine the original source variable's scope (keyPrefix/defaultNs) with
   * any namespace/keyPrefix arguments provided to this call and attach the
   * resulting scope to the newly declared variable.
   */
  private handleGetFixedTFromVariableDeclarator (node: VariableDeclarator, callExpr: CallExpression, sourceVarName: string): void {
    if (node.id.type !== 'Identifier') return

    const targetVarName = node.id.value
    const sourceScope = this.getVarFromScope(sourceVarName)
    if (!sourceScope) return

    const args = callExpr.arguments
    // getFixedT(lng, ns, keyPrefix)
    const nsArg = args[1]?.expression
    const keyPrefixArg = args[2]?.expression

    const nsFromCall = (nsArg?.type === 'StringLiteral') ? nsArg.value : undefined
    const keyPrefixFromCall = (keyPrefixArg?.type === 'StringLiteral') ? keyPrefixArg.value : undefined

    // Merge: call args take precedence over source scope values
    const finalNs = nsFromCall ?? sourceScope.defaultNs
    const finalKeyPrefix = keyPrefixFromCall ?? sourceScope.keyPrefix

    if (finalNs || finalKeyPrefix) {
      this.setVarInScope(targetVarName, { defaultNs: finalNs, keyPrefix: finalKeyPrefix })
    }
  }
}
