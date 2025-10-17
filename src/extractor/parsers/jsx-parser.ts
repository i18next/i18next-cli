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
 * Serializes JSX children into a string, correctly indexing component placeholders.
 * This version correctly calculates an element's index based on its position
 * among its sibling *elements*, ignoring text nodes for indexing purposes.
 */
function serializeJSXChildren (children: any[], config: I18nextToolkitConfig): string {
  if (!children || children.length === 0) return ''

  const allowedTags = new Set(config.extract.transKeepBasicHtmlNodesFor ?? ['br', 'strong', 'i', 'p'])

  const isFormattingWhitespace = (n: any) =>
    n &&
    n.type === 'JSXText' &&
    /^\s*$/.test(n.value) &&
    n.value.includes('\n')

  // counter of "indexable" slots (increments for meaningful text, expression containers and non-preserved elements)
  const counter = { n: 0 }

  function serialize (nodes: any[]): string {
    if (!nodes || !nodes.length) return ''
    let out = ''

    for (const child of nodes) {
      if (!child) continue

      if (child.type === 'JSXText') {
        if (!isFormattingWhitespace(child)) {
          out += child.value
          counter.n++
        }
        continue
      }

      if (child.type === 'JSXExpressionContainer') {
        const expr = child.expression
        if (!expr) continue

        if (expr.type === 'StringLiteral') {
          out += expr.value
        } else if (expr.type === 'Identifier') {
          out += `{{${expr.value}}}`
        } else if (expr.type === 'ObjectExpression') {
          const prop = expr.properties[0]
          if (prop && prop.type === 'KeyValueProperty' && prop.key && prop.key.type === 'Identifier') {
            out += `{{${prop.key.value}}}`
          } else if (prop && prop.type === 'Identifier') {
            out += `{{${prop.value}}}`
          }
        } else if (expr.type === 'MemberExpression' && expr.property && expr.property.type === 'Identifier') {
          out += `{{${expr.property.value}}}`
        } else if (expr.type === 'CallExpression' && expr.callee?.type === 'Identifier') {
          out += `{{${expr.callee.value}}}`
        }
        // expression containers (including explicit {' '}) consume a slot
        counter.n++
        continue
      }

      if (child.type === 'JSXElement') {
        let tag: string | undefined
        if (child.opening && child.opening.name && child.opening.name.type === 'Identifier') {
          tag = child.opening.name.value
        }

        if (tag && allowedTags.has(tag)) {
          // preserved HTML tag: do NOT consume a numeric slot for the tag itself
          const inner = serialize(child.children || [])
          out += `<${tag}>${inner}</${tag}>`
        } else {
          // non-preserved element: use current counter value as numeric index, then consume the slot
          const myIndex = counter.n
          counter.n++
          const inner = serialize(child.children || [])
          out += `<${myIndex}>${inner}</${myIndex}>`
        }
        continue
      }

      if (child.type === 'JSXFragment') {
        out += serialize(child.children || [])
        continue
      }

      // unknown node types: ignore
    }

    return out
  }

  const result = serialize(children)
  return String(result).replace(/\s+/g, ' ').trim()
}
