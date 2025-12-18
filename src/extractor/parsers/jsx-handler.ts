import type { JSXElement, ObjectExpression } from '@swc/core'
import type { PluginContext, I18nextToolkitConfig, ExtractedKey } from '../../types'
import { ExpressionResolver } from './expression-resolver'
import { extractFromTransComponent } from './jsx-parser'
import { getObjectPropValue } from './ast-utils'

export class JSXHandler {
  private config: Omit<I18nextToolkitConfig, 'plugins'>
  private pluginContext: PluginContext
  private expressionResolver: ExpressionResolver
  private getCurrentFile: () => string
  private getCurrentCode: () => string
  private lastSearchIndex: number = 0

  constructor (
    config: Omit<I18nextToolkitConfig, 'plugins'>,
    pluginContext: PluginContext,
    expressionResolver: ExpressionResolver,
    getCurrentFile: () => string,
    getCurrentCode: () => string
  ) {
    this.config = config
    this.pluginContext = pluginContext
    this.expressionResolver = expressionResolver
    this.getCurrentFile = getCurrentFile
    this.getCurrentCode = getCurrentCode
  }

  /**
   * Reset the search index when starting to process a new file.
   */
  public resetSearchIndex (): void {
    this.lastSearchIndex = 0
  }

  /**
   * Helper method to calculate line and column by searching for the JSX element in the code.
   */
  private getLocationFromNode (node: any): { line: number, column: number } | undefined {
    const code = this.getCurrentCode()

    // For JSXElement, search for the opening tag
    let searchText: string | undefined

    if (node.type === 'JSXElement' && node.opening) {
      const tagName = node.opening.name?.value
      if (tagName) {
        searchText = `<${tagName}`
      }
    }

    if (!searchText) return undefined

    const position = code.indexOf(searchText, this.lastSearchIndex)

    if (position === -1) return undefined

    this.lastSearchIndex = position + searchText.length

    const upToPosition = code.substring(0, position)
    const lines = upToPosition.split('\n')

    return {
      line: lines.length,
      column: lines[lines.length - 1].length
    }
  }

  /**
   * Processes JSX elements to extract translation keys from Trans components.
   *
   * Identifies configured Trans components and delegates to the JSX parser
   * for complex children serialization and attribute extraction.
   *
   * @param node - JSX element node to process
   * @param getScopeInfo - Function to retrieve scope information for variables
   */
  handleJSXElement (node: JSXElement, getScopeInfo: (name: string) => { defaultNs?: string; keyPrefix?: string } | undefined): void {
    const elementName = this.getElementName(node)

    if (elementName && (this.config.extract.transComponents || ['Trans']).includes(elementName)) {
      let extractedAttributes: ReturnType<typeof extractFromTransComponent> | null = null

      try {
        extractedAttributes = extractFromTransComponent(node, this.config as any)
      } catch (err) {
        const loc = this.getLocationFromNode(node)
        const where = loc
          ? `${this.getCurrentFile()}:${loc.line}:${loc.column}`
          : this.getCurrentFile()

        const message =
          err instanceof Error
            ? err.message
            : (typeof err === 'string' ? err : '') || String(err)

        // Prefer any logger that might exist on pluginContext, else fall back to console.
        const warn =
          (this.pluginContext as any)?.logger?.warn?.bind((this.pluginContext as any).logger) ??
          console.warn.bind(console)

        warn(`Failed to extract <${elementName}> at ${where}`)
        warn(`  ${message}`)

        // IMPORTANT: do not rethrow; keep visiting the rest of the file
        return
      }

      const keysToProcess: string[] = []

      if (extractedAttributes) {
        if (extractedAttributes.keyExpression) {
          const keyValues = this.expressionResolver.resolvePossibleKeyStringValues(extractedAttributes.keyExpression)
          keysToProcess.push(...keyValues)
        } else {
          keysToProcess.push(extractedAttributes.serializedChildren)
        }

        let extractedKeys: ExtractedKey[]

        const { contextExpression, optionsNode, defaultValue, hasCount, isOrdinal, serializedChildren } = extractedAttributes

        // Extract location information using the helper method
        const location = this.getLocationFromNode(node)
        const locations = location
          ? [{
              file: this.getCurrentFile(),
              line: location.line,
              column: location.column
            }]
          : undefined

        // If ns is not explicitly set on the component, try to find it from the key
        // or the `t` prop
        if (!extractedAttributes.ns) {
          extractedKeys = keysToProcess.map(key => {
            const nsSeparator = this.config.extract.nsSeparator ?? ':'
            let ns: string | undefined

            // If the key contains a namespace separator, it takes precedence
            // over the default t ns value
            if (nsSeparator && key.includes(nsSeparator)) {
              let parts: string[]
              ([ns, ...parts] = key.split(nsSeparator))

              key = parts.join(nsSeparator)
            }

            return {
              key,
              ns,
              defaultValue: defaultValue || serializedChildren,
              hasCount,
              isOrdinal,
              explicitDefault: extractedAttributes.explicitDefault,
              locations
            }
          })

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
            const scopeInfo = getScopeInfo(tIdentifier)
            if (scopeInfo?.defaultNs) {
              extractedKeys.forEach(key => {
                if (!key.ns) {
                  key.ns = scopeInfo.defaultNs
                }
              })
            }

            // APPLY keyPrefix from useTranslation to Trans component keys
            if (scopeInfo?.keyPrefix) {
              const keySeparator = this.config.extract.keySeparator ?? '.'
              for (const ek of extractedKeys) {
                // only apply prefix to keys that don't already contain a namespace (ek.key is already namespace-stripped)
                let finalKey = ek.key
                if (keySeparator !== false) {
                  if (String(scopeInfo.keyPrefix).endsWith(String(keySeparator))) {
                    finalKey = `${scopeInfo.keyPrefix}${finalKey}`
                  } else {
                    finalKey = `${scopeInfo.keyPrefix}${keySeparator}${finalKey}`
                  }
                } else {
                  finalKey = `${scopeInfo.keyPrefix}${finalKey}`
                }

                // validate result does not create empty segments (robustness)
                if (keySeparator !== false) {
                  const segments = String(finalKey).split(String(keySeparator))
                  if (segments.some(segment => segment.trim() === '')) {
                    // this.logger?.warn?.(`Skipping applying keyPrefix due to empty segment: keyPrefix='${scopeInfo.keyPrefix}', key='${ek.key}'`)
                    continue
                  }
                }

                ek.key = finalKey
              }
            }
          }
        } else {
          const { ns } = extractedAttributes
          extractedKeys = keysToProcess.map(key => {
            return {
              key,
              ns,
              defaultValue: defaultValue || serializedChildren,
              hasCount,
              isOrdinal,
              locations
            }
          })
        }

        extractedKeys.forEach(key => {
          // Apply defaultNS from config if no namespace was found on the component and
          // the key does not contain a namespace prefix
          if (!key.ns) {
            key.ns = this.config.extract.defaultNS
          }
        })

        // Handle the combination of context and count
        if (contextExpression && hasCount) {
          // Check if plurals are disabled
          if (this.config.extract.disablePlurals) {
            // When plurals are disabled, treat count as a regular option
            // Still handle context normally
            const contextValues = this.expressionResolver.resolvePossibleContextStringValues(contextExpression)
            const contextSeparator = this.config.extract.contextSeparator ?? '_'

            if (contextValues.length > 0) {
              // For static context (string literal), only add context variants
              if (contextExpression.type === 'StringLiteral') {
                for (const context of contextValues) {
                  for (const extractedKey of extractedKeys) {
                    const contextKey = `${extractedKey.key}${contextSeparator}${context}`
                    this.pluginContext.addKey({
                      key: contextKey,
                      ns: extractedKey.ns,
                      defaultValue: extractedKey.defaultValue,
                      locations: extractedKey.locations
                    })
                  }
                }
              } else {
                // For dynamic context, add both base and context variants
                extractedKeys.forEach(extractedKey => {
                  this.pluginContext.addKey({
                    key: extractedKey.key,
                    ns: extractedKey.ns,
                    defaultValue: extractedKey.defaultValue,
                    locations: extractedKey.locations,
                    keyAcceptingContext: extractedKey.key
                  })
                })
                for (const context of contextValues) {
                  for (const extractedKey of extractedKeys) {
                    const contextKey = `${extractedKey.key}${contextSeparator}${context}`
                    this.pluginContext.addKey({
                      key: contextKey,
                      ns: extractedKey.ns,
                      defaultValue: extractedKey.defaultValue,
                      locations: extractedKey.locations
                    })
                  }
                }
              }
            } else {
              // Fallback to just base keys if context resolution fails
              extractedKeys.forEach(extractedKey => {
                this.pluginContext.addKey({
                  key: extractedKey.key,
                  ns: extractedKey.ns,
                  defaultValue: extractedKey.defaultValue,
                  locations: extractedKey.locations,
                  keyAcceptingContext: extractedKey.key
                })
              })
            }
          } else {
            // Original plural handling logic when plurals are enabled
            // Find isOrdinal prop on the <Trans> component
            const ordinalAttr = node.opening.attributes?.find(
              (attr) =>
                attr.type === 'JSXAttribute' &&
                attr.name.type === 'Identifier' &&
                attr.name.value === 'ordinal'
            )
            const isOrdinal = !!ordinalAttr

            const contextValues = this.expressionResolver.resolvePossibleContextStringValues(contextExpression)
            const contextSeparator = this.config.extract.contextSeparator ?? '_'

            // Generate all combinations of context and plural forms
            if (contextValues.length > 0) {
              // Generate base plural forms (no context) - these also accept context
              if (this.config.extract.generateBasePluralForms !== false) {
                extractedKeys.forEach(extractedKey => this.generatePluralKeysForTrans(extractedKey.key, extractedKey.defaultValue, extractedKey.ns, isOrdinal, optionsNode, undefined, extractedKey.locations, extractedKey.key))
              }

              // Generate context + plural combinations
              for (const context of contextValues) {
                for (const extractedKey of extractedKeys) {
                  const contextKey = `${extractedKey.key}${contextSeparator}${context}`
                  // The base key that accepts context is extractedKey.key (without the context suffix)
                  this.generatePluralKeysForTrans(contextKey, extractedKey.defaultValue, extractedKey.ns, isOrdinal, optionsNode, extractedKey.explicitDefault, extractedKey.locations, extractedKey.key)
                }
              }
            } else {
              // Fallback to just plural forms if context resolution fails
              extractedKeys.forEach(extractedKey => this.generatePluralKeysForTrans(extractedKey.key, extractedKey.defaultValue, extractedKey.ns, isOrdinal, optionsNode, extractedKey.explicitDefault, extractedKey.locations))
            }
          }
        } else if (contextExpression) {
          const contextValues = this.expressionResolver.resolvePossibleContextStringValues(contextExpression)
          const contextSeparator = this.config.extract.contextSeparator ?? '_'

          if (contextValues.length > 0) {
            // Add context variants
            for (const context of contextValues) {
              for (const { key, ns, defaultValue, locations } of extractedKeys) {
                this.pluginContext.addKey({
                  key: `${key}${contextSeparator}${context}`,
                  ns,
                  defaultValue,
                  locations,
                })
              }
            }
            // Only add the base key as a fallback if the context is dynamic (i.e., not a simple string).
            if (contextExpression.type !== 'StringLiteral') {
              extractedKeys.forEach(extractedKey => {
                this.pluginContext.addKey({
                  key: extractedKey.key,
                  ns: extractedKey.ns,
                  defaultValue: extractedKey.defaultValue,
                  locations: extractedKey.locations,
                  keyAcceptingContext: extractedKey.key
                })
              })
            }
          } else {
            // If no context values were resolved, just add base keys
            extractedKeys.forEach(extractedKey => {
              this.pluginContext.addKey({
                key: extractedKey.key,
                ns: extractedKey.ns,
                defaultValue: extractedKey.defaultValue,
                locations: extractedKey.locations,
                keyAcceptingContext: extractedKey.key
              })
            })
          }
        } else if (hasCount) {
          // Check if plurals are disabled
          if (this.config.extract.disablePlurals) {
            // When plurals are disabled, just add the base keys (no plural forms)
            extractedKeys.forEach(extractedKey => {
              this.pluginContext.addKey({
                key: extractedKey.key,
                ns: extractedKey.ns,
                defaultValue: extractedKey.defaultValue,
                locations: extractedKey.locations
              })
            })
          } else {
            // Original plural handling logic when plurals are enabled
            // Find isOrdinal prop on the <Trans> component
            const ordinalAttr = node.opening.attributes?.find(
              (attr) =>
                attr.type === 'JSXAttribute' &&
                attr.name.type === 'Identifier' &&
                attr.name.value === 'ordinal'
            )
            const isOrdinal = !!ordinalAttr

            extractedKeys.forEach(extractedKey => this.generatePluralKeysForTrans(extractedKey.key, extractedKey.defaultValue, extractedKey.ns, isOrdinal, optionsNode, extractedKey.explicitDefault, extractedKey.locations))
          }
        } else {
          // No count or context - just add the base keys
          extractedKeys.forEach(extractedKey => {
            this.pluginContext.addKey({
              key: extractedKey.key,
              ns: extractedKey.ns,
              defaultValue: extractedKey.defaultValue,
              locations: extractedKey.locations
            })
          })
        }
      }
    }
  }

  /**
   * Generates plural keys for Trans components, with support for tOptions plural defaults.
   *
   * @param key - Base key name for pluralization
   * @param defaultValue - Default value for the keys
   * @param ns - Namespace for the keys
   * @param isOrdinal - Whether to generate ordinal plural forms
   * @param optionsNode - Optional tOptions object expression for plural-specific defaults
   * @param explicitDefaultFromSource - Whether the default was explicitly provided
   * @param locations - Source location information for this key
   * @param keyAcceptingContext - The base key that accepts context (if this is a context variant)
   */
  private generatePluralKeysForTrans (
    key: string,
    defaultValue: string | undefined,
    ns: string | false | undefined,
    isOrdinal: boolean,
    optionsNode?: ObjectExpression,
    explicitDefaultFromSource?: boolean,
    locations?: Array<{ file: string, line?: number, column?: number }>,
    keyAcceptingContext?: string
  ): void {
    try {
      const type = isOrdinal ? 'ordinal' : 'cardinal'
      const pluralCategories = new Intl.PluralRules(this.config.extract?.primaryLanguage, { type }).resolvedOptions().pluralCategories
      const pluralSeparator = this.config.extract.pluralSeparator ?? '_'

      // Get plural-specific default values from tOptions if available
      let otherDefault: string | undefined
      let ordinalOtherDefault: string | undefined

      if (optionsNode) {
        otherDefault = getObjectPropValue(optionsNode, `defaultValue${pluralSeparator}other`) as string | undefined
        ordinalOtherDefault = getObjectPropValue(optionsNode, `defaultValue${pluralSeparator}ordinal${pluralSeparator}other`) as string | undefined
      }

      // Special-case single-"other" languages: generate base key (or context variant) instead of key_other
      if (pluralCategories.length === 1 && pluralCategories[0] === 'other') {
        // Determine final default for the base/other form
        const specificDefault = optionsNode ? getObjectPropValue(optionsNode, `defaultValue${pluralSeparator}other`) as string | undefined : undefined
        const finalDefault = typeof specificDefault === 'string' ? specificDefault : (typeof defaultValue === 'string' ? defaultValue : key)

        // add base key (no suffix)
        this.pluginContext.addKey({
          key,
          ns,
          defaultValue: finalDefault,
          hasCount: true,
          isOrdinal,
          explicitDefault: Boolean(explicitDefaultFromSource || typeof specificDefault === 'string' || typeof otherDefault === 'string'),
          locations,
          keyAcceptingContext
        })
        return
      }

      for (const category of pluralCategories) {
        // Look for the most specific default value (e.g., defaultValue_ordinal_one)
        const specificDefaultKey = isOrdinal ? `defaultValue${pluralSeparator}ordinal${pluralSeparator}${category}` : `defaultValue${pluralSeparator}${category}`
        const specificDefault = optionsNode ? getObjectPropValue(optionsNode, specificDefaultKey) as string | undefined : undefined

        // Determine the final default value using a clear fallback chain
        let finalDefaultValue: string | undefined
        if (typeof specificDefault === 'string') {
          // 1. Use the most specific default if it exists (e.g., defaultValue_one)
          finalDefaultValue = specificDefault
        } else if (category === 'one' && typeof defaultValue === 'string') {
          // 2. SPECIAL CASE: The 'one' category falls back to the main default value (children content)
          finalDefaultValue = defaultValue
        } else if (isOrdinal && typeof ordinalOtherDefault === 'string') {
          // 3a. Other ordinal categories fall back to 'defaultValue_ordinal_other'
          finalDefaultValue = ordinalOtherDefault
        } else if (!isOrdinal && typeof otherDefault === 'string') {
          // 3b. Other cardinal categories fall back to 'defaultValue_other'
          finalDefaultValue = otherDefault
        } else if (typeof defaultValue === 'string') {
          // 4. If no '_other' is found, all categories can fall back to the main default value
          finalDefaultValue = defaultValue
        } else {
          // 5. Final fallback to the base key itself
          finalDefaultValue = key
        }

        const finalKey = isOrdinal
          ? `${key}${pluralSeparator}ordinal${pluralSeparator}${category}`
          : `${key}${pluralSeparator}${category}`

        this.pluginContext.addKey({
          key: finalKey,
          ns,
          defaultValue: finalDefaultValue,
          hasCount: true,
          isOrdinal,
          // Only treat plural/context variant as explicit when:
          // - the extractor indicated the default was explicit on the source element
          // - OR a plural-specific default was provided in tOptions (specificDefault/otherDefault)
          explicitDefault: Boolean(explicitDefaultFromSource || typeof specificDefault === 'string' || typeof otherDefault === 'string'),
          locations,
          // Pass through the base key that accepts context (if any)
          keyAcceptingContext
        })
      }
    } catch (e) {
      // Fallback to a simple key if Intl API fails
      this.pluginContext.addKey({
        key,
        ns,
        defaultValue,
        locations
      })
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
}
