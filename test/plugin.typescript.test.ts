import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, Plugin, ExtractedKey } from '../src/types'
import ts from 'typescript'
import path from 'path'

// --- MOCKS ---
vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

// --- HELPER FUNCTIONS FOR PLUGIN ---
function isTranslationFunction (node: ts.CallExpression): boolean {
  const expr = node.expression
  // Matches t('...')
  if (ts.isIdentifier(expr) && expr.text === 't') return true

  // Matches i18n.t('...')
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 't') return true

  return false
}

function extractStringsFromType (type: ts.Type): string[] {
  if (type.isStringLiteral()) {
    return [type.value]
  }
  if (type.isUnion()) {
    return type.types.flatMap(t => extractStringsFromType(t))
  }
  if (type.isIntersection()) {
    return type.types.flatMap(t => extractStringsFromType(t))
  }
  return []
}

// --- TYPESCRIPT PLUGIN IMPLEMENTATION (Adapted for Test) ---
function typescriptPlugin (entryPoints: string[]): Plugin {
  return {
    name: 'typescript-resolver',
    async onEnd (keys: Map<string, ExtractedKey>) {
      // 1. Setup Compiler Options
      const compilerOptions: ts.CompilerOptions = {
        allowJs: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
      }

      // 2. Create a custom CompilerHost that reads from memfs (vol)
      const host = ts.createCompilerHost(compilerOptions)
      const originalReadFile = host.readFile
      const originalFileExists = host.fileExists

      host.readFile = (fileName: string) => {
        if (vol.existsSync(fileName)) {
          return vol.readFileSync(fileName, 'utf-8') as string
        }
        return originalReadFile(fileName)
      }

      host.fileExists = (fileName: string) => {
        if (vol.existsSync(fileName)) return true
        return originalFileExists(fileName)
      }

      // Override module resolution to look in memfs
      host.resolveModuleNameLiterals = (moduleLiterals, containingFile, redirectedReference, options, containingSourceFile, reusedNames) => {
        return moduleLiterals.map(moduleLiteral => {
          const moduleName = moduleLiteral.text
          // Simple resolution for test: resolve relative paths against the containing file's directory
          if (moduleName.startsWith('.')) {
            const dir = path.dirname(containingFile)
            const resolvedPath = path.join(dir, moduleName + '.ts') // Assume .ts for this test
            if (vol.existsSync(resolvedPath)) {
              return {
                resolvedModule: {
                  resolvedFileName: resolvedPath,
                  extension: ts.Extension.Ts,
                  isExternalLibraryImport: false,
                },
              }
            }
          }
          // Fallback to standard resolution (for node_modules etc)
          return ts.resolveModuleName(moduleName, containingFile, options, host)
        })
      }

      // 3. Create Program
      const program = ts.createProgram(entryPoints, compilerOptions, host)
      const checker = program.getTypeChecker()

      // 4. Visit AST
      for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue
        // Only visit files in our virtual src directory
        if (!sourceFile.fileName.startsWith('/src')) continue

        ts.forEachChild(sourceFile, visit)
      }

      function visit (node: ts.Node) {
        if (ts.isCallExpression(node) && isTranslationFunction(node)) {
          const arg = node.arguments[0]
          if (arg) {
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
              return
            }

            let values: string[] = []

            // Handle function arguments (e.g. t(() => ...)) by checking return type
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
              const signature = checker.getSignatureFromDeclaration(arg)
              if (signature) {
                const returnType = signature.getReturnType()
                values = extractStringsFromType(returnType)
              }
            } else {
              // Try standard type resolution first
              const type = checker.getTypeAtLocation(arg)
              values = extractStringsFromType(type)
            }

            // Fallback: If type resolution failed (generic string) but it's a TemplateExpression,
            // try to manually resolve the parts. This helps in test environments where full type inference is flaky.
            if (values.length === 0 && ts.isTemplateExpression(arg)) {
              const head = arg.head.text
              // Only handle simple case: `prefix.${var}`
              if (arg.templateSpans.length === 1) {
                const span = arg.templateSpans[0]
                const spanType = checker.getTypeAtLocation(span.expression)
                const spanValues = extractStringsFromType(spanType)

                if (spanValues.length > 0) {
                  values = spanValues.map(v => head + v + span.literal.text)
                }
              }
            }

            values.forEach(val => {
              const ns = 'translation'
              const uniqueKey = `${ns}:${val}`

              if (!keys.has(uniqueKey)) {
                keys.set(uniqueKey, {
                  key: val,
                  defaultValue: val,
                  ns,
                })
              }
            })
          }
        }
        ts.forEachChild(node, visit)
      }
    },
  }
}

describe('plugin system: typescript', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()
  })

  it('should allow a plugin to resolve complex types and add keys via onEnd', async () => {
    const complexTsCode = `
      export function Component() {
        // Use explicit casting to ensure the type is a union for the test
        const category = 'foo' as 'foo' | 'bar';
        
        // The core extractor sees this as a dynamic template literal and ignores it
        // because it can't statically resolve 'category'
        t(\`category.\${category}\`);
        
        // This one is simple and should be picked up by core
        t('simple.key');
      }
    `

    // Mock glob
    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/complex.ts'])

    vol.fromJSON({
      '/src/complex.ts': complexTsCode,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.{js,ts}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      plugins: [typescriptPlugin(['/src/complex.ts'])],
    }

    // Action: Run the key finder
    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Assertions

    // 1. Verify core extractor still works
    expect(extractedKeys).toContain('simple.key')

    // 2. Verify plugin was able to inject resolved keys
    // Note: The TS resolver sees `category.${'foo' | 'bar'}` which resolves to 'category.foo' | 'category.bar'
    // because TypeScript 4.1+ supports template literal types.
    expect(extractedKeys).toContain('category.foo')
    expect(extractedKeys).toContain('category.bar')

    // 3. Verify the dynamic key template itself wasn't added as a garbage key
    // (The core extractor usually ignores template literals it can't fully resolve)
    // eslint-disable-next-line no-template-curly-in-string
    expect(extractedKeys).not.toContain('category.${category}')
  })

  it('should resolve cross-file imports and object lookups (GitHub Issue #89)', async () => {
    // 1. Define a file that exports constants and a helper function
    const constantsCode = `
      export const STATUSES = {
        OPEN: 'status.open',
        CLOSED: 'status.closed'
      } as const;

      // Use a const export for the union type to simplify test stability
      // (Function return inference can be flaky in partial mock environments without full libs)
      export const CATEGORY = 'foo' as 'foo' | 'bar';

      // Scenario C helper: Drizzle-like schema
      export const dbSchema = {
        mailing: {
          states: {
            sent: 'email.sent',
            failed: 'email.failed'
          }
        }
      } as const;
    `

    // 2. Define the app file that imports them and uses them in t()
    const appCode = `
      import { STATUSES, CATEGORY, dbSchema } from './constants';

      export function App() {
        // Scenario A: Cross-file variable type resolution
        t(\`category.\${CATEGORY}\`);

        // Scenario B: Object lookup with union key (Simulating DB/Schema lookup)
        // We simulate a value that could be either key
        const statusKey = 'OPEN' as 'OPEN' | 'CLOSED';
        
        // This resolves to STATUSES['OPEN'] | STATUSES['CLOSED']
        // which is 'status.open' | 'status.closed'
        t(STATUSES[statusKey]);

        // Scenario C: Function callback pattern (Drizzle ORM example)
        // Simulating: t(($) => $.mailing.states[latestMailAttempt.status])
        const mailStatus = 'sent' as 'sent' | 'failed';
        
        // We use a closure here to simulate the selector pattern. 
        // The plugin should resolve the return type of the arrow function.
        t(() => dbSchema.mailing.states[mailStatus]);
      }
    `

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/constants.ts', '/src/app.ts'])

    vol.fromJSON({
      '/src/constants.ts': constantsCode,
      '/src/app.ts': appCode,
    })

    const config: I18nextToolkitConfig = {
      locales: ['en'],
      extract: {
        input: ['src/**/*.{js,ts}'],
        output: 'locales/{{language}}/{{namespace}}.json',
      },
      // We pass both files to the TS program so it can resolve imports
      plugins: [typescriptPlugin(['/src/app.ts', '/src/constants.ts'])],
    }

    const { allKeys } = await findKeys(config)
    const extractedKeys = Array.from(allKeys.values()).map(k => k.key)

    // Assertions for Scenario A
    expect(extractedKeys).toContain('category.foo')
    expect(extractedKeys).toContain('category.bar')

    // Assertions for Scenario B
    expect(extractedKeys).toContain('status.open')
    expect(extractedKeys).toContain('status.closed')

    // Assertions for Scenario C
    expect(extractedKeys).toContain('email.sent')
    expect(extractedKeys).toContain('email.failed')
  })
})
