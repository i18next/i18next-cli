import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { glob } from 'glob'
import { extname, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { parse } from '@swc/core'
import type { Module } from '@swc/types'
import type { StringLiteral } from '@swc/core'
import { prompt } from '../../utils/prompt.js'
import { styleText } from 'node:util'
import type { AttributeRules, ExtractedKey, Logger, I18nextToolkitConfig, InstrumenterOptions, CandidateString, FileInstrumentationResult, InstrumentationResults, ComponentBoundary, FileScanResult, ImportDeclarationSpan, LanguageChangeSite, MemoHookSpan, Plugin, PluralHelperImport } from '../../types.js'
import { detectCandidate, HTML_ENTITY_RE } from './string-detector.js'
import { transformFile as performTransformation } from './transformer.js'
import { generateKeyFromContent, createKeyRegistry } from './key-generator.js'
import { createSpinnerLike } from '../../utils/wrap-ora.js'
import { ConsoleLogger } from '../../utils/logger.js'
import { ignoredAttributeSet, ignoredTags, importAliases, jsxElementName, resolveElementAttributes, translatablePropertySet } from '../../utils/jsx-attributes.js'
import { normalizeSpansToCharIndices, collectIgnoredLineRanges } from '../../extractor/parsers/ast-utils.js'
import { getOutputPath, readProjectDeps } from '../../utils/file-utils.js'
import { findKeys } from '../../extractor/core/key-finder.js'
import { matchesFunctionPattern } from '../../extractor/utils/function-matcher.js'
import { classifyNextFiles, projectPath, type NextFileKind } from './next-files.js'
import { usesMessageFormat, toMessageFormatPlaceholders } from '../../utils/message-format.js'

/**
 * Main orchestrator for the instrument command.
 * Scans source files for hardcoded strings and instruments them with i18next calls.
 *
 * @param config - Toolkit configuration
 * @param options - Instrumentation options (dry-run, interactive, etc.)
 * @param logger - Logger instance
 * @returns Instrumentation results
 */
export async function runInstrumenter (
  config: I18nextToolkitConfig,
  options: InstrumenterOptions,
  logger: Logger = new ConsoleLogger()
): Promise<InstrumentationResults> {
  config.extract.primaryLanguage ||= config.locales[0] || 'en'
  config.extract.secondaryLanguages ||= config.locales.filter((l: string) => l !== config?.extract?.primaryLanguage)

  const spinner = createSpinnerLike('Scanning for hardcoded strings...\n', { quiet: !!options.quiet, logger })

  try {
    // Get list of source files
    const sourceFiles = await getSourceFilesForInstrumentation(config)
    spinner.text = `Scanning ${sourceFiles.length} files for hardcoded strings...`

    // Scan files for candidate strings
    const results: FileInstrumentationResult[] = []
    const keyRegistry = createKeyRegistry()
    let totalCandidates = 0
    let totalTransformed = 0
    let totalSkipped = 0
    let totalLanguageChanges = 0
    let usesI18nextT = false
    // The same warning for many files is printed once, with the files below it
    const warnings = new Map<string, string[]>()
    const warnFor = (where: string, message: string) => {
      warnings.set(message, [...(warnings.get(message) ?? []), where])
    }
    let moduleScopeTotal = 0
    // The code imports i18next before it is instrumented: it is set up already, here or in a shared package
    let i18nextInUse = false

    // Keys the code uses already: a new text gets another key, unless it is the same text, and no new key is
    // the parent of nested ones (`tenants` beside `tenants.title` is a nesting conflict at extract)
    // Best effort, without plugins (their hooks are for extract): a file it cannot read reserves nothing
    const separator = config.extract.keySeparator ?? '.'
    const existingKeys = await findKeys({ ...config, plugins: [] }, { info () {}, warn () {}, error () {} })
      .then(found => found.allKeys, () => new Map<string, ExtractedKey>())
    for (const { key, defaultValue } of existingKeys.values()) {
      const parent = separator ? key.split(separator)[0] : key
      if (parent !== key) keyRegistry.reserve(parent)
      else keyRegistry.reserve(key, defaultValue ?? key)
    }

    // Detect framework and language
    const hasReact = await isProjectUsingReact()
    const hasTypeScript = await isProjectUsingTypeScript()

    // A Next.js app gets next-i18next's calls: getT() in Server Components, useT() in Client Components,
    // useTranslation() from next-i18next/pages in the Pages Router. Also one with i18next not set up at all,
    // whose Server Components no plain react-i18next hook would work in; one with an i18next setup of its own
    // keeps it.
    const contents = new Map<string, string>()
    for (const file of sourceFiles) contents.set(file, await readFile(file, 'utf-8'))
    const deps = await readProjectDeps()
    const code = [...contents.values()]
    const nextI18next = !!deps['next-i18next'] || code.some(c => NEXT_I18NEXT_IMPORT_RE.test(c)) ||
      (!!deps.next && !deps.i18next && !deps['react-i18next'] && !code.some(c => I18NEXT_IMPORT_RE.test(c)))
    const nextFiles = nextI18next ? await classifyNextFiles(contents) : undefined
    const nextKinds = nextFiles?.kinds
    const serverModule = nextI18next ? findServerModule(contents) : undefined

    // Initialize plugins
    const plugins = config.plugins || []
    await initializeInstrumentPlugins(plugins, { config, logger })

    // Resolve target namespace
    let targetNamespace = options.namespace
    if (!targetNamespace && options.isInteractive) {
      const defaultNS = config.extract.defaultNS ?? 'translation'
      const { ns } = await prompt([
        {
          type: 'input',
          name: 'ns',
          message: 'Target namespace for extracted keys:',
          default: typeof defaultNS === 'string' ? defaultNS : 'translation'
        }
      ])
      if (ns && ns !== defaultNS) {
        targetNamespace = ns
      }
    }

    for (const file of sourceFiles) {
      try {
        let content = contents.get(file)!

        // Run instrumentOnLoad plugin pipeline
        const loadResult = await runInstrumentOnLoadPipeline(content, file, plugins, logger)
        if (loadResult === null) continue // plugin says skip this file
        content = loadResult
        i18nextInUse ||= I18NEXT_IMPORT_RE.test(content) || NEXT_I18NEXT_IMPORT_RE.test(content)

        const nextKind = nextKinds?.get(file)
        const scanResult = await scanFileForCandidates(content, file, config, nextKind)
        let { candidates } = scanResult
        const { components, languageChangeSites, imports, memoHooks, pluralHelperImports } = scanResult

        // Run instrumentOnResult plugin pipeline
        candidates = await runInstrumentOnResultPipeline(file, candidates, plugins, logger)

        if (scanResult.ownTSkipped) {
          totalCandidates += scanResult.ownTSkipped
          totalSkipped += scanResult.ownTSkipped
          warnFor(`${file} (${scanResult.ownTSkipped})`, 'Skipped the texts of components that declare a `t` of their own (not a translation function): rename it, then run instrument again.')
        }

        for (const { message, count, lines } of scanResult.dropped ?? []) {
          totalCandidates += count
          totalSkipped += count
          warnFor(lines ? lines.map(line => `${file}:${line}`).join(', ') : `${file} (${count})`, message)
        }

        if (scanResult.moduleScopeSkipped > 0) {
          totalCandidates += scanResult.moduleScopeSkipped
          totalSkipped += scanResult.moduleScopeSkipped
          moduleScopeTotal += scanResult.moduleScopeSkipped
          warnFor(`${file} (${scanResult.moduleScopeSkipped})`, MODULE_SCOPE_WARNING)
        }

        if (candidates.length === 0 && languageChangeSites.length === 0) {
          continue
        }

        totalCandidates += candidates.length

        // Handle interactive mode
        if (options.isInteractive) {
          // Ask user about each candidate
          for (const candidate of candidates) {
            const { action } = await prompt([
              {
                type: 'select',
                name: 'action',
                message: `Translate: "${candidate.content}" (${candidate.line}:${candidate.column})?`,
                choices: [
                  { name: 'Approve', value: 'approve' },
                  { name: 'Skip', value: 'skip' },
                  { name: 'Edit key', value: 'edit-key' },
                  { name: 'Edit value', value: 'edit-value' }
                ]
              }
            ])

            switch (action) {
              case 'approve':
                candidate.key = keyRegistry.add(generateKeyFromContent(keySourceOf(candidate)), candidate.content)
                break
              case 'skip':
                candidate.skipReason = 'User skipped'
                break
              case 'edit-key': {
                const { key } = await prompt([
                  {
                    type: 'input',
                    name: 'key',
                    message: 'New key:',
                    default: generateKeyFromContent(keySourceOf(candidate))
                  }
                ])
                candidate.key = key
                keyRegistry.reserve(key, candidate.content)
                break
              }
              case 'edit-value': {
                const { value } = await prompt([
                  {
                    type: 'input',
                    name: 'value',
                    message: 'New value:',
                    default: candidate.content
                  }
                ])
                candidate.content = value
                candidate.key = keyRegistry.add(generateKeyFromContent(value), value)
                break
              }
            }
          }
        }

        // Filter candidates that were skipped by user
        const approvedCandidates = candidates.filter(c => !c.skipReason)

        if (approvedCandidates.length > 0 || languageChangeSites.length > 0) {
          // Generate keys for approved candidates
          for (const candidate of approvedCandidates) {
            if (!candidate.key) {
              candidate.key = keyRegistry.add(generateKeyFromContent(keySourceOf(candidate)), candidate.content)
            }
          }

          // After key generation, so ICU/MF2 syntax does not end up in generated keys
          if (usesMessageFormat(config)) approvedCandidates.forEach(candidate => toMessageFormatCandidate(candidate, config))

          // Transform the file
          const transformResult = performTransformation(
            content,
            file,
            approvedCandidates,
            {
              isDryRun: options.isDryRun,
              hasReact,
              isPrimaryLanguageFile: true,
              config,
              components,
              namespace: targetNamespace,
              languageChangeSites,
              imports,
              memoHooks,
              pluralHelperImports,
              next: nextKind && { kind: nextKind, serverModule: serverModuleFor(serverModule, file) }
            }
          )

          if (!options.isDryRun && transformResult.modified) {
            // Write the transformed file
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, transformResult.newContent || content)
          }

          totalTransformed += transformResult.transformCount
          totalLanguageChanges += transformResult.languageChangeCount
          totalSkipped += candidates.length - approvedCandidates.length

          // Track whether any non-component candidate was transformed (i.e. i18next.t() was used)
          if (!usesI18nextT && approvedCandidates.some(c => !c.insideComponent && c.confidence >= 0.7)) {
            usesI18nextT = true
          }

          // Collect warnings (e.g. i18next.t() in React files) and candidates that could not be rewritten
          for (const warning of [...(transformResult.warnings ?? []), ...transformResult.errors]) {
            warnFor(file, warning.startsWith(`${file}: `) ? warning.slice(file.length + 2) : warning)
          }

          results.push({
            file,
            candidates: approvedCandidates,
            result: transformResult,
            languageChangeSites
          })
        } else {
          totalSkipped += candidates.length
        }
      } catch (err) {
        logger.warn(`Error processing ${file}:`, err)
      }
    }

    const langChangeSuffix = totalLanguageChanges > 0 ? `, ${totalLanguageChanges} language-change site(s)` : ''
    spinner.succeed(
      styleText('bold', `Scanned complete: ${totalCandidates} candidates, ${totalTransformed} approved${langChangeSuffix}`)
    )

    for (const [message, where] of warnings) {
      const head = message === MODULE_SCOPE_WARNING ? `Skipped ${moduleScopeTotal} module-scope string(s). ${message}` : message
      logger.warn(`${head}\n${where.map(w => `  ${w}`).join('\n')}`)
    }

    if (nextI18next && totalTransformed > 0) {
      // next-i18next sets i18next up itself (its config, the proxy, the root layout or appWithTranslation)
      // a page loads its namespaces itself, with serverSideTranslations() (or a helper it imports that calls it)
      const loads = (file: string) => [file, ...nextFiles!.imports.get(file) ?? []].some(f => contents.get(f)!.includes('serverSideTranslations'))
      const pagesWithoutProps = results.filter(r => nextKinds?.get(r.file) === 'pages' && isPagesRoute(r.file) && !loads(r.file)).map(r => r.file)
      if (pagesWithoutProps.length) {
        logger.warn(`These pages need serverSideTranslations() in getStaticProps or getServerSideProps, or their texts render untranslated (https://github.com/i18next/next-i18next#pages-router-setup):\n${pagesWithoutProps.map(f => `  ${f}`).join('\n')}`)
      }
      if (!i18nextInUse && !await nextI18nextConfigured()) {
        const kinds = new Set(results.map(r => nextKinds?.get(r.file)))
        logger.info([
          'The code now uses next-i18next. Set it up:',
          `  npm install next-i18next i18next react-i18next${config.extract.messageFormat === 'icu' ? ' i18next-icu intl-messageformat' : config.extract.messageFormat === 'mf2' ? ' i18next-mf2' : ''}`,
          ...(kinds.has('server') || kinds.has('client') ? ['  App Router: i18n.config, proxy and root layout, https://github.com/i18next/next-i18next#app-router-setup (no [lng] folder: localeInPath: false)'] : []),
          ...(kinds.has('pages') ? ['  Pages Router: next-i18next.config.js, appWithTranslation and serverSideTranslations, https://github.com/i18next/next-i18next#pages-router-setup'] : [])
        ].join('\n'))
      }
    }

    // Generate i18n init file if needed and any transformations were made
    if ((totalTransformed > 0 || totalLanguageChanges > 0) && !options.isDryRun && !nextI18next && i18nextInUse) {
      logger.info('Your code imports i18next already, so it is set up somewhere: no i18n init file generated.')
    }
    if ((totalTransformed > 0 || totalLanguageChanges > 0) && !options.isDryRun && !nextI18next && !i18nextInUse) {
      const initFilePath = await ensureI18nInitFile(hasReact, hasTypeScript, config, logger, usesI18nextT)
      if (initFilePath) {
        await injectI18nImportIntoEntryFile(initFilePath, logger)
      }
    }

    // Return summary
    return {
      files: results,
      totalCandidates,
      totalTransformed,
      totalSkipped,
      totalLanguageChanges,
      extractedKeys: new Map()
    }
  } catch (error) {
    spinner.fail(styleText('red', 'Instrumentation failed'))
    throw error
  }
}

/** The text a key is made from: a <Trans> candidate's words, not its JSX source (`<a href=…>`). */
function keySourceOf (candidate: CandidateString): string {
  return candidate.transValue?.replace(/<\/?\d+>/g, '') ?? candidate.content
}

/** An import of next-i18next, which sets i18next up itself. */
const NEXT_I18NEXT_IMPORT_RE = /\bfrom\s*['"]next-i18next(?:\/[\w/]+)?['"]|\brequire\(\s*['"]next-i18next(?:\/[\w/]+)?['"]\s*\)/

/**
 * The module the app imports `getT` from when it is not `next-i18next/server` (`createServerI18next` in its
 * own `i18n.server.ts`, so no init order matters): an alias as written, a relative one as an absolute path.
 */
function findServerModule (contents: Map<string, string>): string | undefined {
  for (const [file, code] of contents) {
    for (const [, names, source] of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      if (!/\bgetT\b/.test(names) || source === 'next-i18next/server') continue
      return source.startsWith('.') ? resolve(dirname(file), source) : source
    }
  }
  return undefined
}

/** The specifier a file imports `getT` with: `next-i18next/server`, the app's alias, or a path relative to it. */
function serverModuleFor (serverModule: string | undefined, file: string): string {
  if (!serverModule) return 'next-i18next/server'
  if (!isAbsolute(serverModule)) return serverModule
  const rel = relative(dirname(resolve(file)), serverModule).replace(/\\/g, '/').replace(/\.(?:tsx?|jsx?|mjs)$/, '')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/** A page of the Pages Router (not `_app`, `_document`, `_error` or an API route), which loads its own translations. */
function isPagesRoute (file: string): boolean {
  const rel = projectPath(file)
  return rel.startsWith('pages/') && !/^pages\/(?:_app|_document|_error|api\/)/.test(rel)
}

/** next-i18next has a config of its own already: `i18n.config.*` (App Router) or `next-i18next.config.*` (Pages Router). */
async function nextI18nextConfigured (): Promise<boolean> {
  const names = ['i18n.config', 'next-i18next.config'].flatMap(name => ['ts', 'js', 'mjs', 'cjs'].map(ext => `${name}.${ext}`))
  for (const name of names) {
    if (await fileExists(join(process.cwd(), name)) || await fileExists(join(process.cwd(), 'src', name))) return true
  }
  return false
}

/** An import of i18next or react-i18next (`.init()` alone is any library's: `Sentry.init()`). */
const I18NEXT_IMPORT_RE = /\bfrom\s*['"](?:i18next|react-i18next)['"]|\brequire\(\s*['"](?:i18next|react-i18next)['"]\s*\)/

const MODULE_SCOPE_WARNING =
  'A t() call there runs once at import time — before i18next may be initialized — and never updates on language change. ' +
  'Move the text into a component/hook (e.g. a useSections() hook calling useTranslation()), or read the key at render time. ' +
  'See: https://www.locize.com/blog/how-to-use-i18next-t-outside-react-components/'

/**
 * Scans a source file for hardcoded string candidates and React component boundaries.
 */
async function scanFileForCandidates (
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  nextKind?: NextFileKind
): Promise<FileScanResult> {
  const candidates: CandidateString[] = []
  const components: ComponentBoundary[] = []
  const languageChangeSites: LanguageChangeSite[] = []
  let moduleScopeSkipped = 0
  let ownTSkipped = 0
  let imports: ImportDeclarationSpan[] | undefined
  const memoHooks: MemoHookSpan[] = []
  let pluralHelperImports: PluralHelperImport[] | undefined
  const dropped: NonNullable<FileScanResult['dropped']> = []
  const fileExt = extname(file).toLowerCase()
  const isTypeScriptFile = ['.ts', '.tsx', '.mts', '.cts'].includes(fileExt)
  const isTSX = fileExt === '.tsx'
  const isJSX = fileExt === '.jsx'

  try {
    // Parse the file
    let ast: Module
    try {
      ast = await parse(content, {
        syntax: isTypeScriptFile ? 'typescript' : 'ecmascript',
        tsx: isTSX,
        jsx: isJSX,
        decorators: true,
        dynamicImport: true,
        comments: true
      })
    } catch (err) {
      // Fallback parsing for .ts with JSX
      if (fileExt === '.ts' && !isTSX) {
        ast = await parse(content, {
          syntax: 'typescript',
          tsx: true,
          decorators: true,
          dynamicImport: true,
          comments: true
        })
      // Fallback for .js and .mjs files with JSX
      } else if ((fileExt === '.js' || fileExt === '.mjs') && !isJSX) {
        ast = await parse(content, {
          syntax: 'ecmascript',
          jsx: true,
          decorators: true,
          dynamicImport: true,
          comments: true
        })
      } else {
        throw err
      }
    }

    // Normalize spans to file-relative char indices. SWC reports spans as UTF-8
    // byte offsets, but JavaScript strings and MagicString use UTF-16 code-unit
    // indices — without the conversion every emoji / accented char / CJK char
    // shifts all subsequent offsets.
    normalizeSpansToCharIndices(ast, content)

    imports = ast.body
      .filter((item: any) => item.type === 'ImportDeclaration')
      .map((item: any) => ({
        source: item.source.value,
        start: item.span.start,
        end: item.span.end,
        locals: (item.specifiers ?? []).map((spec: any) => spec.local?.value).filter(Boolean)
      }))
    collectMemoHooks(ast, memoHooks)

    // Detect React function component boundaries
    detectComponentBoundaries(ast, content, components, nextKind === 'server')

    // Collect function spans so module-scope strings can be excluded below
    const functionSpans: Array<{ start: number, end: number }> = []
    collectFunctionSpans(ast, functionSpans)
    // Next.js reads the texts of `export const metadata` once; generateMetadata() can get them with getT()
    if (nextKind === 'server' && !/\bgenerateMetadata\b/.test(content)) {
      const metadata = metadataExport(ast, content)
      if (metadata) {
        components.push(metadata)
        functionSpans.push({ start: metadata.bodyStart, end: metadata.bodyEnd })
      }
    }

    // Visit AST to find string literals; the object form of extract.acceptedAttributes
    // sets which attributes hold text per JSX element
    const attributeRules = config.extract.acceptedAttributes
    const jsx = attributeRules && !Array.isArray(attributeRules)
      ? { rules: attributeRules, aliases: importAliases(ast) }
      : undefined
    consoleOnlyNames.set(file, collectConsoleOnlyNames(ast))
    fileDataStrings.set(file, collectDataStrings(ast))
    try {
      visitNodeForStrings(ast, content, file, config, candidates, jsx)

      // Detect JSX interpolation patterns (merge adjacent text + expression children)
      detectJSXInterpolation(ast, content, file, config, candidates)

      // Detect plural conditional patterns (ternary chains checking count === 0/1/other)
      detectPluralPatterns(ast, content, file, config, candidates)
    } finally {
      consoleOnlyNames.delete(file)
      fileDataStrings.delete(file)
    }

    // Detect language-change call sites (e.g. updateSettings({ language: code }))
    detectLanguageChangeSites(ast, content, languageChangeSites)

    // Annotate candidates with their enclosing component (if any)
    for (const candidate of candidates) {
      for (const comp of components) {
        if (candidate.offset >= comp.bodyStart && candidate.endOffset <= comp.bodyEnd) {
          candidate.insideComponent = comp.name
          break
        }
      }
    }

    // A component whose `t` is something else (`const [t, setT] = useState(0)`) keeps its texts: a t() call
    // there would call that `t`
    const ownT = new Set(components.filter(c => c.ownT).map(c => c.name))
    if (ownT.size) {
      const keep = candidates.filter(c => !c.insideComponent || !ownT.has(c.insideComponent))
      ownTSkipped = candidates.length - keep.length
      candidates.length = 0
      candidates.push(...keep)
    }

    // Drop module-scope candidates: wrapping them yields a t() call evaluated
    // once at import time — possibly before i18next is initialized, and never
    // re-evaluated on language change. See issue #278.
    const moduleScoped = candidates.filter(
      c => !functionSpans.some(span => c.offset >= span.start && c.endOffset <= span.end)
    )
    if (moduleScoped.length > 0) {
      moduleScopeSkipped = moduleScoped.length
      const keep = candidates.filter(c => !moduleScoped.includes(c))
      candidates.length = 0
      candidates.push(...keep)
    }

    if (nextKind) {
      dropped.push(...dropForNextI18next(candidates, components, nextKind, isApiRoute(file), serverDirectiveSpans(ast)))
      // next-i18next switches the language through the route or useChangeLanguage(): `i18n.changeLanguage()`
      // would change the client instance alone. A call of that switch is no site at all.
      const sites = languageChangeSites.filter(site => !/^(?:\w+\.)?changeLanguage\(/.test(content.slice(site.callStart, site.callEnd)))
      if (sites.length) dropped.push({ message: NEXT_LANGUAGE_CHANGE, count: sites.length, lines: sites.map(site => site.line) })
      languageChangeSites.length = 0
    }

    // Annotate language change sites with their enclosing component (if any)
    for (const site of languageChangeSites) {
      for (const comp of components) {
        if (site.callStart >= comp.bodyStart && site.callEnd <= comp.bodyEnd) {
          site.insideComponent = comp.name
          break
        }
      }
    }

    // Filter out candidates suppressed by ignore-comment directives.
    // Supported comments (line or block):
    //   // i18next-instrument-ignore-next-line  → suppress the single next line
    //   // i18next-instrument-ignore            → suppress the whole next JSX element
    //   /* i18next-instrument-ignore-next-line */
    //   /* i18next-instrument-ignore */
    // AST spans were normalised to char indices above, so the shared helper can
    // resolve element line ranges directly.
    const ignoredLines = collectIgnoredLineRanges(ast, content)
    if (ignoredLines.size > 0) {
      const keep: CandidateString[] = []
      for (const c of candidates) {
        const line = lineOfOffset(content, c.offset)
        if (!ignoredLines.has(line)) {
          keep.push(c)
        }
      }
      candidates.length = 0
      candidates.push(...keep)
    }

    const helperNames = new Set(candidates.map(c => c.pluralHelper).filter((n): n is string => !!n))
    if (helperNames.size) pluralHelperImports = findPluralHelperImports(ast, content, helperNames)

    // Two candidates whose spans overlap cannot both be rewritten (a template literal in another one's `${}`):
    // the outer one wins, the inner text stays in its interpolation value as written
    const bySize = [...candidates].sort((a, b) => (b.endOffset - b.offset) - (a.endOffset - a.offset))
    const kept = new Set<CandidateString>()
    for (const c of bySize) {
      if (![...kept].some(k => c.offset < k.endOffset && k.offset < c.endOffset)) kept.add(c)
    }
    if (kept.size < candidates.length) {
      const keep = candidates.filter(c => kept.has(c))
      candidates.length = 0
      candidates.push(...keep)
    }
  } catch (err) {
    // Silently skip files that can't be parsed
  }

  return { candidates, components, languageChangeSites, moduleScopeSkipped, ownTSkipped, imports, memoHooks, pluralHelperImports, dropped }
}

/** `export const metadata = { title: '…' }` (with or without a type) as the scope of a generateMetadata() to be. */
function metadataExport (ast: any, content: string): ComponentBoundary | null {
  for (const item of ast.body ?? []) {
    const decl = item.type === 'ExportDeclaration' ? item.declaration : null
    const [declarator] = decl?.type === 'VariableDeclaration' && decl.declarations?.length === 1 ? decl.declarations : []
    if (declarator?.id?.value !== 'metadata' || declarator.init?.type !== 'ObjectExpression') continue
    const annotation = declarator.id.typeAnnotation?.typeAnnotation
    return {
      name: `metadata@${declarator.init.span.start}`,
      bodyStart: declarator.init.span.start,
      bodyEnd: declarator.init.span.end,
      hasUseTranslation: false,
      expressionBody: true,
      isAsync: true,
      metadataHead: {
        start: decl.span.start,
        end: declarator.init.span.start,
        type: annotation?.span ? content.slice(annotation.span.start, annotation.span.end) : undefined
      }
    }
  }
  return null
}

/** A route handler (`route.ts` under `app/`, a file under `pages/api/`): its texts are responses of an API, not of a page. */
function isApiRoute (file: string): boolean {
  const rel = projectPath(file)
  return /^app\/(?:.*\/)?route\.[cm]?[jt]sx?$/.test(rel) || rel.startsWith('pages/api/')
}

/**
 * The functions that run as Server Actions or cached (`'use server'`, `'use cache'` as their first statement), all
 * of the file for such a directive at its top: they have no root params, so getT() there needs `{ lng }` passed in.
 */
function serverDirectiveSpans (ast: any): Array<{ start: number, end: number }> {
  const directive = (stmts: any[]) => stmts.some((st: any) => st.type === 'ExpressionStatement' &&
    st.expression?.type === 'StringLiteral' && /^use (?:server|cache)\b/.test(st.expression.value))
  // the directive prologue: the string statements a body or module starts with
  const leading = (stmts: any[] = []) => {
    const end = stmts.findIndex((st: any) => st.type !== 'ExpressionStatement' || st.expression?.type !== 'StringLiteral')
    return end < 0 ? stmts : stmts.slice(0, end)
  }
  if (directive(leading(ast.body))) return [{ start: 0, end: Infinity }]
  const spans: Array<{ start: number, end: number }> = []
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (FUNCTION_LIKE.has(node.type) && isBlockBody(node.body) && directive(leading(node.body.stmts))) {
      spans.push({ start: node.body.span.start, end: node.body.span.end })
      return
    }
    for (const key in node) {
      const value = node[key]
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object' && key !== 'span') walk(value)
    }
  }
  walk(ast)
  return spans
}

const NEXT_API = 'Left API routes as they are: their texts are responses, not pages (getT() there needs { lng } from the request).'
const NEXT_DIRECTIVE = "Left Server Actions and cached functions ('use server', 'use cache') as they are: getT() there needs { lng } passed in."
const NEXT_UNKNOWN = "Skipped the texts of files that no page or layout imports (as far as the imports resolve), so it is not known whether Server or Client Components render them: add 'use client' to a Client Component, then run instrument again."
const NEXT_OUTSIDE = 'Skipped texts outside components: next-i18next has no global t(). Move them into a component (or, in a Server Component file, an async function), then run instrument again.'
const NEXT_SHARED = 'Skipped the texts of components that Server and Client Components both render, where neither getT() nor a hook works: give them a `t` prop (from getT() or useT() in the callers), then run instrument again.'
const NEXT_WRAPPED = 'Skipped the texts of Server Components wrapped in a call (memo, forwardRef), which cannot become async for getT().'
const NEXT_LANGUAGE_CHANGE = 'Language switches left as they are: next-i18next changes the language through the route (/de/…) or useChangeLanguage() from next-i18next/client. Wire these by hand.'

/**
 * Takes out the candidates next-i18next cannot translate where they are: outside a component (no global `t`), in
 * a component rendered on both sides without a `t` prop, a <Trans> there, in a Server Component that cannot
 * become async. Returns what it dropped, by reason.
 */
function dropForNextI18next (
  candidates: CandidateString[],
  components: ComponentBoundary[],
  kind: NextFileKind,
  apiRoute: boolean,
  directiveSpans: Array<{ start: number, end: number }>
): NonNullable<FileScanResult['dropped']> {
  const componentOf = (c: CandidateString) => components.find(comp => comp.name === c.insideComponent)
  const reasonOf = (c: CandidateString): string | null => {
    if (apiRoute) return NEXT_API
    if (directiveSpans.some(span => c.offset >= span.start && c.endOffset <= span.end)) return NEXT_DIRECTIVE
    const comp = componentOf(c)
    // a <Trans> takes its `t` from the React context, in any render code of a Client Component
    if (!comp) return c.type === 'jsx-mixed' && (kind === 'client' || kind === 'pages') ? null : NEXT_OUTSIDE
    // with `t` and `i18n` props, a <Trans> takes them both and works on either side
    if ((kind === 'shared' || kind === 'unknown') && (!comp.hasUseTranslation || (c.type === 'jsx-mixed' && !comp.i18nParam))) {
      return kind === 'shared' ? NEXT_SHARED : NEXT_UNKNOWN
    }
    if (kind === 'server' && comp.wrapped && !comp.hasUseTranslation) return NEXT_WRAPPED
    return null
  }
  const counts = new Map<string, number>()
  const keep = candidates.filter(c => {
    const reason = reasonOf(c)
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1)
    return !reason
  })
  candidates.length = 0
  candidates.push(...keep)
  return [...counts].map(([message, count]) => ({ message, count }))
}

/**
 * Node types whose span delimits deferred (call-time) evaluation. A string
 * outside all of them is evaluated when the module is first imported.
 */
const FUNCTION_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'PrivateMethod',
  'MethodProperty',
  'GetterProperty',
  'SetterProperty',
  'Constructor'
])

/**
 * Recursively collects the spans of every function-like node in the AST.
 */
function collectFunctionSpans (node: any, spans: Array<{ start: number, end: number }>): void {
  if (!node || typeof node !== 'object') return

  if (FUNCTION_NODE_TYPES.has(node.type) && node.span) {
    spans.push({ start: node.span.start, end: node.span.end })
    // No need to recurse: nested functions are inside this span already.
    return
  }

  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => collectFunctionSpans(item, spans))
      } else {
        collectFunctionSpans(value, spans)
      }
    }
  }
}

/**
 * Returns the 1-based line number for a character offset.
 */
function lineOfOffset (content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

// ─── Component boundary detection ───────────────────────────────────────────

/**
 * Recursively detects React function component boundaries in the AST.
 *
 * Identifies:
 * - FunctionDeclaration with uppercase name: `function Greeting() { ... }`
 * - FunctionExpression with uppercase name: `export default function Greeting() { ... }`
 * - VariableDeclarator with uppercase name + arrow/function expression:
 *   `const Greeting = () => { ... }` or `const Greeting = function() { ... }`
 * - forwardRef wrappers: `const Greeting = React.forwardRef((props, ref) => { ... })`
 * - memo wrappers: `const Greeting = React.memo(() => { ... })`
 */
function detectComponentBoundaries (
  node: any,
  content: string,
  components: ComponentBoundary[],
  serverFile = false
): void {
  if (!node) return

  // FunctionDeclaration with uppercase name
  if (node.type === 'FunctionDeclaration' && node.identifier?.value && /^[A-Z]/.test(node.identifier.value)) {
    const body = node.body
    if (isBlockBody(body) && body.span) {
      components.push({
        name: node.identifier.value,
        bodyStart: body.span.start,
        bodyEnd: body.span.end,
        ...tBinding(node, body),
        ...functionFacts(node)
      })
    }
  }

  // FunctionExpression with uppercase name.
  // Covers `export default function TasksPage() { ... }` — SWC represents the
  // function inside ExportDefaultDeclaration as a FunctionExpression, not a
  // FunctionDeclaration. Deduplicate against bodies already registered by the
  // VariableDeclarator path (e.g. `const Foo = function Foo() {}`).
  if (node.type === 'FunctionExpression' && node.identifier?.value && /^[A-Z]/.test(node.identifier.value)) {
    const body = node.body
    if (isBlockBody(body) && body.span) {
      const alreadyRegistered = components.some(
        c => c.bodyStart === body.span.start && c.bodyEnd === body.span.end
      )
      if (!alreadyRegistered) {
        components.push({
          name: node.identifier.value,
          bodyStart: body.span.start,
          bodyEnd: body.span.end,
          ...tBinding(node, body),
          ...functionFacts(node)
        })
      }
    }
  }

  // VariableDeclarator with uppercase name
  if (node.type === 'VariableDeclarator' && node.id?.value && /^[A-Z]/.test(node.id.value)) {
    const init = node.init
    if (init) {
      // Direct arrow/function expression: const Greeting = () => { ... }
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        addComponentFromFunctionNode(node.id.value, init, content, components)
      }
      // Wrapped in a call: React.memo(...), React.forwardRef(...), memo(...), forwardRef(...)
      if (init.type === 'CallExpression') {
        const callee = init.callee
        const isWrapper =
          // React.forwardRef, React.memo
          (callee?.type === 'MemberExpression' &&
            (callee.property?.value === 'forwardRef' || callee.property?.value === 'memo')) ||
          // forwardRef, memo (direct import)
          (callee?.type === 'Identifier' &&
            (callee.value === 'forwardRef' || callee.value === 'memo'))

        if (isWrapper && init.arguments?.length > 0) {
          const arg = init.arguments[0]?.expression || init.arguments[0]
          if (arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) {
            addComponentFromFunctionNode(node.id.value, arg, content, components, true)
          }
        }
      }
    }
  }

  // Not a component, but a function with a `t` of its own (`const { t } = await getT()` in `generateMetadata`,
  // a custom hook), or in a Server Component file one that can await getT(): an async one, or the metadata
  // functions Next.js awaits
  if (FUNCTION_LIKE.has(node.type) && node.body?.span && !components.some(c => c.bodyStart === node.body.span.start)) {
    const name: string | undefined = node.identifier?.value
    const ownHook = isBlockBody(node.body) && bindsT({}, node.body) === 'translation'
    if (ownHook || (serverFile && (node.async || /^generate(?:Metadata|Viewport)$/.test(name ?? '')))) {
      addComponentFromFunctionNode(`${name ?? 'function'}@${node.body.span.start}`, node, content, components, false, true)
    }
  }

  // Recurse into children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => detectComponentBoundaries(item, content, components, serverFile))
      } else {
        detectComponentBoundaries(value, content, components, serverFile)
      }
    }
  }
}

const FUNCTION_LIKE = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** Where a function starts, whether it is async, and the translation hook it calls without taking `t`. */
function functionFacts (fnNode: any, wrapped = false): Pick<ComponentBoundary, 'start' | 'isAsync' | 'wrapped' | 'hookPattern' | 'i18nParam' | 'returnType'> {
  const facts: Pick<ComponentBoundary, 'start' | 'isAsync' | 'wrapped' | 'hookPattern' | 'i18nParam' | 'returnType'> = { start: fnNode.span?.start, isAsync: !!fnNode.async }
  if (wrapped) facts.wrapped = true
  if ((fnNode.params ?? []).some((p: any) => patternBinds(p, 'i18n'))) facts.i18nParam = true
  const returnType = fnNode.returnType?.typeAnnotation?.span
  if (returnType) facts.returnType = { start: returnType.start, end: returnType.end }
  for (const stmt of isBlockBody(fnNode.body) ? fnNode.body.stmts ?? [] : []) {
    for (const d of stmt.type === 'VariableDeclaration' ? stmt.declarations ?? [] : []) {
      const call = d.init?.type === 'AwaitExpression' ? d.init.argument : d.init
      const hook = call?.type === 'CallExpression' ? dottedName(call.callee)?.split('.').pop() : null
      const props = d.id?.type === 'ObjectPattern' ? d.id.properties ?? [] : []
      if (!hook || !HOOK_CALL_RE.test(hook) || !props.length || props.some((p: any) => p.type === 'RestElement')) continue
      facts.hookPattern = { statement: stmt.span.start, first: props[0].span.start, last: props[props.length - 1].span.end, names: props.map((p: any) => p.key?.value).filter(Boolean) }
      return facts
    }
  }
  return facts
}

/**
 * swc >=1.16 types function bodies as 'FunctionBody'; older versions used 'BlockStatement'.
 */
function isBlockBody (body: any): boolean {
  return body?.type === 'BlockStatement' || body?.type === 'FunctionBody'
}

/**
 * Helper: extracts a ComponentBoundary from an ArrowFunctionExpression or FunctionExpression
 * that has a block body.
 */
function addComponentFromFunctionNode (
  name: string,
  fnNode: any,
  content: string,
  components: ComponentBoundary[],
  wrapped = false,
  anyExpressionBody = false
): void {
  const body = fnNode.body
  if (isBlockBody(body) && body.span) {
    components.push({
      name,
      bodyStart: body.span.start,
      bodyEnd: body.span.end,
      ...tBinding(fnNode, body),
      ...functionFacts(fnNode, wrapped)
    })
  } else if ((isJSXExpression(body) || anyExpressionBody) && body?.span) {
    // `const Hint = () => <p>…</p>`: a component too; its body becomes a block when it needs the hook
    // (as does `async () => ({ title: … })`, a server function)
    components.push({
      name,
      bodyStart: body.span.start,
      bodyEnd: body.span.end,
      ...tBinding(fnNode, {}),
      ...functionFacts(fnNode, wrapped),
      expressionBody: true
    })
  }
}

/** JSX, possibly in parentheses. */
function isJSXExpression (expr: any): boolean {
  if (expr?.type === 'ParenthesisExpression') return isJSXExpression(expr.expression)
  return expr?.type === 'JSXElement' || expr?.type === 'JSXFragment'
}

/**
 * The `t` a component has already: `'translation'` for a parameter (`({ t })`, a prop passed down) or one
 * destructured from a translation hook (`const { t } = useTranslation('ns')`, also re-exported or renamed:
 * `useT`, `useAppTranslation`, `getTranslations`), `'other'` for any other `t` in its body
 * (`const [t, setT] = useState(0)`), null for none. Another `const { t }` would be a redeclaration, and the
 * `t()` calls would call the other `t`.
 */
function bindsT (fnNode: any, body: any): 'translation' | 'other' | null {
  if ((fnNode.params ?? []).some((p: any) => patternBinds(p, 't'))) return 'translation'
  for (const stmt of body.stmts ?? []) {
    if (stmt.type === 'FunctionDeclaration' && stmt.identifier?.value === 't') return 'other'
    for (const d of stmt.type === 'VariableDeclaration' ? stmt.declarations ?? [] : []) {
      if (!patternBinds(d.id, 't')) continue
      const call = d.init?.type === 'AwaitExpression' ? d.init.argument : d.init
      const hook = call?.type === 'CallExpression' ? dottedName(call.callee)?.split('.').pop() : null
      // `const t = i18n.getFixedT(lng, 'footer')` is one too
      if (d.id.type === 'Identifier' && hook === 'getFixedT') return 'translation'
      return d.id.type === 'ObjectPattern' && hook && TRANSLATION_HOOK_RE.test(hook) ? 'translation' : 'other'
    }
  }
  return null
}

/** The translation hooks a call to which can take `t` as well; an app's own `useRoleTranslations()` returns data. */
const HOOK_CALL_RE = /^(?:useTranslation|useT|getT)$/

/** Names of the hooks and functions that give a translation `t`. */
const TRANSLATION_HOOK_RE = /^(?:use|get)\w*(?:Translation|T|I18n|Intl)\w*$/

/** A component's `hasUseTranslation`, and `ownT` when its `t` is something else (see `bindsT`). */
function tBinding (fnNode: any, body: any): { hasUseTranslation: boolean, ownT?: true } {
  const kind = bindsT(fnNode, body)
  return kind === 'other' ? { hasUseTranslation: true, ownT: true } : { hasUseTranslation: kind === 'translation' }
}

/** Whether a binding pattern (a parameter, a destructuring) binds `name`; defaults and renamed keys aside. */
function patternBinds (pat: any, name: string): boolean {
  switch (pat?.type) {
    case 'Identifier': return pat.value === name
    case 'Parameter': return patternBinds(pat.pat, name)
    case 'AssignmentPattern': return patternBinds(pat.left, name)
    case 'RestElement': return patternBinds(pat.argument, name)
    case 'ArrayPattern': return (pat.elements ?? []).some((e: any) => patternBinds(e, name))
    case 'ObjectPattern': return (pat.properties ?? []).some((p: any) =>
      p.type === 'KeyValuePatternProperty'
        ? patternBinds(p.value, name)
        : p.type === 'AssignmentPatternProperty' ? p.key?.value === name : patternBinds(p.argument, name))
    default: return false
  }
}

// Non-translatable JSX attributes are defined in utils/jsx-attributes.ts
// and shared with the linter. The instrumenter uses `ignoredAttributeSet`
// to skip recursing into non-translatable attribute values.

/**
 * Returns true when the AST node is a `t(...)` or `i18next.t(...)` call
 * expression — i.e. code that was already instrumented.
 */
function isTranslationCall (node: any, functions: readonly string[] = []): boolean {
  const name = dottedName(node.callee)
  if (!name) return false
  // t(...), $t(...), i18next.t(...), props.t(...), this.$t(...), and the project's own (`extract.functions`)
  return name === 't' || name === '$t' || /\.\$?t$/.test(name) || functions.some(fn => matchesFunctionPattern(name, fn))
}

/** A callee as a dotted name (`this.props.t`, `i18n.t`), or null for a computed one. */
function dottedName (callee: any): string | null {
  if (callee?.type === 'Identifier') return callee.value
  if (callee?.type === 'ThisExpression') return 'this'
  if (callee?.type !== 'MemberExpression' || callee.property?.type !== 'Identifier') return null
  const object = dottedName(callee.object)
  return object && `${object}.${callee.property.value}`
}

/**
 * Methods whose string arguments are never text shown to a user: selectors, attribute and storage names,
 * and the strings a text is searched for or compared with (translating `msg.includes('not found')` breaks it).
 */
const NON_TEXT_METHODS = new Set([
  'querySelector', 'querySelectorAll', 'closest', 'matches', 'getElementById', 'getElementsByClassName',
  'getElementsByTagName', 'getElementsByName', 'addEventListener', 'removeEventListener',
  'getAttribute', 'hasAttribute', 'removeAttribute', 'getPropertyValue', 'setProperty', 'removeProperty',
  'getItem', 'setItem', 'removeItem',
  // analytics event and user names: a translated one splits the data by language
  'track', 'trackEvent', 'logEvent', 'capture', 'captureMessage', 'captureException', 'identify',
  // event names, and format patterns (`dayjs(d).format('DD MMM YYYY')`)
  'emit', 'on', 'once', 'off', 'addListener', 'removeListener', 'format',
  'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'match', 'matchAll', 'search', 'replace',
  'replaceAll', 'split', 'localeCompare'
])

/**
 * Functions whose string arguments are never text: `gtag('event', 'Sign Up Completed')`, `require('x')`,
 * `RegExp('…')`, `format(date, 'yyyy-MM-dd')`.
 */
const NON_TEXT_FUNCTIONS = new Set(['gtag', 'require', 'RegExp', 'format'])

/** Objects whose method calls are logs or error reports, for developers whatever they say. */
const LOG_OBJECTS = /^(?:logger|log|Sentry|sentry|Bugsnag|bugsnag|Rollbar|rollbar|winston|pino)$/

/** A call to one of `NON_TEXT_METHODS` or `NON_TEXT_FUNCTIONS` (`el.closest('button, a')`, `gtag(…)`). */
function isNonTextMethodCall (node: any): boolean {
  const callee = node.callee
  if (callee?.type === 'Identifier') return NON_TEXT_FUNCTIONS.has(callee.value)
  if (callee?.type !== 'MemberExpression' || callee.property?.type !== 'Identifier') return false
  return NON_TEXT_METHODS.has(callee.property.value) || (callee.object?.type === 'Identifier' && LOG_OBJECTS.test(callee.object.value))
}

/**
 * The names of a file's variables whose every use is inside a `console.*` call: a variable declared twice
 * counts as one name, and any use elsewhere takes it out.
 */
function collectConsoleOnlyNames (ast: any): Set<string> {
  const declared = new Set<string>()
  const inConsole = new Set<string>()
  const elsewhere = new Set<string>()
  const walk = (node: any, inLog: boolean): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(n => walk(n, inLog)); return }
    if (node.type === 'VariableDeclarator') {
      if (node.id?.type === 'Identifier') declared.add(node.id.value)
      else walk(node.id, inLog)
      walk(node.init, inLog)
      return
    }
    if (node.type === 'MemberExpression') {
      walk(node.object, inLog)
      if (node.property?.type === 'Computed') walk(node.property, inLog)
      return
    }
    if (node.type === 'KeyValueProperty') { walk(node.value, inLog); return }
    if (node.type === 'Identifier') (inLog ? inConsole : elsewhere).add(node.value)
    const log = inLog || (node.type === 'CallExpression' && isConsoleCall(node))
    for (const key in node) if (key !== 'span') walk(node[key], log)
  }
  walk(ast, false)
  return new Set([...declared].filter(n => inConsole.has(n) && !elsewhere.has(n)))
}

/** Per file, the names `collectConsoleOnlyNames` found for its content (set by the scan, read by the visit). */
const consoleOnlyNames = new Map<string, Set<string>>()

/** The property names whose value is text (`label`, `title`, …), lower-cased. */
const translatablePropertyLowerSet = new Set([...translatablePropertySet].map(p => p.toLowerCase()))

/** String literals a JSX element renders (see `markRendered`): text whatever their words. */
const renderedStrings = new WeakSet<object>()

/** Marks the strings an expression rendered as a JSX child can produce: itself, a branch, a fallback. */
function markRendered (expr: any): void {
  if (!expr) return
  if (expr.type === 'StringLiteral') renderedStrings.add(expr)
  else if (expr.type === 'ConditionalExpression') {
    markRendered(expr.consequent)
    markRendered(expr.alternate)
  } else if (expr.type === 'BinaryExpression' && LOGICAL_OPERATORS.has(expr.operator)) {
    // swc types `&&`, `||` and `??` as a BinaryExpression
    markRendered(expr.right)
  } else if (expr.type === 'ParenthesisExpression') markRendered(expr.expression)
}

/** Per file, the strings `collectDataStrings` found (set by the scan, read by the visit). */
const fileDataStrings = new Map<string, Set<string>>()

/** Property and attribute names whose string value is data the code matches against. */
const DATA_KEYS = new Set(['id', 'key', 'value', 'type', 'code', 'kind'])

/** Names of lists whose strings are values to match (`order: ['2FA', 'no 2FA']`). */
const DATA_LISTS = /^(?:order|ids|keys|values|types|kinds|codes)$/i

/**
 * The strings a file uses as data: compared (`=== 'no 2FA'`), a `case`, an object key, the value of an `id`,
 * `key`, `value`, `type`, `code` or `kind`, an entry of an `order`/`ids`/`values` list, or an argument of a
 * method that compares (`includes`). The same string as text elsewhere in that file is then data too: a
 * facet's `of()` returning `'no 2FA'` must keep matching `order: ['2FA', 'no 2FA']`.
 */
function collectDataStrings (ast: any): Set<string> {
  const found = new Set<string>()
  const add = (node: any) => { if (node?.type === 'StringLiteral') found.add(node.value) }
  const addList = (node: any) => { if (node?.type === 'ArrayExpression') for (const e of node.elements ?? []) add(e?.expression) }
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'BinaryExpression' && COMPARISON_OPERATORS.has(node.operator)) { add(node.left); add(node.right) }
    if (node.type === 'SwitchCase') add(node.test)
    if (node.type === 'KeyValueProperty') {
      add(node.key)
      const name = propertyName(node.key)
      if (name && DATA_KEYS.has(name)) add(node.value)
      if (name && DATA_LISTS.test(name)) addList(node.value)
    }
    if (node.type === 'VariableDeclarator' && DATA_LISTS.test(node.id?.value ?? '')) addList(node.init)
    if (node.type === 'JSXAttribute' && DATA_KEYS.has(node.name?.value) && node.value?.type === 'StringLiteral') add(node.value)
    if (node.type === 'CallExpression' && isNonTextMethodCall(node)) {
      for (const arg of node.arguments ?? []) add(arg.expression)
      if (node.callee?.type === 'MemberExpression') addList(node.callee.object)
    }
    for (const key in node) if (key !== 'span') walk(node[key])
  }
  walk(ast)
  return found
}

/** `console.log(...)`, `console.warn(...)`: their arguments are for developers, however they are built. */
function isConsoleCall (node: any): boolean {
  const callee = node.callee
  return callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier' && callee.object.value === 'console'
}

/**
 * Recursively visits AST nodes to find string literals.
 * `jsx` carries the per-element attribute rules; at each JSX opening tag it gets
 * that element's resolved attributes, which apply to the tag's own attributes.
 */
function visitNodeForStrings (
  node: any,
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  candidates: CandidateString[],
  jsx?: {
    rules: AttributeRules,
    aliases: Map<string, string>,
    element?: { accepted: Set<string>, removed: Set<string> }
  }
): void {
  if (!node) return

  if (node.type === 'JSXOpeningElement' && jsx) {
    jsx = { ...jsx, element: resolveElementAttributes(jsx.rules, jsxElementName(node.name, jsx.aliases)) }
  }

  const visit = (child: any) => visitNodeForStrings(child, content, file, config, candidates, jsx)

  // Its string arguments are not text; what it is called on and the functions it gets may hold some
  // (`el.addEventListener('click', () => { status.textContent = 'Copied to clipboard' })`)
  if (node.type === 'CallExpression' && isNonTextMethodCall(node)) {
    visit(node.callee)
    for (const arg of node.arguments ?? []) visitTextHolders(arg.expression, content, file, config, candidates, jsx)
    return
  }

  const parts = nonTextParts(node, file, config, true)
  if (parts === 'all') return
  if (parts) {
    forEachChild(node, parts, visit)
    return
  }

  // Skip non-translatable JSX attributes entirely (e.g. className={...})
  if (node.type === 'JSXAttribute') {
    const nameNode = node.name
    let attrName: string | null = null
    if (nameNode?.type === 'Identifier') {
      attrName = nameNode.value
    } else if (nameNode?.type === 'JSXNamespacedName') {
      // e.g. data-testid
      attrName = `${nameNode.namespace?.value ?? ''}:${nameNode.name?.value ?? ''}`
    }
    // A rule that adds an attribute on this element wins over the built-in skip list (e.g. `name`)
    const added = attrName != null && jsx?.element?.accepted.has(attrName.toLowerCase())
    // The value of an ignored attribute, or one a rule removed on this element, is not text; but the
    // elements and functions in it hold text as anywhere else (`action={<Button>change</Button>}`,
    // `onClick={() => setMessage('Copied')}`)
    const notText = !!attrName && (
      (ignoredAttributeSet.has(attrName) && !added) ||
      !!jsx?.element?.removed.has(attrName.toLowerCase()) ||
      // For hyphenated names (data-testid), also check with the raw text
      (attrName.includes(':') && ignoredAttributeSet.has(attrName.replace(':', '-')))
    )
    if (notText) {
      visitTextHolders(node.value, content, file, config, candidates, jsx)
      return
    }
  }

  // What a JSX element renders from an expression is text, a single word too: `{used ? <>…</> : 'Never used'}`,
  // `{busy && 'saving'}`, `{name || 'the organization'}`
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
    for (const child of node.children ?? []) if (child.type === 'JSXExpressionContainer') markRendered(child.expression)
  }

  // The two branches of a ternary are alternatives of one text: when one is text, a string on the other side
  // is too (`running ? 'Confirm all reviews' : 'stop'`, `n ? \`Pay invoice ${n}\` : 'Pay invoice'`)
  if (node.type === 'ConditionalExpression') {
    visit(node.test)
    visit(node.consequent)
    visit(node.alternate)
    const branches = [node.consequent, node.alternate]
    const found = (b: any) => candidates.some(c => c.offset === b?.span?.start && c.endOffset === b?.span?.end)
    branches.forEach((b, i) => {
      if (b?.type !== 'StringLiteral' || found(b) || !found(branches[1 - i])) return
      const candidate = stringCandidate(b, content, file, config, jsx?.element?.accepted, true)
      if (candidate) candidates.push(candidate)
    })
    return
  }

  // Check if this is a string literal
  if (node.type === 'StringLiteral') {
    const candidate = stringCandidate(node, content, file, config, jsx?.element?.accepted, renderedStrings.has(node))
    if (candidate) candidates.push(candidate)
  }

  // Template literals
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis
    const expressions = node.expressions

    if (quasis?.length === 1 && (!expressions || expressions.length === 0)) {
      // Static template literal (no interpolation), e.g. `Welcome back`
      const raw = quasis[0].raw || quasis[0].cooked || ''
      const trimmed = raw.trim()
      if (trimmed && node.span && typeof node.span.start === 'number') {
        const candidate = detectCandidate(
          trimmed,
          node.span.start,
          node.span.end,
          file,
          content,
          config
        )
        if (candidate && candidate.confidence >= 0.7) {
          candidate.type = 'template-literal'
          if (node.span.start > 0 && content[node.span.start - 1] === '=') {
            candidate.type = 'jsx-attribute'
          }
          candidates.push(candidate)
        }
      }
    } else if (quasis?.length > 1 && expressions?.length > 0 && node.span) {
      // Template literal with interpolation, e.g. `${count}-day streak`, possibly with a plural in it
      const plural = buildPluralTemplate(quasis, expressions, content)
      const result = plural
        ? { text: plural.pluralForms.other, interpolations: plural.interpolations }
        : buildInterpolatedTemplate(quasis, expressions, content)
      if (result && hasWordsBesidePlaceholders(result.text)) {
        const trimmed = result.text.trim()
        if (trimmed) {
          const candidate = detectCandidate(
            trimmed,
            node.span.start,
            node.span.end,
            file,
            content,
            config
          )
          if (candidate) {
            candidate.content = trimmed
            candidate.type = 'template-literal'
            if (result.interpolations.length) candidate.interpolations = result.interpolations
            if (plural) {
              candidate.pluralForms = plural.pluralForms
              candidate.pluralHelper = plural.pluralHelper
            }
            // Template literals mixing text + expressions are likely user-facing, plurals always
            candidate.confidence = Math.min(1, candidate.confidence + (plural ? 0.3 : 0.15))
            if (node.span.start > 0 && content[node.span.start - 1] === '=') {
              candidate.type = 'jsx-attribute'
            }
            if (candidate.confidence >= 0.7) {
              candidates.push(candidate)
            }
          }
        }
      }
    }
  }

  // Check if this is JSX text content (e.g. <h1>Hello World</h1>)
  if (node.type === 'JSXText') {
    if (node.span && typeof node.span.start === 'number') {
      const raw = content.slice(node.span.start, node.span.end)
      const trimmed = raw.trim()
      if (trimmed) {
        const trimmedStart = raw.indexOf(trimmed)
        const offset = node.span.start + trimmedStart
        const endOffset = offset + trimmed.length
        const candidate = detectCandidate(jsxTextValue(trimmed), offset, endOffset, file, content, config, undefined, true)
        if (candidate) {
          candidate.type = 'jsx-text'
          // JSXText is almost always user-visible content; boost confidence
          candidate.confidence = Math.min(1, candidate.confidence + 0.2)
          if (candidate.confidence >= 0.7) {
            candidates.push(candidate)
          }
        }
      }
    }
  }

  // Recursively visit children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => visitNodeForStrings(item, content, file, config, candidates, jsx))
      } else {
        visitNodeForStrings(value, content, file, config, candidates, jsx)
      }
    }
  }
}

/**
 * Whether a name says it holds a language model's input: a function or variable (not a component) whose
 * camelCase words include `prompt` and one of system, user, ai, llm, gpt, assistant, chat, model
 * (`getSystemPrompt`, `aiFixPrompt`, `userPromptBatch`). A bare `prompt` may ask the user something
 * (`deletePrompt`), and `EmailPrompt` or `UserPromptDialog` are components.
 */
function isModelPromptName (name: string | null | undefined): boolean {
  if (!name || !/^[a-z]/.test(name)) return false
  const words = name.split(/(?=[A-Z])|_/).map(w => w.toLowerCase())
  return words.includes('prompt') && words.some(w => MODEL_WORDS.has(w))
}

const MODEL_WORDS = new Set(['system', 'user', 'ai', 'llm', 'gpt', 'assistant', 'chat', 'model'])

/**
 * JSX text as React renders it: each line trimmed where it meets a line break, the lines joined by one space,
 * entities decoded (`can&apos;t` → `can't`). In a `t()` default the source form would show as written.
 */
function jsxTextValue (raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/)
  let lastNonEmpty = 0
  lines.forEach((line, i) => { if (/[^ \t]/.test(line)) lastNonEmpty = i })
  let text = ''
  lines.forEach((line, i) => {
    let part = line.replace(/\t/g, ' ')
    if (i > 0) part = part.replace(/^ +/, '')
    if (i < lines.length - 1) part = part.replace(/ +$/, '')
    if (part) text += i < lastNonEmpty ? `${part} ` : part
  })
  return text.replace(HTML_ENTITY_RE, entity => decodeEntity(entity))
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  deg: '°'
}

/** One HTML character reference as its character; an unknown name stays as written. */
function decodeEntity (entity: string): string {
  const body = entity.slice(1, -1)
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return Number.isFinite(code) && code <= 0x10FFFF ? String.fromCodePoint(code) : entity
  }
  return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? entity
}

/**
 * What of a node is never text, the same for every walker looking for text: `'all'` (a t() call, a console
 * call, a <Trans>, an icon, code, a prompt for a language model, a log line, an error or a pattern), the
 * child keys that are not (an object key, a member property, a compared operand, a `case` value, the strings
 * of a non-text call), or null (all of it may be). `withTextHolders` is for the walker that visits the
 * functions and elements passed to a non-text call itself.
 */
function nonTextParts (node: any, file: string, config: I18nextToolkitConfig, withTextHolders: boolean): 'all' | string[] | null {
  switch (node.type) {
    case 'CallExpression':
      // already instrumented (also its options on a second run), or for developers however it is built
      if (isTranslationCall(node, config.extract.functions) || isConsoleCall(node)) return 'all'
      return !withTextHolders && isNonTextMethodCall(node) ? ['arguments'] : null
    case 'NewExpression':
      // `new Error('…')` is for developers, `new RegExp('…')` a pattern
      return node.callee?.type === 'Identifier' && /^RegExp$|Error$/.test(node.callee.value) ? 'all' : null
    case 'JSXElement': {
      if (isTransComponent(node, config.extract.transComponents) || isIconElement(node)) return 'all'
      // what code, scripts and styles show (`ignoredTags`, as for lint); inside a sentence it stays in its <Trans>
      const tag = node.opening?.name?.type === 'Identifier' ? node.opening.name.value.toLowerCase() : null
      return tag && (ignoredTags.includes(tag) || config.extract.ignoredTags?.some(t => t.toLowerCase() === tag)) ? 'all' : null
    }
    case 'KeyValueProperty':
      // a key names something and is never text; a call there is even a syntax error (`{ 'a b': 1 }`)
      return isModelPromptName(propertyName(node.key)) ? 'all' : ['key']
    case 'MemberExpression':
      return ['property']
    case 'BinaryExpression':
      // the strings a value is compared with are data (`status === 'Active'`)
      if (!COMPARISON_OPERATORS.has(node.operator)) return null
      return ['left', 'right'].filter(k => node[k]?.type === 'StringLiteral' || node[k]?.type === 'TemplateLiteral')
    case 'SwitchCase':
      return ['test']
    case 'FunctionDeclaration':
      // a prompt is the input of a language model: translating it changes what the model does
      return isModelPromptName(node.identifier?.value) ? 'all' : null
    case 'VariableDeclarator':
      // a prompt, or a variable used only in console calls (a log line: `const took = …; console.log(took)`)
      return isModelPromptName(node.id?.value) ||
        (node.id?.type === 'Identifier' && consoleOnlyNames.get(file)?.has(node.id.value))
        ? 'all'
        : null
    default:
      return null
  }
}

/** Calls `visit` for each child node, but not those under the keys `except`. */
function forEachChild (node: any, except: 'all' | string[] | null, visit: (child: any) => void): void {
  if (except === 'all') return
  for (const key in node) {
    if (key === 'span' || except?.includes(key)) continue
    const value = node[key]
    if (Array.isArray(value)) value.forEach(item => item && typeof item === 'object' && visit(item))
    else if (value && typeof value === 'object') visit(value)
  }
}

/** A string literal as a candidate of enough confidence, or null; `textSlot` takes a single word as text. */
function stringCandidate (
  stringNode: StringLiteral,
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  accepted: ReadonlySet<string> | undefined,
  textSlot: boolean
): CandidateString | null {
  if (!stringNode.span || typeof stringNode.span.start !== 'number') return null
  // the same string as data elsewhere in the file: translating it here breaks the match there (what a JSX
  // element renders and an attribute's value, `data-tip='overridden'`, are shown, never matched)
  // nor a text property's (`{ value: 'Weekly', label: 'Weekly' }`)
  const attributeValue = stringNode.span.start > 0 && content[stringNode.span.start - 1] === '='
  const property = /([\w]+)\s*:\s*$/.exec(content.slice(Math.max(0, stringNode.span.start - 40), stringNode.span.start))?.[1]
  const textProperty = !!property && translatablePropertyLowerSet.has(property.toLowerCase())
  if (fileDataStrings.get(file)?.has(stringNode.value) && !renderedStrings.has(stringNode) && !attributeValue && !textProperty) return null
  const candidate = detectCandidate(stringNode.value, stringNode.span.start, stringNode.span.end, file, content, config, accepted, textSlot)
  // in a text slot the place says it is text, whatever the words score
  if (candidate && textSlot) candidate.confidence = Math.max(candidate.confidence, 0.7)
  if (!candidate || candidate.confidence < 0.7) return null
  // Detect JSX attribute context: in JSX, attr="value" has = right before the opening quote
  if (stringNode.span.start > 0 && content[stringNode.span.start - 1] === '=') candidate.type = 'jsx-attribute'
  return candidate
}

const LOGICAL_OPERATORS = new Set(['&&', '||', '??'])

const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=', 'in', 'instanceof'])

/** The name of an object property's key (`label`, `'aria-label'`), or null for a computed one. */
function propertyName (key: any): string | null {
  return key?.type === 'Identifier' || key?.type === 'StringLiteral' ? key.value : null
}

/** Visits the JSX elements and functions inside a value that is not text itself, and nothing else of it. */
function visitTextHolders (
  node: any,
  ...rest: [string, string, I18nextToolkitConfig, CandidateString[], Parameters<typeof visitNodeForStrings>[5]]
): void {
  if (!node || typeof node !== 'object') return
  if (TEXT_HOLDERS.has(node.type)) {
    visitNodeForStrings(node, ...rest)
    return
  }
  for (const key in node) {
    const value = node[key]
    if (Array.isArray(value)) value.forEach(item => visitTextHolders(item, ...rest))
    else visitTextHolders(value, ...rest)
  }
}

const TEXT_HOLDERS = new Set(['JSXElement', 'JSXFragment', 'ArrowFunctionExpression', 'FunctionExpression'])

// ─── Template-literal interpolation helpers ──────────────────────────────────

/**
 * Builds a merged text with `{{var}}` placeholders from a template literal's
 * quasis and expressions arrays.
 */
function buildInterpolatedTemplate (
  quasis: any[],
  expressions: any[],
  content: string
): { text: string, interpolations: Array<{ name: string, expression: string }> } | null {
  const interpolations: Array<{ name: string, expression: string }> = []
  const usedNames: UsedNames = new Map()
  let text = ''

  for (let i = 0; i < quasis.length; i++) {
    const quasi = quasis[i]
    text += quasi.cooked ?? quasi.raw ?? ''

    if (i < expressions.length) {
      const info = resolveExpressionName(expressions[i], content, usedNames)
      if (!info) return null // un-resolvable expression — bail
      text += `{{${info.name}}}`
      if (!info.reused) interpolations.push(info)
    }
  }

  return interpolations.length > 0 ? { text, interpolations } : null
}

/**
 * Whether a text with `{{placeholders}}` holds at least one word standing on its own, and is not a
 * kebab-case name. A word: two letters or more, not camelCase, punctuation around it, a placeholder only
 * after it (`review{{suffix}}.`), not before it nor joined by `_`, `.` or `-`. Ids, paths, keys, flags and
 * class names built in a template literal have none: `{{projectId}}-{{version}}`, `weight_{{code}}`,
 * `{{baseUrl}}/api/{{id}}`, `{{id}}.collapsed`, `{{metric}}Avg`, `nameField{{i}}`, `--ct {{cdnType}}`,
 * `locize-dropzone {{state}}`.
 */
function hasWordsBesidePlaceholders (text: string): boolean {
  // a placeholder becomes one private-use character, neither letter nor punctuation
  const bare = text.replace(HTML_ENTITY_RE, ' ').replace(/\{\{[^}]*\}\}/g, '\uE000')
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(bare.replace(/\uE000/g, ' ').trim())) return false
  return bare.split(/\s+/).some(token => {
    // (a name with digits in a later part counts: `next-i18next v{{version}}`)
    const word = /^[^\p{L}\p{N}\uE000_.-]*(\p{L}{2,}(?:['’-]\p{N}*\p{L}[\p{L}\p{N}]*)*)[^\p{L}\p{N}_]*$/u.exec(token)?.[1]
    // `zh-{{country}}`, `{{a}}/{{b}}`: a placeholder joined to the word by a separator makes an id, not a phrase
    if (/[-_./:#@=&?|\\]\uE000/.test(token)) return false
    // one Han, Kana or Hangul character is a word of its own (`共 {{n}} 条`)
    return (!!word && !/\p{Ll}\p{Lu}/u.test(word)) || /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u.test(token)
  })
}

/**
 * A template literal one of whose expressions is a plural (a plural helper call or a `count === 1` ternary),
 * as one text per plural form: `${n(keys)} ${plural(keys, 'key', 'keys')} unused` → one: '{{keys}} key unused',
 * other: '{{keys}} keys unused', count: keys. An expression that is the count itself becomes `{{count}}`.
 */
function buildPluralTemplate (
  quasis: any[],
  expressions: any[],
  content: string
): { pluralForms: NonNullable<CandidateString['pluralForms']>, interpolations: Array<{ name: string, expression: string }>, pluralHelper?: string } | null {
  const pluralIndex = expressions.findIndex(e => parsePluralExpression(e, content))
  if (pluralIndex < 0) return null
  const plural = parsePluralExpression(expressions[pluralIndex], content)!

  const usedNames: UsedNames = new Map()
  const interpolations: Array<{ name: string, expression: string }> = []
  const formText = (form: string): string | null => {
    let text = ''
    for (let i = 0; i < quasis.length; i++) {
      text += quasis[i].cooked ?? quasis[i].raw ?? ''
      if (i >= expressions.length) continue
      if (i === pluralIndex) {
        text += form
        continue
      }
      const expression = content.slice(expressions[i].span.start, expressions[i].span.end)
      if (expression === plural.countExpression) {
        text += '{{count}}'
        continue
      }
      const info = resolveExpressionName(expressions[i], content, usedNames)
      if (!info) return null
      text += `{{${info.name}}}`
      if (!info.reused) interpolations.push(info)
    }
    return text.trim()
  }

  const other = formText(plural.other)
  const one = plural.one !== undefined ? formText(plural.one) : undefined
  const zero = plural.zero !== undefined ? formText(plural.zero) : undefined
  if (!other || one === null || zero === null) return null
  if (!mergeInterpolations(interpolations, plural.interpolations)) return null
  return { pluralForms: { countExpression: plural.countExpression, zero, one, other }, interpolations, pluralHelper: pluralHelperOf(expressions[pluralIndex]) }
}

/** The name of the plural helper a call expression calls (`plural(n, …)` → `plural`), or undefined. */
function pluralHelperOf (expr: any): string | undefined {
  return expr?.type === 'CallExpression' && expr.callee?.type === 'Identifier' ? expr.callee.value : undefined
}

/**
 * Adds a plural's own placeholders (from its forms) to the text's; false when a name stands for two
 * different expressions.
 */
function mergeInterpolations (
  into: Array<{ name: string, expression: string }>,
  from: Array<{ name: string, expression: string }> = []
): boolean {
  for (const item of from) {
    const same = into.find(i => i.name === item.name)
    if (same && same.expression !== item.expression) return false
    if (!same) into.push(item)
  }
  return true
}

/** Placeholder names given so far in one text, each with its expression. */
type UsedNames = Map<string, string>

/**
 * The name an expression's value says best what it is, or null:
 * - `Identifier` → itself (`count`); `MemberExpression` → its last property (`profile.name` → `name`)
 * - a formatter's call, by its argument: `format.date(user.lastLogin)` → `lastLogin`, `n(queue)` → `queue`,
 *   `Math.floor(m / 60)` → `m` (a namespace or a formatter keeps the meaning of what it gets)
 * - a string method's call, by what it is called on: `input.value.trim()` → `value`
 * - any other call, by the function: `price(plan)` → `price`, `api.calculatePercentage(stats)` → `calculatePercentage`
 * - `a - b`, `a || b`, `(a)`, `a as T`, `a!` → the name of `a`
 */
function nameOfExpression (expr: any): string | null {
  switch (expr?.type) {
    case 'Identifier': return expr.value
    case 'MemberExpression':
      return !expr.computed && expr.property?.type === 'Identifier' ? expr.property.value : null
    case 'CallExpression': {
      const callee = expr.callee
      const argument = () => nameOfExpression(expr.arguments?.[0]?.expression)
      if (callee?.type === 'Identifier') return FORMATTER_RE.test(callee.value) ? argument() : callee.value
      if (callee?.type !== 'MemberExpression' || callee.property?.type !== 'Identifier') return null
      const object = callee.object
      const method = callee.property.value
      if (object?.type === 'Identifier' && (/^[A-Z]/.test(object.value) || FORMATTER_NAMESPACE_RE.test(object.value))) return argument()
      // `date.toLocaleDateString()`, `terms.map(…).join(', ')`: still the value it is called on
      if (STRING_METHODS.has(method) || ARRAY_METHODS.has(method)) return nameOfExpression(object)
      return method
    }
    case 'BinaryExpression':
      // `name || email` (swc types `||`, `&&`, `??` as a BinaryExpression), `i + 1`: the value meant; any other
      // arithmetic is a new quantity (`segments * tokensPerSegment`), which no operand names
      if (LOGICAL_OPERATORS.has(expr.operator)) return nameOfExpression(expr.left)
      if ((expr.operator === '+' || expr.operator === '-') && expr.right?.type === 'NumericLiteral') return nameOfExpression(expr.left)
      return null
    case 'ParenthesisExpression':
    case 'TsAsExpression':
    case 'TsNonNullExpression':
    case 'TsSatisfiesExpression': return nameOfExpression(expr.expression)
    default: return null
  }
}

/** Names of formatter functions: their call shows the value they get (`n(queue)`, `formatDate(createdAt)`). */
const FORMATTER_RE = /^(?:format\w*|fmt|formatter|n|num|number|money|percent)$/i

/** Names of formatting namespaces (`format.date(x)`); a capitalized one (`Math`, `Intl`) is one too. */
const FORMATTER_NAMESPACE_RE = /^(?:format\w*|fmt|formatter|intl)$/i

/** Array methods whose result still holds what they are called on. */
const ARRAY_METHODS = new Set(['map', 'filter', 'sort', 'slice', 'flat', 'flatMap', 'concat', 'reverse'])

/**
 * Resolves a human-friendly interpolation name from an AST expression node (see `nameOfExpression`;
 * `val`, `val2`, ... when none). The same expression twice in one text gets one name (`reused`), so the
 * options name it once.
 */
function resolveExpressionName (
  expr: any,
  content: string,
  usedNames: UsedNames
): { name: string, expression: string, reused?: boolean } | null {
  if (!expr?.span) return null

  const expression = content.slice(expr.span.start, expr.span.end)
  for (const [name, expr] of usedNames) {
    if (expr === expression) return { name, expression, reused: true }
  }
  const baseName = nameOfExpression(expr) ?? 'val'

  let name = baseName
  let counter = 2
  while (usedNames.has(name)) {
    name = `${baseName}${counter++}`
  }
  usedNames.set(name, expression)

  return { name, expression }
}

// ─── JSX sibling interpolation merging ───────────────────────────────────────

/**
 * Walks the AST looking for JSXElement / JSXFragment nodes whose children
 * contain a mergeable mix of `JSXText` and `JSXExpressionContainer` with simple
 * expressions (Identifier / MemberExpression).  When found, a single merged
 * `CandidateString` is created and any overlapping individual candidates are
 * removed.
 */
function detectJSXInterpolation (
  node: any,
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  candidates: CandidateString[]
): void {
  if (!node) return

  // Not text (a <Trans>, code, an icon, a prompt, a log line, a key, …): nothing to merge in it
  const parts = nonTextParts(node, file, config, false)
  if (parts === 'all') return

  const children = (node.type === 'JSXElement' || node.type === 'JSXFragment') ? node.children : null

  if (children?.length > 1) {
    // Build "runs" of consecutive JSXText + simple-expression containers
    const runs: any[][] = []
    let currentRun: any[] = []

    for (const child of children) {
      if (child.type === 'JSXText') {
        currentRun.push(child)
      } else if (child.type === 'JSXExpressionContainer' && (isSimpleJSXExpression(child.expression) || child.expression?.type === 'StringLiteral')) {
        // a simple expression, or literal text such as {' '}
        currentRun.push(child)
      } else if (child.type === 'JSXExpressionContainer' && parsePluralExpression(child.expression, content)) {
        // Plural ternary or plural helper call: part of the run, merged with it
        currentRun.push(child)
      } else if (child.type === 'JSXElement' && isSimpleJSXElement(child)) {
        // Simple HTML element — include in the run for Trans detection
        currentRun.push(child)
      } else {
        // JSXElement, complex expression, etc. — break the run
        if (currentRun.length > 0) {
          runs.push(currentRun)
          currentRun = []
        }
      }
    }
    if (currentRun.length > 0) {
      runs.push(currentRun)
    }

    for (const fullRun of runs) {
      // Whitespace at a run's edges stays in the source: a rewrite of it would drop a space the page shows
      // (`provider:{' '}<strong>…`)
      const run = trimRun(fullRun)
      if (!run.length) continue
      const hasText = run.some(c => c.type === 'JSXText' && c.value?.trim())
      const hasExpr = run.some(c => c.type === 'JSXExpressionContainer')
      const hasElement = run.some(c => c.type === 'JSXElement')
      // Require at least one text node plus either an expression or element
      if (!hasText || run.length < 2) continue
      if (!hasExpr && !hasElement) continue

      // Check if any expression container in this run is a plural ternary
      let pluralChild: any = null
      let pluralData: ReturnType<typeof parsePluralExpression> = null
      for (const child of run) {
        if (child.type === 'JSXExpressionContainer') {
          const p = parsePluralExpression(child.expression, content)
          if (p) {
            pluralChild = child
            pluralData = p
            break // only one plural ternary per run
          }
        }
      }

      // A sentence with both an element and a plural stays in its parts: in a <Trans> the plural's forms would
      // end up untranslated in an interpolation, and a plural t() cannot hold the element
      if (hasElement && pluralChild) continue

      if (hasElement) {
        // ── JSX sibling run with nested HTML elements → <Trans> ──
        const [spanStart, spanEnd] = runSpan(run, content)

        // Build the translation string (with indexed tags) and text-only version (for scoring)
        const usedNames: UsedNames = new Map()
        const interpolations: Array<{ name: string, expression: string }> = []
        let transValue = ''
        let textOnly = ''
        let transContent = ''
        let childIndex = 0
        let valid = true

        for (const child of run) {
          if (child.type === 'JSXText') {
            const raw = content.slice(child.span.start, child.span.end)
            const text = jsxTextValue(raw)
            transValue += text
            textOnly += text
            transContent += raw
            // whitespace with a line break is no child of the element at all
            if (text) childIndex++
          } else if (child.type === 'JSXExpressionContainer' && child.expression?.type === 'StringLiteral') {
            // {' '} and other literal text: part of the sentence, kept as written
            transValue += child.expression.value
            textOnly += child.expression.value
            transContent += content.slice(child.span.start, child.span.end)
            childIndex++
          } else if (child.type === 'JSXExpressionContainer') {
            const info = resolveExpressionName(child.expression, content, usedNames)
            if (!info) { valid = false; break }
            transValue += `{{${info.name}}}`
            textOnly += info.name
            // In <Trans> children, simple expressions become {{ obj }} syntax
            const objExpr = info.name === info.expression ? info.name : `${info.name}: ${info.expression}`
            transContent += `{{ ${objExpr} }}`
            if (!info.reused) interpolations.push(info)
            childIndex++
          } else if (child.type === 'JSXElement') {
            const innerText = getJSXElementTextContent(child, content)
            transValue += `<${childIndex}>${innerText}</${childIndex}>`
            textOnly += innerText
            // Keep the original JSX element source for the <Trans> children
            transContent += content.slice(child.span.start, child.span.end)
            childIndex++
          }
        }

        if (!valid) continue

        const trimmedText = textOnly.trim()
        const trimmedTransValue = transValue.trim()
        if (!trimmedText || !trimmedTransValue) continue

        const candidate = detectCandidate(trimmedText, spanStart, spanEnd, file, content, config)
        if (candidate) {
          candidate.type = 'jsx-mixed'
          candidate.content = transContent.trim()
          candidate.transValue = trimmedTransValue
          if (interpolations.length > 0) {
            candidate.interpolations = interpolations
          }
          // Mixed text + elements in JSX is almost always user-facing
          candidate.confidence = Math.min(1, candidate.confidence + 0.25)

          if (candidate.confidence >= 0.7) {
            // Remove individual candidates that overlap with the merged span
            for (let i = candidates.length - 1; i >= 0; i--) {
              if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
                candidates.splice(i, 1)
              }
            }
            candidates.push(candidate)
          }
        }
      } else if (pluralChild && pluralData) {
        // ── JSX sibling run with embedded plural ternary ──
        const countExpr = pluralData.countExpression

        // Resolve names for non-count, non-plural expressions
        const usedNames: UsedNames = new Map()
        const extraInterpolations: Array<{ name: string, expression: string }> = []
        const exprNameMap = new Map<any, string>()
        let valid = true

        for (const child of run) {
          if (child.type === 'JSXExpressionContainer' && child !== pluralChild && child.expression?.type !== 'StringLiteral') {
            const exprText = content.slice(child.expression.span.start, child.expression.span.end)
            if (exprText === countExpr) {
              exprNameMap.set(child, 'count')
            } else {
              const info = resolveExpressionName(child.expression, content, usedNames)
              if (!info) { valid = false; break }
              exprNameMap.set(child, info.name)
              if (!info.reused) extraInterpolations.push(info)
            }
          }
        }

        if (!valid || !mergeInterpolations(extraInterpolations, pluralData.interpolations)) continue

        // Build merged text for each plural form
        const forms = [
          ...(pluralData.zero !== undefined ? ['zero' as const] : []),
          ...(pluralData.one !== undefined ? ['one' as const] : []),
          'other' as const
        ]
        const formTexts: Record<string, string> = {}

        for (const form of forms) {
          let text = ''
          for (const child of run) {
            if (child.type === 'JSXText') {
              text += jsxTextValue(content.slice(child.span.start, child.span.end))
            } else if (child.expression?.type === 'StringLiteral') {
              text += child.expression.value
            } else if (child === pluralChild) {
              const formText = form === 'zero'
                ? pluralData.zero!
                : form === 'one'
                  ? pluralData.one!
                  : pluralData.other
              text += formText
            } else {
              const name = exprNameMap.get(child)!
              text += `{{${name}}}`
            }
          }
          formTexts[form] = text.trim()
        }

        const [spanStart, spanEnd] = runSpan(run, content)
        const otherText = formTexts.other
        if (!otherText) continue

        const candidate = detectCandidate(otherText, spanStart, spanEnd, file, content, config)
        if (candidate) {
          candidate.type = 'jsx-text'
          candidate.content = otherText
          candidate.pluralForms = {
            countExpression: countExpr,
            zero: formTexts.zero,
            one: formTexts.one,
            other: otherText
          }
          if (extraInterpolations.length > 0) {
            candidate.interpolations = extraInterpolations
          }
          candidate.pluralHelper = pluralHelperOf(pluralChild.expression)
          // Plural + JSX merge is always user-facing
          candidate.confidence = Math.min(1, candidate.confidence + 0.3)

          if (candidate.confidence >= 0.7) {
            // Remove individual candidates that overlap with the merged span
            for (let i = candidates.length - 1; i >= 0; i--) {
              if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
                candidates.splice(i, 1)
              }
            }
            candidates.push(candidate)
          }
        }
      } else {
        // ── Original JSX sibling merging (text + expressions, no elements) ──
        // Build the interpolated text from the run
        const usedNames: UsedNames = new Map()
        const interpolations: Array<{ name: string, expression: string }> = []
        let text = ''
        let valid = true

        for (const child of run) {
          if (child.type === 'JSXText') {
            text += jsxTextValue(content.slice(child.span.start, child.span.end))
          } else if (child.expression?.type === 'StringLiteral') {
            text += child.expression.value
          } else {
            const info = resolveExpressionName(child.expression, content, usedNames)
            if (!info) { valid = false; break }
            text += `{{${info.name}}}`
            if (!info.reused) interpolations.push(info)
          }
        }

        if (!valid) continue

        const trimmed = text.trim()
        const literalPiece = run.some(c => c.expression?.type === 'StringLiteral')
        if (!trimmed || (interpolations.length === 0 && !literalPiece) || !hasWordsBesidePlaceholders(trimmed)) continue

        const [spanStart, spanEnd] = runSpan(run, content)

        const candidate = detectCandidate(trimmed, spanStart, spanEnd, file, content, config)
        if (candidate) {
          candidate.type = 'jsx-text'
          candidate.content = trimmed
          if (interpolations.length) candidate.interpolations = interpolations
          // Mixed text + expressions in JSX is almost always user-facing
          candidate.confidence = Math.min(1, candidate.confidence + 0.2)

          if (candidate.confidence >= 0.7) {
            // Remove individual candidates that overlap with the merged span
            for (let i = candidates.length - 1; i >= 0; i--) {
              if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
                candidates.splice(i, 1)
              }
            }
            candidates.push(candidate)
          }
        }
      }
    }
  }

  // Recurse into children
  forEachChild(node, parts, child => detectJSXInterpolation(child, content, file, config, candidates))
}

/** A run without the whitespace-only text, `{' '}` pieces and empty elements (`<hr />`, `<br />`) at its two ends. */
function trimRun (run: any[]): any[] {
  const blank = (c: any) => (c.type === 'JSXText' && !c.value?.trim()) ||
    (c.type === 'JSXExpressionContainer' && c.expression?.type === 'StringLiteral' && !c.expression.value.trim()) ||
    (c.type === 'JSXElement' && !c.children?.length)
  let start = 0
  let end = run.length
  while (start < end && blank(run[start])) start++
  while (end > start && blank(run[end - 1])) end--
  return run.slice(start, end)
}

/** Where a run's rewrite starts and ends: inside the whitespace of its first and last text. */
function runSpan (run: any[], content: string): [number, number] {
  const first = run[0]
  const last = run[run.length - 1]
  let start = first.span.start
  let end = last.span.end
  if (first.type === 'JSXText') {
    const raw = content.slice(first.span.start, first.span.end)
    start += raw.length - raw.trimStart().length
  }
  if (last.type === 'JSXText') {
    const raw = content.slice(last.span.start, last.span.end)
    end -= raw.length - raw.trimEnd().length
  }
  return [start, end]
}

/**
 * Returns true when the expression is a simple Identifier or non-computed
 * MemberExpression (i.e. dot notation like `profile.name`).
 */
function isSimpleJSXExpression (expr: any): boolean {
  if (!expr) return false
  if (expr.type === 'Identifier') return true
  if (expr.type === 'MemberExpression' && !expr.computed && expr.property?.type === 'Identifier') return true
  // A string or number made from one, inside a sentence as a placeholder (`up to {n.toLocaleString()} segments`,
  // `{Math.round(score * 100)}%`, `+ {total - shown} more`); any other call may return elements
  if (expr.type === 'ParenthesisExpression') return isSimpleJSXExpression(expr.expression)
  if (expr.type === 'NumericLiteral') return true
  if (expr.type === 'BinaryExpression' && ARITHMETIC_OPERATORS.has(expr.operator)) {
    return isSimpleJSXExpression(expr.left) && isSimpleJSXExpression(expr.right)
  }
  // a choice between such values (`{young ? 3 : 2}`); a choice between strings is text of its own, which a
  // placeholder would leave untranslated
  if (expr.type === 'ConditionalExpression') {
    return [expr.consequent, expr.alternate].every(b => b?.type !== 'StringLiteral' && b?.type !== 'TemplateLiteral' && isSimpleJSXExpression(b))
  }
  // `format.date(x)`, `formatPrice(x)`: a formatter returns a string
  if (expr.type === 'CallExpression' && expr.callee?.type === 'Identifier') return /^format[A-Z]/.test(expr.callee.value)
  if (expr.type === 'CallExpression' && expr.callee?.type === 'MemberExpression' && expr.callee.property?.type === 'Identifier') {
    const object = expr.callee.object
    const method = expr.callee.property.value
    return STRING_METHODS.has(method) || /^format/.test(method) ||
      (object?.type === 'Identifier' && (object.value === 'Math' || object.value === 'Number' || /^(?:format|formatter|fmt|intl)$/i.test(object.value)))
  }
  return false
}

const ARITHMETIC_OPERATORS = new Set(['-', '*', '/', '%'])

/**
 * Methods that return a string whatever they are called on (`list.map(…).join(', ')`), so their call in JSX
 * text is a placeholder like a variable; not `slice`, which keeps an array of elements.
 */
const STRING_METHODS = new Set([
  'join', 'toString', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toFixed', 'toPrecision',
  'trim', 'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'substring', 'replace', 'replaceAll'
])

/**
 * Returns true when a JSXElement is "simple" enough to be included in a
 * `<Trans>` JSX sibling run.  Accepts:
 * - Self-closing HTML elements (`<br />`, `<img />`)
 * - HTML elements whose only children are `JSXText` nodes
 * - Components whose only children are text, a link in a sentence
 *   (`Leave your <DialogLink to='/'>projects</DialogLink> first.`); a component
 *   without text (`<Icon />`) breaks the run
 */
function isSimpleJSXElement (node: any): boolean {
  if (node.type !== 'JSXElement' || isIconElement(node)) return false
  const namePart = node.opening?.name
  if (!namePart) return false
  const children = node.children || []
  const textOnly = children.every((c: any) => c.type === 'JSXText')
  if (namePart.type === 'JSXMemberExpression') {
    const name = `${namePart.object?.value ?? ''}.${namePart.property?.value ?? ''}`
    return INLINE_COMPONENT_RE.test(name) && children.length > 0 && textOnly
  }
  if (namePart.type !== 'Identifier') return false
  const tagName: string = namePart.value
  if (tagName[0] !== tagName[0].toLowerCase()) return INLINE_COMPONENT_RE.test(tagName) && children.some((c: any) => c.value?.trim()) && textOnly
  // Self-closing elements are simple
  if (node.opening?.selfClosing) return true
  // Elements with only text children (or empty) are simple
  return children.length === 0 || textOnly
}

/**
 * Components that stand inside a sentence: links and text styles (`DialogLink`, `Text.Strong`). A button or a
 * card next to a text is a piece of its own, not part of the sentence.
 */
const INLINE_COMPONENT_RE = /Link$|^Text\b|Text$|^(?:Strong|Em|B|I|Code|Mark|Highlight)$/

/**
 * Returns the text content of a simple JSXElement's children.
 */
function getJSXElementTextContent (node: any, content: string): string {
  const children = node.children || []
  return children
    .filter((c: any) => c.type === 'JSXText')
    .map((c: any) => content.slice(c.span.start, c.span.end))
    .join('')
}

/**
 * Returns true when a JSXElement is a `<Trans>` component
 * (already instrumented content).
 */
function isTransComponent (node: any, transComponents: readonly string[] = []): boolean {
  const opening = node.opening
  if (!opening) return false
  const name = opening.name
  // react-i18next's own: Trans, IcuTrans and their WithoutContext variants for Server Components
  if (name?.type === 'Identifier') return TRANS_RE.test(name.value) || transComponents.includes(name.value)
  if (name?.type === 'JSXMemberExpression' && name.property?.type === 'Identifier') {
    const object = name.object?.type === 'Identifier' ? name.object.value : ''
    return TRANS_RE.test(name.property.value) || transComponents.includes(`${object}.${name.property.value}`)
  }
  return false
}

const TRANS_RE = /^(?:Icu)?Trans(?:WithoutContext)?$/

/**
 * An icon: an element whose name ends in `Icon`, or one with a Material icon class. Its text is a ligature
 * (`<Icon>delete</Icon>`, `<span className='material-icons'>search</span>`) that a translation would break.
 */
function isIconElement (node: any): boolean {
  const name = node.opening?.name
  const tag = name?.type === 'Identifier' ? name.value : name?.type === 'JSXMemberExpression' ? name.property?.value : ''
  if (/Icon$/.test(tag ?? '')) return true
  return (node.opening?.attributes ?? []).some((a: any) =>
    a.name?.value === 'className' && a.value?.type === 'StringLiteral' && /\bmaterial-(?:icons|symbols)/.test(a.value.value))
}

// ─── Plural conditional pattern detection ────────────────────────────────────

/**
 * Extracts the text value from a string literal or static template literal node.
 * Returns `null` for anything else.
 */
function extractStaticText (node: any): string | null {
  if (!node) return null
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis
    if (quasis?.length === 1 && (!node.expressions || node.expressions.length === 0)) {
      return quasis[0].cooked ?? quasis[0].raw ?? null
    }
  }
  return null
}

/**
 * Extracts text from a node that may contain the count variable as an
 * interpolation (e.g. `${activeTasks} tasks left`).  The count variable
 * is replaced with `{{count}}` in the returned text.
 * Returns `null` when the node isn't a recognised textual form.
 */
function extractTextWithCount (node: any, countIdentifier: string, content: string): string | null {
  // Static text (no variable at all — still valid for zero/one forms)
  const staticText = extractStaticText(node)
  if (staticText !== null) return staticText

  // Template literal with interpolation
  if (node?.type === 'TemplateLiteral') {
    const quasis = node.quasis ?? []
    const expressions = node.expressions ?? []
    if (quasis.length === 0 || expressions.length === 0) return null

    let text = ''
    for (let i = 0; i < quasis.length; i++) {
      text += quasis[i].cooked ?? quasis[i].raw ?? ''
      if (i < expressions.length) {
        const expr = expressions[i]
        const exprText = content.slice(expr.span.start, expr.span.end)
        if (exprText === countIdentifier) {
          text += '{{count}}'
        } else {
          // Unknown expression — bail
          return null
        }
      }
    }
    return text
  }

  return null
}

/**
 * Resolves the count variable name from a `BinaryExpression` test of the form
 * `identifier === <number>`.  Returns `{ identifier, number }` or `null`.
 */
function parseCountTest (test: any, content: string): { identifier: string, value: number } | null {
  if (test?.type !== 'BinaryExpression') return null
  if (test.operator !== '===' && test.operator !== '==') return null

  let identSide: any
  let numSide: any

  if (test.left?.type === 'NumericLiteral') {
    numSide = test.left
    identSide = test.right
  } else if (test.right?.type === 'NumericLiteral') {
    numSide = test.right
    identSide = test.left
  } else {
    return null
  }

  if (!identSide?.span) return null
  const identifier = content.slice(identSide.span.start, identSide.span.end)

  return { identifier, value: numSide.value }
}

/**
 * Walks the AST looking for conditional (ternary) expression chains that
 * correspond to a count-based pluralisation pattern, e.g.
 *
 * ```
 * tasks === 0
 *   ? 'No tasks'
 *   : tasks === 1
 *     ? 'One task'
 *     : `${tasks} tasks`
 * ```
 *
 * When such a pattern is detected a single `CandidateString` is emitted with
 * `pluralForms` populated and any individual candidates that overlap with the
 * ternary's span are removed.
 */
function detectPluralPatterns (
  node: any,
  content: string,
  file: string,
  config: I18nextToolkitConfig,
  candidates: CandidateString[]
): void {
  if (!node) return

  const parts = nonTextParts(node, file, config, false)
  if (parts === 'all') return

  if (node.type === 'ConditionalExpression' || node.type === 'CallExpression') {
    const plural = parsePluralExpression(node, content)
    if (plural) {
      // Use the "other" form as the candidate content (with {{count}})
      const spanStart = node.span.start
      const spanEnd = node.span.end

      // Skip if this ternary is already covered by a wider candidate
      // (e.g. a JSX sibling run that merged surrounding text with this plural)
      const alreadyHandled = candidates.some(c =>
        c.pluralForms && c.offset <= spanStart && c.endOffset >= spanEnd
      )
      if (alreadyHandled) return

      const candidate = detectCandidate(
        plural.other,
        spanStart,
        spanEnd,
        file,
        content,
        config
      )
      if (candidate) {
        candidate.type = 'string-literal'
        candidate.content = plural.other
        candidate.pluralForms = {
          countExpression: plural.countExpression,
          zero: plural.zero,
          one: plural.one,
          other: plural.other
        }
        if (plural.interpolations) candidate.interpolations = plural.interpolations
        candidate.pluralHelper = pluralHelperOf(node)
        // Plural patterns are always user-facing text — boost confidence
        candidate.confidence = Math.min(1, candidate.confidence + 0.3)

        if (candidate.confidence >= 0.7) {
          // Remove individual candidates that overlap with the ternary span
          for (let i = candidates.length - 1; i >= 0; i--) {
            if (candidates[i].offset >= spanStart && candidates[i].endOffset <= spanEnd) {
              candidates.splice(i, 1)
            }
          }
          candidates.push(candidate)
          // Don't recurse into children — we already consumed the whole ternary
          return
        }
      }
    }
  }

  // Recurse into children
  forEachChild(node, parts, child => detectPluralPatterns(child, content, file, config, candidates))
}

/** A plural helper call or a `count === 1` ternary as its plural forms, or null. */
function parsePluralExpression (
  expr: any,
  content: string
): { countExpression: string, zero?: string, one?: string, other: string, interpolations?: Array<{ name: string, expression: string }> } | null {
  if (expr?.type === 'ConditionalExpression') return tryParsePluralTernary(expr, content)
  if (expr?.type === 'CallExpression') return tryParsePluralCall(expr, content)
  return null
}

/** Names of plural helpers whose call reads `(count, one, other)`. */
const PLURAL_HELPER_RE = /^(?:plural|pluralize|pluralise)$/i

/**
 * Attempts to parse a plural helper call into a plural pattern:
 *   plural(count, '# file', '# files')   →  one: '{{count}} file', other: '{{count}} files'
 *   pluralize(n, 'item', `${n} items`)   →  one: 'item', other: '{{count}} items'
 * `#` in a form stands for the number, as in ICU. Only a call whose two forms are text (a string, or a
 * template literal whose only expression is the count) and whose count is not a string.
 */
function tryParsePluralCall (
  node: any,
  content: string
): { countExpression: string, zero?: string, one: string, other: string, interpolations?: Array<{ name: string, expression: string }> } | null {
  const callee = node.callee
  const name = callee?.type === 'Identifier'
    ? callee.value
    : callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier' ? callee.property.value : null
  if (!name || !PLURAL_HELPER_RE.test(name)) return null

  const [count, one, other] = (node.arguments ?? []).map((a: any) => a?.spread ? null : a?.expression)
  if (!count?.span || !one || !other || count.type === 'StringLiteral' || count.type === 'TemplateLiteral') return null

  const countExpression = content.slice(count.span.start, count.span.end)
  // A form's other expressions become placeholders, named once for both forms (`showing ${shown} of # user`)
  const usedNames: UsedNames = new Map()
  const interpolations: Array<{ name: string, expression: string }> = []
  const formText = (form: any): string | null => {
    const text = extractStaticText(form)
    if (text !== null) return text
    if (form?.type !== 'TemplateLiteral') return null
    let result = ''
    for (let i = 0; i < form.quasis.length; i++) {
      result += form.quasis[i].cooked ?? form.quasis[i].raw ?? ''
      const expr = form.expressions?.[i]
      if (!expr) continue
      if (content.slice(expr.span.start, expr.span.end) === countExpression) {
        result += '{{count}}'
        continue
      }
      const info = resolveExpressionName(expr, content, usedNames)
      if (!info) return null
      result += `{{${info.name}}}`
      if (!info.reused) interpolations.push(info)
    }
    return result
  }
  const oneText = formText(one)
  const otherText = formText(other)
  if (oneText === null || otherText === null) return null

  return {
    countExpression,
    one: oneText.replace(/#/g, '{{count}}'),
    other: otherText.replace(/#/g, '{{count}}'),
    ...(interpolations.length ? { interpolations } : {})
  }
}

/**
 * Parses the shape of a `ConditionalExpression` tree into a plural pattern (see `tryParsePluralTernary`).
 *
 * Supported shapes:
 *   count === 0 ? zeroText : count === 1 ? oneText : otherText   (3-way)
 *   count === 1 ? oneText  : otherText                           (2-way)
 *
 * Returns `null` when the node doesn't match any recognised plural shape.
 */
function parsePluralTernaryShape (
  node: any,
  content: string
): { countExpression: string, zero?: string, one?: string, other: string } | null {
  if (node?.type !== 'ConditionalExpression') return null

  const outerTest = parseCountTest(node.test, content)
  if (!outerTest) return null

  const countExpr = outerTest.identifier

  // ──── 3-way:  count === 0 ? zero : count === 1 ? one : other ──────────
  if (outerTest.value === 0) {
    const zeroText = extractTextWithCount(node.consequent, countExpr, content)
    if (zeroText === null) return null

    const alt = node.alternate
    if (alt?.type === 'ConditionalExpression') {
      const innerTest = parseCountTest(alt.test, content)
      if (!innerTest || innerTest.identifier !== countExpr || innerTest.value !== 1) return null

      const oneText = extractTextWithCount(alt.consequent, countExpr, content)
      const otherText = extractTextWithCount(alt.alternate, countExpr, content)
      if (oneText === null || otherText === null) return null

      return { countExpression: countExpr, zero: zeroText, one: oneText, other: otherText }
    }

    // 2-way zero/other:  count === 0 ? zero : other
    const otherText = extractTextWithCount(node.alternate, countExpr, content)
    if (otherText === null) return null
    return { countExpression: countExpr, zero: zeroText, other: otherText }
  }

  // ──── 2-way:  count === 1 ? one : other ───────────────────────────────
  if (outerTest.value === 1) {
    const oneText = extractTextWithCount(node.consequent, countExpr, content)
    const otherText = extractTextWithCount(node.alternate, countExpr, content)
    if (oneText === null || otherText === null) return null

    return { countExpression: countExpr, one: oneText, other: otherText }
  }

  return null
}

/**
 * A ternary on `count === 1` is a plural only when its branches are text: `score === 1 ? 'var(--ok)' :
 * 'var(--warn)'` and `score === 1 ? 'item-full' : 'item-low'` pick a style.
 */
function tryParsePluralTernary (
  node: any,
  content: string
): { countExpression: string, zero?: string, one?: string, other: string } | null {
  const plural = parsePluralTernaryShape(node, content)
  if (!plural) return null
  // Fragments merged with the text around them (`''`, `'s'`, `${n}`) are fine; a technical form is not
  const forms = [plural.zero, plural.one, plural.other].filter((f): f is string => f !== undefined)
  const technical = forms.some(f => f.trim().length > 1 && detectsAsTechnical(f))
  return !technical && forms.some(f => /\p{L}/u.test(f.replace(/\{\{[^}]*\}\}/g, ''))) ? plural : null
}

/** A form that the string detector skips as technical (a CSS value, a class name); a single word is text here. */
function detectsAsTechnical (text: string): boolean {
  return detectCandidate(text, 0, text.length, 'plural.js', text, { locales: [], extract: { input: [], output: '' } }, undefined, true) === null
}

// ─── Language-change detection ───────────────────────────────────────────────

/**
 * Property names that indicate a "language" value in an object literal.
 * When a function call passes an object with one of these keys, we treat
 * the call as a language-change site.
 */
const LANGUAGE_PROP_NAMES = new Set(['language', 'lang', 'locale', 'lng'])

/**
 * Function-name patterns that indicate a direct language setter.
 * Matched against the full function name (case-insensitive).
 *
 * Examples: `setLanguage(code)`, `setLocale(lng)`, `changeLanguage(x)`
 */
const LANGUAGE_SETTER_RE = /^(?:set|change|update|select)(?:Language|Lang|Locale|Lng)$/i

/**
 * A variable or a property (`code`, `lang.code`, `e.target.value`): the injected `changeLanguage()` repeats
 * the expression, which must then give the same value without doing anything (`getDefault(…)` would run twice).
 */
function isPlainValue (expr: any): boolean {
  if (expr?.type === 'Identifier') return true
  return expr?.type === 'MemberExpression' && expr.property?.type === 'Identifier' && isPlainValue(expr.object)
}

/** Nodes whose statements are a list, where one more statement can go before another. */
const STATEMENT_LISTS = new Set(['FunctionBody', 'BlockStatement', 'Module', 'Script', 'SwitchCase'])

/**
 * Callees whose object argument holds the user's settings, so a language property there is the app's
 * language (`updateSettings({ language })`, `saveProfile({ locale })`, `setState({ locale })`). Elsewhere a
 * `language`/`lng` property is data (`fetchTranslations({ lng })`, `list.push({ lng })`), and hooks
 * (`useState({ lng: [] })`) never are.
 */
const SETTINGS_CALLEE_RE = /settings|preferences|prefs|profile|user|account|state|locale|language/i

/**
 * Walks the AST looking for call expressions that appear to change the
 * application language.  Detected sites will later be augmented with an
 * `i18n.changeLanguage()` call by the transformer.
 *
 * Recognised patterns:
 *
 * 1. Object-property setters:
 *    `updateSettings({ language: lang.code })`
 *    `setState({ locale: selectedLng })`
 *
 * 2. Direct setters:
 *    `setLanguage(code)`
 *    `setLocale(lng)`
 *    `changeLanguage(selectedLng)`
 *
 * Only a call that is a statement of its own in a block or an arrow function's expression body: the
 * injected call goes before it, which would change any other place (`const x = setLocale(l)`,
 * `return save({ locale })`, `if (ok) setLocale(l)`).
 */
function detectLanguageChangeSites (
  node: any,
  content: string,
  sites: LanguageChangeSite[],
  parent?: any,
  grandparent?: any
): void {
  if (!node) return

  const standsAlone = (parent?.type === 'ExpressionStatement' && parent.expression === node &&
      STATEMENT_LISTS.has(grandparent?.type)) ||
    (parent?.type === 'ArrowFunctionExpression' && parent.body === node)
  if (node.type === 'CallExpression' && node.span && standsAlone) {
    const detected = tryParseLanguageChangeCall(node, content)
    if (detected) {
      // Check if changeLanguage() already exists nearby (e.g. same arrow body)
      const lookbackStart = Math.max(0, detected.callStart - 200)
      const nearbyBefore = content.slice(lookbackStart, detected.callStart)
      if (nearbyBefore.includes('changeLanguage')) {
        // Already instrumented — skip this site
      } else {
        // Compute 1-based line and 0-based column from offset
        let line = 1
        let lastNewline = -1
        for (let i = 0; i < detected.callStart && i < content.length; i++) {
          if (content[i] === '\n') {
            line++
            lastNewline = i
          }
        }
        sites.push({
          ...detected,
          line,
          column: detected.callStart - lastNewline - 1
        })
      }
      // Don't return — keep recursing for nested calls
    }
  }

  // Recurse into children
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => detectLanguageChangeSites(item, content, sites, node, parent))
      } else {
        detectLanguageChangeSites(value, content, sites, node, parent)
      }
    }
  }
}

/**
 * The imports of the plural helpers `names` (`import { plural, number } from './format'`), each with the
 * number of other identifiers naming it in the file and the text that removes its import.
 */
function findPluralHelperImports (ast: any, content: string, names: Set<string>): PluralHelperImport[] {
  const found: PluralHelperImport[] = []
  for (const decl of ast.body ?? []) {
    if (decl.type !== 'ImportDeclaration') continue
    const specifiers = decl.specifiers ?? []
    // `import fmt, { plural } from …` mixes a default with the braces: removing one of them takes more than a
    // specifier and a comma, so such an import stays
    const named = specifiers.every((spec: any) => spec.type === 'ImportSpecifier')
    specifiers.forEach((spec: any, i: number) => {
      const name = spec.local?.value
      if (!names.has(name) || (!named && specifiers.length > 1)) return
      let [removeStart, removeEnd] = specifiers.length === 1
        ? [decl.span.start, decl.span.end]
        : i < specifiers.length - 1
          ? [spec.span.start, specifiers[i + 1].span.start]
          : [specifiers[i - 1].span.end, spec.span.end]
      if (specifiers.length === 1) removeEnd += /^\r?\n/.exec(content.slice(removeEnd))?.[0].length ?? 0
      found.push({ name, references: 0, removeStart, removeEnd })
    })
  }
  const count = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'ImportDeclaration') return
    if (node.type === 'Identifier') {
      const helper = found.find(h => h.name === node.value)
      if (helper) helper.references++
    }
    for (const key in node) {
      const value = node[key]
      if (Array.isArray(value)) value.forEach(count)
      else if (value && typeof value === 'object') count(value)
    }
  }
  count(ast)
  return found
}

/** The `useMemo`/`useCallback` calls with a callback and a dependency array (see `MemoHookSpan`). */
function collectMemoHooks (node: any, hooks: MemoHookSpan[]): void {
  if (!node || typeof node !== 'object') return
  if (node.type === 'CallExpression' && ['useMemo', 'useCallback'].includes(getCalleeName(node.callee) ?? '')) {
    const [callback, deps] = (node.arguments ?? []).map((a: any) => a?.expression)
    if (callback?.span && deps?.type === 'ArrayExpression' && deps.span) {
      const elements = (deps.elements ?? []).filter(Boolean).map((e: any) => e.expression)
      hooks.push({
        callbackStart: callback.span.start,
        callbackEnd: callback.span.end,
        insertAt: elements.length ? elements[elements.length - 1].span.end : deps.span.start + 1,
        hasDeps: elements.length > 0,
        hasT: elements.some((e: any) => e.type === 'Identifier' && e.value === 't')
      })
    }
  }
  for (const key in node) {
    const value = node[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) value.forEach(item => collectMemoHooks(item, hooks))
      else collectMemoHooks(value, hooks)
    }
  }
}

/**
 * Inspects a single CallExpression node to determine if it is a language-change
 * call.  Returns the detected site data (without line/column) or `null`.
 */
function tryParseLanguageChangeCall (
  node: any,
  content: string
): { languageExpression: string, callStart: number, callEnd: number } | null {
  if (node.type !== 'CallExpression') return null
  if (!node.arguments?.length) return null

  const calleeName = getCalleeName(node.callee)

  // Skip calls that are already i18next API calls (e.g. i18n.changeLanguage())
  if (node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier') {
    const objName = node.callee.object.value
    if (objName === 'i18n' || objName === 'i18next') return null
  }

  // ── Pattern 1: direct setter, setLanguage(expr), changeLocale(expr) etc. ──
  if (calleeName && LANGUAGE_SETTER_RE.test(calleeName)) {
    const firstArg = node.arguments[0]?.expression
    if (firstArg?.span && isPlainValue(firstArg)) {
      const langExpr = content.slice(firstArg.span.start, firstArg.span.end)
      // Skip if the argument is already an i18next.changeLanguage call
      if (langExpr.includes('changeLanguage')) return null
      return {
        languageExpression: langExpr,
        callStart: node.span.start,
        callEnd: node.span.end
      }
    }
  }

  // ── Pattern 2: object with language property, updateSettings({ language: expr }) ──
  if (!calleeName || /^use[A-Z]/.test(calleeName) || !SETTINGS_CALLEE_RE.test(calleeName)) return null
  for (const arg of node.arguments) {
    const expr = arg.expression ?? arg
    if (expr?.type !== 'ObjectExpression') continue
    if (!Array.isArray(expr.properties)) continue

    for (const prop of expr.properties) {
      if (prop.type !== 'KeyValueProperty') continue
      const keyName = (prop.key?.type === 'Identifier' && prop.key.value) ||
                      (prop.key?.type === 'StringLiteral' && prop.key.value)
      if (typeof keyName !== 'string') continue
      if (!LANGUAGE_PROP_NAMES.has(keyName.toLowerCase())) continue

      // Found a language property — extract the value expression
      const valNode = prop.value
      if (valNode?.span) {
        const langExpr = content.slice(valNode.span.start, valNode.span.end)
        // Skip if value is a static string (e.g. `{ language: 'en' }` in a config), or not a plain value
        if (valNode.type === 'StringLiteral' || !isPlainValue(valNode)) continue
        // Skip if already contains changeLanguage
        if (langExpr.includes('changeLanguage')) continue
        return {
          languageExpression: langExpr,
          callStart: node.span.start,
          callEnd: node.span.end
        }
      }
    }
  }

  return null
}

/**
 * Extracts a simple function name from a CallExpression callee.
 * Handles `Identifier` (e.g. `setLanguage`) and `MemberExpression`
 * (extracts the final property, e.g. `settings.setLanguage` → `setLanguage`).
 */
function getCalleeName (callee: any): string | null {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.value
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
    return callee.property.value
  }
  return null
}

/**
 * Gets the list of source files to instrument.
 */
async function getSourceFilesForInstrumentation (config: I18nextToolkitConfig): Promise<string[]> {
  // Stories, mocks and fixtures hold sample data, not the app's texts
  const defaultIgnore = [
    'node_modules/**', 'dist/**', 'build/**', '.next/**',
    '**/*.{stories,story,storybook}.*', '**/__mocks__/**', '**/__fixtures__/**', '**/__tests__/**'
  ]

  const userIgnore = Array.isArray(config.extract.ignore)
    ? config.extract.ignore
    : config.extract.ignore ? [config.extract.ignore] : []

  return await glob(config.extract.input, {
    ignore: [...defaultIgnore, ...userIgnore],
    cwd: process.cwd(),
    // A directory named e.g. `abc.tsx` matches the input globs
    nodir: true
  })
}

/**
 * Checks if the project uses React.
 */
export async function isProjectUsingReact (): Promise<boolean> {
  const deps = await readProjectDeps()
  return !!deps.react || !!deps['react-i18next']
}

// ── Project environment detection ───────────────────────────────────────

export type ProjectEnvironment = 'browser' | 'node-server' | 'edge' | 'unknown'

/** Well-known frontend framework packages (presence → browser environment). */
const FRONTEND_FRAMEWORKS = [
  'react', 'react-i18next', 'vue', 'vue-i18next',
  '@angular/core', 'angular-i18next',
  'svelte', 'svelte-i18next',
  'preact', 'solid-js', 'jquery', 'lit', 'ember-source', 'stimulus',
  'next', 'nuxt', 'gatsby', '@remix-run/react', 'astro'
]

/** Well-known bundlers whose presence implies a browser build target. */
const BUNDLERS = [
  'webpack', 'vite', '@vitejs/plugin-react', 'rollup', 'parcel',
  'esbuild', 'turbopack', 'snowpack'
]

/** Edge/serverless markers (no filesystem access). */
const EDGE_MARKERS = [
  '@cloudflare/workers-types', 'wrangler', '@cloudflare/next-on-pages',
  '@vercel/edge', '@netlify/edge-functions', '@deno/kv'
]

/** Well-known Node.js server frameworks. */
const SERVER_FRAMEWORKS = [
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi',
  '@nestjs/core', 'restify', 'micro', 'polka', 'h3'
]

/**
 * Analyses `package.json` dependencies (and a few project-root files) to
 * classify the project's runtime environment.
 *
 * Priority order:
 *   1. Edge / serverless markers  → `'edge'`   (no filesystem)
 *   2. Frontend framework or bundler → `'browser'`
 *   3. Node.js server framework   → `'node-server'`
 *   4. Fallback                   → `'unknown'`
 */
export async function detectProjectEnvironment (): Promise<ProjectEnvironment> {
  try {
    const allDeps = await readProjectDeps()
    const has = (list: string[]) => list.some(dep => !!allDeps[dep])

    // 1. Edge / serverless (check first — these projects may also list a
    //    bundler or even a framework, but they have no filesystem)
    if (has(EDGE_MARKERS)) return 'edge'
    // Also check for wrangler.toml / wrangler.json
    const cwd = process.cwd()
    if (await fileExists(join(cwd, 'wrangler.toml')) || await fileExists(join(cwd, 'wrangler.json'))) {
      return 'edge'
    }

    // 2. Browser / frontend
    if (has(FRONTEND_FRAMEWORKS) || has(BUNDLERS)) return 'browser'

    // 3. Node.js server
    if (has(SERVER_FRAMEWORKS)) return 'node-server'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Checks if the project uses TypeScript (looks for tsconfig.json).
 */
export async function isProjectUsingTypeScript (): Promise<boolean> {
  try {
    await access(process.cwd() + '/tsconfig.json')
    return true
  } catch {
    return false
  }
}

/**
 * Checks if a file exists.
 */
async function fileExists (filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Common i18n init file names to check for.
 */
const I18N_INIT_FILE_NAMES = [
  'i18n.ts', 'i18n.js', 'i18n.mjs', 'i18n.mts',
  'i18next.ts', 'i18next.js', 'i18next.mjs', 'i18next.mts',
  'i18n/index.ts', 'i18n/index.js', 'i18n/index.mjs',
  'i18next/index.ts', 'i18next/index.js'
]

/**
 * Searches the common locations (`src/` and the project root) for an existing
 * i18n initialization file.
 *
 * @returns The path of the first init file found (relative to cwd, native
 *          platform separators), or null.
 */
export async function findExistingI18nInitFile (): Promise<string | null> {
  const cwd = process.cwd()
  const searchDirs = ['src', '.']
  for (const dir of searchDirs) {
    for (const name of I18N_INIT_FILE_NAMES) {
      if (await fileExists(join(cwd, dir, name))) {
        return join(dir, name)
      }
    }
  }
  return null
}

/**
 * Computes a POSIX-style relative path from the init-file directory to the
 * output template path (which still contains {{language}} / {{namespace}} placeholders).
 */
function buildDynamicImportPath (outputTemplate: string, initDir: string): string {
  const cwd = process.cwd()
  const absTemplate = isAbsolute(outputTemplate) ? outputTemplate : resolve(cwd, outputTemplate)
  let rel = relative(initDir, absTemplate)
  if (!rel.startsWith('.')) {
    rel = './' + rel
  }
  return rel.replace(/\\/g, '/')
}

/**
 * Ensures that an i18n initialization file exists in the project.
 * If no existing init file is found, generates a sensible default.
 *
 * The generated file's backend strategy depends on the project context:
 * - React app without i18next.t() → `i18next-resources-to-backend` (async dynamic imports)
 * - React app with i18next.t()    → bundled resources (static imports, synchronous)
 * - Server-side (no React)        → `i18next-fs-backend` (filesystem, initAsync: false + preload)
 */
async function ensureI18nInitFile (
  hasReact: boolean,
  hasTypeScript: boolean,
  config: I18nextToolkitConfig,
  logger: Logger,
  usesI18nextT: boolean
): Promise<string | null> {
  const cwd = process.cwd()

  // Check for existing init files in common locations (an init elsewhere imports i18next, see runInstrumenter)
  if (await findExistingI18nInitFile()) {
    return null // Init file already exists
  }

  // Determine output location — prefer src/ if it exists
  const srcExists = await fileExists(join(cwd, 'src'))
  const initDir = srcExists ? join(cwd, 'src') : cwd
  const initFileExt = hasTypeScript ? '.ts' : '.js'
  const initFilePath = join(initDir, 'i18n' + initFileExt)

  const environment = await detectProjectEnvironment()
  const strategy = determineBackendStrategy(environment, usesI18nextT)
  const outputTemplate = typeof config.extract.output === 'string' ? config.extract.output : null

  const initContent = buildInitFileContent({
    strategy,
    hasReact,
    hasTypeScript,
    config,
    initDir,
    outputTemplate
  })

  try {
    await mkdir(initDir, { recursive: true })
    await writeFile(initFilePath, initContent)
    logger.info(`Generated i18n init file: ${initFilePath}`)
    return initFilePath
  } catch (err) {
    logger.warn(`Failed to generate i18n init file: ${err}`)
    return null
  }
}

// ── Backend strategy helpers ─────────────────────────────────────────────

type BackendStrategy = 'resources-to-backend' | 'bundled-resources' | 'fs-backend'

/**
 * Determines which backend strategy to use for the i18n init file.
 *
 * Decision logic:
 *   1. Node.js server with filesystem → `fs-backend`
 *      (synchronous with `initAsync: false` + `preload`)
 *   2. Browser / edge / unknown with `i18next.t()` outside React components →
 *      `bundled-resources` (static imports so resources are available synchronously)
 *   3. Otherwise → `resources-to-backend` (async dynamic imports, lazy-loaded)
 */
function determineBackendStrategy (environment: ProjectEnvironment, usesI18nextT: boolean): BackendStrategy {
  if (environment === 'node-server') return 'fs-backend'
  if (usesI18nextT) return 'bundled-resources'
  return 'resources-to-backend'
}

/**
 * Builds the full i18n init file content from composable parts,
 * avoiding repetition across different strategies.
 */
function buildInitFileContent (opts: {
  strategy: BackendStrategy
  hasReact: boolean
  hasTypeScript: boolean
  config: I18nextToolkitConfig
  initDir: string
  outputTemplate: string | null
}): string {
  const { strategy, hasReact, hasTypeScript, config, initDir, outputTemplate } = opts
  const primaryLang = config.extract.primaryLanguage ?? config.locales[0] ?? 'en'
  const defaultNS = config.extract.defaultNS !== false ? (config.extract.defaultNS || 'translation') : null
  const ns = defaultNS || 'translation'

  // ── Dependencies for the install hint ──
  // ICU / MF2 values only render with their i18nFormat plugin (intl-messageformat is i18next-icu's peer)
  const formatPlugin = config.extract.messageFormat === 'icu'
    ? { name: 'ICU', pkg: 'i18next-icu', deps: ['i18next-icu', 'intl-messageformat'] }
    : config.extract.messageFormat === 'mf2'
      ? { name: 'MF2', pkg: 'i18next-mf2', deps: ['i18next-mf2'] }
      : undefined
  const deps: string[] = ['i18next']
  if (hasReact) deps.push('react-i18next')
  if (formatPlugin) deps.push(...formatPlugin.deps)
  if (strategy === 'resources-to-backend' && outputTemplate) deps.push('i18next-resources-to-backend')
  if (strategy === 'fs-backend' && outputTemplate) deps.push('i18next-fs-backend')

  const lines: string[] = []

  // ── Header comment ──
  lines.push(
    "// Generated by i18next-cli — review and adapt to your project's needs.",
    `// You may need to install dependencies: npm install ${deps.join(' ')}`,
    '//',
    '// Other translation loading approaches:',
    '//   • Static imports or bundled JSON: https://www.i18next.com/how-to/add-or-load-translations',
    '//   • Lazy-load from a server: https://github.com/i18next/i18next-http-backend',
    '//   • Manage translations with your team via Locize: https://www.locize.com',
    '//     (see i18next-locize-backend: https://github.com/locize/i18next-locize-backend)'
  )

  // ── Import declarations ──
  lines.push("import i18next from 'i18next'")
  if (hasReact) lines.push("import { initReactI18next } from 'react-i18next'")
  if (formatPlugin) lines.push(`import ${formatPlugin.name} from '${formatPlugin.pkg}'`)

  if (outputTemplate) {
    switch (strategy) {
      case 'resources-to-backend':
        lines.push("import resourcesToBackend from 'i18next-resources-to-backend'")
        break
      case 'bundled-resources':
        for (const locale of config.locales) {
          const importPath = buildResourceImportPath(outputTemplate, initDir, locale, ns)
          lines.push(`import ${toResourceVarName(locale, ns)} from '${importPath}'`)
        }
        break
      case 'fs-backend':
        lines.push("import Backend from 'i18next-fs-backend'")
        lines.push("import { resolve, dirname } from 'node:path'")
        lines.push("import { fileURLToPath } from 'node:url'")
        break
    }
  }

  // ── Pre-init statements ──
  lines.push('')
  if (strategy === 'fs-backend' && outputTemplate) {
    lines.push('const __dirname = dirname(fileURLToPath(import.meta.url))')
    lines.push('')
  }

  // ── .use() chain entries ──
  const useEntries: string[] = []
  if (formatPlugin) useEntries.push(`  .use(${formatPlugin.name})`)
  if (hasReact) useEntries.push('  .use(initReactI18next)')
  if (outputTemplate) {
    if (strategy === 'resources-to-backend') {
      const dynamicPath = buildDynamicImportPath(outputTemplate, initDir)
      const importPathTemplate = dynamicPath
        // eslint-disable-next-line no-template-curly-in-string
        .replace(/\{\{language\}\}|\{\{lng\}\}/g, '${language}')
        // eslint-disable-next-line no-template-curly-in-string
        .replace(/\{\{namespace\}\}/g, '${namespace}')
      const hasNamespace = outputTemplate.includes('{{namespace}}')
      const cbParams = hasNamespace
        ? (hasTypeScript ? 'language: string, namespace: string' : 'language, namespace')
        : (hasTypeScript ? 'language: string' : 'language')
      useEntries.push(`  .use(resourcesToBackend((${cbParams}) => import(\`${importPathTemplate}\`)))`)
    } else if (strategy === 'fs-backend') {
      useEntries.push('  .use(Backend)')
    }
  }

  // Emit the i18next chain — use compact form if no .use() calls
  const awaitPrefix = (strategy === 'fs-backend' && outputTemplate) ? 'await ' : ''
  if (useEntries.length > 0) {
    lines.push(`${awaitPrefix}i18next`)
    lines.push(...useEntries)
    lines.push('  .init({')
  } else {
    lines.push(`${awaitPrefix}i18next.init({`)
  }

  // ── .init() options ──
  const initOpts: string[] = []

  if (strategy === 'fs-backend' && outputTemplate) {
    initOpts.push('    initAsync: false,')
  }
  initOpts.push('    returnEmptyString: false, // an empty translation falls back (the default since i18next 27)')
  if (strategy === 'fs-backend') {
    initOpts.push(`    // lng: '${config.locales.at(-1)}', // or add a language detector to detect the preferred language of your user`)
  } else {
    // Without a language the app shows fallbackLng only; through supportedLngs `de-DE` resolves to `de`
    initOpts.push(`    supportedLngs: [${config.locales.map(l => `'${l}'`).join(', ')}],`)
    initOpts.push("    lng: typeof navigator !== 'undefined' ? navigator.language : undefined, // the browser's language; i18next-browser-languagedetector also remembers a choice")
  }
  initOpts.push(`    fallbackLng: '${primaryLang}',`)
  if (defaultNS) {
    initOpts.push(`    defaultNS: '${ns}',`)
  }

  // Strategy-specific init options
  if (outputTemplate) {
    if (strategy === 'bundled-resources') {
      initOpts.push('    resources: {')
      for (const locale of config.locales) {
        const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(locale) ? locale : `'${locale}'`
        initOpts.push(`      ${key}: { ${ns}: ${toResourceVarName(locale, ns)} },`)
      }
      initOpts.push('    },')
    } else if (strategy === 'fs-backend') {
      const loadPath = buildFsBackendLoadPath(outputTemplate, initDir)
      initOpts.push(`    preload: [${config.locales.map(l => `'${l}'`).join(', ')}],`)
      initOpts.push('    backend: {')
      initOpts.push(`      loadPath: resolve(__dirname, '${loadPath}'),`)
      initOpts.push('    },')
    }
  } else {
    // No concrete output path — user needs to configure loading manually
    initOpts.push('    // resources: { ... }  — or use a backend plugin to load translations')
  }

  lines.push(initOpts.join('\n'))
  lines.push('  })')
  lines.push('')
  lines.push('export default i18next')
  lines.push('')

  return lines.join('\n')
}

/**
 * Resolves the import path for a specific locale/namespace resource file
 * (used by the bundled-resources strategy).
 */
function buildResourceImportPath (outputTemplate: string, initDir: string, locale: string, namespace: string): string {
  const rel = buildDynamicImportPath(outputTemplate, initDir)
  return rel
    .replace(/\{\{language\}\}|\{\{lng\}\}/g, locale)
    .replace(/\{\{namespace\}\}|\{\{ns\}\}/g, namespace)
}

/**
 * Resolves the loadPath for i18next-fs-backend, using i18next's `{{lng}}`
 * and `{{ns}}` interpolation syntax.
 */
function buildFsBackendLoadPath (outputTemplate: string, initDir: string): string {
  const rel = buildDynamicImportPath(outputTemplate, initDir)
  return rel
    .replace(/\{\{language\}\}/g, '{{lng}}')
    .replace(/\{\{namespace\}\}/g, '{{ns}}')
}

/**
 * Converts a locale + namespace pair to a valid JS variable name.
 * E.g. ('en', 'translation') → 'enTranslation', ('zh-CN', 'common') → 'zhCNCommon'
 */
function toResourceVarName (locale: string, namespace: string): string {
  const sanitizedLocale = locale.replace(/[^a-zA-Z0-9]/g, '')
  return sanitizedLocale + namespace.charAt(0).toUpperCase() + namespace.slice(1)
}

/**
 * Common entry-point file names, checked in priority order.
 */
const ENTRY_FILE_CANDIDATES = [
  'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js',
  'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js',
  'src/App.tsx', 'src/App.ts', 'src/App.jsx', 'src/App.js',
  'pages/_app.tsx', 'pages/_app.ts', 'pages/_app.jsx', 'pages/_app.js',
  'app/layout.tsx', 'app/layout.ts', 'app/layout.jsx', 'app/layout.js',
  'index.tsx', 'index.ts', 'index.jsx', 'index.js',
  'main.tsx', 'main.ts', 'main.jsx', 'main.js'
]

/**
 * Attempts to inject a side-effect import of the i18n init file into the
 * project's main entry file.  If no recognisable entry file is found, or the
 * import already exists, the function silently returns.
 */
async function injectI18nImportIntoEntryFile (
  initFilePath: string,
  logger: Logger
): Promise<void> {
  const cwd = process.cwd()

  // 1. Find the first existing entry file
  let entryFilePath: string | null = null
  for (const candidate of ENTRY_FILE_CANDIDATES) {
    const abs = join(cwd, candidate)
    if (await fileExists(abs)) {
      entryFilePath = abs
      break
    }
  }
  if (!entryFilePath) {
    logger.info('No recognisable entry file found — please import the i18n init file manually.')
    return
  }

  // 2. Compute the relative import path (POSIX-style, without extension)
  const entryDir = dirname(entryFilePath)
  let rel = relative(entryDir, initFilePath).replace(/\\/g, '/')
  // Strip file extension for a cleaner import
  rel = rel.replace(/\.(tsx?|jsx?|mjs|mts)$/, '')
  if (!rel.startsWith('.')) {
    rel = './' + rel
  }

  // 3. Check whether the import is already present
  let content: string
  try {
    content = await readFile(entryFilePath, 'utf-8')
  } catch {
    logger.warn(`Could not read entry file: ${entryFilePath}`)
    return
  }

  // Check for existing import of the i18n init file (with or without extension)
  const importBase = rel.replace(/^\.\//, '')
  const importPatterns = [
    `import '${rel}'`, `import "${rel}"`,
    `import './${importBase}'`, `import "./${importBase}"`,
    `import '${rel}.`, `import "${rel}.`,
    // Also check for require or named imports
    `from '${rel}'`, `from "${rel}"`,
    `from './${importBase}'`, `from "./${importBase}"`,
    // Bare 'i18n' import
    "import './i18n'", 'import "./i18n"',
    "import '../i18n'", 'import "../i18n"',
    "from './i18n'", 'from "./i18n"',
    "from '../i18n'", 'from "../i18n"'
  ]
  for (const pattern of importPatterns) {
    if (content.includes(pattern)) {
      return // Already imported
    }
  }

  // 4. Insert the import at the top, right after any existing import block
  const importStatement = `import '${rel}'\n`

  // Find the best insertion point: after the last top-level import statement
  const lines = content.split('\n')
  let lastImportLine = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('import ') || trimmed.startsWith('import\t') || trimmed.startsWith('import{')) {
      // Walk past multi-line imports
      lastImportLine = i
    }
  }

  let newContent: string
  if (lastImportLine >= 0) {
    // Insert after the last import line
    lines.splice(lastImportLine + 1, 0, importStatement.trimEnd())
    newContent = lines.join('\n')
  } else {
    // No imports found — prepend at the very top
    newContent = importStatement + content
  }

  try {
    await writeFile(entryFilePath, newContent)
    logger.info(`Injected i18n import into entry file: ${entryFilePath}`)
  } catch (err) {
    logger.warn(`Failed to inject i18n import into entry file: ${err}`)
  }
}

/**
 * Rewrites a candidate for `extract.messageFormat` `'icu'` or `'mf2'`: `{{name}}` placeholders become
 * `{name}` / `{$name}`, and plural forms become one message with a plural on `count`, so the code gets
 * `t('key', '{count, plural, one {…} other {…}}', { count: expr })` and the JSON one key.
 */
function toMessageFormatCandidate (candidate: CandidateString, config: I18nextToolkitConfig): void {
  const convert = (text: string) => toMessageFormatPlaceholders(text, config)
  if (candidate.pluralForms) {
    const { countExpression, zero, one, other } = candidate.pluralForms
    candidate.content = config.extract.messageFormat === 'mf2'
      ? `.input {$count :number} .match $count ${zero !== undefined ? `0 {{${convert(zero)}}} ` : ''}${one !== undefined ? `one {{${convert(one)}}} ` : ''}* {{${convert(other)}}}`
      : `{count, plural, ${zero !== undefined ? `=0 {${convert(zero)}} ` : ''}${one !== undefined ? `one {${convert(one)}} ` : ''}other {${convert(other)}}}`
    candidate.interpolations = [{ name: 'count', expression: countExpression }, ...(candidate.interpolations ?? [])]
    candidate.pluralForms = undefined
    return
  }
  // the content of a <Trans> candidate is JSX source; only its JSON value changes
  if (candidate.type !== 'jsx-mixed') candidate.content = convert(candidate.content)
  if (candidate.transValue) candidate.transValue = convert(candidate.transValue)
}

/**
 * Extracts and writes translation keys discovered during instrumentation.
 */
export async function writeExtractedKeys (
  candidates: CandidateString[],
  config: I18nextToolkitConfig,
  namespace?: string,
  logger: Logger = new ConsoleLogger()
): Promise<void> {
  if (candidates.length === 0) return

  const primaryLanguage = config.extract.primaryLanguage ?? config.locales[0] ?? 'en'
  const ns = namespace ?? config.extract.defaultNS ?? 'translation'

  // Build a map of keys from candidates
  const translations: Record<string, string> = {}
  for (const candidate of candidates) {
    if (candidate.key) {
      if (candidate.pluralForms) {
        // Write separate plural-suffix entries for i18next
        const pf = candidate.pluralForms
        if (pf.zero != null) {
          translations[`${candidate.key}_zero`] = pf.zero
        }
        if (pf.one != null) {
          translations[`${candidate.key}_one`] = pf.one
        }
        translations[`${candidate.key}_other`] = pf.other
      } else {
        translations[candidate.key] = candidate.transValue ?? candidate.content
      }
    }
  }

  if (Object.keys(translations).length === 0) return

  // Get the output path
  const outputPath = getOutputPath(config.extract.output, primaryLanguage, typeof ns === 'string' ? ns : 'translation')

  try {
    // Load existing translations
    let existingContent: Record<string, any> = {}
    try {
      const content = await readFile(outputPath, 'utf-8')
      existingContent = JSON.parse(content)
    } catch {
      existingContent = {}
    }

    // Merge with new translations
    const merged = { ...existingContent, ...translations }

    // Write the file
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, JSON.stringify(merged, null, 2))

    logger.info(`Updated ${outputPath}`)
  } catch (err) {
    logger.warn(`Failed to write translated keys: ${err}`)
  }
}

// ─── Plugin pipeline helpers ───────────────────────────────────────────────

/**
 * Normalizes a file extension to lowercase with a leading dot.
 */
function normalizeExtension (ext: string): string {
  const trimmed = ext.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

/**
 * Checks whether an instrument plugin should run for a given file,
 * based on its `instrumentExtensions` hint.
 */
function shouldRunInstrumentPluginForFile (plugin: Plugin, filePath: string): boolean {
  const hints = plugin.instrumentExtensions
  if (!hints || hints.length === 0) return true
  const fileExt = normalizeExtension(extname(filePath))
  if (!fileExt) return false
  const normalizedHints = hints.map(h => normalizeExtension(h)).filter(Boolean)
  if (normalizedHints.length === 0) return true
  return normalizedHints.includes(fileExt)
}

/**
 * Runs `instrumentSetup` for every plugin that implements it.
 */
async function initializeInstrumentPlugins (
  plugins: Plugin[],
  context: { config: I18nextToolkitConfig; logger: Logger }
): Promise<void> {
  for (const plugin of plugins) {
    try {
      await plugin.instrumentSetup?.(context)
    } catch (err) {
      context.logger.warn(`Plugin ${plugin.name} instrumentSetup failed:`, err)
    }
  }
}

/**
 * Runs the `instrumentOnLoad` pipeline for a file.
 * Returns `null` if a plugin wants to skip the file, otherwise the
 * (possibly transformed) source code.
 */
async function runInstrumentOnLoadPipeline (
  initialCode: string,
  filePath: string,
  plugins: Plugin[],
  logger: Logger
): Promise<string | null> {
  let code = initialCode
  for (const plugin of plugins) {
    if (!shouldRunInstrumentPluginForFile(plugin, filePath)) continue
    try {
      const result = await plugin.instrumentOnLoad?.(code, filePath)
      if (result === null) return null
      if (typeof result === 'string') code = result
    } catch (err) {
      logger.warn(`Plugin ${plugin.name} instrumentOnLoad failed:`, err)
    }
  }
  return code
}

/**
 * Runs the `instrumentOnResult` pipeline for a file's candidates.
 * Returns the (possibly modified) array of candidates.
 */
async function runInstrumentOnResultPipeline (
  filePath: string,
  initialCandidates: CandidateString[],
  plugins: Plugin[],
  logger: Logger
): Promise<CandidateString[]> {
  let candidates = initialCandidates
  for (const plugin of plugins) {
    if (!shouldRunInstrumentPluginForFile(plugin, filePath)) continue
    try {
      const result = await plugin.instrumentOnResult?.(filePath, candidates)
      if (Array.isArray(result)) {
        candidates = result
      }
    } catch (err) {
      logger.warn(`Plugin ${plugin.name} instrumentOnResult failed:`, err)
    }
  }
  return candidates
}
