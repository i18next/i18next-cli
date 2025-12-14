import type { CallExpression, ArrowFunctionExpression, ObjectExpression } from '@swc/core'
import type { PluginContext, I18nextToolkitConfig, Logger, ExtractedKey, ScopeInfo } from '../../types'
import { ExpressionResolver } from './expression-resolver'
import { getObjectPropValueExpression, getObjectPropValue, isSimpleTemplateLiteral } from './ast-utils'

// Helper to escape regex characters
const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export class CallExpressionHandler {
  private pluginContext: PluginContext
  private config: Omit<I18nextToolkitConfig, 'plugins'>
  private logger: Logger
  private expressionResolver: ExpressionResolver
  public objectKeys = new Set<string>()
  private getCurrentFile: () => string
  private getCurrentCode: () => string
  private lastSearchIndex: number = 0

  constructor (
    config: Omit<I18nextToolkitConfig, 'plugins'>,
    pluginContext: PluginContext,
    logger: Logger,
    expressionResolver: ExpressionResolver,
    getCurrentFile: () => string,
    getCurrentCode: () => string
  ) {
    this.config = config
    this.pluginContext = pluginContext
    this.logger = logger
    this.expressionResolver = expressionResolver
    this.getCurrentFile = getCurrentFile
    this.getCurrentCode = getCurrentCode
  }

  /**
   * Reset the search index when starting to process a new file.
   * This should be called before processing each file.
   */
  public resetSearchIndex (): void {
    this.lastSearchIndex = 0
  }

  /**
   * Helper method to calculate line and column from a position in the code.
   * Uses string searching instead of SWC span offsets to avoid accumulation bugs.
   */
  private getLocationFromNode (node: any): { line: number, column: number } | undefined {
    const code = this.getCurrentCode()

    // Extract searchable text from the node
    // For CallExpression, we can search for the key argument
    let searchText: string | undefined

    if (node.type === 'CallExpression' && node.arguments.length > 0) {
      const firstArg = node.arguments[0].expression

      if (firstArg.type === 'StringLiteral') {
        // Search for the string literal including quotes
        searchText = firstArg.raw ?? `'${firstArg.value}'`
      } else if (firstArg.type === 'TemplateLiteral') {
        // For template literals, search for the backtick
        searchText = '`'
      }
    }

    if (!searchText) return undefined

    // Search for the text starting from last known position
    const position = code.indexOf(searchText, this.lastSearchIndex)

    if (position === -1) {
      // Not found - might be a parsing issue, skip location tracking
      return undefined
    }

    // Update last search position for next search
    this.lastSearchIndex = position + searchText.length

    // Calculate line and column from the position
    const upToPosition = code.substring(0, position)
    const lines = upToPosition.split('\n')

    return {
      line: lines.length,
      column: lines[lines.length - 1].length
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
      } else if (arg2.type === 'TemplateLiteral' && isSimpleTemplateLiteral(arg2)) {
        defaultValue = arg2.quasis[0].cooked
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

    // Helper: detect if options object contains any defaultValue* properties
    const optionsHasDefaultProps = (opts?: ObjectExpression) => {
      if (!opts || !Array.isArray(opts.properties)) return false
      for (const p of opts.properties as any[]) {
        if (p && p.type === 'KeyValueProperty' && p.key) {
          const keyName = (p.key.type === 'Identifier' && p.key.value) || (p.key.type === 'StringLiteral' && p.key.value)
          if (typeof keyName === 'string' && keyName.startsWith('defaultValue')) return true
        }
      }
      return false
    }

    // explicit for base key when a string default was provided OR explicit plural defaults are present
    const explicitDefaultForBase = typeof finalDefaultValue === 'string' || optionsHasDefaultProps(options)
    // detect if options contain plural-specific defaultValue_* props
    const explicitPluralDefaultsInOptions = optionsHasDefaultProps(options)
    // If a base default string exists, consider it explicit for plural VARIANTS only when
    // it does NOT contain a count interpolation like '{{count}}' — templates with count
    // are often the runtime interpolation form and should NOT overwrite existing variant forms.
    const containsCountPlaceholder = (s?: string) => {
      if (typeof s !== 'string') return false
      const ip = this.config.extract.interpolationPrefix ?? '{{'
      const is = this.config.extract.interpolationSuffix ?? '}}'
      const re = new RegExp(`${escapeRegex(ip)}\\s*count\\s*${escapeRegex(is)}`)
      return re.test(s)
    }
    const explicitPluralForVariants = Boolean(explicitPluralDefaultsInOptions || (typeof finalDefaultValue === 'string' && !containsCountPlaceholder(finalDefaultValue)))

    // Loop through each key found (could be one or more) and process it
    for (let i = 0; i < keysToProcess.length; i++) {
      const originalKey = keysToProcess[i] // preserve original (possibly namespaced) form
      let key = keysToProcess[i]
      let ns: string | false | undefined

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
      // Use the original (possibly namespaced) key as the default when no explicit
      // default was provided and the source key contained a namespace prefix.
      const dv = isLastKey
        ? (typeof finalDefaultValue === 'string'
            ? finalDefaultValue
            : (nsSeparator && originalKey.includes(nsSeparator || ':') ? originalKey : key))
        : key

      // Handle plurals, context, and returnObjects
      if (options) {
        const contextPropValue = getObjectPropValueExpression(options, 'context')

        const keysWithContext: ExtractedKey[] = []

        // 1. Handle Context
        if (contextPropValue?.type === 'StringLiteral' || contextPropValue?.type === 'NumericLiteral' || contextPropValue?.type === 'BooleanLiteral') {
          // If the context is static, we don't need to add the base key
          const contextValue = `${contextPropValue.value}`

          const contextSeparator = this.config.extract.contextSeparator ?? '_'
          // Ignore context: ''
          if (contextValue !== '') {
            keysWithContext.push({ key: `${finalKey}${contextSeparator}${contextValue}`, ns, defaultValue: dv, explicitDefault: explicitDefaultForBase })
          }
        } else if (contextPropValue) {
          const contextValues = this.expressionResolver.resolvePossibleContextStringValues(contextPropValue)
          const contextSeparator = this.config.extract.contextSeparator ?? '_'

          if (contextValues.length > 0) {
            contextValues.forEach(context => {
              keysWithContext.push({ key: `${finalKey}${contextSeparator}${context}`, ns, defaultValue: dv, explicitDefault: explicitDefaultForBase })
            })
          }
          // For dynamic context, also add the base key as a fallback
          keysWithContext.push({
            key: finalKey,
            ns,
            defaultValue: dv,
            explicitDefault: explicitDefaultForBase,
            keyAcceptingContext: finalKey
          })
        }

        // 2. Handle Plurals
        // Robust detection for `{ count }`, `{ count: x }`, `{ 'count': x }` etc.
        // Support KeyValueProperty and common shorthand forms that SWC may emit.
        const propNameFromNode = (p: any): string | undefined => {
          if (!p) return undefined
          // Standard key:value property
          if (p.type === 'KeyValueProperty' && p.key) {
            if (p.key.type === 'Identifier') return p.key.value
            if (p.key.type === 'StringLiteral') return p.key.value
          }
          // SWC may represent shorthand properties differently (no explicit key node).
          // Try common shapes: property with `value` being an Identifier (shorthand).
          if (p.type === 'KeyValueProperty' && p.value && p.value.type === 'Identifier') {
            // e.g. { count: count } - already covered above, but keep safe fallback
            return p.key && p.key.type === 'Identifier' ? p.key.value : undefined
          }
          // Some AST variants use 'ShorthandProperty' or keep the Identifier directly.
          if ((p.type === 'ShorthandProperty' || p.type === 'Identifier') && (p as any).value) {
            return (p as any).value
          }
          // Fallback: if node has an 'id' or 'key' string value
          if (p.key && typeof p.key === 'string') return p.key
          return undefined
        }

        const hasCount = (() => {
          if (!options || !Array.isArray(options.properties)) return false
          for (const p of options.properties as any[]) {
            const name = propNameFromNode(p)
            if (name === 'count') return true
          }
          return false
        })()

        const isOrdinalByOption = (() => {
          if (!options || !Array.isArray(options.properties)) return false
          for (const p of options.properties as any[]) {
            const name = propNameFromNode(p)
            if (name === 'ordinal') {
              // If it's a key:value pair with a BooleanLiteral true, respect it.
              if (p.type === 'KeyValueProperty' && p.value && p.value.type === 'BooleanLiteral') {
                return Boolean(p.value.value)
              }
              // shorthand `ordinal` without explicit true -> treat as false
              return false
            }
          }
          return false
        })()
        if (hasCount || isOrdinalByKey) {
          // QUICK PATH: If ALL target locales only have the "other" category,
          // emit base/context keys directly (avoid generating *_other). This
          // mirrors the special-case in handlePluralKeys but is placed here as a
          // defensive guard to ensure keys are always emitted.
          try {
            const typeForCheck = isOrdinalByKey ? 'ordinal' : 'cardinal'
            // Prefer the configured primaryLanguage as the deciding signal for
            // "single-other" languages (ja/zh/ko). Fall back to union of locales.
            const primaryLang = this.config.extract?.primaryLanguage || (Array.isArray(this.config.locales) ? this.config.locales[0] : undefined) || 'en'
            let isSingleOther = false
            try {
              const primaryCategories = new Intl.PluralRules(primaryLang, { type: typeForCheck }).resolvedOptions().pluralCategories
              if (primaryCategories.length === 1 && primaryCategories[0] === 'other') {
                isSingleOther = true
              }
            } catch {
              // ignore and fall back to union-of-locales check below
            }

            if (!isSingleOther) {
              const allPluralCategoriesCheck = new Set<string>()
              for (const locale of this.config.locales) {
                try {
                  const rules = new Intl.PluralRules(locale, { type: typeForCheck })
                  rules.resolvedOptions().pluralCategories.forEach(c => allPluralCategoriesCheck.add(c))
                } catch {
                  new Intl.PluralRules('en', { type: typeForCheck }).resolvedOptions().pluralCategories.forEach(c => allPluralCategoriesCheck.add(c))
                }
              }
              const pluralCategoriesCheck = Array.from(allPluralCategoriesCheck).sort()
              if (pluralCategoriesCheck.length === 1 && pluralCategoriesCheck[0] === 'other') {
                isSingleOther = true
              }
            }

            if (isSingleOther) {
              // Emit only base/context keys (no _other) and skip the heavy plural path.
              if (keysWithContext.length > 0) {
                for (const k of keysWithContext) {
                  this.pluginContext.addKey({
                    key: k.key,
                    ns: k.ns,
                    defaultValue: k.defaultValue,
                    hasCount: true,
                    isOrdinal: isOrdinalByKey
                  })
                }
              } else {
                this.pluginContext.addKey({
                  key: finalKey,
                  ns,
                  defaultValue: dv,
                  hasCount: true,
                  isOrdinal: isOrdinalByKey
                })
              }
              continue
            }
          } catch (e) {
            // Ignore Intl failures here and fall through to normal logic
          }
          // Check if plurals are disabled
          if (this.config.extract.disablePlurals) {
            // When plurals are disabled, treat count as a regular option (for interpolation only)
            // Still handle context normally
            if (keysWithContext.length > 0) {
              keysWithContext.forEach(this.pluginContext.addKey)
            } else {
              this.pluginContext.addKey({ key: finalKey, ns, defaultValue: dv, explicitDefault: explicitDefaultForBase })
            }
          } else {
            // Original plural handling logic when plurals are enabled
            // Always pass the base key to handlePluralKeys - it will handle context internally.
            // Pass explicitDefaultForBase so that when a call-site provided an explicit
            // base default (e.g. t('key', 'Default', { count })), plural variant keys
            // are treated as explicit and may be synced to that default.
            this.handlePluralKeys(finalKey, ns, options, isOrdinalByOption || isOrdinalByKey, finalDefaultValue, explicitPluralForVariants)
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
      {
        // ✅ Use the helper method to find location by searching the code
        const location = this.getLocationFromNode(node)

        this.pluginContext.addKey({
          key: finalKey,
          ns,
          defaultValue: dv,
          explicitDefault: explicitDefaultForBase,
          locations: location
            ? [{
                file: this.getCurrentFile(),
                line: location.line,
                column: location.column
              }]
            : undefined
        })

        // Check for nested translations in the key itself
        this.extractNestedKeys(finalKey, ns)
      }

      // Check for nested translations in the default value
      if (typeof finalDefaultValue === 'string') {
        this.extractNestedKeys(finalDefaultValue, ns)
      }
    }
  }

  /**
   * Scans a string for nested translations like $t(key, options) and extracts them.
   */
  private extractNestedKeys (text: string, ns: string | false | undefined): void {
    if (!text || typeof text !== 'string') return

    const prefix = this.config.extract.nestingPrefix ?? '$t('
    const suffix = this.config.extract.nestingSuffix ?? ')'

    const escapedPrefix = escapeRegex(prefix)
    const escapedSuffix = escapeRegex(suffix)

    // Regex adapted from i18next Interpolator.js
    // Matches nested calls like $t(key) or $t(key, { options })
    // It handles balanced parentheses to some extent and quoted strings
    const nestingRegexp = new RegExp(
      `${escapedPrefix}((?:[^()"']+|"[^"]*"|'[^']*'|\\((?:[^()]|"[^"]*"|'[^']*')*\\))*?)${escapedSuffix}`,
      'g'
    )

    let match
    while ((match = nestingRegexp.exec(text)) !== null) {
      if (match[1]) {
        // Do NOT trust the outer `ns` blindly — compute namespace from the nested key itself
        // inside processNestedContent. Pass `undefined` so processNestedContent resolves ns
        // deterministically (either from key "ns:key" or from defaultNS).
        this.processNestedContent(match[1], undefined)
      }
    }
  }

  private processNestedContent (content: string, ns: string | false | undefined) {
    let key = content
    let optionsString = ''

    const separator = this.config.extract.nestingOptionsSeparator ?? ','

    // Logic adapted from i18next Interpolator.js handleHasOptions
    if (content.indexOf(separator) < 0) {
      key = content.trim()
    } else {
      // Split by separator, but be careful about objects
      // i18next does: const c = key.split(new RegExp(`${sep}[ ]*{`));
      // This assumes options start with {

      const sepRegex = new RegExp(`${escapeRegex(separator)}[ ]*{`)
      const parts = content.split(sepRegex)

      if (parts.length > 1) {
        key = parts[0].trim()
        // Reconstruct the options part: add back the '{' that was consumed by split
        optionsString = `{${parts.slice(1).join(separator + ' {')}`
      } else {
        // Fallback for simple split if no object pattern found
        const sepIdx = content.indexOf(separator)
        key = content.substring(0, sepIdx).trim()
        optionsString = content.substring(sepIdx + 1).trim()
      }
    }

    // Remove quotes from key if present
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1)
    }

    if (!key) return

    // Resolve namespace for the nested key:
    // If nested key contains nsSeparator (e.g. "ns:key"), extract namespace,
    // otherwise use configured defaultNS.
    let nestedNs: string | false | undefined
    const nsSeparator = this.config.extract.nsSeparator ?? ':'
    if (nsSeparator && key.includes(nsSeparator)) {
      const parts = key.split(nsSeparator)
      nestedNs = parts.shift()
      key = parts.join(nsSeparator)
      if (!key || key.trim() === '') return
    } else {
      nestedNs = this.config.extract.defaultNS
    }

    let hasCount = false
    let context: string | undefined

    if (optionsString) {
      // Simple regex check for count and context in the options string
      // This is an approximation since we don't have a full JSON parser here that handles JS objects perfectly
      // but it should cover most static cases.

      // Check for count: ...
      if (/['"]?count['"]?\s*:/.test(optionsString)) {
        hasCount = true
      }

      // Check for context: ...
      const contextMatch = /['"]?context['"]?\s*:\s*(['"])(.*?)\1/.exec(optionsString)
      if (contextMatch) {
        context = contextMatch[2]
      }
    }

    if (hasCount || context !== undefined) {
      this.generateNestedPluralKeys(key, nestedNs, hasCount, context)
    } else {
      this.pluginContext.addKey({ key, ns: nestedNs })
    }
  }

  private generateNestedPluralKeys (key: string, ns: string | false | undefined, hasCount: boolean, context: string | undefined) {
    try {
      const type = 'cardinal'

      // If only context, no plural
      if (!hasCount && context !== undefined) {
        this.pluginContext.addKey({ key, ns })
        this.pluginContext.addKey({ key: `${key}_${context}`, ns })
        return
      }

      // If hasCount, generate plurals
      const allPluralCategories = new Set<string>()
      const locales = this.config.locales || ['en']
      for (const locale of locales) {
        try {
          const pluralRules = new Intl.PluralRules(locale, { type })
          const categories = pluralRules.resolvedOptions().pluralCategories
          categories.forEach(cat => allPluralCategories.add(cat))
        } catch (e) {
          const englishRules = new Intl.PluralRules('en', { type })
          const categories = englishRules.resolvedOptions().pluralCategories
          categories.forEach(cat => allPluralCategories.add(cat))
        }
      }

      const pluralCategories = Array.from(allPluralCategories).sort()
      const pluralSeparator = this.config.extract.pluralSeparator ?? '_'
      const contextSeparator = this.config.extract.contextSeparator ?? '_'

      const primaryLang = this.config.extract?.primaryLanguage || (Array.isArray(this.config.locales) ? this.config.locales[0] : undefined) || 'en'
      let primaryIsSingleOther = false
      try {
        const primaryCats = new Intl.PluralRules(primaryLang, { type }).resolvedOptions().pluralCategories
        if (primaryCats.length === 1 && primaryCats[0] === 'other') primaryIsSingleOther = true
      } catch {
        primaryIsSingleOther = false
      }

      const isSingleOther = primaryIsSingleOther || (pluralCategories.length === 1 && pluralCategories[0] === 'other')

      const keysToGenerate: Array<{ key: string, context?: string }> = []

      if (context !== undefined) {
        keysToGenerate.push({ key, context })
      } else {
        keysToGenerate.push({ key })
      }

      if (isSingleOther) {
        for (const { key: baseKey, context } of keysToGenerate) {
          const finalKey = context ? `${baseKey}${contextSeparator}${context}` : baseKey
          this.pluginContext.addKey({ key: finalKey, ns, hasCount: true })
        }
        return
      }

      for (const { key: baseKey, context } of keysToGenerate) {
        for (const category of pluralCategories) {
          let finalKey: string
          if (context) {
            finalKey = `${baseKey}${contextSeparator}${context}${pluralSeparator}${category}`
          } else {
            finalKey = `${baseKey}${pluralSeparator}${category}`
          }
          this.pluginContext.addKey({ key: finalKey, ns, hasCount: true })
        }
      }
    } catch (e) {
      this.pluginContext.addKey({ key, ns })
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
  private handlePluralKeys (key: string, ns: string | false | undefined, options: ObjectExpression, isOrdinal: boolean, defaultValueFromCall?: string, explicitDefaultFromSource?: boolean): void {
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

      // Handle context - both static and dynamic
      const contextPropValue = getObjectPropValueExpression(options, 'context')
      const keysToGenerate: Array<{ key: string, context?: string }> = []

      if (contextPropValue) {
        // Handle dynamic context by resolving all possible values
        const contextValues = this.expressionResolver.resolvePossibleContextStringValues(contextPropValue)

        if (contextValues.length > 0) {
          // For static context (string literal), only generate context variants
          if (contextPropValue.type === 'StringLiteral') {
            // Only generate context-specific plural forms, no base forms
            for (const contextValue of contextValues) {
              if (contextValue.length > 0) {
                keysToGenerate.push({ key, context: contextValue })
              }
            }
          } else {
            // For dynamic context, generate context variants AND base forms
            for (const contextValue of contextValues) {
              if (contextValue.length > 0) {
                keysToGenerate.push({ key, context: contextValue })
              }
            }

            // Only generate base plural forms if generateBasePluralForms is not disabled
            const shouldGenerateBaseForms = this.config.extract?.generateBasePluralForms !== false
            if (shouldGenerateBaseForms) {
              keysToGenerate.push({ key })
            }
          }
        } else {
          // Couldn't resolve context, fall back to base key only
          keysToGenerate.push({ key })
        }
      } else {
        // No context, always generate base plural forms
        keysToGenerate.push({ key })
      }

      // If the only plural category across configured locales is "other",
      // prefer the base key (no "_other" suffix) as it's more natural for languages
      // with no grammatical plural forms (ja/zh/ko).
      // Prefer the configured primaryLanguage as signal for single-"other" languages.
      // If primaryLanguage indicates single-"other", treat as that case; otherwise
      // fall back to earlier union-of-locales check that produced `pluralCategories`.
      const primaryLang = this.config.extract?.primaryLanguage || (Array.isArray(this.config.locales) ? this.config.locales[0] : undefined) || 'en'
      let primaryIsSingleOther = false
      try {
        const primaryCats = new Intl.PluralRules(primaryLang, { type }).resolvedOptions().pluralCategories
        if (primaryCats.length === 1 && primaryCats[0] === 'other') primaryIsSingleOther = true
      } catch {
        primaryIsSingleOther = false
      }

      if (primaryIsSingleOther || (pluralCategories.length === 1 && pluralCategories[0] === 'other')) {
        for (const { key: baseKey, context } of keysToGenerate) {
          const specificOther = getObjectPropValue(options, `defaultValue${pluralSeparator}other`)
          // Final default resolution:
          // 1) plural-specific defaultValue_other
          // 2) general defaultValue (from options)
          // 3) defaultValueFromCall (string arg)
          // 4) fallback to key (or context-key for context variants)
          let finalDefaultValue: string | undefined
          if (typeof specificOther === 'string') {
            finalDefaultValue = specificOther
          } else if (typeof defaultValue === 'string') {
            finalDefaultValue = defaultValue
          } else if (typeof defaultValueFromCall === 'string') {
            finalDefaultValue = defaultValueFromCall
          } else {
            finalDefaultValue = context ? `${baseKey}_${context}` : baseKey
          }

          const ctxSep = this.config.extract.contextSeparator ?? '_'
          const finalKey = context ? `${baseKey}${ctxSep}${context}` : baseKey

          this.pluginContext.addKey({
            key: finalKey,
            ns,
            defaultValue: finalDefaultValue,
            hasCount: true,
            isOrdinal,
            explicitDefault: Boolean(explicitDefaultFromSource || typeof specificOther === 'string')
          })
        }
        return
      }

      // Generate plural forms for each key variant
      for (const { key: baseKey, context } of keysToGenerate) {
        for (const category of pluralCategories) {
          // 1. Look for the most specific default value
          const specificDefaultKey = isOrdinal ? `defaultValue${pluralSeparator}ordinal${pluralSeparator}${category}` : `defaultValue${pluralSeparator}${category}`
          const specificDefault = getObjectPropValue(options, specificDefaultKey)

          // 2. Determine the final default value using the ORIGINAL fallback chain with corrections
          let finalDefaultValue: string | undefined
          if (typeof specificDefault === 'string') {
            // Most specific: defaultValue_one, defaultValue_ordinal_other, etc.
            finalDefaultValue = specificDefault
          } else if (category === 'one' && typeof defaultValue === 'string') {
            // For "one" category, prefer the general defaultValue
            finalDefaultValue = defaultValue
          } else if (category === 'one' && typeof defaultValueFromCall === 'string') {
            // For "one" category, also consider defaultValueFromCall
            finalDefaultValue = defaultValueFromCall
          } else if (isOrdinal && typeof ordinalOtherDefault === 'string') {
            // For ordinals (non-one categories), fall back to ordinal_other
            finalDefaultValue = ordinalOtherDefault
          } else if (!isOrdinal && typeof otherDefault === 'string') {
            // For cardinals (non-one categories), fall back to _other
            finalDefaultValue = otherDefault
          } else if (typeof defaultValue === 'string') {
            // General defaultValue as fallback
            finalDefaultValue = defaultValue
          } else if (typeof defaultValueFromCall === 'string') {
            // defaultValueFromCall as fallback
            finalDefaultValue = defaultValueFromCall
          } else {
            // Final fallback to the base key itself
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
            isOrdinal,
            // Only treat plural/context variant as explicit when:
            // - the extractor marked the source as explicitly providing plural defaults
            // - OR a plural-specific default was provided in the options (specificDefault/otherDefault)
            // Do NOT treat the presence of a general base defaultValueFromCall as making variants explicit.
            explicitDefault: Boolean(explicitDefaultFromSource || typeof specificDefault === 'string' || typeof otherDefault === 'string'),
            // If this is a context variant, track the base key (without context or plural suffixes)
            keyAcceptingContext: context !== undefined ? key : undefined
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
