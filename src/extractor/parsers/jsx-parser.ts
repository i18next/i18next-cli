import type { Expression, JSXAttribute, JSXAttributeOrSpread, JSXElement, JSXElementChild, JSXElementName, JSXExpression, ObjectExpression } from '@swc/core'
import type { I18nextToolkitConfig } from '../../types'
import { getObjectPropValue, getObjectPropValueExpression, isSimpleTemplateLiteral } from './ast-utils'
import * as React from 'react'
import { getDefaults } from 'react-i18next'
import { nodesToString } from 'react-i18next/TransWithoutContext'

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

/**
 * Like getStringLiteralFromExpression(), but for SWC Expression nodes.
 * Used for ConditionalExpression branches (consequent/alternate).
 */
function getStaticStringFromExpression (expression: Expression | null | undefined): string | undefined {
  if (!expression) return undefined

  if (expression.type === 'StringLiteral') return expression.value

  // Be tolerant to parens / TS assertions depending on parser output
  if ((expression as any).type === 'ParenExpression' && (expression as any).expr) {
    return getStaticStringFromExpression((expression as any).expr)
  }
  if ((expression as any).type === 'ParenthesizedExpression' && (expression as any).expression) {
    return getStaticStringFromExpression((expression as any).expression)
  }
  if ((expression as any).type === 'TsAsExpression' && (expression as any).expression) {
    return getStaticStringFromExpression((expression as any).expression)
  }

  // Static JSX (used in some ConditionalExpression branches):
  // <>some text{" "}more</>  -> "some text more"
  if ((expression as any).type === 'JSXFragment' || (expression as any).type === 'JSXElement') {
    const jsxChildren = (expression as any).children ?? []
    let out = ''

    for (const ch of jsxChildren) {
      if (!ch) continue

      if (ch.type === 'JSXText') {
        out += ch.value
        continue
      }

      if (ch.type === 'JSXExpressionContainer') {
        if (!ch.expression || ch.expression.type === 'JSXEmptyExpression') continue
        const lit = getStringLiteralFromExpression(ch.expression)
        if (lit === undefined) return undefined
        out += lit
        continue
      }

      // Any nested JSXElement/Fragment/etc => not statically serializable here
      return undefined
    }

    return out
  }

  // TemplateLiteral with no expressions: join all quasis (handles multi-quasi literals too)
  if (
    expression.type === 'TemplateLiteral' &&
    Array.isArray((expression as any).expressions) &&
    (expression as any).expressions.length === 0
  ) {
    const quasis = (expression as any).quasis ?? []
    const cooked = quasis.map((q: any) => q?.cooked ?? q?.raw ?? '').join('')
    return cooked
  }

  if (expression.type === 'TemplateLiteral' && isSimpleTemplateLiteral(expression as any)) {
    return (expression as any).quasis?.[0]?.cooked
  }

  // Support static string concatenation: 'a' + 'b'
  if ((expression as any).type === 'BinaryExpression') {
    const op = (expression as any).operator ?? (expression as any).op
    if (op === '+') {
      const left = getStaticStringFromExpression((expression as any).left)
      const right = getStaticStringFromExpression((expression as any).right)
      if (left !== undefined && right !== undefined) return left + right
    }
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
      // TODO: This might actually be an error - not sure that react-i18next can handle at runtime
      return `{{${expr.value}}}`
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
      return `{{${keys.join(',')}}}`
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

/**
 * Serializes JSX children into a string, correctly indexing component placeholders.
 * This version correctly calculates an element's index based on its position
 * among its sibling *elements*, ignoring text nodes for indexing purposes.
 */
function serializeJSXChildren2 (children: any[], config: I18nextToolkitConfig): string {
  if (!children || children.length === 0) return ''

  const allowedTags = new Set(config.extract.transKeepBasicHtmlNodesFor ?? ['br', 'strong', 'i', 'p'])

  const isFormattingWhitespace = (n: any) =>
    n &&
    n.type === 'JSXText' &&
    /^\s*$/.test(n.value) &&
    n.value.includes('\n')

  const isElementish = (n: any) => n && (n.type === 'JSXElement' || n.type === 'JSXFragment')

  const findNextNonFormattingSibling = (nodes: any[], startIndex: number) => {
    for (let j = startIndex; j < nodes.length; j++) {
      const candidate = nodes[j]
      if (!candidate) continue
      if (candidate.type === 'JSXText' && isFormattingWhitespace(candidate)) continue
      return candidate
    }
    return undefined
  }

  // Build deterministic global slot list (pre-order)
  function collectSlots (nodes: any[], slots: any[], parentIsNonPreserved = false, isRootLevel = false) {
    if (!nodes || !nodes.length) return

    // Check if there are multiple <p> elements at root level
    const multiplePAtRoot = isRootLevel && nodes.filter((n: any) =>
      n && n.type === 'JSXElement' && n.opening?.name?.value === 'p'
    ).length > 1

    // First, identify boundary whitespace nodes (start and end of sibling list)
    // We trim ONLY pure-whitespace JSXText nodes from the boundaries
    let startIdx = 0
    let endIdx = nodes.length - 1

    // Skip leading boundary whitespace (pure whitespace JSXText only)
    while (startIdx <= endIdx && isFormattingWhitespace(nodes[startIdx])) {
      startIdx++
    }

    // Skip trailing boundary whitespace (pure whitespace JSXText only)
    while (endIdx >= startIdx && isFormattingWhitespace(nodes[endIdx])) {
      endIdx--
    }

    // Now process all nodes in the range [startIdx, endIdx] - this includes interior whitespace
    const meaningfulNodes = startIdx <= endIdx ? nodes.slice(startIdx, endIdx + 1) : []

    // If the parent is non-preserved but it contains element/fragment children,
    // we want to keep meaningful text & simple expressions so inline-tags inside
    // a single wrapper (e.g. <span>.. <code/> ..</span>) preserve sibling ordering.
    // If there are NO element children (e.g. <pre>some text</pre>) then all inner
    // text/expressions should be treated as part of the parent and NOT create slots.
    const parentHasElementChildren = meaningfulNodes.some(
      (n) => n && (n.type === 'JSXElement' || n.type === 'JSXFragment')
    )

    for (let i = 0; i < meaningfulNodes.length; i++) {
      const n = meaningfulNodes[i]
      if (!n) continue

      if (n.type === 'JSXText') {
        // When inside a non-preserved parent that has NO element children (e.g. <pre>),
        // skip all inner text nodes — they're part of the parent and must not shift indexes.
        if (parentIsNonPreserved && !parentHasElementChildren) {
          continue
        }

        // For non-preserved parents that DO have element children, only skip pure
        // formatting whitespace; keep meaningful text so inline sibling indexes stay correct.
        if (parentIsNonPreserved && isFormattingWhitespace(n)) {
          continue
        }

        // Otherwise, preserve previous behavior for boundary/formatting merging.
        if (isFormattingWhitespace(n)) {
          // If this formatting whitespace sits between two element/fragment nodes
          // (e.g. <br />\n  <small>...), treat it as layout-only and skip it so it
          // doesn't become its own slot and shift subsequent element indexes.
          const prevOrig = meaningfulNodes[i - 1]
          const nextOrig = meaningfulNodes[i + 1]
          if (
            prevOrig &&
            (prevOrig.type === 'JSXElement' || prevOrig.type === 'JSXFragment') &&
            nextOrig &&
            (nextOrig.type === 'JSXElement' || nextOrig.type === 'JSXFragment')
          ) {
            continue
          }

          const prevSlot = slots[slots.length - 1]
          const prevOriginal = meaningfulNodes[i - 1]

          if (prevSlot) {
            // If the previous original sibling is an expression container, treat
            // this formatting whitespace as formatting after an expression and skip it.
            if (prevOriginal && prevOriginal.type === 'JSXExpressionContainer') {
              continue
            }
            // Only merge into previous text when the previous original sibling was also JSXText.
            if (prevSlot.type === 'JSXText' && prevOriginal && prevOriginal.type === 'JSXText') {
              prevSlot.value = String(prevSlot.value) + n.value
              continue
            }
          }
        }

        // Don't treat the FIRST meaningful text node inside a non-preserved parent
        // that also contains element children as an independent global slot.
        // This preserves expected placeholder indexing for inline tags wrapped
        // inside a single container (e.g. <span>text <code/> more <code/> ...</span>).
        if (parentIsNonPreserved && parentHasElementChildren && i === 0) {
          continue
        }

        // Add all other JSXText nodes
        slots.push(n)
        continue
      }

      if (n.type === 'JSXExpressionContainer') {
        // IMPORTANT:
        // Inside a non-preserved parent with NO element children (e.g. <Text.Span>{...only text/expr...}</Text.Span>),
        // inner expressions must NOT create global slots. They serialize as part of the parent's text content and
        // must not shift sibling placeholder indices outside this element.
        if (parentIsNonPreserved && !parentHasElementChildren) {
          continue
        }

        // Handle pure-string expression containers (e.g. {" "}):
        // - If it's pure space (no newline) and it directly follows a non-text sibling
        //   (element/fragment), treat it as formatting and skip it.
        // - Otherwise, count it as a slot (do NOT merge it into previous JSXText).
        const textVal = getStringLiteralFromExpression(n.expression)
        if (textVal !== undefined) {
          const isPureSpaceNoNewline = /^\s*$/.test(textVal) && !textVal.includes('\n')
          const prevOriginal = meaningfulNodes[i - 1]
          const nextOriginal = meaningfulNodes[i + 1]

          // If this is an explicit {" "} and it sits BETWEEN two elements/fragments,
          // it MUST be counted as a child slot to match react-i18next <Trans> indexing,
          // even if code formatting introduces newline-only JSXText nodes.
          if (isPureSpaceNoNewline) {
            const nextMeaningful = findNextNonFormattingSibling(meaningfulNodes, i + 1)
            if (isElementish(prevOriginal) && isElementish(nextMeaningful)) {
              // keep it as a slot (do not skip)
            } else {
              // --- existing skip/merge heuristics (kept, but now only apply when NOT between elements) ---

              // If the explicit {" "} is followed by a newline-only JSXText which
              // itself is followed by an element/fragment, treat the {" "}
              // as layout-only and skip it. This covers cases where the space
              // precedes a newline-only separator before an element (fixes index
              // shifting in object-expression span tests).
              const nextNextOriginal = meaningfulNodes[i + 2]
              if (
                nextOriginal &&
                nextOriginal.type === 'JSXText' &&
                isFormattingWhitespace(nextOriginal) &&
                nextNextOriginal &&
                (nextNextOriginal.type === 'JSXElement' || nextNextOriginal.type === 'JSXFragment')
              ) {
                const prevOriginalCandidate = meaningfulNodes[i - 1]
                const prevPrevOriginal = meaningfulNodes[i - 2]
                const shouldSkip =
                  !prevOriginalCandidate ||
                  (prevOriginalCandidate.type !== 'JSXText' && prevPrevOriginal && prevPrevOriginal.type === 'JSXExpressionContainer')

                if (shouldSkip) {
                  continue
                }
              }

              // Only treat {" "} as pure formatting to skip when it sits between
              // an element/fragment and a newline-only JSXText. In that specific
              // boundary case the explicit space is merely layout and must be ignored.
              if (
                prevOriginal &&
                (prevOriginal.type === 'JSXElement' || prevOriginal.type === 'JSXFragment') &&
                nextOriginal &&
                nextOriginal.type === 'JSXText' &&
                isFormattingWhitespace(nextOriginal)
              ) {
                continue
              }

              // 1) Merge into previous text when the previous original sibling is JSXText
              //    and the next original sibling is either missing or a non-formatting JSXText.
              const nextIsTextNonFormatting = !nextOriginal || (nextOriginal.type === 'JSXText' && !isFormattingWhitespace(nextOriginal))
              if (prevOriginal && prevOriginal.type === 'JSXText' && nextIsTextNonFormatting) {
                const prevSlot = slots[slots.length - 1]
                if (prevSlot && prevSlot.type === 'JSXText') {
                  prevSlot.value = String(prevSlot.value) + (n.expression as any).value
                  continue
                }
              }

              // 2) Skip when this explicit space sits between an element/fragment
              //    and a newline-only formatting JSXText (boundary formatting).
              if (
                prevOriginal &&
                (prevOriginal.type === 'JSXElement' || prevOriginal.type === 'JSXFragment') &&
                nextOriginal &&
                nextOriginal.type === 'JSXText' &&
                isFormattingWhitespace(nextOriginal)
              ) {
                continue
              }
              // 3) Otherwise fallthrough and count this expression as a slot.
            }
          }
        }

        // All JSXExpressionContainers count as slots for indexing.
        slots.push(n)
        continue
      }

      if (n.type === 'JSXElement') {
        const tagName = n.opening && n.opening.name && n.opening.name.type === 'Identifier'
          ? n.opening.name.value
          : undefined
        if (tagName && allowedTags.has(tagName)) {
          // Check if this preserved tag will actually be preserved as literal HTML
          // or if it will be indexed (has complex children or attributes)
          const hasAttrs =
            n.opening &&
            Array.isArray((n.opening as any).attributes) &&
            (n.opening as any).attributes.length > 0
          const children = n.children || []
          // Check for single PURE text child (JSXText OR simple string expression)
          const isSinglePureTextChild =
            children.length === 1 && (
              children[0]?.type === 'JSXText' ||
              (children[0]?.type === 'JSXExpressionContainer' &&
                getStringLiteralFromExpression(children[0].expression) !== undefined)
            )

          // Self-closing tags (no children) should be added to slots but rendered as literal HTML
          // Tags with single pure text child should NOT be added to slots and rendered as literal HTML
          const isSelfClosing = !children.length
          const hasTextContent = isSinglePureTextChild

          if (hasAttrs && !isSinglePureTextChild) {
            // Has attributes AND complex children -> will be indexed, add to slots
            slots.push(n)
            collectSlots(n.children || [], slots, true)
          } else if (isSelfClosing) {
            // Self-closing tag with no attributes: add to slots (affects indexes) but will render as literal
            slots.push(n)
          } else if (!hasTextContent) {
            // Has complex children but no attributes

            // Check if children contain any expressions (interpolations)
            const hasExpressions = (n.children || []).some((c: any) =>
              c.type === 'JSXExpressionContainer' &&
              getStringLiteralFromExpression(c.expression) === undefined
            )

            if (hasExpressions) {
              slots.push(n)
              collectSlots(n.children || [], slots, true)
            } else if (tagName === 'p') {
              // If this root-level <p> contains children that themselves will be
              // indexed (non-preserved elements / elements with attrs / complex children),
              // we must index the <p> so inner numeric placeholders keep stable numbering.
              const childWillBeIndexed = (children || []).some((ch: any) => {
                if (!ch || ch.type !== 'JSXElement') return false
                const chTag = ch.opening && ch.opening.name && ch.opening.name.type === 'Identifier'
                  ? ch.opening.name.value
                  : undefined
                const chHasAttrs = ch.opening && Array.isArray((ch.opening as any).attributes) && (ch.opening as any).attributes.length > 0
                const chChildren = ch.children || []
                const chIsSinglePureText =
                  chChildren.length === 1 && (
                    chChildren[0]?.type === 'JSXText' ||
                    (chChildren[0]?.type === 'JSXExpressionContainer' &&
                      getStringLiteralFromExpression(chChildren[0].expression) !== undefined)
                  )
                const chWillBePreserved = chTag && allowedTags.has(chTag) && !chHasAttrs && (chChildren.length === 0 || chIsSinglePureText)
                return !chWillBePreserved
              })

              // Detect if there are other meaningful root-level text nodes (not just formatting/newlines).
              // If so, prefer preserving the <p> as literal HTML to avoid turning the whole root
              // into a numeric placeholder (which would shift expected child indices).
              const hasOtherMeaningfulRootText =
                isRootLevel &&
                meaningfulNodes.some((mn: any) => mn && mn !== n && mn.type === 'JSXText' && !isFormattingWhitespace(mn))

              if (multiplePAtRoot || (isRootLevel && childWillBeIndexed && !hasOtherMeaningfulRootText)) {
                slots.push(n)
                collectSlots(n.children || [], slots, true, false)
              } else {
                // preserve as literal and collect children normally
                collectSlots(n.children || [], slots, false, false)
              }
            } else {
              // Other preserved tags: preserve as literal, don't add to slots
              // But DO process children to add them to slots
              collectSlots(n.children || [], slots, false, false)
            }
          } else {
            // Has single pure text child and no attributes: preserve as literal, don't add to slots
            // Don't process children either - they're part of the preserved tag
          }
          continue
        } else {
          // non-preserved element: the element itself is a single slot.
          // Pre-order: allocate the parent's slot first, then descend into its
          // children. While descending, mark parentIsNonPreserved so
          // KeyValueProperty-style object-expression placeholders are not added
          // as separate sibling slots.
          slots.push(n)
          collectSlots(n.children || [], slots, true)
        }
        continue
      }

      if (n.type === 'JSXFragment') {
        collectSlots(n.children || [], slots, parentIsNonPreserved)
        continue
      }

      // ignore unknown node types
    }
  }

  // prepare the global slot list for the whole subtree
  const globalSlots: any[] = []
  collectSlots(children, globalSlots, false, true)

  // Helper: build a local (restarted) index map for JSXElement children that should render
  // as numeric placeholders, while ALSO counting preceding meaningful text/expressions/<br />
  // as slots (even though they are not rendered as <n>...</n> placeholders).
  function buildLocalChildIndexMap (childrenList: any[]) {
    const map = new Map<any, number>()
    if (!childrenList || !childrenList.length) return map

    const isMeaningfulJSXText = (n: any) =>
      n && n.type === 'JSXText' && !isFormattingWhitespace(n) && String(n.value).length > 0

    const isMeaningfulJSXExpression = (n: any) => {
      if (!n || n.type !== 'JSXExpressionContainer') return false
      const expr = n.expression
      if (!expr || expr.type === 'JSXEmptyExpression') return false

      const lit = getStringLiteralFromExpression(expr)
      if (lit !== undefined) {
        // ignore newline+indentation formatting expressions, but count normal spaces
        if (/^\s*$/.test(lit) && lit.includes('\n')) return false
        return true
      }

      // identifiers / object expressions / calls etc. serialize to {{...}} and still consume a slot
      return true
    }

    const getTag = (el: any): string | undefined =>
      el?.opening?.name?.type === 'Identifier' ? el.opening.name.value : undefined

    const isSinglePureTextChild = (el: any) => {
      const kids = el?.children || []
      return (
        kids.length === 1 && (
          kids[0]?.type === 'JSXText' ||
          (kids[0]?.type === 'JSXExpressionContainer' &&
            getStringLiteralFromExpression(kids[0].expression) !== undefined)
        )
      )
    }

    const isIndexedPlaceholderElement = (el: any) => {
      const tag = getTag(el)
      if (!tag || !allowedTags.has(tag)) return true // non-preserved => always indexed

      // <p> is treated as indexed in this serializer in most cases (and in all non-root cases)
      if (tag === 'p') return true

      const hasAttrs =
        el.opening &&
        Array.isArray((el.opening as any).attributes) &&
        (el.opening as any).attributes.length > 0

      const kids = el.children || []
      const hasKids = kids.length > 0

      // self-closing basic HTML tags are rendered as literal (<br />) not numeric
      if (!hasKids) return false

      // basic HTML with a single pure text child is rendered as literal (<strong>text</strong>)
      if (isSinglePureTextChild(el)) return false

      // basic HTML with attributes + complex children is indexed
      if (hasAttrs) return true

      // complex basic HTML without attrs: only index it if our existing slotter decided it’s a slot
      return globalSlots.indexOf(el) !== -1
    }

    const isLiteralPreservedSelfClosingSlot = (el: any) => {
      const tag = getTag(el)
      if (!tag || !allowedTags.has(tag)) return false
      const kids = el.children || []
      if (kids.length !== 0) return false

      const hasAttrs =
        el.opening &&
        Array.isArray((el.opening as any).attributes) &&
        (el.opening as any).attributes.length > 0

      // Match existing behavior: count <br /> (no attrs) as a slot that shifts later indexes.
      return tag === 'br' && !hasAttrs
    }

    let local = 0
    for (const ch of childrenList) {
      if (!ch) continue

      if (isMeaningfulJSXText(ch) || isMeaningfulJSXExpression(ch)) {
        local += 1
        continue
      }

      if (ch.type === 'JSXElement') {
        if (isIndexedPlaceholderElement(ch)) {
          map.set(ch, local)
          local += 1
        } else if (isLiteralPreservedSelfClosingSlot(ch)) {
          // literal <br /> still occupies a slot position
          local += 1
        }
        continue
      }

      // fragments: do not consume a slot themselves (keep existing behavior)
    }

    return map
  }

  // Track ELEMENT NODES that MUST be tight (no spaces) because the element splits a word across a newline.
  // We'll map these node refs to numeric global indices later before string cleanup.
  const tightNoSpaceNodes = new Set<any>()

  // Trim only newline-only indentation at the edges of serialized inner text.
  // This preserves single leading/trailing spaces which are meaningful between inline placeholders.
  const trimFormattingEdges = (s: string) =>
    String(s)
      // remove leading newline-only indentation
      .replace(/^\s*\n\s*/g, '')
      // remove trailing newline-only indentation
      .replace(/\s*\n\s*$/g, '')

  const getElementTag = (el: any): string | undefined =>
    el?.opening?.name?.type === 'Identifier' ? el.opening.name.value : undefined

  // If el is a preserved/basic-html element with exactly one "pure text" child, return that child's text.
  // Used only for whitespace heuristics around preserved inline tags like <strong>.
  const getSinglePureTextChildText = (el: any): string | undefined => {
    const tag = getElementTag(el)
    if (!tag || !allowedTags.has(tag)) return undefined
    const kids = el?.children || []
    if (kids.length !== 1) return undefined
    const k = kids[0]
    if (!k) return undefined
    if (k.type === 'JSXText') return String(k.value)
    if (k.type === 'JSXExpressionContainer') return getStringLiteralFromExpression(k.expression) // may be undefined
    return undefined
  }

  function visitNodes (nodes: any[], localIndexMap?: Map<any, number>, isRootLevel = false): string {
    if (!nodes || nodes.length === 0) return ''
    let out = ''

    // Resolve a numeric index for a node using localIndexMap when possible.
    // Some AST node references may not match by identity in maps (e.g. after cloning),
    // so also attempt to match by span positions as a fallback.
    const resolveIndex = (n: any) => {
      if (!n) return -1
      if (localIndexMap && localIndexMap.has(n)) return localIndexMap.get(n)
      if (localIndexMap) {
        for (const [k, v] of localIndexMap.entries()) {
          try {
            if (k && n && k.span && n.span && k.span.start === n.span.start && k.span.end === n.span.end) return v
          } catch (e) { /* ignore */ }
        }
      }
      return globalSlots.indexOf(n)
    }

    // Helper to determine the root index.
    // If there are preserved elements (like <p>) that are NOT in globalSlots but are in nodes,
    // we must account for them to ensure subsequent indexed elements get the correct index.
    const getRootIndex = (n: any) => {
      if (!isRootLevel) return globalSlots.indexOf(n)

      // Find the index of n in the original nodes array
      const nodeIndex = nodes.indexOf(n)
      if (nodeIndex === -1) return -1

      // Count how many meaningful siblings (elements or non-formatting text) appear before n
      let meaningfulSiblingsBefore = 0
      for (let i = 0; i < nodeIndex; i++) {
        const sibling = nodes[i]
        if (!sibling) continue
        if (sibling.type === 'JSXText') {
          if (!isFormattingWhitespace(sibling)) meaningfulSiblingsBefore++
        } else if (sibling.type === 'JSXExpressionContainer') {
          // Check if expression is meaningful (not empty/comment)
          if (sibling.expression && sibling.expression.type !== 'JSXEmptyExpression') meaningfulSiblingsBefore++
        } else if (sibling.type === 'JSXElement') {
          meaningfulSiblingsBefore++
        }
      }
      return meaningfulSiblingsBefore
    }

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!node) continue

      if (node.type === 'JSXText') {
        if (isFormattingWhitespace(node)) continue

        const nextNode = nodes[i + 1]
        const prevNode = nodes[i - 1]

        // If this text follows a preserved tag and starts with newline+whitespace, trim it
        if (prevNode && prevNode.type === 'JSXElement') {
          const prevTag = prevNode.opening?.name?.type === 'Identifier' ? prevNode.opening.name.value : undefined
          const prevIsPreservedTag = prevTag && allowedTags.has(prevTag)

          // Only trim leading whitespace after SELF-CLOSING preserved tags (like <br />)
          // Block tags like <p> or inline tags like <strong> need surrounding spaces
          const prevChildren = prevNode.children || []
          const prevIsSelfClosing = prevChildren.length === 0

          if (prevIsPreservedTag && prevIsSelfClosing && /^\s*\n\s*/.test(node.value)) {
            // Text starts with newline after a self-closing preserved tag - trim leading formatting
            const trimmedValue = node.value.replace(/^\s*\n\s*/, '')
            if (trimmedValue) {
              out += trimmedValue
              continue
            }
            // If nothing left after trimming, skip this node
            continue
          }

          // if previous preserved tag is NOT self-closing and its inner text ends with whitespace,
          // drop leading newline/indentation/space from the following text node to avoid double-spacing.
          if (prevIsPreservedTag && !prevIsSelfClosing && /^\s*\n\s*/.test(node.value)) {
            const prevInner = getSinglePureTextChildText(prevNode)
            if (prevInner !== undefined && /\s$/.test(prevInner)) {
              const trimmedValue = node.value
                .replace(/^\s*\n\s*/g, '')
                .replace(/^\s+/g, '')
              if (trimmedValue) {
                out += trimmedValue
                continue
              }
              continue
            }
          }

          // If previous node is a non-preserved element (an indexed placeholder)
          // and the current text starts with a formatting newline, detect
          // the "word-split" scenario: previous meaningful text (before the element)
          // ends with an alnum char and this trimmed text starts with alnum.
          // In that case do NOT insert any separating space — the inline element
          // split a single word across lines.
          if (!prevIsPreservedTag && /^\s*\n\s*/.test(node.value)) {
            const trimmedValue = node.value.replace(/^\s*\n\s*/, '')
            if (trimmedValue) {
              // If the previous element is a self-closing non-preserved element,
              // do not insert an extra separating space — common for inline
              // components like <NumberInput/>days
              if (prevNode && prevNode.type === 'JSXElement' && Array.isArray(prevNode.children) && prevNode.children.length === 0) {
                out += trimmedValue
                continue
              }

              const prevPrev = nodes[i - 2]
              if (prevPrev && prevPrev.type === 'JSXText') {
                const prevPrevTrimmed = prevPrev.value.replace(/\n\s*$/, '')
                const prevEndsAlnum = /[A-Za-z0-9]$/.test(prevPrevTrimmed)
                const nextStartsAlnum = /^[A-Za-z0-9]/.test(trimmedValue)
                const nextStartsLowercase = /^[a-z]/.test(trimmedValue)
                if (prevEndsAlnum && nextStartsAlnum && nextStartsLowercase) {
                  // word-split: do NOT insert a space
                  out += trimmedValue
                  continue
                }
              }
              // non-word-split: insert a separating space before the trimmed text
              out += ' ' + trimmedValue
              continue
            }
            continue
          }
        }

        // If this text node ends with newline+whitespace and is followed by an element,
        if (/\n\s*$/.test(node.value) && nextNode && nextNode.type === 'JSXElement') {
          const textWithoutTrailingNewline = node.value.replace(/\n\s*$/, '')
          if (textWithoutTrailingNewline.trim()) {
            // Check if the next element is a preserved tag
            const nextTag = nextNode.opening?.name?.type === 'Identifier' ? nextNode.opening.name.value : undefined
            const isPreservedTag = nextTag && allowedTags.has(nextTag)

            // Check if the preserved tag has children (not self-closing)
            const nextChildren = nextNode.children || []
            const nextHasChildren = nextChildren.length > 0

            // for preserved tags with a single pure text child, detect leading whitespace in the child
            // so we don't inject an extra space before the tag (e.g. "for\n<strong> 3 seconds </strong>").
            const nextInner = getSinglePureTextChildText(nextNode)
            const nextInnerStartsWithSpace = nextInner !== undefined && /^\s/.test(nextInner)

            // Check if there was a space BEFORE the newline in the source
            const hasSpaceBeforeNewline = /\s\n/.test(node.value)

            // Check if there's text content AFTER the next element
            const nodeAfterNext = nodes[i + 2]
            const hasTextAfter = nodeAfterNext &&
              nodeAfterNext.type === 'JSXText' &&
              !isFormattingWhitespace(nodeAfterNext) &&
              /[a-zA-Z0-9]/.test(nodeAfterNext.value)

            // Does the next element have attributes? (helps decide spacing for tags like <a href="...">)
            const nextHasAttrs = !!(nextNode.opening && Array.isArray((nextNode.opening as any).attributes) && (nextNode.opening as any).attributes.length > 0)

            // Preserve leading whitespace
            // Only treat a real leading space (not a leading newline + indentation) as "leading space"
            const hasLeadingSpace = /^\s/.test(textWithoutTrailingNewline) && !/^\n/.test(textWithoutTrailingNewline)

            const trimmed = textWithoutTrailingNewline.trim()
            const withLeading = hasLeadingSpace ? ' ' + trimmed : trimmed

            // Add trailing space only if:
            // 1. There was an explicit space before the newline, OR
            // 2. The next element is NOT a preserved tag AND has text after (word boundary)
            //    Preserved tags like <br />, <p>, etc. provide their own separation
            // Require an explicit leading space for the "non-preserved + hasTextAfter" case
            // Detect "word-split" case more strictly:
            // - previous trimmed ends with alnum
            // - the text after the element starts with alnum
            // - there was no explicit space before the newline and no explicit leading space,
            // - AND the text-after does NOT itself start with an explicit space.
            const prevEndsWithAlnum = /[A-Za-z0-9]$/.test(trimmed)
            const nextStartsWithAlnum = nodeAfterNext && typeof nodeAfterNext.value === 'string' && /^[A-Za-z0-9]/.test(nodeAfterNext.value.trim())
            const nextStartsWithLowercase = nodeAfterNext && typeof nodeAfterNext.value === 'string' && /^[a-z]/.test(nodeAfterNext.value.trim())
            // Treat newline-leading indentation as NOT an explicit leading space.
            const nextHasLeadingSpace = nodeAfterNext && typeof nodeAfterNext.value === 'string' && /^\s/.test(nodeAfterNext.value) && !/^\n/.test(nodeAfterNext.value)

            // Only treat as a word-split (no space) when the following word begins
            // with a lowercase letter — this avoids removing spaces between separate
            // capitalized / distinct words like "First <1>Second".
            const shouldInsertForNextWithAttrs = nextHasAttrs && nextHasChildren && hasTextAfter && !(
              prevEndsWithAlnum &&
              nextStartsWithAlnum &&
              nextStartsWithLowercase &&
              !hasSpaceBeforeNewline &&
              !hasLeadingSpace &&
              !nextHasLeadingSpace
            )
            // If the text after the next element begins with punctuation, do not insert a space
            const nextStartsWithPunctuation = nodeAfterNext && typeof nodeAfterNext.value === 'string' && /^[,;:!?.]/.test(nodeAfterNext.value.trim())
            const shouldInsertForNextWithAttrsFinal = shouldInsertForNextWithAttrs && !nextStartsWithPunctuation

            // Persist a "tight" decision so post-normalization can remove any artificial
            // spaces that were introduced by whitespace collapsing/newline handling.
            // This ensures cases like "word\n  <1>link</1>\n  word" become "word<1>link</1>word".
            const isWordSplitStrict = prevEndsWithAlnum && nextStartsWithAlnum && nextStartsWithLowercase && !hasSpaceBeforeNewline && !hasLeadingSpace && !nextHasLeadingSpace
            if (isWordSplitStrict) {
              // mark the actual element node; map to numeric index later
              tightNoSpaceNodes.add(nextNode)
            }

            // only auto-insert space before preserved tags with children when the tag's inner
            // does NOT already start with whitespace.
            if (
              hasSpaceBeforeNewline ||
              (isPreservedTag && nextHasChildren && !nextInnerStartsWithSpace) ||
              (!isPreservedTag && hasTextAfter && hasLeadingSpace) ||
              shouldInsertForNextWithAttrsFinal
            ) {
              out += withLeading + ' '
            } else {
              out += withLeading
            }
            continue
          }
        }

        out += node.value
        continue
      }

      if (node.type === 'JSXExpressionContainer') {
        const expr = node.expression
        if (!expr) continue

        const textVal = getStringLiteralFromExpression(expr)
        if (textVal !== undefined) {
          out += textVal
        } else if (expr.type === 'Identifier') {
          out += `{{${expr.value}}}`
        } else if (expr.type === 'TsAsExpression' && expr.expression?.type === 'ObjectExpression') {
          const objExpr = expr.expression
          const keys = objExpr.properties
            .filter((prop: any) => prop.type === 'KeyValueProperty' && prop.key && prop.key.type === 'Identifier')
            .map((prop: any) => prop.key.value)
          if (keys.length > 0) {
            out += keys.map((k: any) => `{{${k}}}`).join('')
          } else {
            const prop = objExpr.properties[0]
            if (prop && prop.type === 'Identifier') {
              out += `{{${prop.value}}}`
            } else {
              // non-fatal
              out += ''
            }
          }
        } else if (expr.type === 'ObjectExpression') {
          const prop = expr.properties[0]
          if (prop && prop.type === 'KeyValueProperty' && prop.key && prop.key.type === 'Identifier') {
            out += `{{${prop.key.value}}}`
          } else if (prop && prop.type === 'Identifier') {
            out += `{{${prop.value}}}`
          } else {
            // non-fatal
            out += ''
          }
        } else if (expr.type === 'MemberExpression' && expr.property && expr.property.type === 'Identifier') {
          out += `{{${expr.property.value}}}`
        } else if (expr.type === 'CallExpression' && expr.callee?.type === 'Identifier') {
          out += `{{${expr.callee.value}}}`
        } else if (expr.type === 'ConditionalExpression') {
          // Support: {cond ? 'a' : 'b'} (static-string branches)
          const a = getStaticStringFromExpression(expr.consequent)
          const b = getStaticStringFromExpression(expr.alternate)

          if (a !== undefined && b !== undefined) {
            // Heuristic:
            // - If one branch is a strict prefix of the other, pick the longer (keeps extra static tail),
            //   e.g. "to select" vs "to select, or right click..."
            // - Otherwise, stay deterministic and prefer consequent (avoids choosing alternates just because they’re 1 char longer).
            const aTrim = a.trim()
            const bTrim = b.trim()

            const aIsPrefixOfB = bTrim.startsWith(aTrim)
            const bIsPrefixOfA = aTrim.startsWith(bTrim)

            if (aIsPrefixOfB && bTrim.length > aTrim.length) out += bTrim
            else if (bIsPrefixOfA && aTrim.length > bTrim.length) out += aTrim
            else out += a
          } else if (a !== undefined) {
            out += a
          } else if (b !== undefined) {
            out += b
          } else {
            // non-fatal: omit non-serializable conditionals
            out += ''
          }
        } else if (expr.type === 'JSXEmptyExpression') {
          // skip
        } else {
          // IMPORTANT: do not throw (throwing skips the whole file extraction)
          out += ''
        }
        continue
      }

      if (node.type === 'JSXElement') {
        // Capture index before incrementing
        const myRuntimeIndex = isRootLevel ? getRootIndex(node) : undefined

        let tag: string | undefined
        if (node.opening && node.opening.name && node.opening.name.type === 'Identifier') {
          tag = node.opening.name.value
        }

        if (tag && allowedTags.has(tag)) {
          // Match react-i18next behavior: only preserve as literal HTML when:
          // 1. No children (!childChildren) AND no attributes (!childPropsCount)
          // 2. OR: Has children but only the children prop (childPropsCount === 1) AND children is a simple string (isString(childChildren))

          const hasAttrs =
            node.opening &&
            Array.isArray((node.opening as any).attributes) &&
            (node.opening as any).attributes.length > 0

          const children = node.children || []
          const hasChildren = children.length > 0

          // Check if children is a single PURE text node (JSXText OR simple string expression)
          const isSinglePureTextChild =
            children.length === 1 && (
              children[0]?.type === 'JSXText' ||
              (children[0]?.type === 'JSXExpressionContainer' &&
                getStringLiteralFromExpression(children[0].expression) !== undefined)
            )

          const isPTag = tag === 'p'
          let pCountAtRoot = 0
          if (isPTag && isRootLevel) {
            pCountAtRoot = nodes.filter((n: any) => n && n.type === 'JSXElement' && n.opening?.name?.value === 'p').length
          }

          // Preserve as literal HTML in two cases:
          // 1. No children and no attributes: <br />
          // 2. Single pure text child (with or without attributes): <strong>text</strong> or <strong title="...">text</strong>
          if ((!hasChildren || isSinglePureTextChild)) {
            const inner = isSinglePureTextChild ? visitNodes(children, undefined) : ''
            const hasMeaningfulChildren = String(inner).trim() !== ''

            if (!hasMeaningfulChildren) {
              // Self-closing
              const prevOriginal = nodes[i - 1]
              if (prevOriginal && prevOriginal.type === 'JSXText' && /\n\s*$/.test(prevOriginal.value)) {
                out = out.replace(/\s+$/, '')
              }
              out += `<${tag} />`
            } else if (allowedTags.has(tag) && tag !== 'p') {
              out += `<${tag}>${trimFormattingEdges(inner)}</${tag}>`
            } else if (isPTag && isRootLevel && pCountAtRoot > 1) {
              // Only preserve <p> as literal HTML if there are multiple root <p> siblings
              out += `<${tag}>${trimFormattingEdges(inner)}</${tag}>`
            } else if (isPTag) {
              // Always index <p> unless it's a root-level <p> among multiple <p> siblings
              const idx = isRootLevel && myRuntimeIndex !== undefined ? myRuntimeIndex : globalSlots.indexOf(node)
              out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
            } else {
              const idx = isRootLevel && myRuntimeIndex !== undefined ? myRuntimeIndex : globalSlots.indexOf(node)
              out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
            }
          } else if (hasAttrs && !isSinglePureTextChild) {
            // Has attributes -> treat as indexed element with numeric placeholder
            const idx = isRootLevel && myRuntimeIndex !== undefined ? myRuntimeIndex : resolveIndex(node)

            // IMPORTANT: child indexing must account for meaningful text and {" "} expression slots,
            // otherwise inline elements inside <p> end up as <0>...</0> instead of <1>/<2>/...
            const childrenLocalMap = buildLocalChildIndexMap(children)
            const inner = visitNodes(children, childrenLocalMap.size ? childrenLocalMap : undefined)

            out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
          } else {
            // Has complex children but no attributes -> preserve tag as literal but index children
            const idx = globalSlots.indexOf(node)
            if (idx !== -1) {
              // This tag is in globalSlots, so index it
              const indexToUse = myRuntimeIndex !== undefined ? myRuntimeIndex : idx

              // Use the same slot-aware local mapping for children (counts text + {" "} + <br /> as slots)
              const childrenLocalMap = buildLocalChildIndexMap(children)
              const inner = visitNodes(children, childrenLocalMap.size ? childrenLocalMap : undefined, false)

              out += `<${indexToUse}>${trimFormattingEdges(inner)}</${indexToUse}>`
            } else {
              // Not in globalSlots, preserve as literal HTML
              const inner = visitNodes(children, undefined, false)
              out += `<${tag}>${trimFormattingEdges(inner)}</${tag}>`
            }
          }
        } else {
          // Non-preserved element: always render this element with its global index,
          // but compute CHILD placeholder indices locally (restarted at 0) while
          // counting meaningful text/expressions/<br /> as slot positions.
          const kids = node.children || []
          const idx = resolveIndex(node)

          const kidsLocalMap = buildLocalChildIndexMap(kids)
          const inner = visitNodes(kids, kidsLocalMap.size ? kidsLocalMap : undefined)

          out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
        }
        continue
      }

      if (node.type === 'JSXFragment') {
        out += visitNodes(node.children || [])
        continue
      }

      // unknown node types: ignore
    }

    return out
  }

  const result = visitNodes(children, undefined, true)

  // console.log('[serializeJSXChildren] result before cleanup:', JSON.stringify(result))
  // console.log('[serializeJSXChildren] tightNoSpaceNodes:', Array.from(tightNoSpaceNodes || []))
  // console.log('[serializeJSXChildren] globalSlots:', JSON.stringify(globalSlots, null, 2))
  // const slotContexts = globalSlots.map((s, idx) => {
  //   const prev = globalSlots[idx - 1]
  //   const next = globalSlots[idx + 1]
  //   return {
  //     idx,
  //     type: s ? s.type : null,
  //     tag: s && s.type === 'JSXElement' ? s.opening?.name?.value : undefined,
  //     preview: s && s.type === 'JSXText' ? String(s.value).slice(0, 40) : undefined,
  //     prevType: prev ? prev.type : null,
  //     prevPreview: prev && prev.type === 'JSXText' ? String(prev.value).slice(0, 40) : undefined,
  //     nextType: next ? next.type : null,
  //     nextPreview: next && next.type === 'JSXText' ? String(next.value).slice(0, 40) : undefined
  //   }
  // })
  // console.log('[serializeJSXChildren] slotContexts:', JSON.stringify(slotContexts, null, 2))

  // Final cleanup in correct order:
  // 1. First, handle <br /> followed by whitespace+newline (boundary formatting)
  const afterBrCleanup = String(result).replace(/<br \/>\s*\n\s*/g, '<br />')

  const raw = String(afterBrCleanup)

  const tightNoSpaceIndices = new Set<number>()

  // Map node-based tight markers into numeric global-slot indices (used by later regex passes).
  if (tightNoSpaceNodes && tightNoSpaceNodes.size > 0) {
    for (let i = 0; i < globalSlots.length; i++) {
      if (tightNoSpaceNodes.has(globalSlots[i])) tightNoSpaceIndices.add(i)
    }
  }

  // 1) Remove spaces around explicitly-marked tight indices (word-splits)
  let tmp = String(raw)
  if (tightNoSpaceIndices && tightNoSpaceIndices.size > 0) {
    for (const id of tightNoSpaceIndices) {
      try {
        tmp = tmp.replace(new RegExp('\\s+<' + id + '>', 'g'), '<' + id + '>')
        tmp = tmp.replace(new RegExp('<\\/' + id + '>\\s+', 'g'), '</' + id + '>')
      } catch (e) { /* ignore */ }
    }
  }

  // 2) For non-tight placeholders, if there was a newline boundary between
  //    a closing tag and following text OR between preceding text and an
  //    opening tag, ensure a single separating space. This recovers spaces
  //    that are semantically meaningful when the source had newline
  //    boundaries but not a word-split.
  tmp = tmp.replace(/<\/(\d+)>\s*\n\s*(\S)/g, (m, idx, after) => {
    const id = Number(idx)
    return tightNoSpaceIndices.has(id) ? `</${idx}>${after}` : `</${idx}> ${after}`
  })
  tmp = tmp.replace(/(\S)\s*\n\s*<(\d+)/g, (m, before, idx) => {
    const id = Number(idx)
    return tightNoSpaceIndices.has(id) ? `${before}<${idx}` : `${before} <${idx}`
  })

  // 3) Collapse remaining newlines/indentation and whitespace to single spaces,
  //    remove space before period and trim.
  tmp = tmp.replace(/\s*\n\s*/g, ' ')
  tmp = tmp.replace(/\s+/g, ' ')

  // Tighten whitespace inside parentheses around interpolations/placeholders:
  // "( {{x}})" -> "({{x}})" and "({{x}} )" -> "({{x}})"
  tmp = tmp.replace(/\(\s+(\{\{)/g, '($1')
  tmp = tmp.replace(/(\}\})\s+\)/g, '$1)')

  // remove spaces before common punctuation (comma, semicolon, colon, question, exclamation, period)
  tmp = tmp.replace(/\s+([,;:!?.])/g, '$1')
  const finalResult = tmp.trim()

  // Final guaranteed cleanup for tight (word-split) placeholders:
  // remove any spaces (including NBSP) left before opening or after closing numeric placeholders
  // to ensure "word <1>link</1>word" -> "word<1>link</1>word" when marked tight.
  let postFinal = String(finalResult)
  if (tightNoSpaceIndices && tightNoSpaceIndices.size > 0) {
    for (const id of tightNoSpaceIndices) {
      try {
        // remove ordinary whitespace and non-breaking space variants
        postFinal = postFinal.replace(new RegExp('[\\s\\u00A0]+<' + id + '>', 'g'), '<' + id + '>')
        postFinal = postFinal.replace(new RegExp('<\\/' + id + '>[\\s\\u00A0]+', 'g'), '</' + id + '>')
      } catch (e) { /* ignore */ }
    }
  }

  // Additional deterministic pass:
  // If globalSlots show an element whose previous slot is JSXText ending with alnum
  // and next slot is JSXText starting with alnum, and the original previous text did
  // not have an explicit space-before-newline nor the next text a leading space,
  // remove any single space left before the opening placeholder in the final string.
  try {
    for (let idx = 0; idx < globalSlots.length; idx++) {
      const s = globalSlots[idx]
      if (!s || s.type !== 'JSXElement') continue
      const prev = globalSlots[idx - 1]
      const next = globalSlots[idx + 1]
      if (!prev || !next) continue
      if (prev.type !== 'JSXText' || next.type !== 'JSXText') continue

      const prevRaw = String(prev.value)
      const nextRaw = String(next.value)
      const prevTrimmed = prevRaw.replace(/\n\s*$/, '')
      const prevEndsAlnum = /[A-Za-z0-9]$/.test(prevTrimmed)
      const nextStartsAlnum = /^[A-Za-z0-9]/.test(nextRaw.trim())
      const nextStartsLowercase = /^[a-z]/.test(nextRaw.trim())
      const hasSpaceBeforeNewline = /\s\n/.test(prevRaw)
      // Treat newline-leading indentation as NOT an explicit leading space.
      const nextHasLeadingSpace = nextRaw && /^\s/.test(nextRaw) && !/^\n/.test(nextRaw)

      // Only collapse the space for true word-splits where the next token starts lowercase.
      if (prevEndsAlnum && nextStartsAlnum && nextStartsLowercase && !hasSpaceBeforeNewline && !nextHasLeadingSpace) {
        const id = idx
        postFinal = postFinal.replace(new RegExp('\\s+<' + id + '>', 'g'), '<' + id + '>')
      }
    }
  } catch (e) { /* ignore */ }

  return postFinal.trim()
}
