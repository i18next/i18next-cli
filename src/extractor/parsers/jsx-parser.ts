import type { Expression, JSXElement, ObjectExpression, Property } from '@swc/core'
import type { I18nextToolkitConfig } from '../../types'
import { getObjectProperty, getObjectPropValue } from './ast-utils'

export interface ExtractedJSXAttributes {
  /** holds the raw key expression from the AST */
  keyExpression?: Expression;

  /** holds the serialized JSX children from the AST */
  serializedChildren: string;

  /** Default value to use in the primary language */
  defaultValue?: string;

  /** Namespace this key belongs to (if defined on <Trans />) */
  ns?: string;

  /** Whether this key is used with pluralization (count parameter) */
  hasCount?: boolean;

  /** Whether this key is used with ordinal pluralization */
  isOrdinal?: boolean;

  /** AST node for options object, used for advanced plural handling in Trans */
  optionsNode?: ObjectExpression;

  /** hold the raw context expression from the AST */
  contextExpression?: Expression;
}

/**
 * Extracts translation keys from JSX Trans components.
 *
 * This function handles various Trans component patterns:
 * - Explicit i18nKey prop: `<Trans i18nKey="my.key">content</Trans>`
 * - Implicit keys from children: `<Trans>Hello World</Trans>`
 * - Namespace specification: `<Trans ns="common">content</Trans>`
 * - Default values: `<Trans defaults="Default text">content</Trans>`
 * - Pluralization: `<Trans count={count}>content</Trans>`
 * - HTML preservation: `<Trans>Hello <strong>world</strong></Trans>`
 *
 * @param node - The JSX element node to process
 * @param config - The toolkit configuration containing extraction settings
 * @returns Extracted key information or null if no valid key found
 *
 * @example
 * ```typescript
 * // Input JSX:
 * // <Trans i18nKey="welcome.title" ns="home" defaults="Welcome!">
 * //   Welcome to our <strong>amazing</strong> app!
 * // </Trans>
 *
 * const result = extractFromTransComponent(jsxNode, config)
 * // Returns: {
 * //   key: 'welcome.title',
 * //   keyExpression: { ... },
 * //   ns: 'home',
 * //   defaultValue: 'Welcome!',
 * //   hasCount: false
 * // }
 * ```
 */
export function extractFromTransComponent (node: JSXElement, config: I18nextToolkitConfig): ExtractedJSXAttributes | null {
  const i18nKeyAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'Identifier' &&
      attr.name.value === 'i18nKey'
  )

  const defaultsAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'Identifier' &&
      attr.name.value === 'defaults'
  )

  const countAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'Identifier' &&
      attr.name.value === 'count'
  )

  const valuesAttr = node.opening.attributes?.find(
    (attr) => attr.type === 'JSXAttribute' && attr.name.type === 'Identifier' && attr.name.value === 'values'
  )

  // Find the 'count' property in the 'values' object if count={...} is not defined
  let valuesCountProperty: Property | undefined
  if (
    !countAttr &&
    valuesAttr?.type === 'JSXAttribute' &&
    valuesAttr.value?.type === 'JSXExpressionContainer' &&
    valuesAttr.value.expression.type === 'ObjectExpression'
  ) {
    valuesCountProperty = getObjectProperty(valuesAttr.value.expression, 'count')
  }

  const hasCount = !!countAttr || !!valuesCountProperty

  const tOptionsAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'Identifier' &&
      attr.name.value === 'tOptions'
  )
  const optionsNode = (tOptionsAttr?.type === 'JSXAttribute' && tOptionsAttr.value?.type === 'JSXExpressionContainer' && tOptionsAttr.value.expression.type === 'ObjectExpression')
    ? tOptionsAttr.value.expression
    : undefined

  // Find isOrdinal prop on the <Trans> component
  const ordinalAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
            attr.name.type === 'Identifier' &&
            attr.name.value === 'ordinal'
  )
  const isOrdinal = !!ordinalAttr

  const contextAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
        attr.name.type === 'Identifier' &&
        attr.name.value === 'context'
  )
  let contextExpression = (contextAttr?.type === 'JSXAttribute' && contextAttr.value?.type === 'JSXExpressionContainer')
    ? contextAttr.value.expression
    : (contextAttr?.type === 'JSXAttribute' && contextAttr.value?.type === 'StringLiteral')
        ? contextAttr.value
        : undefined

  // 1. Prioritize direct props for 'ns' and 'context'
  const nsAttr = node.opening.attributes?.find(attr => attr.type === 'JSXAttribute' && attr.name.type === 'Identifier' && attr.name.value === 'ns')
  let ns: string | undefined
  if (nsAttr?.type === 'JSXAttribute' && nsAttr.value?.type === 'StringLiteral') {
    ns = nsAttr.value.value
  } else {
    ns = undefined
  }

  // 2. If not found, fall back to looking inside tOptions
  if (optionsNode) {
    if (ns === undefined) {
      ns = getObjectPropValue(optionsNode, 'ns') as string | undefined
    }
    if (contextExpression === undefined) {
      const contextPropFromOptions = getObjectProperty(optionsNode, 'context')
      if (contextPropFromOptions?.value) {
        contextExpression = contextPropFromOptions.value
      }
    }
  }

  const serialized = serializeJSXChildren(node.children, config)

  // Handle default value properly
  let defaultValue: string

  if (defaultsAttr?.type === 'JSXAttribute' && defaultsAttr.value?.type === 'StringLiteral') {
    // Explicit defaults attribute takes precedence
    defaultValue = defaultsAttr.value.value
  } else {
    // Use the configured default value or fall back to empty string
    const configuredDefault = config.extract.defaultValue
    if (typeof configuredDefault === 'string') {
      defaultValue = configuredDefault
    } else {
      // For function-based defaults or undefined, use empty string as placeholder
      // The translation manager will handle function resolution with proper context
      defaultValue = ''
    }
  }

  let keyExpression: Expression | undefined
  let processedKeyValue: string | undefined

  if (i18nKeyAttr?.type === 'JSXAttribute') {
    if (i18nKeyAttr.value?.type === 'StringLiteral') {
      keyExpression = i18nKeyAttr.value
      processedKeyValue = keyExpression.value

      // Validate that the key is not empty
      if (!processedKeyValue || processedKeyValue.trim() === '') {
        console.warn('Ignoring Trans component with empty i18nKey')
        return null
      }

      // Handle namespace prefix removal when both ns and i18nKey are provided
      if (ns && keyExpression.type === 'StringLiteral') {
        const nsSeparator = config.extract.nsSeparator ?? ':'
        const keyValue = keyExpression.value

        // If the key starts with the namespace followed by the separator, remove the prefix
        if (nsSeparator && keyValue.startsWith(`${ns}${nsSeparator}`)) {
          processedKeyValue = keyValue.slice(`${ns}${nsSeparator}`.length)

          // Validate processed key is not empty
          if (!processedKeyValue || processedKeyValue.trim() === '') {
            console.warn('Ignoring Trans component with i18nKey that becomes empty after namespace removal')
            return null
          }

          // Create a new StringLiteral with the namespace prefix removed
          keyExpression = {
            ...keyExpression,
            value: processedKeyValue
          }
        }
      }
    } else if (
      i18nKeyAttr.value?.type === 'JSXExpressionContainer' &&
      i18nKeyAttr.value.expression.type !== 'JSXEmptyExpression'
    ) {
      keyExpression = i18nKeyAttr.value.expression
    }

    if (!keyExpression) return null
  }

  // If no explicit defaults provided and we have a processed key, use it as default value
  // This matches the behavior of other similar tests in the codebase
  if (!defaultsAttr && processedKeyValue && !serialized.trim()) {
    defaultValue = processedKeyValue
  } else if (!defaultsAttr && serialized.trim()) {
    defaultValue = serialized
  }

  return {
    keyExpression,
    serializedChildren: serialized,
    ns,
    defaultValue,
    hasCount,
    isOrdinal,
    contextExpression,
    optionsNode,
  }
}

/**
 * Serializes JSX children into a string representation suitable for i18next.
 *
 * This function converts JSX children into the format expected by i18next:
 * - Text nodes are preserved as-is
 * - HTML elements are converted to indexed placeholders or preserved if allowed
 * - JSX expressions become interpolation placeholders: `{{variable}}`
 * - Fragments are flattened
 * - Whitespace is normalized
 *
 * The serialization respects the `transKeepBasicHtmlNodesFor` configuration
 * to determine which HTML tags should be preserved vs. converted to indexed placeholders.
 *
 * @param children - Array of JSX child nodes to serialize
 * @param config - Configuration containing HTML preservation settings
 * @returns Serialized string representation
 *
 * @example
 * ```typescript
 * // JSX: Hello <strong>{{name}}</strong>, you have <Link to="/msgs">{{count}} messages</Link>.
 * // With transKeepBasicHtmlNodesFor: ['strong']
 * // Returns: "Hello <strong>{{name}}</strong>, you have <1>{{count}} messages</1>."
 * //          (strong preserved, Link becomes indexed placeholder <1>)
 *
 * const serialized = serializeJSXChildren(children, config)
 * ```
 *
 * @internal
 */
function serializeJSXChildren (children: any[], config: I18nextToolkitConfig): string {
  const allowedTags = new Set(config.extract.transKeepBasicHtmlNodesFor ?? ['br', 'strong', 'i', 'p'])

  /**
   * Recursively processes JSX children and converts them to string format.
   *
   * @param children - Array of child nodes to process
   * @returns Serialized string content
   */
  function serializeChildren (children: any[]): string {
    let out = ''
    // Use forEach to get the direct index of each child in the array
    children.forEach((child, index) => {
      if (child.type === 'JSXText') {
        out += child.value
      } else if (child.type === 'JSXExpressionContainer') {
        const expr = child.expression
        if (expr.type === 'StringLiteral') {
          out += expr.value
        } else if (expr.type === 'Identifier') {
          out += `{{${expr.value}}}`
        } else if (expr.type === 'ObjectExpression') {
          // Handle object expressions like {{bar: 1}} -> {{bar}}
          const prop = expr.properties[0]
          if (prop && prop.type === 'KeyValueProperty' && prop.key && prop.key.type === 'Identifier') {
            out += `{{${prop.key.value}}}`
          } else if (prop && prop.type === 'Identifier') {
            // Handle the case where properties[0] is directly an Identifier
            out += `{{${prop.value}}}`
          }
        }
      } else if (child.type === 'JSXElement') {
        let tag
        if (child.opening.name.type === 'Identifier') {
          tag = child.opening.name.value
        }

        const innerContent = serializeChildren(child.children)

        if (tag && allowedTags.has(tag)) {
          // If the tag is in the allowed list, preserve it
          out += `<${tag}>${innerContent}</${tag}>`
        } else {
          // Otherwise, replace it with ITS INDEX IN THE CHILDREN ARRAY
          out += `<${index}>${innerContent}</${index}>`
        }
      } else if (child.type === 'JSXFragment') {
        out += serializeChildren(child.children)
      }
    })
    return out
  }

  return serializeChildren(children).trim().replace(/\s{2,}/g, ' ')
}
