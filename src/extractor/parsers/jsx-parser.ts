import type { Expression, JSXAttribute, JSXAttributeOrSpread, JSXElement, JSXElementChild, JSXElementName, JSXExpression, ObjectExpression } from '@swc/core'
import type { I18nextToolkitConfig } from '../../types'
import { getObjectPropValue, getObjectPropValueExpression, isSimpleTemplateLiteral } from './ast-utils'
import * as React from 'react'
import { getDefaults, nodesToString } from 'react-i18next'

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

  /** Whether the defaultValue was explicitly provided on the <Trans /> (defaults prop or tOptions defaultValue*) */
  explicitDefault?: boolean;
}

function getStringLiteralFromExpression (expression: JSXExpression | null): string | undefined {
  if (!expression) return undefined

  if (expression.type === 'StringLiteral') {
    return expression.value
  }

  if (expression.type === 'TemplateLiteral' && isSimpleTemplateLiteral(expression)) {
    return expression.quasis[0].cooked
  }

  return undefined
}

function getStringLiteralFromAttribute (attr: JSXAttribute): string | undefined {
  if (attr.value?.type === 'StringLiteral') {
    return attr.value.value
  }

  if (attr.value?.type === 'JSXExpressionContainer') {
    return getStringLiteralFromExpression(attr.value.expression)
  }

  return undefined
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
  let valuesCountProperty: Expression | undefined
  if (
    !countAttr &&
    valuesAttr?.type === 'JSXAttribute' &&
    valuesAttr.value?.type === 'JSXExpressionContainer' &&
    valuesAttr.value.expression.type === 'ObjectExpression'
  ) {
    valuesCountProperty = getObjectPropValueExpression(valuesAttr.value.expression, 'count')
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
  if (nsAttr?.type === 'JSXAttribute') {
    ns = getStringLiteralFromAttribute(nsAttr)
  } else {
    ns = undefined
  }

  // 2. If not found, fall back to looking inside tOptions
  if (optionsNode) {
    if (ns === undefined) {
      ns = getObjectPropValue(optionsNode, 'ns') as string | undefined
    }
    if (contextExpression === undefined) {
      contextExpression = getObjectPropValueExpression(optionsNode, 'context')
    }
  }

  const serialized = serializeJSXChildren(node.children, config)

  // Handle default value properly
  let defaultValue: string

  const defaultAttributeLiteral = defaultsAttr?.type === 'JSXAttribute' ? getStringLiteralFromAttribute(defaultsAttr) : undefined
  if (defaultAttributeLiteral !== undefined) {
    // Explicit defaults attribute takes precedence
    defaultValue = defaultAttributeLiteral
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

  // Determine if tOptions contained explicit defaultValue* properties
  const optionsHasDefaultProps = (opts?: ObjectExpression) => {
    if (!opts || !Array.isArray((opts as any).properties)) return false
    for (const p of (opts as any).properties) {
      if (p && p.type === 'KeyValueProperty' && p.key) {
        const keyName = (p.key.type === 'Identifier' && p.key.value) || (p.key.type === 'StringLiteral' && p.key.value)
        if (typeof keyName === 'string' && keyName.startsWith('defaultValue')) return true
      }
    }
    return false
  }

  const explicitDefault = defaultAttributeLiteral !== undefined || optionsHasDefaultProps(optionsNode)

  return {
    keyExpression,
    serializedChildren: serialized,
    ns,
    defaultValue,
    hasCount,
    isOrdinal,
    contextExpression,
    optionsNode,
    explicitDefault
  }
}

/**
 * Creates a dummy React component. The implementation / return value is
 * irrelevant, as long as we have something realistic-looking to pass to
 * react-i18next.
 */
function makeDummyComponent (name: string): React.JSXElementConstructor<any> {
  const result = () => null
  Object.defineProperty(result, 'name', { value: name })
  result.displayName = name
  return result
}

function makeDummyProps (attributes: JSXAttributeOrSpread[]): Record<string, any> | null {
  return attributes.length
    ? Object.fromEntries(attributes.map((attr): ([string, string] | null) => {
      if (attr.type === 'SpreadElement') {
        return null
      } else if (attr.name.type === 'Identifier') {
        return [attr.name.value, '']
      } else {
        return [`${attr.name.namespace.value}:${attr.name.name.value}`, '']
      }
    }).filter(i => i != null))
    : null
}

function getElementName (element: JSXElementName): string | React.JSXElementConstructor<any> {
  switch (element.type) {
    case 'Identifier':
      return /\p{Uppercase_Letter}/u.test(element.value) ? makeDummyComponent(element.value) : element.value
    case 'JSXMemberExpression':
      // element.object should be irrelevant for naming purposes here
      return makeDummyComponent(element.property.value)
    case 'JSXNamespacedName':
      return `${element.namespace.value}:${element.name.value}`
  }
}

function trimTextNode (text: string): string | null {
  text = text.replace(/\r\n/g, '\n') // Normalize line endings

  // If text is ONLY whitespace AND contains a newline, remove it entirely
  if (/^\s+$/.test(text) && /\n/.test(text)) {
    return null
  }

  // Trim leading/trailing whitespace sequences containing newlines
  text = text.replace(/^[ \t]*\n[ \t]*/, '')
  text = text.replace(/[ \t]*\n[ \t]*$/, '')

  // Replace whitespace sequences containing newlines with single space
  text = text.replace(/[ \t]*\n[ \t]*/g, ' ')

  return text
}

function swcExpressionToReactNode (expr: JSXExpression): string | React.ReactElement | null {
  switch (expr.type) {
    case 'JSXEmptyExpression':
      return null

    case 'TsAsExpression':
      return swcExpressionToReactNode(expr.expression)
    case 'ParenthesisExpression':
      return swcExpressionToReactNode(expr.expression)

    case 'ConditionalExpression': {
      const consequent = swcExpressionToReactNode(expr.consequent)
      const alternate = swcExpressionToReactNode(expr.alternate)

      // Heuristic:
      // - If one branch is a strict prefix of the other, pick the longer (keeps extra static tail),
      //   e.g. "to select" vs "to select, or right click..."
      // - Otherwise, stay deterministic and prefer consequent (avoids choosing alternates just because they’re 1 char longer).
      if (typeof consequent === 'string' &&
          typeof alternate === 'string' &&
          alternate.length !== consequent.length &&
          alternate.startsWith(consequent)) {
        return alternate
      }

      return consequent
    }

    case 'StringLiteral':
      return expr.value
    case 'TemplateLiteral':
      if (isSimpleTemplateLiteral(expr)) {
        return expr.quasis[0].raw
      }
      // Too complex!
      break
    case 'Identifier':
      // Not a valid React element, but props for Trans interpolation
      // TODO: This might actually be an error - not sure that react-i18next can handle at runtime
      return { [expr.value]: expr.value } as unknown as React.ReactElement
    case 'ObjectExpression': {
      const keys = expr.properties.map((prop) => {
        if (prop.type === 'KeyValueProperty' && (prop.key.type === 'Identifier' || prop.key.type === 'StringLiteral')) {
          return prop.key.value
        } else if (prop.type === 'Identifier') {
          return prop.value
        } else {
        // Too complex to represent! TODO: Flag an error
          return null
        }
      }).filter(k => k !== null)
      // Not a valid React element, but props for Trans interpolation
      return Object.fromEntries(keys.map(k => [k, k])) as unknown as React.ReactElement
    }
  }

  // Too complex to represent! TODO: Flag an error
  return React.createElement('expression', { expression: expr })
}

function swcChildToReactNode (node: JSXElementChild): string | React.ReactElement | null {
  switch (node.type) {
    case 'JSXText':
      return trimTextNode(node.value)
    case 'JSXExpressionContainer':
      return swcExpressionToReactNode(node.expression)
    case 'JSXSpreadChild':
      return ''
    case 'JSXElement':
      return React.createElement(
        getElementName(node.opening.name),
        makeDummyProps(node.opening.attributes),
        ...swcChildrenToReactNodes(node.children)
      )
    case 'JSXFragment':
      return React.createElement(React.Fragment, null, ...swcChildrenToReactNodes(node.children))
  }
}

function swcChildrenToReactNodes (children: JSXElementChild[]): (string | React.ReactElement)[] {
  return children.map(swcChildToReactNode).filter(n => n !== null)
}

function serializeJSXChildren (children: JSXElementChild[], config: I18nextToolkitConfig): string {
  const i18nextOptions = { ...getDefaults() }
  if (config.extract.transKeepBasicHtmlNodesFor) {
    i18nextOptions.transKeepBasicHtmlNodesFor = config.extract.transKeepBasicHtmlNodesFor
  }
  return nodesToString(swcChildrenToReactNodes(children), i18nextOptions)
}
