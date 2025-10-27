import type { Expression, JSXAttribute, JSXElement, JSXExpression, ObjectExpression, Property } from '@swc/core'
import type { I18nextToolkitConfig } from '../../types'
import { getObjectProperty, getObjectPropValue, isSimpleTemplateLiteral } from './ast-utils'

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
      const contextPropFromOptions = getObjectProperty(optionsNode, 'context')
      if (contextPropFromOptions?.value) {
        contextExpression = contextPropFromOptions.value
      }
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

  // Build deterministic global slot list (pre-order)
  function collectSlots (nodes: any[], slots: any[], parentIsNonPreserved = false) {
    if (!nodes || !nodes.length) return

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
        // When inside a non-preserved parent that has no element children (e.g. <pre>),
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
        // If this expression is inside a non-preserved parent element that has NO
        // element children (e.g. <pre>{'foo'}</pre>), treat common simple expressions
        // as part of the parent and do NOT add them as separate sibling/global slots.
        if (parentIsNonPreserved && !parentHasElementChildren && n.expression) {
          const exprType = n.expression.type
          // ObjectExpression placeholders ({{ key: value }}) should be treated
          // as part of the parent.
          if (exprType === 'ObjectExpression') {
            const prop = n.expression.properties && n.expression.properties[0]
            if (prop && prop.type === 'KeyValueProperty') {
              continue
            }
          }

          // For common simple content expressions, don't allocate a separate slot.
          // However, if it's a pure-space StringLiteral ({" "}) we want to keep the
          // special-space handling below, so only skip non-whitespace string literals.
          const textVal = getStringLiteralFromExpression(n.expression)
          if (textVal !== undefined) {
            const isPureSpaceNoNewline = /^\s*$/.test(textVal) && !textVal.includes('\n')
            if (!isPureSpaceNoNewline) {
              continue
            }
            // otherwise fall through to the pure-space handling below
          } else if (exprType === 'Identifier' || exprType === 'MemberExpression' || exprType === 'CallExpression') {
            continue
          }
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

          if (isPureSpaceNoNewline) {
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
            //    This preserves "foo{' '}bar" as a single text node but avoids merging
            //    when the {" "} is followed by newline-only formatting before an element.
            const nextIsTextNonFormatting = !nextOriginal || (nextOriginal.type === 'JSXText' && !isFormattingWhitespace(nextOriginal))
            if (prevOriginal && prevOriginal.type === 'JSXText' && nextIsTextNonFormatting) {
              const prevSlot = slots[slots.length - 1]
              if (prevSlot && prevSlot.type === 'JSXText') {
                prevSlot.value = String(prevSlot.value) + n.expression.value
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

        // All JSXExpressionContainers count as slots for indexing.
        slots.push(n)
        continue
      }

      if (n.type === 'JSXElement') {
        const tagName = n.opening && n.opening.name && n.opening.name.type === 'Identifier'
          ? n.opening.name.value
          : undefined
        if (tagName && allowedTags.has(tagName)) {
          // Count preserved HTML element as a global slot only when the AST
          // marks it self-closing (e.g. <br />). Self-closing preserved tags
          // should influence placeholder indexes (they appear inline without
          // children), while non-self-closing preserved tags (e.g. <strong>)
          // should not.
          const isAstSelfClosing = !!(n.opening && (n.opening as any).selfClosing)
          if (isAstSelfClosing) {
            slots.push(n)
          }
          collectSlots(n.children || [], slots, false)
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
  collectSlots(children, globalSlots, false)

  // Trim only newline-only indentation at the edges of serialized inner text.
  // This preserves single leading/trailing spaces which are meaningful between inline placeholders.
  const trimFormattingEdges = (s: string) =>
    String(s)
      // remove leading newline-only indentation
      .replace(/^\s*\n\s*/g, '')
      // remove trailing newline-only indentation
      .replace(/\s*\n\s*$/g, '')

  function visitNodes (nodes: any[], localIndexMap?: Map<any, number>): string {
    if (!nodes || nodes.length === 0) return ''
    let out = ''
    let lastWasSelfClosing = false

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!node) continue

      if (node.type === 'JSXText') {
        if (isFormattingWhitespace(node)) continue
        if (lastWasSelfClosing) {
          out += node.value.replace(/^\s+/, '')
          lastWasSelfClosing = false
        } else {
          out += node.value
        }
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
        } else if (expr.type === 'ObjectExpression') {
          const prop = expr.properties[0]
          if (prop && prop.type === 'KeyValueProperty' && prop.key && prop.key.type === 'Identifier') {
            out += `{{${prop.key.value}}}`
          } else if (prop && prop.type === 'Identifier') {
            out += `{{${prop.value}}}`
          } else {
            out += '{{value}}'
          }
        } else if (expr.type === 'MemberExpression' && expr.property && expr.property.type === 'Identifier') {
          out += `{{${expr.property.value}}}`
        } else if (expr.type === 'CallExpression' && expr.callee?.type === 'Identifier') {
          out += `{{${expr.callee.value}}}`
        } else {
          out += '{{value}}'
        }
        lastWasSelfClosing = false
        continue
      }

      if (node.type === 'JSXElement') {
        let tag: string | undefined
        if (node.opening && node.opening.name && node.opening.name.type === 'Identifier') {
          tag = node.opening.name.value
        }

        if (tag && allowedTags.has(tag)) {
          const inner = visitNodes(node.children || [], localIndexMap)
          // consider element self-closing for rendering when AST marks it so or it has no meaningful children
          const isAstSelfClosing = !!(node.opening && (node.opening as any).selfClosing)
          const hasMeaningfulChildren = String(inner).trim() !== ''
          if (isAstSelfClosing || !hasMeaningfulChildren) {
            // If the previous original sibling is a JSXText that ends with a
            // newline (the tag was placed on its own indented line), trim any
            // trailing space we've accumulated so we don't leave " ... . <br/>".
            // This targeted trimming avoids breaking other spacing-sensitive cases.
            const prevOriginal = nodes[i - 1]
            if (prevOriginal && prevOriginal.type === 'JSXText' && /\n\s*$/.test(prevOriginal.value)) {
              out = out.replace(/\s+$/, '')
            }
            out += `<${tag}/>`
            lastWasSelfClosing = true
          } else {
            out += `<${tag}>${inner}</${tag}>`
            lastWasSelfClosing = false
          }
        } else {
          // Decide whether to use local (restarted) indexes for this element's
          // immediate children or fall back to the global pre-order indexes.
          // If the element's children contain non-element slots (JSXText /
          // JSXExpressionContainer) that were collected as global slots, we must
          // use the global indexes so those text slots keep their positions.
          const children = node.children || []
          const hasNonElementGlobalSlots = children.some((ch: any) =>
            ch && (ch.type === 'JSXText' || ch.type === 'JSXExpressionContainer') && globalSlots.indexOf(ch) !== -1
          )

          // If there are non-element global slots among the children, render using
          // global indexes. Otherwise build a compact local index map so nested
          // placeholders restart at 0 inside this parent element.
          if (hasNonElementGlobalSlots) {
            const idx = globalSlots.indexOf(node)
            const inner = visitNodes(children, undefined)
            out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
            lastWasSelfClosing = false
          } else {
            const childrenLocalMap = new Map<any, number>()
            let localIdxCounter = 0
            for (const ch of children) {
              if (!ch) continue
              if (ch.type === 'JSXElement') {
                const chTag = ch.opening && ch.opening.name && ch.opening.name.type === 'Identifier'
                  ? ch.opening.name.value
                  : undefined
                if (chTag && allowedTags.has(chTag)) {
                  const isChSelfClosing = !!(ch.opening && (ch.opening as any).selfClosing)
                  if (isChSelfClosing) {
                    childrenLocalMap.set(ch, localIdxCounter++)
                  }
                } else {
                  childrenLocalMap.set(ch, localIdxCounter++)
                }
              }
            }

            const idx = localIndexMap && localIndexMap.has(node) ? localIndexMap.get(node) : globalSlots.indexOf(node)
            const inner = visitNodes(children, childrenLocalMap.size ? childrenLocalMap : undefined)
            out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
            lastWasSelfClosing = false
          }
        }
        continue
      }

      if (node.type === 'JSXFragment') {
        out += visitNodes(node.children || [])
        lastWasSelfClosing = false
        continue
      }

      // unknown node types: ignore
    }

    return out
  }

  const result = visitNodes(children)
  return String(result).replace(/\s+/g, ' ').trim()
}
