import type { Expression, JSXAttribute, JSXElement, JSXExpression, ObjectExpression } from '@swc/core'
import type { I18nextToolkitConfig } from '../../types'
import { getObjectPropValue, getObjectPropValueExpression, isSimpleTemplateLiteral } from './ast-utils'

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
            // For <p> tags at root level with multiple <p> siblings, index them
            // For other preserved tags, preserve as literal (don't add to slots)
            if (tagName === 'p' && multiplePAtRoot) {
              slots.push(n)
              collectSlots(n.children || [], slots, true, false)
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

  // Trim only newline-only indentation at the edges of serialized inner text.
  // This preserves single leading/trailing spaces which are meaningful between inline placeholders.
  const trimFormattingEdges = (s: string) =>
    String(s)
      // remove leading newline-only indentation
      .replace(/^\s*\n\s*/g, '')
      // remove trailing newline-only indentation
      .replace(/\s*\n\s*$/g, '')

  function visitNodes (nodes: any[], localIndexMap?: Map<any, number>, isRootLevel = false): string {
    if (!nodes || nodes.length === 0) return ''
    let out = ''

    // At root level, build index based on element position among siblings
    let rootElementIndex = 0

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!node) continue

      if (node.type === 'JSXText') {
        if (isFormattingWhitespace(node)) continue
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
        continue
      }

      if (node.type === 'JSXElement') {
        let tag: string | undefined
        if (node.opening && node.opening.name && node.opening.name.type === 'Identifier') {
          tag = node.opening.name.value
        }

        // Track root element index for root-level elements
        const myRootIndex = isRootLevel ? rootElementIndex : undefined
        if (isRootLevel && node.type === 'JSXElement') {
          rootElementIndex++
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
            } else {
              // Preserve with content: <strong>text</strong>
              out += `<${tag}>${inner}</${tag}>`
            }
          } else if (hasAttrs && !isSinglePureTextChild) {
            // Has attributes -> treat as indexed element with numeric placeholder
            const childrenLocal = children
            const hasNonElementGlobalSlots = childrenLocal.some((ch: any) =>
              ch && (ch.type === 'JSXText' || ch.type === 'JSXExpressionContainer') && globalSlots.indexOf(ch) !== -1
            )

            if (hasNonElementGlobalSlots) {
              const idx = globalSlots.indexOf(node)
              const inner = visitNodes(childrenLocal, undefined)
              out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
            } else {
              const childrenLocalMap = new Map<any, number>()
              let localIdxCounter = 0
              for (const ch of childrenLocal) {
                if (!ch) continue
                if (ch.type === 'JSXElement') {
                  const chTag = ch.opening && ch.opening.name && ch.opening.name.type === 'Identifier'
                    ? ch.opening.name.value
                    : undefined
                  if (chTag && allowedTags.has(chTag)) {
                    const chHasAttrs =
                      ch.opening &&
                      Array.isArray((ch.opening as any).attributes) &&
                      (ch.opening as any).attributes.length > 0
                    const chChildren = ch.children || []
                    const chIsSingleText = chChildren.length === 1 && chChildren[0]?.type === 'JSXText'
                    // Only skip indexing if it would be preserved as literal
                    if (!chHasAttrs && (!chChildren.length || chIsSingleText)) {
                      // Will be preserved, don't index
                    } else {
                      childrenLocalMap.set(ch, localIdxCounter++)
                    }
                  } else {
                    childrenLocalMap.set(ch, localIdxCounter++)
                  }
                }
              }

              const idx = localIndexMap && localIndexMap.has(node) ? localIndexMap.get(node) : globalSlots.indexOf(node)
              const inner = visitNodes(childrenLocal, childrenLocalMap.size ? childrenLocalMap : undefined)
              out += `<${idx}>${trimFormattingEdges(inner)}</${idx}>`
            }
          } else {
            // Has complex children but no attributes -> preserve tag as literal but index children
            // Check if this tag is in globalSlots - if so, index it
            const idx = globalSlots.indexOf(node)
            if (idx !== -1) {
              // This tag is in globalSlots, so index it
              // At root level, use the element's position among root elements
              const indexToUse = myRootIndex !== undefined ? myRootIndex : idx

              // Check if children have text/expression nodes in globalSlots
              // that appear BEFORE or BETWEEN element children (not just trailing)
              // Exclude formatting whitespace (newline-only text) from this check
              const hasNonElementGlobalSlots = (() => {
                let foundElement = false

                for (const ch of children) {
                  if (!ch) continue

                  if (ch.type === 'JSXElement') {
                    foundElement = true
                    continue
                  }

                  if (ch.type === 'JSXExpressionContainer' && globalSlots.indexOf(ch) !== -1) {
                    // Only count if before/between elements, not trailing
                    return foundElement  // false if before first element, true if after
                  }

                  if (ch.type === 'JSXText' && globalSlots.indexOf(ch) !== -1) {
                    // Exclude formatting whitespace
                    if (isFormattingWhitespace(ch)) continue

                    // Only count text that appears BEFORE the first element
                    // Trailing text after all elements should not force global indexing
                    if (!foundElement) {
                      // Text before first element - counts
                      return true
                    }
                    // Text after an element - check if there are more elements after this text
                    const remainingNodes = children.slice(children.indexOf(ch) + 1)
                    const hasMoreElements = remainingNodes.some((n: any) => n && n.type === 'JSXElement')
                    if (hasMoreElements) {
                      // Text between elements - counts
                      return true
                    }
                    // Trailing text after last element - doesn't count
                  }
                }

                return false
              })()

              // If children have non-element global slots, use global indexes
              // Otherwise use local indexes starting from parent's index + 1
              if (hasNonElementGlobalSlots) {
                const inner = visitNodes(children, undefined, false)
                out += `<${indexToUse}>${trimFormattingEdges(inner)}</${indexToUse}>`
                continue
              }

              // Build local index map for children of this indexed element
              const childrenLocalMap = new Map<any, number>()
              let localIdxCounter = indexToUse  // Start from parent index (reuse parent's index for first child)
              for (const ch of children) {
                if (!ch) continue
                if (ch.type === 'JSXElement') {
                  const chTag = ch.opening && ch.opening.name && ch.opening.name.type === 'Identifier'
                    ? ch.opening.name.value
                    : undefined

                  if (chTag && allowedTags.has(chTag)) {
                    // Check if this child will be preserved as literal HTML
                    const chHasAttrs =
                      ch.opening &&
                      Array.isArray((ch.opening as any).attributes) &&
                      (ch.opening as any).attributes.length > 0
                    const chChildren = ch.children || []
                    const chIsSinglePureText =
                      chChildren.length === 1 && (
                        chChildren[0]?.type === 'JSXText' ||
                        (chChildren[0]?.type === 'JSXExpressionContainer' &&
                          getStringLiteralFromExpression(chChildren[0].expression) !== undefined)
                      )
                    const chWillBePreserved = !chHasAttrs && (!chChildren.length || chIsSinglePureText)
                    if (!chWillBePreserved) {
                      // Will be indexed, add to local map
                      childrenLocalMap.set(ch, localIdxCounter++)
                    }
                  } else {
                    // Non-preserved tag, always indexed
                    childrenLocalMap.set(ch, localIdxCounter++)
                  }
                }
              }
              const inner = visitNodes(children, childrenLocalMap.size > 0 ? childrenLocalMap : undefined, false)
              out += `<${indexToUse}>${trimFormattingEdges(inner)}</${indexToUse}>`
            } else {
              // Not in globalSlots, preserve as literal HTML
              const inner = visitNodes(children, undefined, false)
              out += `<${tag}>${trimFormattingEdges(inner)}</${tag}>`
            }
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
                  // Check if this child will be preserved as literal HTML
                  const chHasAttrs =
                    ch.opening &&
                    Array.isArray((ch.opening as any).attributes) &&
                    (ch.opening as any).attributes.length > 0
                  const chChildren = ch.children || []
                  const chIsSinglePureText = chChildren.length === 1 && chChildren[0]?.type === 'JSXText'
                  const chWillBePreserved = !chHasAttrs && (!chChildren.length || chIsSinglePureText)
                  if (!chWillBePreserved) {
                    // Will be indexed, add to local map
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
          }
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

  // Final cleanup in correct order:
  // 1. First, handle <br /> followed by whitespace+newline (boundary formatting)
  const afterBrCleanup = String(result).replace(/<br \/>\s*\n\s*/g, '<br />')

  // 2. Then normalize remaining whitespace sequences to single space
  const normalized = afterBrCleanup.replace(/\s+/g, ' ')

  // 3. Remove space before period at end
  const finalResult = normalized.replace(/\s+\./g, '.')

  return finalResult.trim()
}
