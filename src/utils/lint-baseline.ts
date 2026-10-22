import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { I18nextToolkitConfig, LintIssue } from '../types.js'

/**
 * Issue counts per file, as `lint --update-baseline` writes them: `{ "src/App.tsx": { "hardcoded: Save": 2 } }`.
 * Like ESLint's bulk suppressions, the file is committed and `lint` then fails only on issues it does not hold.
 * An issue is identified by its file, type and text, not by its line, so moving code keeps it in the baseline,
 * while a second identical hardcoded "Save" in the same file is new.
 */
export type LintBaseline = Record<string, Record<string, number>>

/** The baseline file: `lint.baseline`, default `i18next-lint-baseline.json` in the working directory. */
export const lintBaselinePath = (config: I18nextToolkitConfig): string =>
  resolve(process.cwd(), config.lint?.baseline ?? 'i18next-lint-baseline.json')

const fileKey = (file: string) => relative(process.cwd(), resolve(process.cwd(), file)).split(sep).join('/')
const issueKey = (issue: LintIssue) => `${issue.type ?? 'hardcoded'}: ${issue.text}`

/** The baseline, or undefined when the file does not exist. A file that does not parse throws. */
export async function readLintBaseline (path: string): Promise<LintBaseline | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(content)
  } catch (err: any) {
    throw new Error(`could not parse the lint baseline ${path}: ${err?.message ?? err}. Run "npx i18next-cli lint --update-baseline" to write it again.`)
  }
}

/** Writes every issue into the baseline, sorted for stable diffs. Returns the number of issues written. */
export async function writeLintBaseline (path: string, files: Record<string, LintIssue[]>): Promise<number> {
  const baseline: LintBaseline = {}
  let count = 0
  for (const [file, issues] of Object.entries(files).sort(([a], [b]) => fileKey(a).localeCompare(fileKey(b)))) {
    const counts: Record<string, number> = {}
    for (const key of issues.map(issueKey).sort()) counts[key] = (counts[key] ?? 0) + 1
    baseline[fileKey(file)] = counts
    count += issues.length
  }
  await writeFile(path, JSON.stringify(baseline, null, 2) + '\n')
  return count
}

/**
 * Leaves out the issues the baseline holds. Returns the remaining issues, how many were left out,
 * and how many baseline entries no longer occur (fixed issues, to drop with `--update-baseline`).
 */
export function applyLintBaseline (files: Record<string, LintIssue[]>, baseline: LintBaseline): { files: Record<string, LintIssue[]>, existing: number, stale: number } {
  const left = new Map(Object.entries(baseline).map(([file, counts]) => [file, { ...counts }]))
  const remaining: Record<string, LintIssue[]> = {}
  let existing = 0
  for (const [file, issues] of Object.entries(files)) {
    const counts = left.get(fileKey(file))
    const fresh = issues.filter(issue => {
      const key = issueKey(issue)
      if (!counts?.[key]) return true
      counts[key]--
      existing++
      return false
    })
    if (fresh.length) remaining[file] = fresh
  }
  let stale = 0
  for (const counts of left.values()) {
    for (const n of Object.values(counts)) stale += n
  }
  return { files: remaining, existing, stale }
}
