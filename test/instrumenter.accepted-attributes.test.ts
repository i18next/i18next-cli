import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parse } from '@swc/core'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { runInstrumenter } from '../src/instrumenter'
import { importAliases, jsxElementName, resolveElementAttributes } from '../src/utils/jsx-attributes'
import type { I18nextToolkitConfig, Logger } from '../src/types'
import { normalizePath } from './utils/path'

const silentLogger: Logger = { info () {}, warn () {}, error () {} }

// The same prop name means different things on different components:
// `label` is a button's text but a chart's data key.
const rules = {
  '*': ['!label'],
  Button: ['label'],
  PageTitle: ['heading'],
  'Select.Option': ['hint', 'LABEL'],
  Option: ['!title'],
  Item: ['hint'],
  Field: ['name'],
}

describe('resolveElementAttributes', () => {
  it('applies "*" first, then the element entry, which can re-add', () => {
    expect(resolveElementAttributes(rules, 'Chart').accepted.has('label')).toBe(false)
    expect(resolveElementAttributes(rules, 'Chart').removed.has('label')).toBe(true)
    expect(resolveElementAttributes(rules, 'Button').accepted.has('label')).toBe(true)
    expect(resolveElementAttributes(rules, 'Button').removed.has('label')).toBe(false)
    // the built-in list stays the base
    expect(resolveElementAttributes(rules, 'Chart').accepted.has('title')).toBe(true)
  })

  it('compares attribute names case-insensitively, element keys case-sensitively', () => {
    expect(resolveElementAttributes(rules, 'Select.Option').accepted.has('label')).toBe(true)
    expect(resolveElementAttributes({ Button: ['ariaLabel'] }, 'Button').accepted.has('arialabel')).toBe(true)
    expect(resolveElementAttributes(rules, 'button').accepted.has('label')).toBe(false)
  })

  it('uses the dotted key before the last segment', () => {
    expect(resolveElementAttributes(rules, 'Select.Option').accepted.has('hint')).toBe(true)
    expect(resolveElementAttributes(rules, 'Select.Option').accepted.has('title')).toBe(true)
    expect(resolveElementAttributes(rules, 'Option').removed.has('title')).toBe(true)
    expect(resolveElementAttributes(rules, 'Menu.Item').accepted.has('hint')).toBe(true)
  })

  it('ignores inherited object keys and entries that are not arrays', () => {
    expect(() => resolveElementAttributes(rules, 'toString')).not.toThrow()
    expect(resolveElementAttributes(rules, 'constructor').accepted.has('title')).toBe(true)
    expect(resolveElementAttributes({ '*': '!title' } as any, 'Chart').accepted.has('title')).toBe(true)
  })
})

describe('jsxElementName', () => {
  it('resolves import aliases, also at the root of a member expression', async () => {
    const ast = await parse(
      "import { PageTitle as PT, Select as S, Chart } from './ui'\nimport { default as Def } from './def'\nconst a = <PT />; const b = <S.Option />; const c = <Chart />; const d = <Local />; const e = <Def />",
      { syntax: 'typescript', tsx: true }
    )
    const aliases = importAliases(ast)
    const names: Array<string | null> = []
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'JSXOpeningElement') names.push(jsxElementName(node.name, aliases))
      for (const value of Object.values(node)) walk(value)
    }
    walk(ast)
    expect(names).toEqual(['PageTitle', 'Select.Option', 'Chart', 'Local', 'Def'])
  })
})

describe('instrument with per-element acceptedAttributes', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-instrument-attrs-'))
    await fs.mkdir(join(tempDir, 'src'), { recursive: true })
    await fs.writeFile(join(tempDir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0', 'react-i18next': '^17.0.0', i18next: '^26.0.0' } }))
    await fs.writeFile(join(tempDir, 'src', 'Page.tsx'), [
      "import React from 'react'",
      "import { PageTitle as PT, Chart, Button, Select, Option, Menu, Field } from './ui'",
      '',
      'export function Page ({ year }: { year: number }) {',
      '  return (',
      '    <div>',
      '      <PT heading="Welcome to the dashboard" />',
      '      <Chart label="The monthly revenue overview" title="Revenue by month and region" />',
      // eslint-disable-next-line no-template-curly-in-string
      '      <Chart label={`The monthly revenue for ${year}`} />',
      '      <Button label="Save all your changes" />',
      '      <button label="Send this form right now" />',
      '      <Select.Option hint="Pick the region you live in" label="The northern region of the country" title="Choose one of the regions below" />',
      '      <Option title="This title is a lookup id here" />',
      '      <Field name="Your full shipping address" />',
      '      <Menu.Item hint="Opens the settings of your account" />',
      '      <input placeholder="Enter your full name here" />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'))
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  async function candidates (acceptedAttributes?: I18nextToolkitConfig['extract']['acceptedAttributes']) {
    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: normalizePath(join(tempDir, 'src/**/*.tsx')),
        output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
        acceptedAttributes,
      },
    }
    const results = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    return results.files.flatMap(f => f.candidates).map(c => c.content)
  }

  it('follows the per-element rules', async () => {
    const found = await candidates(rules)
    // added on the element (PageTitle through the PT alias, Button re-adds what "*" removed)
    expect(found).toContain('Welcome to the dashboard')
    expect(found).toContain('Save all your changes')
    // removed by "*": the direct value and the expression are both skipped
    expect(found).not.toContain('The monthly revenue overview')
    expect(found.some(c => c.startsWith('The monthly revenue for'))).toBe(false)
    // built-in attributes stay
    expect(found).toContain('Revenue by month and region')
    expect(found).toContain('Enter your full name here')
    // element keys are case-sensitive: <button> is not Button
    expect(found).not.toContain('Send this form right now')
    // Select.Option uses its own key (hint, LABEL), not Option's (!title)
    expect(found).toContain('Pick the region you live in')
    expect(found).toContain('The northern region of the country')
    expect(found).toContain('Choose one of the regions below')
    expect(found).not.toContain('This title is a lookup id here')
    // an added attribute wins over the built-in skip list
    expect(found).toContain('Your full shipping address')
    // Menu.Item falls back to the Item key
    expect(found).toContain('Opens the settings of your account')
  })

  it('keeps the behaviour without rules and with the array form', async () => {
    for (const option of [undefined, ['title']]) {
      const found = await candidates(option)
      expect(found).toContain('The monthly revenue overview')
      expect(found).toContain('Enter your full name here')
      expect(found).not.toContain('Welcome to the dashboard')
      expect(found).not.toContain('Pick the region you live in')
      expect(found).toContain('This title is a lookup id here')
      expect(found).not.toContain('Your full shipping address')
    }
  })
})
