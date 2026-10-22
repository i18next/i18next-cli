import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { glob } from 'glob'
import { parseTree, findNodeAtLocation } from 'jsonc-parser'
import type { I18nextToolkitConfig, LintIssue } from '../types.js'
import { getOutputPath, loadTranslationFile } from './file-utils.js'
import { parseNestedReferences } from './nesting.js'

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The variable names of the i18next interpolations in a value: `{{name}}`, `{{- name}}` (unescaped),
 * `{{val, number}}` and `{{ user.name }}` give `name`, `name`, `val` and `user.name`.
 * Read like i18next's Interpolator: anything between prefix and suffix, trimmed, a `-` right after the
 * prefix marks it unescaped, and a format follows the first `,`.
 * ponytail: i18next's defaults for unescapePrefix (`-`) and formatSeparator (`,`); custom ones are not read.
 */
export function interpolationNames (value: string, extract: Pick<I18nextToolkitConfig['extract'], 'interpolationPrefix' | 'interpolationSuffix'>): string[] {
  const prefix = escapeRegExp(extract.interpolationPrefix ?? '{{')
  const suffix = escapeRegExp(extract.interpolationSuffix ?? '}}')
  const names: string[] = []
  for (const [, inner] of value.matchAll(new RegExp(`${prefix}(.+?)${suffix}`, 'g'))) {
    const name = inner.replace(/^-/, '').split(',')[0].trim()
    // a brace means ICU (`one {{count} item}`) in a project without extract.messageFormat, not a variable
    if (name && !/[{}]/.test(name)) names.push(name)
  }
  return names
}

/** What an ICU or MF2 message uses. */
export interface MessageShape {
  /** Argument names (`{name}` in ICU, `{$name}` in MF2). `#` and markup are not arguments. */
  args: Set<string>
  /** Plural selections: their CLDR category selectors and the numbers of their exact selectors (`=0` in ICU, `0` in MF2). */
  plurals: Array<{ arg: string, type: 'cardinal' | 'ordinal', categories: string[], exact: number[] }>
  /** MF2 only: `start` / `end` when a pattern starts / ends with whitespace, which MF2 keeps as text. */
  edges: Set<'start' | 'end'>
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
 * Rewrites an i18next-format text (`Hello {{name}}`, `{{total, number}}`) into the configured message format:
 * `{name}` / `{total, number}` for ICU, `{$name}` / `{$total :number}` for MF2, and escapes the text around the
 * placeholders. Values of the i18next format are returned as is.
 * ponytail: `#` is not quoted inside ICU plurals, and an MF2 text starting with `.` is left to `lint` to report.
 */
export function toMessageFormatPlaceholders (value: string, config: Pick<I18nextToolkitConfig, 'extract'>): string {
  const format = config.extract.messageFormat
  if (format !== 'icu' && format !== 'mf2') return value
  const text = (segment: string, beforePlaceholder: boolean) => format === 'mf2'
    ? segment.replace(/[\\{}]/g, '\\$&')
    : segment
      // an apostrophe before { } < > or ' starts quoted text in ICU, so a literal one is doubled
      .replace(beforePlaceholder ? /'(?=[{}<>']|$)/g : /'(?=[{}<>'])/g, "''")
      .replace(/[{}]/g, "'$&'")
  let result = ''
  let last = 0
  for (const match of value.matchAll(/\{\{\s*([^{},\s]+)\s*(?:,\s*([^{}]*?)\s*)?\}\}/g)) {
    const [placeholder, name, fmt] = match
    result += text(value.slice(last, match.index), true) +
      (format === 'icu' ? `{${name}${fmt ? `, ${fmt}` : ''}}` : `{$${name}${fmt ? ` :${fmt}` : ''}}`)
    last = match.index + placeholder.length
  }
  return result + text(value.slice(last), false)
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
      const shape: MessageShape = { args: new Set(), plurals: [], edges: new Set() }
      walk(elements, shape)
      return shape
    }
  }

  const { parseMessage, validate } = await import('messageformat')
  return (message) => {
    const msg = parseMessage(message) // throws a MessageSyntaxError
    const shape: MessageShape = { args: validate(msg).variables, plurals: [], edges: new Set() } // validate throws a MessageDataModelError
    for (const pattern of msg.type === 'select' ? msg.variants.map(v => v.value) : [msg.pattern]) {
      const first = pattern[0]
      const last = pattern[pattern.length - 1]
      if (typeof first === 'string' && /^\s/.test(first)) shape.edges.add('start')
      if (typeof last === 'string' && /\s$/.test(last)) shape.edges.add('end')
    }
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
  /** `other` plus every category a whole number below one million selects */
  required: string[]
  /** per required category, the smallest whole numbers it selects (up to 10) and whether there are more */
  numbers: Map<string, { first: number[], more: boolean }>
}

const categoryCache = new Map<string, PluralCategories | undefined>()
const FIRST_NUMBERS = 10

/**
 * The plural categories a message for `lng` may and must have: allowed are the locale's CLDR
 * categories, required are `other` plus every category a whole number below one million selects.
 * So ru needs one/few/many, while fr, es, it and pt may leave out `many` (from 1,000,000 only)
 * and cs/lt `many` (fractions only). Undefined when Intl does not know the locale.
 * Same rule as Locize (`@inweso-dev/i18n-utils` `pluralCategories`); port a fix by hand in both directions.
 * ponytail: samples 0..1999, not every number below one million: CLDR's whole-number rules look at
 * small values and at n % 10, % 100 and % 1000, and a category met from 1000 on selects hundreds of numbers.
 */
export function pluralCategories (lng: string, type: 'cardinal' | 'ordinal'): PluralCategories | undefined {
  const cacheKey = `${lng}|${type}`
  if (categoryCache.has(cacheKey)) return categoryCache.get(cacheKey)
  // a language code may use `_` (ru_RU, zh_Hant_TW), Intl only reads `-`
  const locale = lng.replace(/_/g, '-')
  let categories
  try {
    if (Intl.PluralRules.supportedLocalesOf([locale]).length) {
      const rules = new Intl.PluralRules(locale, { type })
      const numbers = new Map([['other', { first: [] as number[], more: false }]])
      for (let i = 0; i < 2000; i++) {
        const category = rules.select(i)
        let n = numbers.get(category)
        if (!n) numbers.set(category, n = { first: [], more: false })
        if (n.first.length < FIRST_NUMBERS) n.first.push(i)
        else n.more = true
        if (i >= 1000) n.more = true
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
 * it selects few small numbers and exact selectors cover them all: en `=1` covers `one`, while ru `=1`
 * does not (ru `one` is also 21, 31, ...).
 */
function missingPluralCategories (plural: MessageShape['plurals'][number], lng: string): string[] {
  const expected = pluralCategories(lng, plural.type)
  const exact = new Set(plural.exact)
  const covered = (c: string) => {
    if (c === 'other') return false
    const n = expected!.numbers.get(c)!
    return !n.more && n.first.every(i => exact.has(i))
  }
  return (expected?.required ?? ['other'])
    .filter(c => !plural.categories.includes(c))
    .filter(c => !covered(c))
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

// Namespace discovery as in `sync`: the primary language's files
async function primaryNamespaces (config: I18nextToolkitConfig, primary: string): Promise<Array<string | undefined>> {
  const { output, ignoreNamespaces = [] } = config.extract
  if (typeof output === 'string' && !output.includes('{{namespace}}')) return [undefined]
  return (await glob(getOutputPath(output, primary, '*').replace(/\\/g, '/')))
    .map(file => basename(file).split('.')[0])
    .filter(ns => !ignoreNamespaces.includes(ns))
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
  const { output } = config.extract
  const keySeparator = config.extract.keySeparator || '.'
  const primary = config.extract.primaryLanguage || config.locales[0] || 'en'
  const locales = [primary, ...config.locales.filter(l => l !== primary)]
  const namespaces = await primaryNamespaces(config, primary)

  const issuesByFile = new Map<string, LintIssue[]>()
  for (const ns of namespaces) {
    let primaryShapes = new Map<string, MessageShape>()
    for (const lng of locales) {
      const file = getOutputPath(output, lng, ns)
      const resources = await loadTranslationFile(file)
      if (!resources) continue

      const shapes = new Map<string, MessageShape>()
      const problems: Array<{ path: Array<string | number>, text: string, severity?: 'warning' }> = []
      for (const [path, value] of leaves(resources)) {
        // an empty value is untranslated, not a message
        if (typeof value !== 'string' || value === '') continue
        const key = path.join(keySeparator)
        const report = (text: string, severity?: 'warning') => problems.push({ path, text: `${key}: ${text}`, severity })

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
          // a correct translation with a visible flaw, so a warning (Locize's soft `whitespace`)
          if ([...source.edges].sort().join() !== [...shape.edges].sort().join()) {
            report(`whitespace at the start or end of a pattern differs from "${primary}", MF2 shows it as text`, 'warning')
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
        issuesByFile.set(file, problems.map(({ path, text, severity }) => ({ text, line: lineOf(path), type: 'messageFormat', severity })))
      }
    }
  }
  return issuesByFile
}

/**
 * Checks the translation values of every locale in the i18next format against the primary language: the
 * interpolations (by name, so `{{val, number}}` and `{{ val }}` are both `val`), the nested `$t(key)` references and
 * the tags (`<0>`, `<1/>`, `<bold>`), except the basic HTML react-i18next keeps (`transKeepBasicHtmlNodesFor`).
 * Plural forms are compared as a group (the union over `_one`, `_other`, ...), since a language may leave `{{count}}`
 * out of `_one` or `_zero` and has forms the primary language lacks.
 * The same idea as Locize's check 240 (`checkI18nFeatures`). Returns the issues per translation file.
 * ponytail: a placeholder dropped from one plural form while another form keeps it passes; a per-form rule would flag `{{count}}`.
 */
export async function lintI18nextResources (config: I18nextToolkitConfig, severity: 'error' | 'warning'): Promise<Map<string, LintIssue[]>> {
  const { output, interpolationPrefix = '{{', interpolationSuffix = '}}', nestingPrefix = '$t(', nestingSuffix = ')', nestingOptionsSeparator } = config.extract
  const keySeparator = config.extract.keySeparator || '.'
  const nsSeparator = config.extract.nsSeparator ?? ':'
  // the suffixes i18next's PluralResolver appends: `_one`, `_ordinal_two`, and `_zero` for a count of 0
  const s = escapeRegExp(config.extract.pluralSeparator ?? '_')
  const pluralSuffix = new RegExp(`(?:${s}ordinal)?${s}(?:zero|one|two|few|many|other)$`)
  // react-i18next's default, src/defaults.js
  const keptHtml = new Set(config.extract.transKeepBasicHtmlNodesFor ?? ['br', 'strong', 'i', 'p'])
  const primary = config.extract.primaryLanguage || config.locales[0] || 'en'
  const locales = config.locales.filter(l => l !== primary)

  const placeholders = (value: string): string[] => [
    ...interpolationNames(value, config.extract).map(name => `${interpolationPrefix}${name}${interpolationSuffix}`),
    ...parseNestedReferences(value, { nestingPrefix, nestingSuffix, nestingOptionsSeparator, nsSeparator })
      .map(ref => `${nestingPrefix}${ref.ns ? `${ref.ns}${nsSeparator}` : ''}${ref.key}${nestingSuffix}`),
    // <Trans> renders <0>…</0> from its children and <bold> from its components; an unknown tag shows up as
    // text. The kept basic HTML (<br/>, <strong>) is rendered as is, so a language may add or drop it.
    ...[...value.matchAll(/<([A-Za-z0-9][\w.:-]*)(?:\s(?:"[^"]*"|'[^']*'|[^'">])*)?\/?>/g)]
      .filter(match => !keptHtml.has(match[1]))
      .map(match => `<${match[1]}>`),
  ]

  interface Group { path: Array<string | number>, label: string, values: number, empty: boolean, tokens: Set<string> }
  const groupsOf = (resources: Record<string, any>): Map<string, Group> => {
    const groups = new Map<string, Group>()
    for (const [path, value] of leaves(resources)) {
      if (typeof value !== 'string') continue
      const key = path.join(keySeparator)
      const base = key.replace(pluralSuffix, '')
      let group = groups.get(base)
      if (!group) groups.set(base, group = { path, label: key, values: 0, empty: false, tokens: new Set() })
      else group.label = base
      if (value === '') {
        group.empty = true
        continue
      }
      group.values++
      for (const token of placeholders(value)) group.tokens.add(token)
    }
    return groups
  }

  // A file that does not parse makes `extract`, `sync` and `status` fail loudly, so `lint` skips it
  const load = (file: string) => loadTranslationFile(file).catch(() => null)

  const issuesByFile = new Map<string, LintIssue[]>()
  for (const ns of await primaryNamespaces(config, primary)) {
    const primaryResources = await load(getOutputPath(output, primary, ns))
    if (!primaryResources) continue
    const primaryGroups = groupsOf(primaryResources)

    for (const lng of locales) {
      const file = getOutputPath(output, lng, ns)
      const resources = await load(file)
      if (!resources) continue

      const problems: Array<{ path: Array<string | number>, text: string }> = []
      for (const [base, group] of groupsOf(resources)) {
        const source = primaryGroups.get(base)
        if (!source?.values || !group.values) continue
        // a partly translated plural may still lack the form that carries {{count}}
        const missing = group.empty ? [] : [...source.tokens].filter(t => !group.tokens.has(t))
        const unexpected = [...group.tokens].filter(t => !source.tokens.has(t))
        if (!missing.length && !unexpected.length) continue
        const diff = [
          missing.length ? `missing ${missing.join(', ')}` : '',
          unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
        ].filter(Boolean).join(', ')
        problems.push({ path: group.path, text: `${group.label}: ${diff} (compared with "${primary}")` })
      }

      if (problems.length) {
        const lineOf = await lineFinder(file)
        issuesByFile.set(file, problems.map(({ path, text }) => ({ text, line: lineOf(path), type: 'placeholder', severity })))
      }
    }
  }
  return issuesByFile
}
