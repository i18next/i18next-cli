import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { glob } from 'glob'
import { parseTree, findNodeAtLocation } from 'jsonc-parser'
import type { I18nextToolkitConfig, LintIssue } from '../types.js'
import { getOutputPath, loadTranslationFile } from './file-utils.js'

/** What an ICU or MF2 message uses. */
export interface MessageShape {
  /** Argument names (`{name}` in ICU, `{$name}` in MF2). `#` and markup are not arguments. */
  args: Set<string>
  /** Plural selections: their CLDR category selectors and the numbers of their exact selectors (`=0` in ICU, `0` in MF2). */
  plurals: Array<{ arg: string, type: 'cardinal' | 'ordinal', categories: string[], exact: number[] }>
}

/** Parses an ICU or MF2 message. Throws an Error with the parser's message on a syntax error. */
export type MessageAnalyzer = (message: string) => MessageShape

/**
 * True for `extract.messageFormat` `'icu'` and `'mf2'`. These formats put plurals and selects into the
 * message itself and have no `$t()` nesting, so the CLI writes no plural or context suffix keys for them.
 */
export const usesMessageFormat = (config: Pick<I18nextToolkitConfig, 'extract'>): boolean =>
  config.extract.messageFormat === 'icu' || config.extract.messageFormat === 'mf2'

/**
 * Rewrites i18next placeholders (`{{name}}`, `{{name, format}}`) into the configured message format:
 * `{name}` / `{name, format}` for ICU, `{$name}` / `{$name :format}` for MF2. Other values are returned as is.
 * ponytail: literal braces in the text are not escaped for ICU or MF2.
 */
export function toMessageFormatPlaceholders (value: string, config: Pick<I18nextToolkitConfig, 'extract'>): string {
  const format = config.extract.messageFormat
  if (format !== 'icu' && format !== 'mf2') return value
  return value.replace(/\{\{\s*([^{},\s]+)\s*(?:,\s*([^{}]*?)\s*)?\}\}/g, (_, name: string, fmt?: string) =>
    format === 'icu' ? `{${name}${fmt ? `, ${fmt}` : ''}}` : `{$${name}${fmt ? ` :${fmt}` : ''}}`)
}

const CLDR_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other']
const byCldrOrder = (a: string, b: string) => CLDR_ORDER.indexOf(a) - CLDR_ORDER.indexOf(b)
const MF2_NUMBER_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/

/**
 * Loads the parser for `messageFormat` lazily, so projects in the i18next format never load it.
 */
export async function loadMessageAnalyzer (format: 'icu' | 'mf2'): Promise<MessageAnalyzer> {
  if (format === 'icu') {
    const { parse, TYPE } = await import('@formatjs/icu-messageformat-parser')
    const walk = (elements: any[], shape: MessageShape) => {
      for (const el of elements) {
        if (el.type === TYPE.literal || el.type === TYPE.pound) continue
        if (el.type === TYPE.tag) {
          walk(el.children, shape)
          continue
        }
        shape.args.add(el.value)
        if (el.type === TYPE.plural) {
          const selectors = Object.keys(el.options)
          shape.plurals.push({
            arg: el.value,
            type: el.pluralType === 'ordinal' ? 'ordinal' : 'cardinal',
            categories: selectors.filter(selector => !selector.startsWith('=')),
            exact: selectors.filter(selector => selector.startsWith('=')).map(selector => Number(selector.slice(1))),
          })
        }
        if (el.type === TYPE.plural || el.type === TYPE.select) {
          for (const option of Object.values<any>(el.options)) walk(option.value, shape)
        }
      }
    }
    return (message) => {
      let elements
      try {
        // ignoreTag like i18next-icu, so the <0>…</0> placeholders of <Trans> stay text
        elements = parse(message, { ignoreTag: true })
      } catch (err: any) {
        const column = err?.location?.start?.column
        throw new Error(column ? `${err.message} at column ${column}` : String(err?.message ?? err))
      }
      const shape: MessageShape = { args: new Set(), plurals: [] }
      walk(elements, shape)
      return shape
    }
  }

  const { parseMessage, validate } = await import('messageformat')
  return (message) => {
    const msg = parseMessage(message) // throws a MessageSyntaxError
    const shape: MessageShape = { args: validate(msg).variables, plurals: [] } // validate throws a MessageDataModelError
    if (msg.type !== 'select') return shape
    msg.selectors.forEach((selector, i) => {
      const type = mf2PluralType(msg.declarations, selector.name)
      if (!type) return
      const categories = new Set<string>()
      const exact: number[] = []
      for (const { keys } of msg.variants) {
        const key = keys[i]
        if (key.type === '*') categories.add('other')
        else if (MF2_NUMBER_LITERAL.test(key.value)) exact.push(Number(key.value))
        else categories.add(key.value)
      }
      shape.plurals.push({ arg: selector.name, type, categories: [...categories], exact })
    })
    return shape
  }
}

// The plural type a `.match` selector variable resolves to, following `.local $a = {$b}` references.
// ponytail: only :number and :integer select by plural category; the draft :percent and :currency are not checked.
function mf2PluralType (declarations: any[], name: string): 'cardinal' | 'ordinal' | undefined {
  let decl = declarations.find(d => d.name === name)
  for (let hops = 0; decl && hops <= declarations.length; hops++) {
    const fn = decl.value.functionRef
    if (fn) {
      if (fn.name !== 'number' && fn.name !== 'integer') return undefined
      const select = fn.options?.select
      if (!select) return 'cardinal'
      if (select.type !== 'literal') return undefined
      return select.value === 'ordinal' ? 'ordinal' : select.value === 'plural' ? 'cardinal' : undefined
    }
    const arg = decl.value.arg
    decl = arg?.type === 'variable' && arg.name !== decl.name ? declarations.find(d => d.name === arg.name) : undefined
  }
  return undefined
}

interface PluralCategories {
  /** the locale's CLDR categories */
  allowed: string[]
  /** `other` plus every category a whole number from 0 to 1000 selects */
  required: string[]
  /** per required category, the whole numbers from 0 to 1000 it is selected for */
  numbers: Map<string, number[]>
}

const categoryCache = new Map<string, PluralCategories | undefined>()

/**
 * The plural categories a message for `lng` may and must have: allowed are the locale's CLDR
 * categories, required are `other` plus every category a whole number from 0 to 1000 selects.
 * So ru needs one/few/many, while fr, es, it and pt may leave out `many` (from 1,000,000 only)
 * and cs/lt `many` (fractions only). Undefined when Intl does not know the locale.
 * Same rule as the Locize AI-review guard and MCP server.
 */
export function pluralCategories (lng: string, type: 'cardinal' | 'ordinal'): PluralCategories | undefined {
  const cacheKey = `${lng}|${type}`
  if (categoryCache.has(cacheKey)) return categoryCache.get(cacheKey)
  let categories
  try {
    if (Intl.PluralRules.supportedLocalesOf([lng]).length) {
      const rules = new Intl.PluralRules(lng, { type })
      const numbers = new Map<string, number[]>([['other', []]])
      for (let i = 0; i <= 1000; i++) {
        const category = rules.select(i)
        const list = numbers.get(category)
        if (list) list.push(i)
        else numbers.set(category, [i])
      }
      categories = { allowed: rules.resolvedOptions().pluralCategories as string[], required: [...numbers.keys()], numbers }
    }
  } catch {
    // an invalid language tag: only `other` is required
  }
  categoryCache.set(cacheKey, categories)
  return categories
}

/**
 * The required categories a plural lacks. A category other than `other` also counts as present when
 * exact selectors cover every whole number it is selected for: en `=1` covers `one`, while ru `=1`
 * does not (ru `one` is also 21, 31, ...). This is where the rule deliberately differs from Locize.
 */
function missingPluralCategories (plural: MessageShape['plurals'][number], lng: string): string[] {
  const expected = pluralCategories(lng, plural.type)
  const exact = new Set(plural.exact)
  return (expected?.required ?? ['other'])
    .filter(c => !plural.categories.includes(c))
    .filter(c => c === 'other' || !expected!.numbers.get(c)!.every(n => exact.has(n)))
    .sort(byCldrOrder)
}

function * leaves (value: any, path: Array<string | number> = []): Generator<[Array<string | number>, unknown]> {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield * leaves(v, [...path, Array.isArray(value) ? Number(k) : k])
  } else {
    yield [path, value]
  }
}

// The line of a key in a JSON file, 0 for other formats or when it is not found.
async function lineFinder (file: string): Promise<(path: Array<string | number>) => number> {
  if (!/\.json5?$/i.test(file)) return () => 0
  const content = await readFile(resolve(process.cwd(), file), 'utf-8')
  const tree = parseTree(content)
  return (path) => {
    const node = tree && findNodeAtLocation(tree, path)
    return node ? content.slice(0, node.parent?.offset ?? node.offset).split('\n').length : 0
  }
}

/**
 * Checks every translation value of every locale for `extract.messageFormat` `'icu'` or `'mf2'`:
 * syntax, argument names against the primary language, and plural categories per locale.
 * Returns the issues per translation file.
 */
export async function lintMessageFormatResources (config: I18nextToolkitConfig, analyze: MessageAnalyzer): Promise<Map<string, LintIssue[]>> {
  const isMf2 = config.extract.messageFormat === 'mf2'
  const formatName = isMf2 ? 'MF2' : 'ICU'
  const arg = (name: string) => isMf2 ? `{$${name}}` : `{${name}}`
  const { output, ignoreNamespaces = [] } = config.extract
  const keySeparator = config.extract.keySeparator || '.'
  const primary = config.extract.primaryLanguage || config.locales[0] || 'en'
  const locales = [primary, ...config.locales.filter(l => l !== primary)]

  // Namespace discovery as in `sync`: the primary language's files
  const namespaces: Array<string | undefined> = typeof output === 'string' && !output.includes('{{namespace}}')
    ? [undefined]
    : (await glob(getOutputPath(output, primary, '*').replace(/\\/g, '/')))
        .map(file => basename(file).split('.')[0])
        .filter(ns => !ignoreNamespaces.includes(ns))

  const issuesByFile = new Map<string, LintIssue[]>()
  for (const ns of namespaces) {
    let primaryShapes = new Map<string, MessageShape>()
    for (const lng of locales) {
      const file = getOutputPath(output, lng, ns)
      const resources = await loadTranslationFile(file)
      if (!resources) continue

      const shapes = new Map<string, MessageShape>()
      const problems: Array<{ path: Array<string | number>, text: string }> = []
      for (const [path, value] of leaves(resources)) {
        // an empty value is untranslated, not a message
        if (typeof value !== 'string' || value === '') continue
        const key = path.join(keySeparator)
        const report = (text: string) => problems.push({ path, text: `${key}: ${text}` })

        let shape: MessageShape
        try {
          shape = analyze(value)
        } catch (err: any) {
          const hint = value.includes('{{') ? `. i18next interpolation like {{name}} does not work with ${formatName}, use ${arg('name')}` : ''
          report(`${formatName} syntax error: ${err?.message ?? err}${hint}`)
          continue
        }
        shapes.set(key, shape)

        const source = lng === primary ? undefined : primaryShapes.get(key)
        if (source) {
          const missing = [...source.args].filter(a => !shape.args.has(a)).map(arg)
          const unexpected = [...shape.args].filter(a => !source.args.has(a)).map(arg)
          if (missing.length || unexpected.length) {
            report(`arguments differ from "${primary}": ${[
              missing.length ? `missing ${missing.join(', ')}` : '',
              unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
            ].filter(Boolean).join(', ')}`)
          }
        }

        for (const plural of shape.plurals) {
          const expected = pluralCategories(lng, plural.type)
          const label = `${plural.type === 'ordinal' ? (isMf2 ? 'ordinal' : 'selectordinal') : 'plural'} ${arg(plural.arg)}`
          const missing = missingPluralCategories(plural, lng)
          const unexpected = expected ? plural.categories.filter(c => !expected.allowed.includes(c)).sort(byCldrOrder) : []
          if (missing.length) report(`${label} is missing the "${lng}" categories ${missing.join(', ')}`)
          if (unexpected.length) report(`${label} has categories "${lng}" does not use: ${unexpected.join(', ')}`)
        }
      }
      if (lng === primary) primaryShapes = shapes

      if (problems.length) {
        const lineOf = await lineFinder(file)
        issuesByFile.set(file, problems.map(({ path, text }) => ({ text, line: lineOf(path), type: 'messageFormat' })))
      }
    }
  }
  return issuesByFile
}
