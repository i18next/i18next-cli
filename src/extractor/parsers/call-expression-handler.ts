import type { CallExpression, ArrowFunctionExpression, ObjectExpression } from '@swc/core'
import type { PluginContext, I18nextToolkitConfig, Logger, ExtractedKey, ScopeInfo } from '../../types'
import { ExpressionResolver } from './expression-resolver'
import { getObjectProperty, getObjectPropValue } from './ast-utils'

export class CallExpressionHandler {
  private pluginContext: PluginContext
  private config: Omit<I18nextToolkitConfig, 'plugins'>
  private logger: Logger
  private expressionResolver: ExpressionResolver
  public objectKeys = new Set<string>()

  constructor (
    config: Omit<I18nextToolkitConfig, 'plugins'>,
    pluginContext: PluginContext,
    logger: Logger,
    expressionResolver: ExpressionResolver
  ) {
    this.config = config
    this.pluginContext = pluginContext
    this.logger = logger
    this.expressionResolver = expressionResolver
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
   * @param getScopeInfo - Function to retrieve scope information for variables
   */
  handleCallExpression (node: CallExpression, getScopeInfo: (name: string) => ScopeInfo | undefined): void {
    const functionName = this.getFunctionName(node.callee)
    if (!functionName) return

    // The scope lookup will only work for simple identifiers, which is okay for this fix.
    const scopeInfo = getScopeInfo(functionName)
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

    const { keysToProcess, isSelectorAPI } = this.handleCallExpressionArgument(node, 0)

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

      // Determine namespace (explicit ns > ns:key > scope ns > default)
      // See https://www.i18next.com/overview/api#getfixedt
      if (options) {
        const nsVal = getObjectPropValue(options, 'ns')
        if (typeof nsVal === 'string') ns = nsVal
      }

      const nsSeparator = this.config.extract.nsSeparator ?? ':'
      if (!ns && nsSeparator && key.includes(nsSeparator)) {
        const parts = key.split(nsSeparator)
        ns = parts.shift()
        key = parts.join(nsSeparator)

        if (!key || key.trim() === '') {
          this.logger.warn(`Skipping key that became empty after namespace removal: '${ns}${nsSeparator}'`)
          continue
        }
      }

      if (!ns && scopeInfo?.defaultNs) ns = scopeInfo.defaultNs
      if (!ns) ns = this.config.extract.defaultNS

      let finalKey = key

      // Apply keyPrefix AFTER namespace extraction
      if (scopeInfo?.keyPrefix) {
        const keySeparator = this.config.extract.keySeparator ?? '.'

        // Apply keyPrefix - handle case where keyPrefix already ends with separator
        if (keySeparator !== false) {
          if (scopeInfo.keyPrefix.endsWith(keySeparator)) {
            finalKey = `${scopeInfo.keyPrefix}${key}`
          } else {
            finalKey = `${scopeInfo.keyPrefix}${keySeparator}${key}`
          }
        } else {
          finalKey = `${scopeInfo.keyPrefix}${key}`
        }

        // Validate keyPrefix combinations that create problematic keys
        if (keySeparator !== false) {
          // Check for patterns that would create empty segments in the nested key structure
          const segments = finalKey.split(keySeparator)
          const hasEmptySegment = segments.some(segment => segment.trim() === '')

          if (hasEmptySegment) {
            this.logger.warn(`Skipping key with empty segments: '${finalKey}' (keyPrefix: '${scopeInfo.keyPrefix}', key: '${key}')`)
            continue
          }
        }
      }

      const isLastKey = i === keysToProcess.length - 1
      const dv = isLastKey ? (finalDefaultValue || key) : key

      // Handle plurals, context, and returnObjects
      if (options) {
        const contextProp = getObjectProperty(options, 'context')

        const keysWithContext: ExtractedKey[] = []

        // 1. Handle Context
        if (contextProp?.value?.type === 'StringLiteral' || contextProp?.value.type === 'NumericLiteral' || contextProp?.value.type === 'BooleanLiteral') {
          // If the context is static, we don't need to add the base key
          const contextValue = `${contextProp.value.value}`

          const contextSeparator = this.config.extract.contextSeparator ?? '_'
          // Ignore context: ''
          if (contextValue !== '') {
            keysWithContext.push({ key: `${finalKey}${contextSeparator}${contextValue}`, ns, defaultValue: dv })
          }
        } else if (contextProp?.value) {
          const contextValues = this.expressionResolver.resolvePossibleContextStringValues(contextProp.value)
          const contextSeparator = this.config.extract.contextSeparator ?? '_'

          if (contextValues.length > 0) {
            contextValues.forEach(context => {
              keysWithContext.push({ key: `${finalKey}${contextSeparator}${context}`, ns, defaultValue: dv })
            })
            // For dynamic context, also add the base key as a fallback
            keysWithContext.push({ key: finalKey, ns, defaultValue: dv })
          }
        }

        // 2. Handle Plurals
        const hasCount = getObjectPropValue(options, 'count') !== undefined
        const isOrdinalByOption = getObjectPropValue(options, 'ordinal') === true
        if (hasCount || isOrdinalByKey) {
          // Check if plurals are disabled
          if (this.config.extract.disablePlurals) {
            // When plurals are disabled, treat count as a regular option (for interpolation only)
            // Still handle context normally
            if (keysWithContext.length > 0) {
              keysWithContext.forEach(this.pluginContext.addKey)
            } else {
              this.pluginContext.addKey({ key: finalKey, ns, defaultValue: dv })
            }
          } else {
            // Original plural handling logic when plurals are enabled
            // Always pass the base key to handlePluralKeys - it will handle context internally
            this.handlePluralKeys(finalKey, ns, options, isOrdinalByOption || isOrdinalByKey, finalDefaultValue)
          }

          continue // This key is fully handled
        }

        if (keysWithContext.length > 0) {
          keysWithContext.forEach(this.pluginContext.addKey)

          continue // This key is now fully handled
        }

        // 3. Handle returnObjects
        if (getObjectPropValue(options, 'returnObjects') === true) {
          this.objectKeys.add(finalKey)
          // Fall through to add the base key itself
        }
      }

      // 4. Handle selector API as implicit returnObjects
      if (isSelectorAPI) {
        this.objectKeys.add(finalKey)
        // Fall through to add the base key itself
      }

      // 5. Default case: Add the simple key
      this.pluginContext.addKey({ key: finalKey, ns, defaultValue: dv })
    }
  }

  /**
   * Processed a call expression to extract keys from the specified argument.
   *
   * @param node - The call expression node
   * @param argIndex - The index of the argument to process
   * @returns An object containing the keys to process and a flag indicating if the selector API is used
   */
  private handleCallExpressionArgument (
    node: CallExpression,
    argIndex: number
  ): { keysToProcess: string[]; isSelectorAPI: boolean } {
    const firstArg = node.arguments[argIndex].expression
    const keysToProcess: string[] = []
    let isSelectorAPI = false

    if (firstArg.type === 'ArrowFunctionExpression') {
      const key = this.extractKeyFromSelector(firstArg)
      if (key) {
        keysToProcess.push(key)
        isSelectorAPI = true
      }
    } else if (firstArg.type === 'ArrayExpression') {
      for (const element of firstArg.elements) {
        if (element?.expression) {
          keysToProcess.push(...this.expressionResolver.resolvePossibleKeyStringValues(element.expression))
        }
      }
    } else {
      keysToProcess.push(...this.expressionResolver.resolvePossibleKeyStringValues(firstArg))
    }

    return {
      keysToProcess: keysToProcess.filter((key) => !!key),
      isSelectorAPI,
    }
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
   */
  private handlePluralKeys (key: string, ns: string | undefined, options: ObjectExpression, isOrdinal: boolean, defaultValueFromCall?: string): void {
    try {
      const type = isOrdinal ? 'ordinal' : 'cardinal'

      // Generate plural forms for ALL target languages to ensure we have all necessary keys
      const allPluralCategories = new Set<string>()

      for (const locale of this.config.locales) {
        try {
          const pluralRules = new Intl.PluralRules(locale, { type })
          const categories = pluralRules.resolvedOptions().pluralCategories
          categories.forEach(cat => allPluralCategories.add(cat))
        } catch (e) {
          // If a locale is invalid, fall back to English rules
          const englishRules = new Intl.PluralRules('en', { type })
          const categories = englishRules.resolvedOptions().pluralCategories
          categories.forEach(cat => allPluralCategories.add(cat))
        }
      }

      const pluralCategories = Array.from(allPluralCategories).sort()
      const pluralSeparator = this.config.extract.pluralSeparator ?? '_'

      // Get all possible default values once at the start
      const defaultValue = getObjectPropValue(options, 'defaultValue')
      const otherDefault = getObjectPropValue(options, `defaultValue${pluralSeparator}other`)
      const ordinalOtherDefault = getObjectPropValue(options, `defaultValue${pluralSeparator}ordinal${pluralSeparator}other`)

      // Get the count value and determine target category if available
      const countValue = getObjectPropValue(options, 'count')
      let targetCategory: string | undefined

      if (typeof countValue === 'number') {
        try {
          const primaryLanguage = this.config.extract?.primaryLanguage || this.config.locales[0] || 'en'
          const pluralRules = new Intl.PluralRules(primaryLanguage, { type })
          targetCategory = pluralRules.select(countValue)
        } catch (e) {
          // If we can't determine the category, continue with normal logic
        }
      }

      // Handle context - both static and dynamic
      const contextProp = getObjectProperty(options, 'context')
      const keysToGenerate: Array<{ key: string, context?: string }> = []

      if (contextProp?.value) {
        // Handle dynamic context by resolving all possible values
        const contextValues = this.expressionResolver.resolvePossibleContextStringValues(contextProp.value)

        if (contextValues.length > 0) {
          // Generate keys for each context value
          for (const contextValue of contextValues) {
            if (contextValue.length > 0) {
              keysToGenerate.push({ key, context: contextValue })
            }
          }

          // For dynamic context, also generate base plural forms if generateBasePluralForms is not disabled
          const shouldGenerateBaseForms = this.config.extract?.generateBasePluralForms !== false
          if (shouldGenerateBaseForms) {
            keysToGenerate.push({ key })
          }
        } else {
          // Couldn't resolve context, fall back to base key only
          keysToGenerate.push({ key })
        }
      } else {
        // No context, always generate base plural forms
        keysToGenerate.push({ key })
      }

      // Generate plural forms for each key variant
      for (const { key: baseKey, context } of keysToGenerate) {
        for (const category of pluralCategories) {
          // 1. Look for the most specific default value
          const specificDefaultKey = isOrdinal ? `defaultValue${pluralSeparator}ordinal${pluralSeparator}${category}` : `defaultValue${pluralSeparator}${category}`
          const specificDefault = getObjectPropValue(options, specificDefaultKey)

          // 2. Determine the final default value using a clear fallback chain
          let finalDefaultValue: string | undefined
          if (typeof specificDefault === 'string') {
            finalDefaultValue = specificDefault
          } else if (category === 'one' && typeof defaultValue === 'string') {
            finalDefaultValue = defaultValue
          } else if (isOrdinal && typeof ordinalOtherDefault === 'string') {
            finalDefaultValue = ordinalOtherDefault
          } else if (!isOrdinal && typeof otherDefault === 'string') {
            finalDefaultValue = otherDefault
          } else if (typeof defaultValue === 'string') {
            finalDefaultValue = defaultValue
          } else if (defaultValueFromCall && targetCategory === category) {
            finalDefaultValue = defaultValueFromCall
          } else {
            finalDefaultValue = baseKey
          }

          // 3. Construct the final plural key
          let finalKey: string
          if (context) {
            const contextSeparator = this.config.extract.contextSeparator ?? '_'
            finalKey = isOrdinal
              ? `${baseKey}${contextSeparator}${context}${pluralSeparator}ordinal${pluralSeparator}${category}`
              : `${baseKey}${contextSeparator}${context}${pluralSeparator}${category}`
          } else {
            finalKey = isOrdinal
              ? `${baseKey}${pluralSeparator}ordinal${pluralSeparator}${category}`
              : `${baseKey}${pluralSeparator}${category}`
          }

          this.pluginContext.addKey({
            key: finalKey,
            ns,
            defaultValue: finalDefaultValue,
            hasCount: true,
            isOrdinal
          })
        }
      }
    } catch (e) {
      this.logger.warn(`Could not determine plural rules for language "${this.config.extract?.primaryLanguage}". Falling back to simple key extraction.`)
      // Fallback to a simple key if Intl API fails
      const defaultValue = defaultValueFromCall || getObjectPropValue(options, 'defaultValue')
      this.pluginContext.addKey({ key, ns, defaultValue: typeof defaultValue === 'string' ? defaultValue : key })
    }
  }

  /**
   * Serializes a callee node (Identifier or MemberExpression) into a string.
   *
   * Produces a dotted name for simple callees that can be used for scope lookups
   * or configuration matching.
   *
   * @param callee - The CallExpression callee node to serialize
   * @returns A dotted string name for supported callees, or null when the callee
   *          is a computed/unsupported expression.
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
