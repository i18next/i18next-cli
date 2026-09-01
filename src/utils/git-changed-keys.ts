import { execFileSync } from 'node:child_process'
import { styleText } from 'node:util'
import { extname, isAbsolute, relative, sep } from 'node:path'
import { JsonParser, JsonObjectNode } from '@croct/json5-parser'
import yaml from 'yaml'

const runGit = (args: string[]): string => execFileSync('git', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
})

const CI_FETCH_HINT = 'In CI, make sure the checkout is not shallow and includes the base branch — e.g. actions/checkout with "fetch-depth: 0".'

/**
 * Resolves the git ref to compare against for --changed-only.
 *
 * Returns the resolved base branch (for messaging) and the merge-base of that
 * ref and HEAD — the commit where the current branch diverged — so commits
 * landing on the base branch after the branch point are not attributed to this
 * branch (the semantics of `git diff base...HEAD`). Falls back to the base tip
 * when merge-base cannot be computed (e.g. shallow clones).
 *
 * Throws with an actionable message when git is unavailable, the cwd is not
 * inside a repository, or no base ref can be resolved.
 */
export function resolveGitCompareRef (base?: string): { base: string, compareRef: string } {
  try {
    runGit(['--version'])
  } catch {
    throw new Error('--changed-only requires git, but the "git" command was not found. Install git or remove --changed-only to sync the whole project.')
  }

  try {
    runGit(['rev-parse', '--git-dir'])
  } catch {
    throw new Error(`--changed-only requires a git repository, but "${process.cwd()}" is not inside one. Run the sync inside your repository or remove --changed-only to sync the whole project.`)
  }

  const candidates = base
    ? [base, `origin/${base}`]
    : ['origin/HEAD', 'main', 'origin/main', 'master', 'origin/master']

  let resolvedBase: string | undefined
  for (const candidate of candidates) {
    try {
      runGit(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
      resolvedBase = candidate
      break
    } catch { /* try the next candidate */ }
  }

  if (!resolvedBase) {
    if (base) {
      throw new Error(`--changed-only could not resolve the base ref "${base}" (also tried "origin/${base}"). Fetch it first (git fetch origin ${base}). ${CI_FETCH_HINT}`)
    }
    throw new Error(`--changed-only could not auto-detect a base branch (tried origin/HEAD, main and master). Pass one explicitly with --base <ref>. ${CI_FETCH_HINT}`)
  }

  let compareRef: string | undefined
  try {
    compareRef = runGit(['merge-base', resolvedBase, 'HEAD']).trim()
  } catch { /* fall back to the base tip below */ }
  if (!compareRef) {
    console.warn(styleText('yellow', `could not find the merge-base of ${resolvedBase} and HEAD — comparing against ${resolvedBase} directly. On shallow CI clones (actions/checkout default fetch-depth: 1) deepen the fetch for exact results.`))
    compareRef = resolvedBase
  }

  return { base: resolvedBase, compareRef }
}

/**
 * Returns the content of a file at the given ref, or `null` when the file did
 * not exist there (a file new on this branch). Existence is checked via
 * cat-file's exit code instead of matching `git show`'s stderr, which is
 * localized.
 */
export function readFileAtRef (compareRef: string, filePath: string): string | null {
  const rel = isAbsolute(filePath) ? relative(process.cwd(), filePath) : filePath
  // "./" makes the path relative to the cwd instead of the repo root
  const gitPath = `${compareRef}:./${rel.split(sep).join('/')}`
  try {
    runGit(['cat-file', '-e', gitPath])
  } catch {
    return null
  }
  return runGit(['show', gitPath])
}

/**
 * Parses translation file content from a string (git blob) using the same
 * parsers as loadTranslationFile. JS/TS resource modules cannot be evaluated
 * from git history, so --changed-only does not support them.
 */
export function parseTranslationContent (content: string, filePath: string): Record<string, any> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.json') return JSON.parse(content)
  if (ext === '.json5') return JsonParser.parse(content, JsonObjectNode).toJSON()
  if (ext === '.yaml' || ext === '.yml') return yaml.parse(content) as Record<string, any>
  throw new Error(`--changed-only cannot diff "${filePath}": only JSON, JSON5 and YAML translation files are supported (JS/TS resource modules cannot be parsed from git history).`)
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Builds a matcher deciding whether a key belongs to the changed set.
 *
 * Plural grouping: when ANY variant of a base key changed, ALL variants of
 * that base key match. Source and target languages have different CLDR plural
 * category counts (en: one/other; ar: zero..other), so an exact-key match
 * would drop the target-only forms. Covers cardinal and ordinal CLDR suffixes
 * plus the legacy v3 forms (_plural, _0, _1, ...). Kept in sync with the
 * sister copy in locize-cli (src/gitChangedKeys.js).
 *
 * The caller is expected to keep changed sets scoped per source FILE: the same
 * bare key name in two files (e.g. each email template having its own
 * `subject`) must not cross-match.
 */
export function makeChangedKeyMatcher (changedKeys: Set<string>, pluralSeparator = '_'): (key: string) => boolean {
  const s = escapeRegExp(pluralSeparator)
  const pluralSuffixRegex = new RegExp(`(?:${s}ordinal)?${s}(?:zero|one|two|few|many|other|plural|\\d+)$`)
  const baseChanged = new Set<string>()
  for (const key of changedKeys) {
    baseChanged.add(key.replace(pluralSuffixRegex, ''))
  }
  return (key: string): boolean => {
    if (changedKeys.has(key)) return true
    const base = key.replace(pluralSuffixRegex, '')
    return base !== key && baseChanged.has(base)
  }
}
