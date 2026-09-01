import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runSyncer } from '../src/syncer'
import type { I18nextToolkitConfig } from '../src/types'

// isolate from the developer's global git config (signing, hooks, defaultBranch)
const git = (args: string[], cwd: string) => execFileSync('git', args, {
  cwd,
  stdio: 'ignore',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
})
const commit = (cwd: string, message: string) => git(['-c', 'user.name=test', '-c', 'user.email=test@test.tld', 'commit', '-m', message], cwd)

const config: I18nextToolkitConfig = {
  locales: ['en', 'de'],
  extract: {
    input: ['src/'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
}

describe('syncer --changed-only', () => {
  const originalCwd = process.cwd()
  let repo: string

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'i18next-changed-only-')))
    process.chdir(repo)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(repo, { recursive: true, force: true })
  })

  const writeJson = (relPath: string, obj: Record<string, unknown>) => {
    mkdirSync(dirname(join(repo, relPath)), { recursive: true })
    writeFileSync(join(repo, relPath), JSON.stringify(obj, null, 2))
  }
  const readJson = (relPath: string) => JSON.parse(readFileSync(join(repo, relPath), 'utf8'))

  it('scopes changed keys per source file: the same bare key name in another namespace does not cross-match', async () => {
    git(['init', '-b', 'main'], repo)
    writeJson('locales/en/emailA.json', { subject: 'Welcome!', footer: 'Bye' })
    writeJson('locales/en/emailB.json', { subject: 'Goodbye!' })
    git(['add', '.'], repo)
    commit(repo, 'base')
    git(['checkout', '-q', '-b', 'feature'], repo)
    writeJson('locales/en/emailA.json', { subject: 'Welcome to locize!', footer: 'Bye' })

    await runSyncer(config, { quiet: true, changedOnly: true })

    // only emailA's changed key is propagated — not its unchanged footer,
    // and not emailB's same-named subject
    expect(readJson('locales/de/emailA.json')).toEqual({ subject: '' })
    expect(existsSync(join(repo, 'locales/de/emailB.json'))).toBe(false)
  })

  it('includes all plural variants of a base key when any variant changed in that file', async () => {
    git(['init', '-b', 'main'], repo)
    writeJson('locales/en/items.json', {
      item_one: '{{count}} item',
      item_other: '{{count}} items',
      unrelated: 'untouched',
    })
    git(['add', '.'], repo)
    commit(repo, 'base')
    git(['checkout', '-q', '-b', 'feature'], repo)
    writeJson('locales/en/items.json', {
      item_one: '{{count}} single item',
      item_other: '{{count}} items',
      unrelated: 'untouched',
    })

    await runSyncer(config, { quiet: true, changedOnly: true })

    // item_one changed, so the whole plural family syncs — but not `unrelated`
    expect(readJson('locales/de/items.json')).toEqual({ item_one: '', item_other: '' })
  })

  it('does not remove obsolete keys from secondary files (removals are out of scope)', async () => {
    git(['init', '-b', 'main'], repo)
    writeJson('locales/en/app.json', { title: 'Title' })
    writeJson('locales/de/app.json', { title: 'Titel', obsolete: 'bleibt' })
    git(['add', '.'], repo)
    commit(repo, 'base')
    git(['checkout', '-q', '-b', 'feature'], repo)
    writeJson('locales/en/app.json', { title: 'Title', added: 'New' })

    await runSyncer(config, { quiet: true, changedOnly: true })

    expect(readJson('locales/de/app.json')).toEqual({ title: 'Titel', obsolete: 'bleibt', added: '' })
  })

  it('auto-detects master as the base branch when neither origin/HEAD nor main exist', async () => {
    git(['init', '-b', 'master'], repo)
    writeJson('locales/en/app.json', { title: 'Title' })
    git(['add', '.'], repo)
    commit(repo, 'base')
    git(['checkout', '-q', '-b', 'feature'], repo)
    writeJson('locales/en/app.json', { title: 'Title', added: 'New' })

    await runSyncer(config, { quiet: true, changedOnly: true })

    expect(readJson('locales/de/app.json')).toEqual({ added: '' })
  })

  it('fails with a clear message outside a git repository', async () => {
    writeJson('locales/en/app.json', { title: 'Title' })

    await expect(runSyncer(config, { quiet: true, changedOnly: true }))
      .rejects.toThrow(/not inside one/)
  })

  it('fails with a fetch hint when the explicit base ref cannot be resolved', async () => {
    git(['init', '-b', 'main'], repo)
    writeJson('locales/en/app.json', { title: 'Title' })
    git(['add', '.'], repo)
    commit(repo, 'base')

    await expect(runSyncer(config, { quiet: true, changedOnly: true, base: 'develop' }))
      .rejects.toThrow(/could not resolve the base ref "develop"[\s\S]*fetch-depth/)
  })
})
