import type { JSXElement } from '@swc/core'
import type { ExtractedKey, I18nextToolkitConfig } from '../../types'
import { getObjectProperty, getObjectPropValue } from './ast-utils'

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
 * //   ns: 'home',
 * //   defaultValue: 'Welcome!',
 * //   hasCount: false
 * // }
 * ```
 */
export function extractFromTransComponent (node: JSXElement, config: I18nextToolkitConfig): ExtractedKey | null {
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
  const hasCount = !!countAttr

  const tOptionsAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'Identifier' &&
      attr.name.value === 'tOptions'
  )
  const optionsNode = (tOptionsAttr?.type === 'JSXAttribute' && tOptionsAttr.value?.type === 'JSXExpressionContainer' && tOptionsAttr.value.expression.type === 'ObjectExpression')
    ? tOptionsAttr.value.expression
    : undefined

  const contextAttr = node.opening.attributes?.find(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'Identifier' &&
      attr.name.value === 'context'
  )
  let contextExpression = (contextAttr?.type === 'JSXAttribute' && contextAttr.value?.type === 'JSXExpressionContainer')
    ? contextAttr.value.expression
    : undefined

  let key: string
  if (i18nKeyAttr?.type === 'JSXAttribute' && i18nKeyAttr.value?.type === 'StringLiteral') {
    key = i18nKeyAttr.value.value
  } else {
    key = serializeJSXChildren(node.children, config)
  }

  if (!key) {
    return null
  }

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

  let defaultValue = config.extract.defaultValue || ''
  if (defaultsAttr?.type === 'JSXAttribute' && defaultsAttr.value?.type === 'StringLiteral') {
    defaultValue = defaultsAttr.value.value
  } else {
    defaultValue = serializeJSXChildren(node.children, config)
  }

  return { key, ns, defaultValue: defaultValue || key, hasCount, contextExpression, optionsNode }
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
          const prop = expr.properties[0]
          if (prop && prop.type === 'Identifier') {
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
