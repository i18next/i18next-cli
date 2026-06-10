import { styleText } from 'node:util'
import { readFile } from 'node:fs/promises'
import { execa } from 'execa'
import inquirer from 'inquirer'
import { glob } from 'glob'
import { loadConfig, ensureConfig } from '../config.js'
import { detectConfig } from '../heuristic-config.js'
import { runExtractor } from '../extractor.js'
import { runInstrumenter, findExistingI18nInitFile } from '../instrumenter/index.js'
import { runLocizeSync, runLocizeDownload, LocizeCommandError, maskApiKey } from '../locize.js'
import { openBrowser, promptLocizeCredentials } from '../utils/locize-onboarding.js'
import { getNestedKeys, getNestedValue } from '../utils/nested-object.js'
import { detectStack, hasStackPlugin } from './detect.js'
import { AGENT_PROMPT } from './agent-prompt.js'
import type { I18nextToolkitConfig } from '../types.js'

const LOCIZE_SIGNUP_URL = 'https://www.locize.app/register?from=i18next_cli__localize'

const TOTAL_STEPS = 6

/**
 * Server-side errors indicating auto-translation is not enabled/available on
 * the project: the output must both mention auto-translation/MT and describe
 * a disabled state. Checked against the captured stderr/stdout only — never
 * `error.message`, which can echo the invoked command line (and therefore
 * always contains "--auto-translate").
 */
const AI_MENTION_PATTERN = /auto.?translat|machine translation/i
const AI_DISABLED_PATTERN = /not (enabled|allowed|activated|available)|disabled/i

/** Delays between status-poll rounds while waiting for async AI translation (rounds = delays + 1). */
const POLL_DELAYS_MS = [15000, 20000]

export interface LocalizeOptions {
  dryRun?: boolean
  yes?: boolean
  ci?: boolean
  skipInstrument?: boolean
  skipTranslate?: boolean
  skipLocize?: boolean
  namespace?: string
  updateValues?: boolean
  cdnType?: 'standard' | 'pro'
  printAgentPrompt?: boolean
}

function step (n: number, label: string): void {
  console.log(styleText('bold', `\n[${n}/${TOTAL_STEPS}] ${label}`))
}

function ok (message: string): void {
  console.log(styleText('green', `      ✔ ${message}`))
}

function warn (message: string): void {
  console.log(styleText('yellow', `      ⚠ ${message}`))
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Checks the git working tree. Returns:
 * - true: dirty (uncommitted changes)
 * - false: clean
 * - null: not a git repository (or git unavailable)
 */
async function isGitTreeDirty (): Promise<boolean | null> {
  try {
    const { stdout } = await execa('git', ['status', '--porcelain'])
    return stdout.trim().length > 0
  } catch {
    return null
  }
}

interface LocaleCompleteness {
  locale: string
  translated: number
  total: number
}

/**
 * Computes per-locale translation completeness from the local translation
 * files (post-download these mirror the remote state). Intentionally
 * tolerant: non-JSON output formats or unreadable files simply yield no data
 * — this powers an informational summary, not a gate.
 */
async function computeCompleteness (config: I18nextToolkitConfig): Promise<LocaleCompleteness[]> {
  const output = config.extract.output
  if (typeof output !== 'string') return []

  const primary = config.extract.primaryLanguage || config.locales[0] || 'en'
  const secondaries = config.locales.filter(l => l !== primary)
  const rawSep = config.extract.keySeparator
  const keySeparator: string | false = rawSep === false ? false : (rawSep ?? '.')

  const primaryTemplate = output.replace('{{language}}', primary)
  const hasNamespace = primaryTemplate.includes('{{namespace}}')
  const primaryFiles = hasNamespace
    ? await glob(primaryTemplate.replace('{{namespace}}', '*'), { nodir: true })
    : [primaryTemplate]

  const readJson = async (path: string): Promise<Record<string, any> | null> => {
    try {
      return JSON.parse(await readFile(path, 'utf-8'))
    } catch {
      return null
    }
  }

  // namespace → flattened primary keys
  const namespaces = new Map<string, string[]>()
  const [prefix, suffix] = hasNamespace
    ? primaryTemplate.replace(/\\/g, '/').split('{{namespace}}')
    : ['', '']
  for (const file of primaryFiles) {
    const json = await readJson(file)
    if (!json) continue
    const normalized = file.replace(/\\/g, '/')
    const ns = hasNamespace
      ? normalized.slice(prefix.length, suffix ? normalized.length - suffix.length : undefined)
      : ''
    namespaces.set(ns, getNestedKeys(json, keySeparator))
  }

  // No parseable primary files (e.g. yaml/js output formats): make no claim
  // rather than reporting every language as 0/0 = 100% complete.
  if (namespaces.size === 0) return []

  const totalKeys = [...namespaces.values()].reduce((sum, keys) => sum + keys.length, 0)

  const results: LocaleCompleteness[] = []
  for (const locale of secondaries) {
    let translated = 0
    for (const [ns, keys] of namespaces) {
      const path = output.replace('{{language}}', locale).replace('{{namespace}}', ns)
      const json = await readJson(path)
      if (!json) continue
      for (const key of keys) {
        const value = getNestedValue(json, key, keySeparator)
        if (typeof value === 'string' ? value.trim() !== '' : (value !== undefined && value !== null)) {
          translated++
        }
      }
    }
    results.push({ locale, translated, total: totalKeys })
  }
  return results
}

function printCompleteness (completeness: LocaleCompleteness[]): void {
  for (const { locale, translated, total } of completeness) {
    const pct = total === 0 ? 100 : Math.round((translated / total) * 100)
    const color = pct === 100 ? 'green' : pct > 0 ? 'yellow' : 'red'
    console.log(styleText(color, `        ${locale}: ${translated}/${total} (${pct}%)`))
  }
}

function printEpilogue (config: I18nextToolkitConfig): void {
  const projectId = config.locize?.projectId || '<your-project-id>'
  console.log(styleText('green', '\n✅ Done. Your app is localized.'))
  console.log(styleText('cyan', '\nYour AI translations come with confidence scores; low-confidence ones are flagged for review in Locize.'))
  console.log('\nOptional — switch to CDN delivery so translation fixes go live without redeploying your app:')
  console.log(styleText('cyan', '  npm install i18next-locize-backend'))
  console.log(styleText('gray', `
  // in your i18n init file:
  import LocizeBackend from 'i18next-locize-backend'

  i18next
    .use(LocizeBackend)
    .init({
      backend: {
        projectId: '${projectId}',
        version: 'latest', // no apiKey in production!
      },
      // ...
    })
`))
  console.log('Docs: https://github.com/locize/i18next-locize-backend')
  console.log('Your current setup (local translation files) keeps working either way; run `i18next-cli locize-download` in CI to refresh the files.')
}

/**
 * The `localize` supercommand: takes a mono-lingual app to fully localized +
 * delivered via Locize in one command, orchestrating the existing pieces —
 * detect → instrument → extract → connect Locize → sync with AI
 * auto-translate → download & verify.
 */
export async function runLocalize (options: LocalizeOptions = {}, configPath?: string): Promise<void> {
  if (options.printAgentPrompt) {
    console.log(AGENT_PROMPT)
    return
  }

  const isDryRun = !!options.dryRun
  const isCi = !!options.ci
  const autoYes = !!options.yes
  const interactive = !isCi && !autoYes

  console.log(styleText('bold', 'i18next-cli localize — from hardcoded strings to a localized app'))

  // ── [1/6] Detect ────────────────────────────────────────────────────────
  step(1, 'Detecting project…')
  const stack = await detectStack(findExistingI18nInitFile)
  ok(`${stack.framework === 'unknown' ? 'unknown framework' : stack.framework}${stack.hasAppRouter ? ' (App Router)' : ''}${stack.hasTypeScript ? ' + TypeScript' : ''}${stack.hasI18next ? ', i18next detected' : ''}`)

  let skipInstrument = !!options.skipInstrument

  if (stack.hasParaglide) {
    warn('This app uses inlang Paraglide — instrumenting i18next calls would conflict; Locize can still manage these translations.')
    if (!stack.hasI18next) {
      console.log(styleText('yellow', '\nNo i18next setup found alongside Paraglide, so there is nothing for `localize` to do here.'))
      console.log('To manage Paraglide translations with Locize, see https://www.locize.com — or set up i18next first and re-run.')
      return
    }
    skipInstrument = true
  }

  // ── [2/6] Configuration ─────────────────────────────────────────────────
  step(2, 'Configuration…')
  let config: I18nextToolkitConfig
  if (isCi) {
    let loaded = await loadConfig(configPath)
    if (!loaded) {
      const detected = await detectConfig()
      if (!detected) {
        console.error(styleText('red', 'No i18next.config found.'))
        console.log('Run `npx i18next-cli init` locally and commit the config, or pass `--config <path>`.')
        process.exit(1)
        return
      }
      loaded = detected as I18nextToolkitConfig
    }
    config = loaded
  } else {
    config = await ensureConfig(configPath)
  }
  ok(`locales: ${config.locales.join(', ')}`)

  // Instrument eligibility: React/Next natively, other stacks via a configured plugin
  const instrumentableNatively = stack.framework === 'react' || stack.framework === 'next'
  const stackPluginConfigured = hasStackPlugin(config, stack.framework)
  if (!skipInstrument && !instrumentableNatively && !stackPluginConfigured) {
    warn(`instrument transforms React/JSX out of the box${stack.framework !== 'unknown' ? ` — detected ${stack.framework}` : ''}.`)
    console.log(`      For ${stack.framework === 'vue' ? 'Vue, add a plugin to i18next.config.ts — community: i18next-cli-vue' : stack.framework === 'svelte' ? 'Svelte, add a plugin to i18next.config.ts — community: i18next-cli-plugin-svelte' : 'this stack, add a plugin to i18next.config.ts'} — or write your own via the instrumentOnLoad/onLoad hooks (see the Plugin System docs). Then re-run \`i18next-cli localize\`.`)
    console.log('      Without a plugin: wrap strings manually (`i18next-cli lint` lists them) and re-run with `--skip-instrument`.')
    skipInstrument = true
  }

  // ── [3/6] Instrument ────────────────────────────────────────────────────
  step(3, 'Instrumenting code…')
  if (!skipInstrument && isCi && !autoYes) {
    warn('Skipped in CI: instrumentation rewrites source files and needs human review. Run `i18next-cli localize` locally, or pass `--ci --yes` to force.')
    skipInstrument = true
  }

  if (skipInstrument) {
    if (options.skipInstrument) ok('Skipped (--skip-instrument).')
  } else {
    // Dirty-git guard: instrument rewrites source files — make sure the diff is reviewable.
    if (!isDryRun) {
      const dirty = await isGitTreeDirty()
      if (dirty === null) {
        warn("Not a git repository — you won't be able to review instrument's changes as a diff.")
      } else if (dirty) {
        if (interactive) {
          const { proceed } = await inquirer.prompt([{
            type: 'confirm',
            name: 'proceed',
            message: 'Working tree has uncommitted changes. instrument rewrites source files — continue?',
            default: false,
          }])
          if (!proceed) {
            console.log('Aborted. Commit or stash your changes, then re-run `i18next-cli localize`.')
            process.exit(1)
            return
          }
        } else {
          warn('Working tree has uncommitted changes — instrument changes will mix into your diff.')
        }
      }
    }

    // Already-using-i18next heuristic (instrument is idempotent either way)
    if (stack.hasI18next && stack.initFile && interactive) {
      const { proceed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: `Your project already uses i18next (found ${stack.initFile}). Run instrumentation anyway to catch remaining hardcoded strings?`,
        default: true,
      }])
      if (!proceed) skipInstrument = true
    }

    if (stack.hasAppRouter) {
      warn("Next.js App Router detected: instrument injects useTranslation(), which is client-only. Review the diff for server components — add 'use client' or switch those to a server-side t() pattern.")
    }

    if (!skipInstrument) {
      const results = await runInstrumenter(config, {
        isDryRun,
        isInteractive: interactive,
        namespace: options.namespace,
        quiet: false,
      })
      if (results.totalCandidates === 0) {
        ok('No hardcoded strings found — your code looks already internationalized.')
      } else {
        ok(`${results.totalTransformed}/${results.totalCandidates} candidate string(s) ${isDryRun ? 'would be ' : ''}instrumented (${results.totalSkipped} skipped).`)
      }
    }
  }

  // ── [4/6] Extract ───────────────────────────────────────────────────────
  step(4, 'Extracting translation keys…')
  const { hasErrors } = await runExtractor(config, { isDryRun, quiet: false })
  if (hasErrors) {
    console.error(styleText('red', '\nExtraction reported errors (see above).'))
    console.log('Fix the parse errors, then re-run `i18next-cli localize` — completed steps are skipped automatically on re-run.')
    process.exit(1)
    return
  }
  ok(isDryRun ? 'Extraction previewed (dry-run).' : 'Translation keys extracted.')

  if (options.skipLocize) {
    console.log(styleText('green', '\n✅ Done (local files only — steps 5–6 skipped via --skip-locize).'))
    console.log('When you are ready for managed translations + AI auto-translate, re-run without --skip-locize.')
    return
  }

  // ── [5/6] Connect Locize ────────────────────────────────────────────────
  step(5, 'Connecting to Locize…')
  let projectId = config.locize?.projectId || process.env.LOCIZE_PROJECTID || process.env.LOCIZE_PID
  let apiKey = config.locize?.apiKey || process.env.LOCIZE_API_KEY || process.env.LOCIZE_KEY

  if (projectId && apiKey) {
    ok(`Project ${projectId} (API key ${maskApiKey(apiKey)})`)
    config.locize = { ...config.locize, projectId, apiKey }
  } else if (isCi) {
    console.error(styleText('red', 'Missing Locize credentials.'))
    console.log('Set the LOCIZE_PROJECTID and LOCIZE_API_KEY environment variables (Project settings → "API, CDN, NOTIFICATIONS" tab on www.locize.app), or add locize.projectId to i18next.config.ts.')
    process.exit(1)
    return
  } else if (isDryRun) {
    warn('No Locize credentials configured — with credentials, step 6 would sync your keys and request AI auto-translation.')
    console.log(styleText('blue', '\n📋 Dry run complete — re-run without --dry-run to apply.'))
    return
  } else {
    console.log(`
  One manual step — in your browser:
    1. Sign up / log in:   ${LOCIZE_SIGNUP_URL}
    2. Create a project and add your target languages.
       Auto-translate and Quality Estimation are on by default for new projects:
       translations with confidence scores arrive automatically once the project
       is subscribed or an AI/MT provider is configured; low-confidence ones are
       flagged for review.
    3. Copy your Project ID and an API key from Project settings →
       "API, CDN, NOTIFICATIONS" tab (use an *admin* key if the project has no
       languages yet).
`)
    const opened = await openBrowser(LOCIZE_SIGNUP_URL, { ci: isCi })
    if (!opened) {
      console.log(`  👉 Open this URL manually: ${LOCIZE_SIGNUP_URL}\n`)
    }

    const credentials = await promptLocizeCredentials()
    if (!credentials.apiKey) {
      console.error(styleText('red', '\nAn API key is required to sync translations.'))
      console.log('Your code is instrumented and keys are extracted — re-run `i18next-cli localize` anytime to finish, or use `--skip-locize`.')
      process.exit(1)
      return
    }
    projectId = credentials.projectId
    apiKey = credentials.apiKey
    config.locize = { ...config.locize, projectId, apiKey }

    console.log(styleText('cyan', '\nTo persist these credentials for future runs:'))
    console.log(styleText('green', `
  # .env (add to .gitignore!)
  LOCIZE_API_KEY=${apiKey}
`))
    console.log(styleText('green', `  // i18next.config.ts
  locize: {
    projectId: '${projectId}',
    apiKey: process.env.LOCIZE_API_KEY,
  },
`))
  }

  // ── [6/6] Translate & deliver ───────────────────────────────────────────
  step(6, 'Translating & delivering…')
  const autoTranslate = options.skipTranslate ? undefined : true
  try {
    await runLocizeSync(config, {
      autoTranslate,
      updateValues: options.updateValues,
      cdnType: options.cdnType,
      dryRun: isDryRun,
      throwOnError: true,
    })
  } catch (error: any) {
    const capturedOutput = error instanceof LocizeCommandError ? `${error.stderr}\n${error.stdout}` : ''
    if (autoTranslate && AI_MENTION_PATTERN.test(capturedOutput) && AI_DISABLED_PATTERN.test(capturedOutput)) {
      warn('Locize rejected auto-translation — AI/MT is not enabled on this project.')
      // Retry once without auto-translate so the key sync itself completes.
      try {
        await runLocizeSync(config, {
          updateValues: options.updateValues,
          cdnType: options.cdnType,
          dryRun: isDryRun,
          throwOnError: true,
        })
        ok('Keys synced to Locize (without auto-translation).')
      } catch (retryError: any) {
        console.error(styleText('red', `Sync failed: ${retryError.message}`))
      }
      console.log(`
  Enable it: www.locize.app → your project → Settings →
  "EDITOR, TM/MT/AI, ORDERING" tab → turn on the Automatic Translation Workflow.
  Then re-run \`i18next-cli localize\` (or \`i18next-cli locize-sync --auto-translate true\`).
`)
      process.exit(1)
      return
    }
    if (error instanceof LocizeCommandError && /missing required argument/i.test(error.stderr)) {
      console.error(styleText('red', 'Locize rejected the credentials.'))
      console.log('Check the API key role (an admin key is needed to create languages) in Project settings → "API, CDN, NOTIFICATIONS" tab.')
      process.exit(1)
      return
    }
    console.error(styleText('red', `Sync failed: ${error.message}`))
    process.exit(1)
    return
  }

  if (isDryRun) {
    console.log(styleText('blue', '\n📋 Dry run complete — re-run without --dry-run to apply.'))
    return
  }
  ok(`Synced to Locize${autoTranslate ? ' with AI auto-translate requested' : ''}.`)

  // Poll-then-download: AI translation is asynchronous server-side — watch
  // the translations arrive instead of downloading a still-empty snapshot.
  const isComplete = (completeness: LocaleCompleteness[]) =>
    completeness.length > 0 && completeness.every(c => c.translated >= c.total)

  let downloadFailed = false
  const download = async (): Promise<boolean> => {
    try {
      await runLocizeDownload(config, { cdnType: options.cdnType, throwOnError: true })
      return true
    } catch (error: any) {
      downloadFailed = true
      warn(`Download failed: ${error.message}`)
      return false
    }
  }

  let completeness: LocaleCompleteness[] = []
  if (autoTranslate && !isCi) {
    console.log(styleText('cyan', '      Waiting for AI translations to arrive…'))
    for (let round = 0; round <= POLL_DELAYS_MS.length; round++) {
      if (!await download()) break
      completeness = await computeCompleteness(config)
      printCompleteness(completeness)
      // Stop when done — or when completeness cannot be computed (non-JSON
      // output formats); polling blindly would just burn time.
      if (completeness.length === 0 || isComplete(completeness)) break
      if (round < POLL_DELAYS_MS.length) await sleep(POLL_DELAYS_MS[round])
    }
  } else {
    if (await download()) {
      completeness = await computeCompleteness(config)
      printCompleteness(completeness)
    }
  }

  if (downloadFailed || (autoTranslate && completeness.length > 0 && !isComplete(completeness))) {
    warn('Translations may still be processing — run `i18next-cli locize-download` in a minute.')
    console.log('      (On an unsubscribed trial, AI translation needs a subscription or a configured AI/MT provider — see Project settings.)')
  } else if (completeness.length > 0) {
    ok('All languages translated and downloaded.')
  }

  printEpilogue(config)
}
