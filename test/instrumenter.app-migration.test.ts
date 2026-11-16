/* eslint-disable no-template-curly-in-string -- the expectations quote template literals */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInstrumenter } from '../src/instrumenter'
import { generateKeyFromContent } from '../src/instrumenter/core/key-generator'
import type { I18nextToolkitConfig, Logger } from '../src/types'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { normalizePath } from './utils/path'

// Patterns found migrating a hardcoded-strings app (a dashboard of ~700 files) back to i18next

describe('instrumenter: migrating an app with hardcoded strings', () => {
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
    tempDir = await mkdtemp(join(tmpdir(), 'i18next-migrate-'))
    await mkdir(join(tempDir, 'src'), { recursive: true })
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0' } }))
    process.chdir(tempDir)
    warnings = []
    infos = []
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  const config = (extract: Partial<I18nextToolkitConfig['extract']> = {}): I18nextToolkitConfig => ({
    locales: ['en', 'de'],
    extract: {
      input: normalizePath(join(tempDir, 'src/**/*.{js,jsx}')),
      output: normalizePath(join(tempDir, 'locales/{{language}}/{{namespace}}.json')),
      defaultNS: 'translation',
      ...extract
    }
  })

  /** Writes the files, instruments them and returns the first one as rewritten. */
  async function instrument (files: Record<string, string>, isDryRun = false, extract: Partial<I18nextToolkitConfig['extract']> = {}) {
    for (const [name, code] of Object.entries(files)) await writeFile(join(tempDir, 'src', name), code)
    const results = await runInstrumenter(config(extract), { isDryRun, quiet: true }, logger)
    return { code: await readFile(join(tempDir, 'src', Object.keys(files)[0]), 'utf-8'), results }
  }

  const component = (body: string, imports = '') => `${imports}export function Page ({ project, name, items, n, shown, token, user, open }) {
${body}
}
`

  it('finds React in peerDependencies and in the workspace root of a monorepo package', async () => {
    await mkdir(join(tempDir, 'packages', 'app', 'src'), { recursive: true })
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'], dependencies: { react: '^19.0.0' } }))
    await writeFile(join(tempDir, 'packages', 'app', 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(join(tempDir, 'packages', 'app', 'src', 'A.jsx'), component('  return <h1>Welcome to the dashboard</h1>'))
    process.chdir(join(tempDir, 'packages', 'app'))
    const cfg = config()
    cfg.extract.input = normalizePath(join(tempDir, 'packages/app/src/**/*.jsx'))
    await runInstrumenter(cfg, { isDryRun: false, quiet: true }, logger)
    const code = await readFile(join(tempDir, 'packages', 'app', 'src', 'A.jsx'), 'utf-8')
    expect(code).toContain('const { t } = useTranslation()')
    expect(code).not.toContain('i18next.t(')
  })

  it('leaves ids, paths, keys, flags and class names built in template literals alone', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const id = \`\${project.id}-\${project.version}\`
  const weight = \`weight_\${project.code}\`
  const url = \`\${project.baseUrl}/api/\${project.id}?full=\${project.full}\`
  const cls = \`app-dropzone \${project.state}\`
  const flag = \`--env \${project.mode}\`
  const auth = { Authorization: \`Bearer \${token}\` }
  return <div title={\`More actions for \${name}\`}>{id}{weight}{url}{cls}{flag}{auth}</div>`)
    })
    expect(code).toContain('`${project.id}-${project.version}`')
    expect(code).toContain('`weight_${project.code}`')
    expect(code).toContain('`${project.baseUrl}/api/${project.id}?full=${project.full}`')
    expect(code).toContain('`app-dropzone ${project.state}`')
    expect(code).toContain('`--env ${project.mode}`')
    expect(code).toContain('`Bearer ${token}`')
    expect(code).toContain("t('moreActionsForName', 'More actions for {{name}}', { name })")
  })

  it('leaves identifiers, rules and strings without letters alone', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const kind = n ? 'aiReview' : 'apiKeys'
  const rules = 'required|min:2'
  const sep = ' / '
  return <p>{kind}{rules}{sep}</p>`)
    })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('finds the text a call takes last, but not the strings a text is searched for or a selector', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  if (String(name).includes('not enough tokens')) toast('Your project was saved.')
  const button = document.body.closest('button, label')
  alert('Your session has expired')
  return <p>{button && 'Name not available'}</p>`)
    })
    expect(code).toContain("toast(t('yourProjectWasSaved', 'Your project was saved.'))")
    expect(code).toContain("alert(t('yourSessionHasExpired', 'Your session has expired'))")
    expect(code).toContain("t('nameNotAvailable', 'Name not available')")
    expect(code).toContain("includes('not enough tokens')")
    expect(code).toContain("closest('button, label')")
  })

  it('leaves everything in a console call alone, however it is built', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  console.log('[perf] ' + \`search settled after \${n} ms of typing\`)
  return null`)
    })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('rewrites the outer one of two nested template literals instead of failing on the file', async () => {
    const { code, results } = await instrument({
      'A.jsx': component('  return <p>{`Version ${project.version}${n ? `, cached for ${n} seconds` : \'\'} is published`}</p>')
    })
    expect(results.totalTransformed).toBe(1)
    expect(code).toContain("t('versionVersionValIsPublished', 'Version {{version}}{{val}} is published'")
  })

  it('names a placeholder after what a call formats, once for an expression used twice', async () => {
    const { code } = await instrument({
      'A.jsx': component('  return <p title={`Last seen ${format.date(user.lastLogin)}, again ${format.date(user.lastLogin)}`}>x</p>')
    })
    expect(code).toContain("'Last seen {{lastLogin}}, again {{lastLogin}}', { lastLogin: format.date(user.lastLogin) })")
  })

  it('turns plural helper calls into one plural t() and drops the helper import once unused', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const files = plural(n, '# file', '# files')
  const users = plural(items.length, \`showing \${shown} of # user\`, \`showing \${shown} of # users\`)
  return <p title={\`\${n} \${plural(n, 'key', 'keys')} unused for a year\`}>{files}{users}</p>`, "import { plural, number } from './format'\n")
    })
    expect(code).toContain("t('countFiles', { defaultValue_one: '{{count}} file', defaultValue_other: '{{count}} files', count: n })")
    expect(code).toContain("defaultValue_one: 'showing {{shown}} of {{count}} user', defaultValue_other: 'showing {{shown}} of {{count}} users', count: items.length, shown")
    expect(code).toContain("defaultValue_one: '{{count}} key unused for a year', defaultValue_other: '{{count}} keys unused for a year', count: n")
    expect(code).toContain("import { number } from './format'")
    expect(code).not.toContain('plural(')
  })

  it('keeps the plural helper import while a call of it is left', async () => {
    const { code } = await instrument({
      'A.jsx': component("  return <p>{plural(n, '# file', '# files')}{plural(n, items.one, items.other)}</p>", "import { plural } from './format'\n")
    })
    expect(code).toContain("import { plural } from './format'")
    expect(code).toContain('plural(n, items.one, items.other)')
  })

  it('keeps a sentence with {" "} and a link component in one <Trans>, keyed by its words, in the file\'s quotes', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <p className='hint'>
      The{' '}
      <Link to='/docs'>i18n format</Link>{' '}
      depends on your framework.
    </p>
  )`)
    })
    expect(code).toContain("<Trans i18nKey='theI18nFormatDependsOnYourFramework'>")
    expect(code).toContain("<Link to='/docs'>i18n format</Link>")
    expect(code).not.toContain("t('the'")
  })

  it('takes a single word as text in JSX text and in translatable attributes, a sentence end too, but not code', async () => {
    const { code } = await instrument({
      'A.jsx': component("  return <div><Tag>expired</Tag><th aria-label='actions' /><span>Done.</span><code>npm</code></div>")
    })
    expect(code).toContain("{t('expired', 'expired')}")
    expect(code).toContain("aria-label={t('actions', 'actions')}")
    expect(code).toContain("{t('done', 'Done.')}")
    expect(code).toContain('<code>npm</code>')
  })

  it('finds text in JSX and handlers passed to attributes it does not translate', async () => {
    const { code } = await instrument({
      'A.jsx': component("  return <Card action={<Button onClick={() => open('Link copied to clipboard')}>Change it now</Button>} />")
    })
    expect(code).toContain("{t('changeItNow', 'Change it now')}")
    expect(code).toContain("open(t('linkCopiedToClipboard', 'Link copied to clipboard'))")
  })

  it('adds a language switch only where a call is a statement of its own, for a setter or settings, not for data', async () => {
    const { code, results } = await instrument({
      'A.jsx': component(`  const [lng, setLng] = useState()
  const pick = (l) => setLng(l)
  if (open) setLanguage(lng)
  const load = () => fetchDownloads({ lng })
  const save = () => { return saveSettings({ language: lng }) }
  return <p onClick={() => updateSettings({ language: lng })}>{pick}{load}{save}</p>`)
    })
    expect(results.totalLanguageChanges).toBe(2)
    expect(code).toContain('if (open) setLanguage(lng)')
    expect(code).toContain('const pick = (l) => { i18n.changeLanguage(l); setLng(l); }')
    expect(code).toContain('() => fetchDownloads({ lng })')
    expect(code).toContain('return saveSettings({ language: lng })')
    expect(code).toContain('{ i18n.changeLanguage(lng); updateSettings({ language: lng }); }')
  })

  it('adds imports after the real imports, not into a code snippet the page shows', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const snippet = \`npm install i18next

import i18next from 'i18next'
import Backend from 'i18next-locize-backend'
\`
  return <p data-snippet={snippet}>Copy this snippet into your app</p>`, "import React from 'react'\n")
    })
    expect(code.startsWith("import React from 'react'\nimport { useTranslation } from 'react-i18next'\n")).toBe(true)
    expect(code).toContain("import i18next from 'i18next'\nimport Backend from 'i18next-locize-backend'\n`")
  })

  it('does not name a new key after a key the code nests under, and reuses the key of the same text', async () => {
    const { code } = await instrument({
      'A.jsx': component("  return <div><h2>Tenants</h2><p>{t('tenants.title')}</p><b>Save changes</b><i>{t('saveChanges', 'Save changes')}</i></div>", "import { useTranslation } from 'react-i18next'\n").replace('{\n', '{\n  const { t } = useTranslation()\n')
    })
    expect(code).toContain("{t('tenants2', 'Tenants')}")
    expect(code).toContain("<b>{t('saveChanges', 'Save changes')}</b>")
  })

  it('adds t to the dependencies of a useMemo whose callback gets a t() call', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const label = useMemo(() => n > 1 ? 'Several projects selected' : name, [n, name])
  const empty = useCallback(() => 'Nothing selected yet', [])
  return <p>{label}{empty()}</p>`)
    })
    expect(code).toContain('[n, name, t])')
    expect(code).toContain("'Nothing selected yet'), [t])")
  })

  it('generates no init file when the code imports i18next already, but does despite another library\'s init()', async () => {
    await instrument({
      'A.jsx': component('  Sentry.init({ dsn: name })\n  return <h1>Welcome to the dashboard</h1>')
    })
    await expect(access(join(tempDir, 'src', 'i18n.js'))).resolves.toBeUndefined()

    await rm(join(tempDir, 'src'), { recursive: true })
    await mkdir(join(tempDir, 'src'))
    infos = []
    await instrument({
      'B.jsx': component('  return <h1>Welcome to the dashboard</h1>', "import { Trans } from 'react-i18next'\n")
    })
    await expect(access(join(tempDir, 'src', 'i18n.js'))).rejects.toThrow()
    expect(infos.some(m => m.includes('no i18n init file generated'))).toBe(true)
  })

  it('never rewrites object keys, computed keys, compared strings or case values', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const data = { 'Get a subscription to receive new features.': 1 }
  data['Get a subscription to receive new features.'] = 2
  if (name === 'Your session has expired') return null
  switch (name) { case 'Something went wrong here': return null }
  return <p>{data}</p>`)
    })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('leaves the prompts for a language model alone, but not a component or a prompt for the user', async () => {
    const { code } = await instrument({
      'A.jsx': `export function getSystemPrompt (lng) {
  return ['You are a professional native translator.', \`Translate into \${lng}, keep the placeholders.\`].join(' ')
}
export function EmailPrompt () {
  const detailPrompt = 'Please add more details to your request.'
  return <p title={detailPrompt}>Enter your email address to continue</p>
}
`
    })
    expect(code).toContain("['You are a professional native translator.', `Translate into ${lng}, keep the placeholders.`]")
    expect(code).toContain("t('pleaseAddMoreDetailsToYourRequest', 'Please add more details to your request.')")
    expect(code).toContain("t('enterYourEmailAddressToContinue', 'Enter your email address to continue')")
  })

  it('leaves CSS values, class lists and style ternaries alone, and language codes', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  user.style['box-shadow'] = 'inset 0 0 5px 1px var(--input-active)'
  const classes = \`spaces \${name} \${shown} \${token}\`
  const lng = \`zh-\${project.country}\`
  return <p className={classes} lang={lng} style={{ color: n === 1 ? 'var(--state-success)' : 'var(--font-secondary)' }}>{n === 1 ? 'item-score-1' : 'item-score-low'}</p>`)
    })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('takes JSX text as it renders, lines joined and entities decoded', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <p>
      Cancels the organization&apos;s subscription and marks every project
      still on it for deletion.
    </p>
  )`)
    })
    expect(code).toContain("'Cancels the organization\\'s subscription and marks every project still on it for deletion.'")
  })

  it('takes both branches of a text ternary, keeps a sentence around a formatted value, skips camelCase labels', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <div>
      <button>{n ? 'Confirm all reviews' : 'stop'}</button>
      <p>up to {items.length.toLocaleString()} segments of your project are checked</p>
      <Toggle label='pendingAdd' />
    </div>
  )`)
    })
    expect(code).toContain("t('confirmAllReviews', 'Confirm all reviews') : t('stop', 'stop')")
    expect(code).toContain("'up to {{length}} segments of your project are checked', { length: items.length.toLocaleString() }")
    expect(code).toContain("label='pendingAdd'")
  })

  it('uses a t the component has already and imports nothing twice', async () => {
    const { code } = await instrument({
      'A.jsx': `import { useTranslation } from './shared'
export function Bulk ({ t }) {
  return <h2>Bulk delete of the selected keys</h2>
}
export function Other () {
  const { t } = useTranslation('other')
  return <h2>Search and replace in all values</h2>
}
export const Arrow = () => {
  return <h2>Machine translation of the filtered keys</h2>
}
`
    })
    expect(code).not.toContain("from 'react-i18next'")
    expect(code.match(/const \{ t \}/g)).toHaveLength(2)
    expect(code).toContain('export const Arrow = () => {\n  const { t } = useTranslation()')
  })

  it('leaves the project\'s own translate calls, its Trans components and icon ligatures alone', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <div title={translate('Welcome to the dashboard here')}>
      <T>Some text that is translated already</T>
      <Icon>delete</Icon>
      <span className='material-icons'>search</span>
    </div>
  )`)
    }, false, { functions: ['translate'], transComponents: ['T'] })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('leaves analytics events alone but finds the text of a handler a DOM method gets', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  analytics.track('Upgrade Button Clicked')
  gtag('event', 'Sign Up Completed')
  document.body.addEventListener('click', () => { open('Link copied to clipboard') })
  return null`)
    })
    expect(code).toContain("track('Upgrade Button Clicked')")
    expect(code).toContain("gtag('event', 'Sign Up Completed')")
    expect(code).toContain("open(t('linkCopiedToClipboard', 'Link copied to clipboard'))")
  })

  it('finds a CJK text beside a placeholder', async () => {
    const { code } = await instrument({ 'A.jsx': component('  return <p>共 {n} 条</p>') })
    expect(code).toContain("t('n', '共 {{n}} 条', { n })")
  })

  it('keeps a plural helper import that also brings a default import', async () => {
    const { code } = await instrument({
      'A.jsx': component("  return <p>{fmt(n)}{plural(n, '# file', '# files')}</p>", "import fmt, { plural } from './format'\n")
    })
    expect(code).toContain("import fmt, { plural } from './format'")
  })

  it('leaves a log line built in a variable alone, and long class names', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const took = \`search settled after \${n} ms of typing\`
  console.log('[perf]', took)
  return <p className={n === 1 ? 'cat-ui-file-infos-item-score-1' : 'cat-ui-file-infos-item-score-low'}>x</p>`)
    })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('leaves a string the file also uses as data alone, but not the JSX text next to a value', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const facet = { id: 'tfa', of: u => u.on ? 'two-factor is on' : 'two-factor is off', order: ['two-factor is on', 'two-factor is off'] }
  return <select title={facet.id}><option value='all'>all</option></select>`)
    })
    expect(code).toContain("of: u => u.on ? 'two-factor is on' : 'two-factor is off'")
    expect(code).toContain("<option value='all'>{t('all', 'all')}</option>")
  })

  it('takes what a JSX element renders from an expression as text, and both branches of a text ternary', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <div title={n ? \`Pay invoice \${n}\` : 'Pay invoice'}>
      {n ? <b>{n}</b> : 'Never used'}
      {shown && 'saving'}
    </div>
  )`)
    })
    expect(code).toContain("t('payInvoiceN', 'Pay invoice {{n}}', { n }) : t('payInvoice', 'Pay invoice')")
    expect(code).toContain("t('neverUsed', 'Never used')")
    expect(code).toContain("shown && t('saving', 'saving')")
  })

  it('keeps a sentence whole around a value, a choice of values and a literal piece', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <div>
      <p>{shown} of {n ? 3 : 2} steps are done</p>
      <a href='/docs'>Learn{'\\u00a0'}more</a>
    </div>
  )`)
    })
    expect(code).toContain("t('shownOfValStepsAreDone', '{{shown}} of {{val}} steps are done', { shown, val: n ? 3 : 2 })")
    expect(code).toContain("t('learnMore', 'Learn\u00a0more')")
  })

  it('gives an expression-bodied component the hook, and keeps a button out of a sentence', async () => {
    const { code } = await instrument({
      'A.jsx': `export const Hint = () => <p>Assigned keys of this screenshot <Button>add more keys</Button></p>
`
    })
    expect(code).toContain('export const Hint = () => {\n  const { t } = useTranslation()\n  return <p>')
    expect(code).toContain("{t('assignedKeysOfThisScreenshot', 'Assigned keys of this screenshot')}")
    expect(code).not.toContain('<Trans')
  })

  it('adds no language switch that would run a computed expression twice', async () => {
    const { results } = await instrument({
      'A.jsx': component('  useEffect(() => { setLanguage(defaultOf(project)) }, [project])\n  return null')
    })
    expect(results.totalLanguageChanges).toBe(0)
  })

  it('keeps the space at the edge of a rewritten sentence, and translates a rendered string that is also data', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const facet = { order: ['override', 'direct'] }
  return (
    <div title={facet.order[0]}>
      <p>
        The last automatic translation could not use this provider:{' '}
        <strong><code>{name}</code></strong>
      </p>
      <button data-tip='override'>{n ? 'override' : 'edit this entry'}</button>
    </div>
  )`)
    })
    expect(code).toContain("{t('theLastAutomaticTranslationCouldNotUse', 'The last automatic translation could not use this provider:')}{' '}")
    expect(code).toContain("n ? t('override', 'override') : t('editThisEntry', 'edit this entry')")
    expect(code).toContain("data-tip={t('override', 'override')}")
    expect(code).toContain("order: ['override', 'direct']")
  })

  it('leaves the strings of formats, patterns, events, logs and errors alone', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const day = dayjs(n).format('DD MMM YYYY')
  const re = new RegExp('Not found here')
  emitter.emit('project selected now', name)
  logger.info('Loaded all the projects of the user')
  if (!project) throw new Error('Project id is required here')
  return <p title={day}>{String(re)}</p>`)
    })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('translates the branches of a string ternary in a sentence instead of making it a placeholder', async () => {
    const { code } = await instrument({
      'A.jsx': component("  return <p>Logged in as {n ? 'Administrator' : 'Member'}</p>")
    })
    expect(code).not.toContain('{{val}}')
    expect(code).toContain("t('administrator', 'Administrator') : t('member', 'Member')")
  })

  it('gives a component with a t prop the i18n it needs for a language switch', async () => {
    const { code } = await instrument({
      'A.jsx': `export function Picker ({ t, setLanguage }) {
  return <select title={t('pick')} onChange={e => setLanguage(e.target.value)} />
}
`
    })
    expect(code).toContain('const { i18n } = useTranslation()')
    expect(code).toContain("import { useTranslation } from 'react-i18next'")
    expect(code).toContain('i18n.changeLanguage(e.target.value)')
  })

  it('applies the same skips when merging sentences and plurals: code, prompts, computed keys', async () => {
    const { code } = await instrument({
      'A.jsx': `export function getSystemPrompt (n) {
  return n === 1 ? 'Check the one segment' : 'Check all the segments'
}
export function Page ({ n, name }) {
  const counts = { [n === 1 ? 'one item here' : 'many items here']: 1 }
  return <div title={counts}><code>npm install {name} --save-dev</code></div>
}
`
    })
    expect(code).not.toMatch(/\bt\(/)
  })

  it('leaves the texts of a component whose t is not a translation function, and says so', async () => {
    const { code } = await instrument({
      'A.jsx': `export function Clock () {
  const [t, setT] = useState(0)
  return <p onClick={() => setT(t + 1)}>Seconds since the page opened</p>
}
`
    })
    expect(code).not.toContain('useTranslation')
    expect(code).toContain('<p onClick={() => setT(t + 1)}>Seconds since the page opened</p>')
    expect(warnings.some(w => w.includes('declare a `t` of their own'))).toBe(true)
  })

  it('translates the label of an option whose value is the same text, and a ternary branch after a string', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const options = [{ value: 'Pay every week', label: 'Pay every week' }]
  if (options[0].value === 'Pay every week') return null
  return <Field hint={n ? 'Enter your API key' : \`Key \${name} is set already\`} options={options} />`)
    })
    expect(code).toContain("{ value: 'Pay every week', label: t('payEveryWeek', 'Pay every week') }")
    expect(code).toContain("t('keyNameIsSetAlready', 'Key {{name}} is set already', { name })")
  })

  it('skips stories, mocks and fixtures by default', async () => {
    await mkdir(join(tempDir, 'src', '__mocks__'))
    const story = component('  return <h1>Welcome to the dashboard</h1>')
    await instrument({ 'A.stories.jsx': story, '__mocks__/B.jsx': story })
    expect(await readFile(join(tempDir, 'src', 'A.stories.jsx'), 'utf-8')).toBe(story)
    expect(await readFile(join(tempDir, 'src', '__mocks__', 'B.jsx'), 'utf-8')).toBe(story)
  })

  it('reports the module-scope strings of all files in one warning', async () => {
    await instrument({
      'A.jsx': "export const OPTIONS = [{ label: 'First option here' }]\n",
      'B.jsx': "export const MORE = [{ label: 'Second option here' }]\n"
    }, true)
    const moduleScope = warnings.filter(w => w.includes('module-scope string'))
    expect(moduleScope).toHaveLength(1)
    expect(moduleScope[0]).toContain('Skipped 2 module-scope string(s)')
    expect(moduleScope[0]).toMatch(/A\.jsx \(1\)[\s\S]*B\.jsx \(1\)|B\.jsx \(1\)[\s\S]*A\.jsx \(1\)/)
  })
})

describe('generateKeyFromContent', () => {
  it('keeps the first words of a long sentence, at most 40 characters of whole words', () => {
    const key = generateKeyFromContent('You are a member of the organization. Only organization admins can add projects there.')
    expect(key).toBe('youAreAMemberOfTheOrganizationOnly')
    expect(key.length).toBeLessThanOrEqual(40)
  })

  it('makes no `_` that i18next would read as a plural or context suffix', () => {
    expect(generateKeyFromContent('Pay invoice in_...')).toBe('payInvoiceIn')
    expect(generateKeyFromContent('This is a _1 key')).toBe('thisIsA1Key')
  })

  it('takes a placeholder name as words of its own', () => {
    expect(generateKeyFromContent('heap {{used}}→{{total}} MB')).toBe('heapUsedTotalMb')
    expect(generateKeyFromContent('{{unreadNews}} unread')).toBe('unreadNewsUnread')
  })
})
