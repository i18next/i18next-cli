import { realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { getTsConfigAliases } from '../../config.js'

/**
 * Where a file of a Next.js app renders, for next-i18next: `server` for Server Components (`await getT()`),
 * `client` for Client Components of the App Router (`useT()`), `pages` for the Pages Router (`useTranslation()`
 * from `next-i18next/pages`), `shared` for a file that Server and Client Components both import, where neither works,
 * `unknown` for a file of an App Router app that no route imports (as far as its imports resolve).
 */
export type NextFileKind = 'server' | 'client' | 'pages' | 'shared' | 'unknown'

/** A `'use client'` directive: the first statement, after comments only. */
const USE_CLIENT_RE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use client\1/

/** The module specifiers of a file's static, dynamic and `require` imports and its re-exports. */
const IMPORT_RE = /\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(?\s*['"]([^'"\n]+)['"]|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']

/**
 * A file's absolute path with symbolic links resolved (`/var` is `/private/var` on macOS); one that does not exist
 * (yet) resolves under the project root's real path.
 */
function real (file: string, cwd: string): string {
  const abs = resolve(cwd, file)
  try {
    return realpathSync(abs)
  } catch {}
  try {
    return abs.startsWith(cwd + sep) ? realpathSync(cwd) + abs.slice(cwd.length) : abs
  } catch {
    return abs
  }
}

/** A file's path in the project, `/`-separated, without a leading `src/`: `app/page.tsx`, `pages/api/hello.js`. */
export function projectPath (file: string, cwd = process.cwd()): string {
  return relative(real(cwd, cwd), real(file, cwd)).split(sep).join('/').replace(/^src\//, '')
}

/** The directory a file lies in under the project root: `app` or `src/app` (App Router), `pages` or `src/pages`. */
function routerOf (file: string, cwd: string): 'app' | 'pages' | null {
  const top = projectPath(file, cwd).split('/')[0]
  return top === 'app' || top === 'pages' ? top : null
}

/**
 * Classifies the files of a Next.js app by the components that render them, from the import graph: a file under
 * `app/` is a Server Component unless it says `'use client'`; a `'use client'` file and all it imports are Client
 * Components; a file under `pages/` and all it imports render with the Pages Router. Imports resolve relative,
 * through the tsconfig `paths`, from the project root (a `baseUrl` import, `components/Card`) and with the `.js`
 * of an ESM import for a `.ts` file; only the given files count.
 *
 * @param contents - The files' contents by path (relative to `cwd` or absolute)
 * @returns The kind of each file and the files it imports, by the paths they were given with; a file nothing
 *          reaches is `unknown` (`pages` in an app without `app/`)
 */
export async function classifyNextFiles (contents: Map<string, string>, cwd = process.cwd()): Promise<{ kinds: Map<string, NextFileKind>, imports: Map<string, string[]> }> {
  const aliases = Object.entries(await getTsConfigAliases())
  // by real path: the tsconfig aliases are real paths, and an absolute input glob may name a link (`/var/…`)
  const byAbs = new Map([...contents.keys()].map(f => [real(f, cwd), f]))
  const root = real(cwd, cwd)
  const resolveImport = (from: string, spec: string): string | undefined => {
    const alias = aliases.find(([key]) => spec === key || spec.startsWith(key + '/'))
    const bases = spec.startsWith('.')
      ? [resolve(dirname(from), spec)]
      : alias ? [resolve(alias[1], `.${spec.slice(alias[0].length)}`)] : [resolve(root, spec), resolve(root, 'src', spec)]
    // resolve() again: an extension or `/index` joined to a Windows path
    return bases.flatMap(base => [base, base.replace(/\.(?:m?js|jsx)$/, '')])
      .flatMap(base => EXTENSIONS.map(ext => resolve(base + ext)))
      .find(path => byAbs.has(path))
  }

  const imports = new Map<string, string[]>()
  const useClient = new Set<string>()
  for (const [abs, file] of byAbs) {
    const code = contents.get(file)!
    if (USE_CLIENT_RE.test(code)) useClient.add(abs)
    imports.set(abs, [...code.matchAll(IMPORT_RE)]
      .map(m => resolveImport(abs, m[1] ?? m[2] ?? m[3]))
      .filter((path): path is string => !!path))
  }

  // Everything a set of files imports, transitively; a server walk stops at `'use client'`, the client boundary
  const reach = (seeds: string[], stopAtClient: boolean): Set<string> => {
    const seen = new Set<string>()
    const queue = [...seeds]
    while (queue.length) {
      const abs = queue.pop()!
      if (seen.has(abs) || (stopAtClient && useClient.has(abs))) continue
      seen.add(abs)
      queue.push(...imports.get(abs)!)
    }
    return seen
  }
  const all = [...byAbs.keys()]
  const server = reach(all.filter(abs => routerOf(abs, cwd) === 'app' && !useClient.has(abs)), true)
  const appClient = reach([...useClient].filter(abs => routerOf(abs, cwd) !== 'pages'), false)
  const pages = reach(all.filter(abs => routerOf(abs, cwd) === 'pages'), false)

  const hasApp = all.some(abs => routerOf(abs, cwd) === 'app')
  const kinds = new Map<string, NextFileKind>()
  for (const [abs, file] of byAbs) {
    // a file no route reaches may be rendered on either side, through an import that does not resolve
    const kind: NextFileKind = server.has(abs)
      ? (appClient.has(abs) || pages.has(abs) ? 'shared' : 'server')
      : appClient.has(abs) ? 'client' : pages.has(abs) || !hasApp ? 'pages' : 'unknown'
    kinds.set(file, kind)
  }
  return { kinds, imports: new Map([...imports].map(([abs, paths]) => [byAbs.get(abs)!, paths.map(path => byAbs.get(path)!)])) }
}
