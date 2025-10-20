// src/extractor/parsers/jsx-parser.test.ts
import { describe, it, expect } from 'vitest'
import { extractFromTransComponent } from '../src/extractor/parsers/jsx-parser'

function makeText (value: string) {
  return { type: 'JSXText', value }
}

function makeExprString (value: string) {
  return { type: 'JSXExpressionContainer', expression: { type: 'StringLiteral', value } }
}

function makeExprObject (key: string, inner: any) {
  return {
    type: 'JSXExpressionContainer',
    expression: {
      type: 'ObjectExpression',
      properties: [
        {
          type: 'KeyValueProperty',
          key: { type: 'Identifier', value: key },
          value: inner
        }
      ]
    }
  }
}

function makeElement (tag: string, children: any[] = []) {
  return {
    type: 'JSXElement',
    opening: {
      type: 'JSXOpeningElement',
      name: { type: 'Identifier', value: tag },
      attributes: [],
      selfClosing: false,
      typeArguments: null
    },
    children,
    closing: {
      type: 'JSXClosingElement',
      name: { type: 'Identifier', value: tag }
    }
  }
}

const baseConfig: any = {
  extract: {
    defaultValue: '',
    transKeepBasicHtmlNodesFor: ['br', 'strong', 'i', 'p']
  }
}

describe('jsx-parser: prevOriginal whitespace merging', () => {
  it('should ignore boundary whitespace-only JSXText nodes so component indexes start at first meaningful child', () => {
    // Structure:
    // [ formatting boundary text, JSXExpressionContainer(' '), JSXText with actual content, JSXElement<span>..., last text ]
    const node: any = {
      opening: { attributes: [] },
      children: [
        makeText('\n        '), // boundary formatting-only (should be ignored at start)
        makeExprString(' '), // expression containing space -> may merge
        makeText('\n        got'), // meaningful text (not pure whitespace)
        makeExprString(' '),
        makeText('\n        '),
        makeElement('span', [
          makeText('\n          '),
          makeExprObject('username', { type: 'MemberExpression', property: { type: 'Identifier', value: 'userName' }, object: { type: 'Identifier', value: 'item' } }),
          makeText('\n        ')
        ]),
        makeExprString(' '),
        makeText('\n        ticket\n      ')
      ]
    }

    const res = extractFromTransComponent(node, baseConfig)
    expect(res).not.toBeNull()
    // Ensure serializedChildren contains placeholders and preserved content.
    // We're mainly interested that serialization runs without injecting extra initial empty slots.
    expect(typeof res!.serializedChildren).toBe('string')
    // it should include the span content placeholder somewhere and the words 'got' and 'ticket'
    expect(res!.serializedChildren).toContain('got')
    expect(res!.serializedChildren).toContain('ticket')
    expect(res!.serializedChildren).toContain('<') // placeholder/tag markers present
  })

  it('should calculate correct index for children (next index) - prevOriginal handling', () => {
    // Structure intended to test prevOriginal merging:
    // [
    //   JSXText: "First line with empty JSXTextNode" (meaningful),
    //   JSXExpr: " " (should merge into previous),
    //   JSXText: "\n        " (formatting-only interior),
    //   JSXElement <a>Span that should have index 2 but has index 0</a>,
    //   JSXText: "\n        Second line\n      "
    // ]
    const node: any = {
      opening: { attributes: [] },
      children: [
        makeText('\n        First line with empty JSXTextNode'),
        makeExprString(' '),
        makeText('\n        '), // formatting-only, should be treated as formatting (prevOriginal logic)
        makeElement('a', [makeText('Span that should have index 2 but has index 0')]),
        makeText('\n        Second line\n      ')
      ]
    }

    const res = extractFromTransComponent(node, baseConfig)
    expect(res).not.toBeNull()
    // Expected serialization: previous text, then <2> element, then second line
    // (the intended correct behavior: element gets index 2)
    const expectedDefaultValue = 'First line with empty JSXTextNode <2>Span that should have index 2 but has index 0</2> Second line'
    expect(res!.defaultValue).toEqual(expectedDefaultValue)
  })

  it('should match extractor case: object-expression spans with explicit {" "} and preserve expected indexes', () => {
    const node: any = {
      opening: { attributes: [] },
      children: [
        makeText('\n        '),
        makeElement('span', [
          makeText('\n          '),
          makeExprObject('username', { type: 'MemberExpression', property: { type: 'Identifier', value: 'userName' }, object: { type: 'Identifier', value: 'item' } }),
          makeText('\n        ')
        ]),
        makeExprString(' '),
        makeText('\n        got'),
        makeExprString(' '),
        makeText('\n        '),
        makeElement('span', [
          makeText('\n          '),
          makeExprObject('count', { type: 'NumericLiteral', value: 1 }),
          makeText('\n        ')
        ]),
        makeExprString(' '),
        makeText('\n        ticket\n      ')
      ]
    }

    const res = extractFromTransComponent(node, baseConfig)
    expect(res).not.toBeNull()

    // Expect the first <span> to be placeholder 0 and the second placeholder 4
    const expected = '<0>{{username}}</0> got <4>{{count}}</4> ticket'
    expect(res!.defaultValue).toEqual(expected)
  })
})
