/* eslint-disable no-template-curly-in-string -- the expectations quote template literals */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInstrumenter, writeExtractedKeys } from '../src/instrumenter'
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

  it('makes two texts of a template literal with one optional part, not English words in a placeholder', async () => {
    const { code, results } = await instrument({
      'A.jsx': component(`  const label = \`uses AI tokens\${n !== undefined ? \`, \${n} left\` : ''}\`
  return <p title={label}>{\`Version \${project.version}\${n ? \`, cached for \${n} seconds\` : ''} is published\`}</p>`)
    })
    expect(results.totalTransformed).toBe(2)
    expect(code).toContain("{(n ? t('versionCachedForNSecondsIsPublished', 'Version {{version}}, cached for {{n}} seconds is published', { version: project.version, n }) : t('versionIsPublished', 'Version {{version}} is published', { version: project.version }))}")
    expect(code).toContain("(n !== undefined ? t('usesAiTokensNLeft', 'uses AI tokens, {{n}} left', { n }) : t('usesAiTokens', 'uses AI tokens'))")
  })

  it('translates the words of a placeholder\'s value: a fallback and the branches of a choice', async () => {
    const { code } = await instrument({
      'A.jsx': component("  return <input placeholder={`Search ${name || 'items'}…`} title={`Namespace: ${token || (open ? 'all namespaces' : 'none')}`} aria-label={`Row ${user.id || 'new-row'}`} />")
    })
    expect(code).toContain("t('searchName', 'Search {{name}}…', { name: name || t('items', 'items') })")
    expect(code).toContain("{ token: token || (open ? t('allNamespaces', 'all namespaces') : t('none', 'none')) }")
    expect(code).toContain("id: user.id || 'new-row'")
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

  it('adds a language switch only where a call is a statement of its own, for a setter or settings, not for data nor state', async () => {
    const { code, results } = await instrument({
      'A.jsx': component(`  const [lng, setLng] = useState()
  const pick = (l) => setLng(l)
  if (open) setLanguage(lng)
  const load = () => fetchDownloads({ lng })
  const save = () => { return saveSettings({ language: lng }) }
  return <p onClick={() => updateSettings({ language: lng })}>{pick}{load}{save}</p>`)
    })
    expect(results.totalLanguageChanges).toBe(1)
    expect(code).toContain('if (open) setLanguage(lng)')
    // a useState setter sets the component's state (a view's language filter in a translation tool)
    expect(code).toContain('const pick = (l) => setLng(l)')
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
      'A.jsx': "export const OPTIONS = ['First option here']\n",
      'B.jsx': "export const MORE = ['Second option here']\n"
    }, true)
    const moduleScope = warnings.filter(w => w.includes('module-scope string'))
    expect(moduleScope).toHaveLength(1)
    expect(moduleScope[0]).toContain('Skipped 2 module-scope string(s)')
    expect(moduleScope[0]).toMatch(/A\.jsx \(1\): line 1[\s\S]*B\.jsx \(1\): line 1|B\.jsx \(1\): line 1[\s\S]*A\.jsx \(1\): line 1/)
  })

  // Patterns found in a second round on the same app, its texts back in the code (i18next taken out)

  it('never puts an element into a t() value: a variable that holds JSX, or children', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const link = <Link to='/billing'>Billing</Link>
  return <><p>The payment method is changed under {link}.</p><Button>{project.children} in {n} s</Button><b>{children} in {n} s</b></>`)
    })
    expect(code).not.toContain('{{link}}')
    expect(code).not.toContain('{{children}}')
    expect(code).toContain('{link}.')
    expect(code).toContain("{children} {t('inNS', 'in {{n}} s', { n })}")
  })

  it('takes neither a selector of an optional call nor class names in a classNames object for text', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const heading = open?.current?.querySelector('h1, h2, h3, h4')
  const props = select({ classNames: { container: () => 'btn btn-secondary btn-dropdown', menu: () => 'select-menu' } })
  return <Select {...props} heading={heading}>Choose a project</Select>`)
    })
    expect(code).toContain("querySelector('h1, h2, h3, h4')")
    expect(code).toContain("container: () => 'btn btn-secondary btn-dropdown'")
    expect(code).toContain("{t('chooseAProject', 'Choose a project')}")
  })

  it('translates the props of a component that its name or a sentence marks as text, and an icon\'s label', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <>
      <ModalActions saveLabel='set' cancelText='Not now' />
      <ConfirmModal labelConfirm='detach' labelPosition='top' />
      <Grid name='projects' empty='No projects yet.' noMatchFilters='No one matches these filters.' searchPlaceholder='Find a project…' />
      <Loader message='Loading projects' tip='Copy snippet' />
      <Box textAlign='center' titleIcon='lock' align='flex-start center' isEmpty='yes' columns='minmax(0, 1fr) 2fr' />
      <Chart tooltip='off' legend='bottom' empty='hide' allowEmpty='false' filterText='all' fontFamily='Helvetica Neue' dateFormat='MMMM D, YYYY' eventName='Sign Up Clicked' />
      <CopyToClipboard text='npm install i18next' />
      <FitTitle text='Delete tenant {name}?' name={name} />
      <FieldLabel text='Scopes' />
      <Icon name='warning' aria-label='at the limit' data-tip={open ? 'Expand' : 'Collapse'}>warning</Icon>
    </>
  )`)
    })
    expect(code).toContain("labelPosition='top'")
    expect(code).toContain("<Chart tooltip='off' legend='bottom' empty='hide' allowEmpty='false' filterText='all' fontFamily='Helvetica Neue' dateFormat='MMMM D, YYYY' eventName='Sign Up Clicked' />")
    expect(code).toContain("<CopyToClipboard text='npm install i18next' />")
    expect(code).toContain("text={t('deleteTenantName', 'Delete tenant {name}?')}")
    expect(code).toContain("<FieldLabel text={t('scopes', 'Scopes')} />")
    for (const text of ['set', 'Not now', 'detach', 'No projects yet.', 'No one matches these filters.', 'Find a project…', 'Loading projects', 'Copy snippet', 'at the limit', 'Expand', 'Collapse']) {
      expect(code).toContain(`, '${text}')`)
    }
    expect(code).toContain("name='projects'")
    expect(code).toContain("<Box textAlign='center' titleIcon='lock' align='flex-start center' isEmpty='yes' columns='minmax(0, 1fr) 2fr' />")
    expect(code).toContain('>warning</Icon>')
  })

  it('translates a single word under a text property and in a title call, not a placeholder or a list of acronyms', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  useDocumentTitle('Projects')
  const page = getPageTitle('dashboard')
  const meta = <meta name='robots' content={open ? 'noindex' : 'index'} />
  const options = [{ value: '', label: 'has' }, { value: 'not', label: 'has not' }]
  return (
    <Pills options={options}>
      <FitTitle text={n > 1 ? '"{name}",' : name} name={name} />
      <select><option value='eu_vat'>EU VAT</option><option value='ca_pst_bc'>CA PST (BC)</option><option value='unknown'>Other</option></select>
      <Button>SIGN IN</Button>
    </Pills>
  )`)
    })
    expect(code).toContain("useDocumentTitle(t('projects', 'Projects'))")
    expect(code).toContain("{ value: '', label: t('has', 'has') }")
    expect(code).toContain("'\"{name}\",'")
    expect(code).toContain('>EU VAT</option>')
    expect(code).toContain('>CA PST (BC)</option>')
    expect(code).toContain("{t('other', 'Other')}")
    expect(code).toContain("getPageTitle('dashboard')")
    expect(code).toContain("content={open ? 'noindex' : 'index'}")
    expect(code).toContain("{t('signIn', 'SIGN IN')}")
  })

  it('leaves a type alone: a string in a TypeScript type is no value', async () => {
    const { code } = await instrument({
      'A.tsx': `import { useState } from 'react'
type Sort = { label: 'asc' | 'desc' }
export function Page () {
  const [sort] = useState<{ label: 'asc' | 'desc', title: 'Hello there' }>()
  return <p title={sort ? 'Sorted' : 'Not sorted'}>Sorted by name</p>
}
`
    }, false, { input: normalizePath(join(tempDir, 'src/**/*.tsx')) })
    expect(code).toContain("type Sort = { label: 'asc' | 'desc' }")
    expect(code).toContain("useState<{ label: 'asc' | 'desc', title: 'Hello there' }>()")
    expect(code).toContain("{t('sortedByName', 'Sorted by name')}")
  })

  it('keeps a JSX variable of one component from splitting the texts of another', async () => {
    const { code } = await instrument({
      'A.jsx': `export function A () {
  const label = <b>Hi</b>
  return <p>{label}</p>
}
export function B ({ label, n }) {
  return <p>Delete {label} and {n} more items now?</p>
}
`
    })
    expect(code).toContain("{t('deleteLabelAndNMoreItemsNow', 'Delete {{label}} and {{n}} more items now?', { label, n })}")
  })

  it('names the state setters it leaves without a language switch, and only those of the function that declares them', async () => {
    const { code, results } = await instrument({
      'A.jsx': `export function Filter ({ open }) {
  const [lng, setLanguage] = useState()
  return <p onClick={() => setLanguage(open)}>Filter by language</p>
}
export function Settings ({ code }) {
  const { setLanguage } = useSettings()
  return <p onClick={() => setLanguage(code)}>Use this language</p>
}
`
    })
    expect(results.totalLanguageChanges).toBe(1)
    expect(code).toContain('() => setLanguage(open)')
    expect(code).toContain('{ i18n.changeLanguage(code); setLanguage(code); }')
    expect(warnings.some(w => w.includes('React state setters') && w.includes('A.jsx:3'))).toBe(true)
  })

  it('takes a re-export of i18next as its setup, and a pnpm-workspace.yaml with settings only as a single app', async () => {
    await instrument({
      'A.jsx': component('  return <h1>Welcome to the dashboard</h1>'),
      'i18n-shared.js': "export { default } from 'i18next'\n"
    })
    await expect(access(join(tempDir, 'src', 'i18n.js'))).rejects.toThrow()

    await rm(join(tempDir, 'src'), { recursive: true, force: true })
    await mkdir(join(tempDir, 'app'), { recursive: true })
    await writeFile(join(tempDir, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - esbuild\n')
    await writeFile(join(tempDir, 'app', 'A.jsx'), component('  return <h1>Welcome to the dashboard</h1>'))
    const cfg = config()
    cfg.extract.input = normalizePath(join(tempDir, 'app/**/*.jsx'))
    await runInstrumenter(cfg, { isDryRun: false, quiet: true }, logger)
    await expect(access(join(tempDir, 'i18n.js'))).resolves.toBeUndefined()
  })

  it('translates module-scope texts when they are used: JSX text as <Trans>, a property\'s value through a getter', async () => {
    const { code } = await instrument({
      'A.jsx': `const NEWS = [{ title: 'Glossary suggestions', text: <p>Suggested terms from your translations.</p> }]
const KINDS = [{ id: 'project', label: 'Projects' }]
const MESSAGES = Object.freeze({ 'error.notFound': 'Nothing found here.', 100: 'Conflict with another value.' })
const BLOCKS = [1, 2].map(level => ({ value: \`h\${level}\`, label: \`Heading \${level}\` }))
const READ_NOW = [{ label: 'Read at import' }]
const LABELS = READ_NOW.map(k => k.label)
const page = register({ title: 'Registered at import' })
const OPTION = <option value='x'>Plain text only</option>
export function Page ({ code }) {
  return <ul title={MESSAGES[code]}>{[...NEWS, ...KINDS, ...BLOCKS].map(k => <li key={k.label}>{k.label}{k.text}</li>)}{LABELS}{page}{OPTION}</ul>
}
`
    })
    expect(code).toContain("{ get title () { return i18next.t('glossarySuggestions', 'Glossary suggestions') }, text: <p><Trans i18nKey='suggestedTermsFromYourTranslations'>Suggested terms from your translations.</Trans></p> }")
    expect(code).toContain("{ id: 'project', get label () { return i18next.t('projects', 'Projects') } }")
    expect(code).toContain("get 'error.notFound' () { return i18next.t('nothingFoundHere', 'Nothing found here.') }")
    expect(code).toContain("get 100 () { return i18next.t('conflictWithAnotherValue', 'Conflict with another value.') }")
    // a callback of .map() at module scope runs at import: its object's text is read through a getter too
    expect(code).toContain("get label () { return i18next.t('headingLevel', 'Heading {{level}}', { level }) }")
    // read at import, or passed to a call that may read it at once, or plain text only: left, and named
    expect(code).toContain("const READ_NOW = [{ label: 'Read at import' }]")
    expect(code).toContain("register({ title: 'Registered at import' })")
    expect(code).toContain('>Plain text only</option>')
    expect(warnings.find(w => w.includes('module-scope string'))).toContain('Skipped 3 module-scope string(s)')
    expect(code).toContain("import { Trans } from 'react-i18next'")
    expect(code).toContain("import i18next from 'i18next'")
    const { parse } = await import('@swc/core')
    await expect(parse(code, { syntax: 'ecmascript', jsx: true })).resolves.toBeDefined()
  })

  it('leaves the texts that only build data: a mailto body, a file\'s content', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const intro = ['I hit an error in the app.', \`URL: \${user.url}\`].join('\\n')
  const body = intro + items.join('\\n')
  const mail = \`mailto:support@example.com?subject=\${encodeURIComponent('Error in the app')}&body=\${encodeURIComponent(body)}\`
  const preamble = [\`project: \${project.name}\`, \`version: \${n}\`].join('\\n')
  const save = () => zip.file('export.csv', \`\${preamble}\\n\${token}\`)
  const blob = () => new Blob(['Exported by the app'], { type: 'text/plain' })
  return <a href={mail} onClick={save} onDoubleClick={blob}>Send us the details</a>`)
    })
    expect(code).toContain("const intro = ['I hit an error in the app.', `URL: ${user.url}`]")
    expect(code).toContain("encodeURIComponent('Error in the app')")
    expect(code).toContain('const preamble = [`project: ${project.name}`, `version: ${n}`]')
    expect(code).toContain("new Blob(['Exported by the app']")
    expect(code).toContain("{t('sendUsTheDetails', 'Send us the details')}")
  })

  it('names the texts that are parts of a sentence, with their lines', async () => {
    await instrument({
      'A.jsx': component(`  const via = open ? ' (via the command line)' : ''
  const needs = \`, which needs \${name}\`
  return <p title={\`Plan for this project\${needs}\`}>{via}</p>`)
    }, true)
    const parts = warnings.find(w => w.includes('Parts of a sentence'))
    expect(parts).toContain("A.jsx:2 ' (via the command line)'")
    expect(parts).toContain("A.jsx:3 ', which needs {{name}}'")
  })

  it('gives a Next.js app next-i18next even when a page shows an i18next setup snippet as text', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { next: '^16.0.0', react: '^19.0.0' } }))
    await mkdir(join(tempDir, 'src', 'app'), { recursive: true })
    const { code } = await instrument({
      'app/page.jsx': `export default function Page () {
  const snippet = \`import i18next from 'i18next'\`
  return <main><h1>Welcome to the docs</h1><pre>{snippet}</pre></main>
}
`
    })
    expect(code).toContain('await getT()')
    expect(code).not.toContain('useTranslation')
  })

  it('translates the sibling phrases of a text in a map of strings, not a single word beside them', async () => {
    const { code } = await instrument({
      'A.jsx': component("  const labels = { ht: 'by human', tm: 'by translation memory', icon: 'check', className: 'btn primary', old: 'over 14 days ago', list: 'Languages: {list}' }\n  return <p>{labels[token]}</p>")
    })
    expect(code).toContain("{ ht: t('byHuman', 'by human'), tm: t('byTranslationMemory', 'by translation memory'), icon: 'check', className: 'btn primary', old: t('over14DaysAgo', 'over 14 days ago'), list: t('languagesList', 'Languages: {list}') }")
  })

  it('gives no getter to what is read at import, here or in another file, computed again on every read, or changed', async () => {
    const { code } = await instrument({
      'A.jsx': `export const ROLES = [{ value: 'admin', label: 'Administrator role' }]
const LABELS = [{ label: 'First option here' }]
function build () { return LABELS.map(l => l.label) }
export const TITLES = build()
const STORE = [{ title: 'Read by the store' }]
class Store { constructor () { this.title = STORE[0].title } }
export const store = new Store()
export const PAGE = { title: 'Changed later on' }
export function rename (x) { PAGE.title = x }
let n = 0
export const COUNTS = { label: \`Count is \${n++} now\`, title: register('Hello there world'), options: ['Yes please do', 'No thank you'] }
export const VIA_IIFE = (() => [{ label: 'Built by an arrow' }])()
export const FALLBACK = <Suspense fallback={<div>Loading the app now</div>}><App /></Suspense>
export const NEWS = <p>Nothing to see &amp; do here</p>
`,
      'B.jsx': `import { ROLES } from './A'
export const BY_VALUE = Object.fromEntries(ROLES.map(r => [r.value, r.label]))
`
    })
    expect(code).toContain("{ value: 'admin', label: 'Administrator role' }")
    expect(code).toContain("const LABELS = [{ label: 'First option here' }]")
    expect(code).toContain("const STORE = [{ title: 'Read by the store' }]")
    expect(code).toContain("const PAGE = { title: 'Changed later on' }")
    expect(code).toContain("label: `Count is ${n++} now`, title: register('Hello there world'), options: ['Yes please do', 'No thank you']")
    expect(code).toContain("(() => [{ get label () { return i18next.t('builtByAnArrow', 'Built by an arrow') } }])()")
    expect(code).toContain('fallback={<div>Loading the app now</div>}')
    expect(code).toContain('<Trans i18nKey="nothingToSeeDoHere">Nothing to see &amp; do here</Trans>')
  })

  it('leaves the data siblings of a text and TypeScript literals alone, and gives a one-line component its hook on a line of its own', async () => {
    const { code } = await instrument({
      'A.tsx': `export function App () { return <h1>Welcome home today</h1> }
export function Row () {
  const meta = { label: 'Created at', format: 'MMM D, YYYY', transition: 'all 0.3s ease', mime: 'text/plain; charset=utf-8', event: 'Sign Up Completed', font: 'Helvetica Neue', shortcut: 'Ctrl S', hint: 'by the owner' }
  const state = { label: 'Active now' as const }
  return <p title={meta.label}>{state.label}</p>
}
export const MODES = { label: 'Active now' } satisfies { label: 'Active now' | 'Paused now' }
`
    }, false, { input: normalizePath(join(tempDir, 'src/**/*.tsx')) })
    expect(code).toContain("format: 'MMM D, YYYY', transition: 'all 0.3s ease', mime: 'text/plain; charset=utf-8', event: 'Sign Up Completed', font: 'Helvetica Neue', shortcut: 'Ctrl S', hint: t('byTheOwner', 'by the owner') }")
    expect(code).toContain("{ label: 'Active now' as const }")
    expect(code).toContain("export const MODES = { label: 'Active now' } satisfies")
    expect(code).toContain('export function App () {\n  const { t } = useTranslation()\n')
    const { parse } = await import('@swc/core')
    await expect(parse(code, { syntax: 'typescript', tsx: true })).resolves.toBeDefined()
  })

  it('writes the keys of a split text and of the words in a placeholder\'s value', async () => {
    const { results } = await instrument({
      'A.jsx': component("  return <p title={`uses AI tokens${n ? `, ${n} left` : ''}`}>{`Search ${name || 'items'}…`}</p>")
    }, true)
    await writeExtractedKeys(results.files.flatMap(f => f.candidates), config(), undefined, logger)
    const json = JSON.parse(await readFile(join(tempDir, 'locales', 'en', 'translation.json'), 'utf-8'))
    expect(json).toMatchObject({ usesAiTokensNLeft: 'uses AI tokens, {{n}} left', usesAiTokens: 'uses AI tokens', searchName: 'Search {{name}}…', items: 'items' })
  })

  it('never names a placeholder after an option of t()', async () => {
    const { code } = await instrument({
      'A.jsx': component('  return <p title={`${shown.value} of ${count.value} values`}>{n}</p>')
    })
    expect(code).not.toContain('{{count}}')
    expect(code).toContain("'{{value}} of {{value2}} values'")
  })

  it('leaves the strings that go into an ignore list alone', async () => {
    const { code } = await instrument({
      'a.js': `export function errorOf (err, ignore = []) {
  ignore.push('Failed to fetch')
  return ignore.some(i => err.message.includes(i)) ? null : 'Something went wrong. Please try again.'
}
`
    })
    expect(code).toContain("ignore.push('Failed to fetch')")
    expect(code).toContain("i18next.t('somethingWentWrongPleaseTryAgain', 'Something went wrong. Please try again.')")
  })

  it('names a placeholder after what its value is of when the name is taken', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  const label = \`Changes the plan of "\${project.name}" to \${name(open)}.\`
  return <p title={label}>{\`showing \${shown.length} of \${items.length}\`}</p>`)
    })
    expect(code).toContain("'Changes the plan of \"{{name}}\" to {{open}}.', { name: project.name, open: name(open) }")
    expect(code).toContain("'showing {{length}} of {{items}}', { length: shown.length, items: items.length }")
  })

  it('puts a <Trans> around text over several lines on lines of its own', async () => {
    const { code } = await instrument({
      'A.jsx': component(`  return (
    <p>
      Some of your projects enforce two-factor authentication. Set it up
      <a href={\`/p/\${project.slug}/profile\`}>in your profile</a> before you open them,
      or <a href={\`/p/\${project.slug}\`}>leave them</a>.
    </p>
  )`)
    })
    expect(code).toContain(`    <p>
      <Trans i18nKey="someOfYourProjectsEnforceTwofactor">
        Some of your projects enforce two-factor authentication. Set it up
        <a href={\`/p/\${project.slug}/profile\`}>in your profile</a> before you open them,
        or <a href={\`/p/\${project.slug}\`}>leave them</a>.
      </Trans>
    </p>`)
  })

  it('generates the init file when i18next shows only in a snippet, none at the root of a workspace', async () => {
    await instrument({
      'A.jsx': component(`  const snippet = \`import i18next from 'i18next'
i18next.init({ fallbackLng: 'en' })\`
  return <pre title='Your setup code'>{snippet}</pre>`)
    })
    await expect(access(join(tempDir, 'src', 'i18n.js'))).resolves.toBeUndefined()

    await rm(join(tempDir, 'src'), { recursive: true, force: true })
    await mkdir(join(tempDir, 'packages', 'app', 'src'), { recursive: true })
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'], dependencies: { react: '^19.0.0' } }))
    await writeFile(join(tempDir, 'packages', 'app', 'src', 'A.jsx'), component('  return <h1>Welcome to the dashboard</h1>'))
    const cfg = config()
    cfg.extract.input = normalizePath(join(tempDir, 'packages/*/src/**/*.jsx'))
    await runInstrumenter(cfg, { isDryRun: false, quiet: true }, logger)
    await expect(access(join(tempDir, 'i18n.js'))).rejects.toThrow()
    expect(infos.some(i => i.includes('root of a workspace'))).toBe(true)
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
