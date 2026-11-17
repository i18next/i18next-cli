/* eslint-disable no-template-curly-in-string -- the fixtures hold template literals */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInstrumenter } from '../src/instrumenter'
import { classifyNextFiles } from '../src/instrumenter/core/next-files'
import type { I18nextToolkitConfig, Logger } from '../src/types'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { normalizePath } from './utils/path'

// Patterns found running instrument on the next-i18next examples and on hardcoded Next.js apps

describe('instrumenter: Next.js apps get next-i18next', () => {
  let tempDir: string
  let originalCwd: string
  let warnings: string[]
  let infos: string[]
  const logger: Logger = {
    info: (m: string) => { infos.push(m) },
    warn: (m: string) => { warnings.push(m) },
    error () {}
  }

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-next-'))
    process.chdir(tempDir)
    warnings = []
    infos = []
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  const config = (): I18nextToolkitConfig => ({
    locales: ['en', 'de'],
    extract: {
      input: normalizePath(join(tempDir, '{app,pages,components,lib}/**/*.{js,jsx,ts,tsx}')),
      output: normalizePath(join(tempDir, 'public/locales/{{language}}/{{namespace}}.json')),
      defaultNS: 'common'
    }
  })

  /** Writes the app (a package.json with `deps`, and the files), instruments it and returns the files as rewritten. */
  async function instrument (files: Record<string, string>, deps: Record<string, string> = { next: '^16.0.0', react: '^19.0.0', 'next-i18next': '^16.4.0' }) {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }))
    for (const [name, code] of Object.entries(files)) {
      await mkdir(dirname(join(tempDir, name)), { recursive: true })
      await writeFile(join(tempDir, name), code)
    }
    const results = await runInstrumenter(config(), { isDryRun: false, quiet: true }, logger)
    const out: Record<string, string> = {}
    for (const name of Object.keys(files)) out[name] = await readFile(join(tempDir, name), 'utf-8')
    return { out, results }
  }

  it('gives Server Components await getT(), making them async, and Client Components useT()', async () => {
    const { out } = await instrument({
      'app/page.tsx': `import { Counter } from './Counter'
import { Card } from '@/components/Card'

export default function Home() {
  return <main><h1>Our products</h1><Card /><Counter /></main>
}
`,
      'app/Counter.tsx': `'use client'

import { useState } from 'react'
import { Button } from '@/components/Button'

export function Counter() {
  const [count, setCount] = useState(0)
  return <section><p>Items in your cart</p><Button onClick={() => setCount(count + 1)} /></section>
}
`,
      // imported by a Client Component only (through the tsconfig alias): a Client Component too
      'components/Button.tsx': `export function Button({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick}>Add to cart</button>
}
`,
      // imported by a Server Component only: one too, with an expression body
      'components/Card.tsx': `export const Card = () => (
  <p>Free shipping on <strong>all orders</strong> today</p>
)
`,
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } })
    })

    expect(out['app/page.tsx']).toContain("import { getT } from 'next-i18next/server'")
    expect(out['app/page.tsx']).toContain('export default async function Home() {\n  const { t } = await getT()')
    expect(out['app/page.tsx']).toContain("{t('ourProducts', 'Our products')}")
    // the import goes after the directive, which must stay the first statement
    expect(out['app/Counter.tsx']).toMatch(/^'use client'\n\nimport \{ useState \} from 'react'/)
    expect(out['app/Counter.tsx']).toContain("import { useT } from 'next-i18next/client'")
    expect(out['app/Counter.tsx']).toContain('const { t } = useT()')
    expect(out['components/Button.tsx']).toContain('const { t } = useT()')
    expect(out['components/Button.tsx']).not.toMatch(/getT|async/)
    // a <Trans> in a Server Component has no context: t and i18n from getT()
    expect(out['components/Card.tsx']).toContain('export const Card = async () => {')
    expect(out['components/Card.tsx']).toContain('const { t, i18n } = await getT()')
    expect(out['components/Card.tsx']).toContain("import { Trans } from 'react-i18next/TransWithoutContext'")
    expect(out['components/Card.tsx']).toContain('<Trans i18nKey="freeShippingOnAllOrdersToday" t={t} i18n={i18n}>')
    // next-i18next sets i18next up itself: no init file, but the steps
    await expect(access(join(tempDir, 'i18n.ts'))).rejects.toThrow()
    expect(infos.join('\n')).toContain('npm install next-i18next i18next react-i18next')
    expect(infos.join('\n')).toContain('#app-router-setup')
  })

  it('turns `export const metadata` into generateMetadata() and gives the metadata functions getT()', async () => {
    const { out } = await instrument({
      'app/layout.tsx': `import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'My Shop',
  description: 'The best things, delivered fast.'
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
`,
      'app/about/page.tsx': `export function generateMetadata() {
  return { title: 'About us' }
}

export default async function About() {
  const { i18n } = await getT()
  return <p lang={i18n.language}>We are a small team.</p>
}
`
    })

    expect(out['app/layout.tsx']).toContain('export async function generateMetadata (): Promise<Metadata> {\n  const { t } = await getT()\n  return {')
    expect(out['app/layout.tsx']).toContain("title: t('myShop', 'My Shop')")
    expect(out['app/layout.tsx']).not.toContain('export const metadata')
    expect(out['app/about/page.tsx']).toContain('export async function generateMetadata() {\n  const { t } = await getT()')
    expect(out['app/about/page.tsx']).toContain("title: t('aboutUs', 'About us')")
    // its getT() call takes `t` as well, rather than a second call
    expect(out['app/about/page.tsx']).toContain('const { t, i18n } = await getT()')
    expect(out['app/about/page.tsx'].match(/getT\(\)/g)).toHaveLength(2)
  })

  it('skips components that Server and Client Components both render, unless they get t (and i18n) as props', async () => {
    const { out } = await instrument({
      'app/page.tsx': "import { Header } from './Header'\nimport { Base } from './Base'\nexport default async function Page() { return <><Header /><Base /></> }\n",
      'app/client/page.tsx': "'use client'\nimport { Header } from '../Header'\nimport { Base } from '../Base'\nexport default function Page() { return <><Header /><Base /></> }\n",
      'app/Header.tsx': 'export const Header = () => <h2>Welcome to the shop</h2>\n',
      'app/Base.tsx': 'export const Base = ({ t, i18n }) => <footer><p>All rights reserved</p><p>Made with <a href="/x">love</a> here</p></footer>\n'
    })

    expect(out['app/Header.tsx']).not.toContain('t(')
    expect(warnings.join('\n')).toContain('Server and Client Components both render')
    expect(out['app/Base.tsx']).toContain("t('allRightsReserved', 'All rights reserved')")
    expect(out['app/Base.tsx']).toContain('t={t} i18n={i18n}>Made with')
    expect(out['app/Base.tsx']).not.toMatch(/useT|getT/)
  })

  it('leaves API routes, texts outside components and next-i18next language switches alone', async () => {
    const { out } = await instrument({
      'app/api/hello/route.ts': "export async function GET() {\n  return Response.json({ message: 'Hello from the shop API' })\n}\n",
      'lib/labels.ts': 'export function itemsLabel(n: number) {\n  return `Items in stock: ${n}`\n}\n',
      'app/LangSelect.tsx': `'use client'
import { useChangeLanguage } from 'next-i18next/client'
export const LangSelect = ({ lng }) => {
  const changeLanguage = useChangeLanguage()
  return <button onClick={() => changeLanguage(lng)}>Switch the language</button>
}
`
    })

    expect(out['app/api/hello/route.ts']).not.toContain('getT')
    expect(out['lib/labels.ts']).not.toContain('t(')
    expect(out['app/LangSelect.tsx']).toContain('() => changeLanguage(lng)')
    expect(out['app/LangSelect.tsx']).not.toContain('i18n.changeLanguage')
    expect(out['app/LangSelect.tsx']).toContain("t('switchTheLanguage', 'Switch the language')")
    expect(warnings.join('\n')).toContain('Left API routes as they are')
    expect(warnings.join('\n')).toContain('next-i18next has no global t()')
  })

  it('gives the Pages Router useTranslation from next-i18next/pages and names the pages that load no translations', async () => {
    const pagesOnly = { next: '^15.0.0', react: '^19.0.0' }
    const { out } = await instrument({
      'pages/index.js': "import Nav from '../components/Nav'\nexport default function Home() { return <><Nav /><h1>Welcome back</h1></> }\n",
      'pages/about.js': "import { getI18nProps } from '../lib/i18n'\nexport default function About() { return <p>About this site</p> }\nexport const getStaticProps = async ctx => ({ props: { ...(await getI18nProps(ctx)), motto: 'Ship it' } })\n",
      'lib/i18n.js': "import { serverSideTranslations } from 'next-i18next/pages/serverSideTranslations'\nexport const getI18nProps = ctx => serverSideTranslations(ctx.locale, ['common'])\n",
      'components/Nav.js': 'export default function Nav() { return <nav>Our shop</nav> }\n'
    }, pagesOnly)

    expect(out['pages/index.js']).toContain("import { useTranslation } from 'next-i18next/pages'")
    expect(out['components/Nav.js']).toContain('const { t } = useTranslation()')
    // a text in getStaticProps is data of the page, outside any component
    expect(out['pages/about.js']).toContain("motto: 'Ship it'")
    const warning = warnings.find(w => w.includes('serverSideTranslations'))
    expect(warning).toContain('pages/index.js')
    // its helper calls serverSideTranslations()
    expect(warning).not.toContain('pages/about.js')
    // its lib imports next-i18next: set up already, no steps
    expect(infos.join('\n')).not.toContain('Set it up')
  })

  it('turns a return type into a promise, and leaves Server Actions, cached functions and files no route imports', async () => {
    const { out } = await instrument({
      'app/layout.tsx': 'export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {\n  return <html><body><header>Welcome to the shop</header>{children}</body></html>\n}\n',
      'app/cached/page.tsx': "export default async function Page() {\n  'use cache'\n  return <p>Our cached offers</p>\n}\n",
      'app/actions.ts': "'use server'\nexport async function save() {\n  return { message: 'Your changes were saved' }\n}\n",
      'components/Orphan.tsx': 'export const Orphan = () => <p>Nobody imports me here</p>\n'
    })

    expect(out['app/layout.tsx']).toContain('export default async function RootLayout({ children }: { children: React.ReactNode }): Promise<JSX.Element> {')
    expect(out['app/cached/page.tsx']).not.toContain('getT')
    expect(out['app/actions.ts']).not.toContain('getT')
    expect(out['components/Orphan.tsx']).not.toMatch(/\bt\(|getT|useT/)
    expect(warnings.join('\n')).toContain("'use server', 'use cache'")
    expect(warnings.join('\n')).toContain('no page or layout imports')
  })

  it('keeps a Next.js app with an i18next setup of its own on react-i18next', async () => {
    const { out } = await instrument({
      'app/Hint.tsx': "'use client'\nimport { useTranslation } from 'react-i18next'\nexport function Hint() { return <p>Press enter to save</p> }\n"
    }, { next: '^16.0.0', react: '^19.0.0', 'react-i18next': '^17.0.0' })

    expect(out['app/Hint.tsx']).toContain('const { t } = useTranslation()')
    expect(out['app/Hint.tsx']).not.toContain('next-i18next')
  })

  it('takes the t of getFixedT(), and leaves the values of an IcuTrans', async () => {
    const { out } = await instrument({
      'app/Footer.tsx': `export const Footer = ({ i18n, lng }) => {
  const t = i18n.getFixedT(lng, 'footer')
  return <p>{lng} or <IcuTrans i18nKey='welcome' values={{ name: 'Ada' }} t={t} i18n={i18n} /></p>
}
`,
      'app/page.tsx': "import { Footer } from './Footer'\nexport default async function Page() { return <Footer /> }\n"
    })

    expect(out['app/Footer.tsx']).not.toContain("t('ada'")
    expect(out['app/Footer.tsx']).toContain("name: 'Ada'")
    expect(warnings.join('\n')).not.toContain('declare a `t` of their own')
  })

  it('classifies the files of an app by the components that render them', async () => {
    const files = new Map([
      ['app/page.tsx', "import A from './A'\nimport { B } from '../components/B'\nimport { F } from 'components/F'\nimport { G } from '../components/G.js'"],
      // a baseUrl import and the `.js` of an ESM import for a .tsx file
      ['components/F.tsx', ''],
      ['components/G.tsx', ''],
      ['app/A.tsx', "'use client'\nimport { C } from '../components/C'"],
      ['components/B.tsx', "import { C } from './C'"],
      ['components/C.tsx', ''],
      ['pages/index.tsx', "import { D } from '../components/D'"],
      ['components/D.tsx', ''],
      ['components/E.tsx', '']
    ])
    const { kinds } = await classifyNextFiles(files, tempDir)

    expect(Object.fromEntries(kinds)).toEqual({
      'app/page.tsx': 'server',
      'app/A.tsx': 'client',
      'components/B.tsx': 'server',
      'components/C.tsx': 'shared',
      'pages/index.tsx': 'pages',
      'components/D.tsx': 'pages',
      'components/F.tsx': 'server',
      'components/G.tsx': 'server',
      // nothing imports it: either side may render it
      'components/E.tsx': 'unknown'
    })
  })
})

describe('instrumenter: findings of the Next.js round that hold for any React app', () => {
  let tempDir: string
  let originalCwd: string
  const logger: Logger = { info () {}, warn () {}, error () {} }

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-react-'))
    await mkdir(join(tempDir, 'src'), { recursive: true })
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0' } }))
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  async function instrument (code: string) {
    await writeFile(join(tempDir, 'src', 'A.jsx'), code)
    await runInstrumenter({
      locales: ['en'],
      extract: { input: normalizePath(join(tempDir, 'src/**/*.jsx')), output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')) }
    }, { isDryRun: false, quiet: true }, logger)
    return readFile(join(tempDir, 'src', 'A.jsx'), 'utf-8')
  }

  it('puts the import after a directive', async () => {
    const code = await instrument("'use client'\n\nexport function A() { return <p>Hello there</p> }\n")
    expect(code).toMatch(/^'use client'\nimport \{ useTranslation \} from 'react-i18next'\n/)
  })

  it("adds no t to a data hook's call, nor to a hook call after the first text", async () => {
    const code = await instrument(`export function A() {
  const { documents } = useRoleTranslations()
  return <p>{documents.length} documents to translate</p>
}
export function B() {
  const heading = 'Your language settings'
  const { i18n } = useTranslation()
  return <h1 lang={i18n.language}>{heading}</h1>
}
`)
    expect(code).toContain('const { documents } = useRoleTranslations()')
    expect(code).toContain('const { i18n } = useTranslation()')
    // a hook line of its own, before the text
    expect(code).toMatch(/export function B\(\) \{\n {2}const \{ t \} = useTranslation\(\)\n {2}const heading = t\(/)
  })

  it('uses the t a function binds from a translation hook, and adds t to a hook call without it', async () => {
    const code = await instrument(`export function useLabels() {
  const { t } = useTranslation()
  return { title: 'Your weekly summary' }
}
export function A() {
  const { i18n } = useTranslation('settings')
  return <p lang={i18n.language}>Hello there</p>
}
`)
    expect(code).toContain("return { title: t('yourWeeklySummary', 'Your weekly summary') }")
    expect(code).not.toContain('i18next.t(')
    expect(code).toContain("const { t, i18n } = useTranslation('settings')")
  })

  it('keeps an empty element at the edge of a sentence out of its <Trans>, and joins a name with digits to its value', async () => {
    const code = await instrument(`export function A({ pkg }) {
  return <div>
    <h2>Next.js 16 <small>(app directory)</small> - i18next
    <hr /></h2>
    <p>next-i18next v{pkg.version}</p>
  </div>
}
`)
    expect(code).toContain('- i18next</Trans>\n    <hr />')
    expect(code).toContain("t('nexti18nextVVersion', 'next-i18next v{{version}}', { version: pkg.version })")
  })

  it('makes a key of a text with accents from its letters without them', async () => {
    const code = await instrument('export function A() { return <button>Français</button> }\n')
    expect(code).toContain("t('francais', 'Français')")
  })
})
