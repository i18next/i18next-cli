import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { glob } from 'glob'
import { findKeys } from '../src/index'
import type { I18nextToolkitConfig, Logger } from '../src/types'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

const logger = (): Logger & { warnings: string[] } => {
  const warnings: string[] = []
  return { warnings, info: () => {}, warn: (msg: string) => { warnings.push(msg) }, error: () => {} }
}

const keysOf = async (files: Record<string, string>, extract: Partial<I18nextToolkitConfig['extract']> = {}, log: Logger = logger()) => {
  vol.fromJSON(files)
  // the order the issue reports: the unrelated `ABC` is scanned last
  vi.mocked(glob).mockResolvedValue(Object.keys(files).filter(f => /\.tsx?$/.test(f)))
  const { allKeys } = await findKeys({
    locales: ['en'],
    extract: { input: ['src/**/*.ts'], output: 'locales/{{language}}/{{namespace}}.json', functions: ['t'], ...extract },
  }, log)
  return [...allKeys.keys()].map(k => k.replace(/^translation:/, '')).sort()
}

const abc = 'export type ABC = "a" | "b" | "c";'
const xy = 'export type ABC = "x" | "y";'
const use = (from: string, name = 'ABC') => `
  import { ${name} } from "${from}";
  export function translateAbc(abc: ${name}) {
    return t("letters." + abc);
  }
`

describe('extractor: names imported through a barrel file (#327)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('follows `export * from` to the declaration the barrel re-exports', async () => {
    const files = {
      '/src/types/abc.ts': abc,
      '/src/types/index.ts': 'export * from "./abc";',
      '/src/use.ts': use('./types'),
      '/src/types/xy.ts': xy,
    }
    expect(await keysOf(files)).toEqual(['letters.a', 'letters.b', 'letters.c'])
    vol.reset()
    // the other file order (files are scanned sorted by path)
    const { '/src/types/xy.ts': _, ...rest } = files
    expect(await keysOf({ ...rest, '/src/types/0xy.ts': xy })).toEqual(['letters.a', 'letters.b', 'letters.c'])
  })

  it('follows renaming re-exports, re-exported imports, nested and cyclic barrels', async () => {
    expect(await keysOf({
      '/src/types/letters/abc.ts': abc,
      '/src/types/letters/index.ts': 'export type { ABC as Letters } from "./abc";',
      '/src/types/index.ts': 'export * from "./other"; export * from "./letters";',
      '/src/types/other.ts': 'export * from "./index"; export type Other = "o";',
      '/src/use.ts': use('./types', 'Letters'),
      '/src/types/xy.ts': xy,
      '/src/types/letters2.ts': 'export type Letters = "x" | "y";',
    })).toEqual(['letters.a', 'letters.b', 'letters.c'])
    vol.reset()
    expect(await keysOf({
      '/src/types/abc.ts': abc,
      '/src/types/index.ts': 'import type { ABC } from "./abc"; export type { ABC };',
      '/src/use.ts': use('./types'),
      '/src/types/xy.ts': xy,
    })).toEqual(['letters.a', 'letters.b', 'letters.c'])
  })

  it("never resolves a file's own or imported name to another file's same-named declaration", async () => {
    expect(await keysOf({
      // its own `Props`, whose `size` the extractor cannot read
      '/src/a.ts': 'interface Props { size: "a" | "b" }',
      '/src/c.ts': 'interface Props { size: string; onClick: () => void }\nexport const C = (p: Props) => t("c." + p.size);',
      // an enum `Color` imported while other files declare a type `Color`
      '/src/color.ts': 'export enum Color { Red = "red", Blue = "blue" }',
      '/src/d.ts': 'type Color = "z"',
      '/src/use.ts': 'import { Color } from "./color";\nexport const f = (c: Color) => t("color." + c);',
    })).toEqual(['color.blue', 'color.red'])
  })

  it('follows a barrel through a namespace import, for enums and constants too', async () => {
    expect(await keysOf({
      '/src/types/abc.ts': `
        export type ABC = "a" | "b" | "c";
        export enum Color { Red = "red" }
        export const SIZES = ["s", "m"] as const;
      `,
      '/src/types/index.ts': 'export * from "./abc";',
      '/src/use.ts': `
        import * as Types from "./types";
        export function f(abc: Types.ABC) {
          t("letters." + abc);
          t(\`colors.\${Types.Color.Red}\`);
          Types.SIZES.forEach(size => t(\`sizes.\${size}\`));
        }
      `,
      '/src/other.ts': `
        export type ABC = "x" | "y";
        export enum Color { Red = "rot" }
        export const SIZES = ["xl"] as const;
      `,
    })).toEqual(['colors.red', 'letters.a', 'letters.b', 'letters.c', 'sizes.m', 'sizes.s'])
  })

  it('reads a namespace constant from the module it is imported from', async () => {
    expect(await keysOf({
      '/src/ns/a.ts': 'export const NS = "ns1";',
      '/src/ns/index.ts': 'export * from "./a";',
      '/src/direct.ts': 'import { NS } from "./ns/a"; const { t } = useTranslation(NS); t("direct");',
      '/src/barrel.ts': 'import { NS } from "./ns"; const { t } = useTranslation(NS); t("barrel");',
      '/src/ns/z.ts': 'export const NS = "ns2";',
      // its own `NS`, which the extractor cannot read, is not the other files' `NS`
      '/src/own.ts': 'const NS = getNs(); const { t } = useTranslation(NS); t("own");',
    })).toEqual(['ns1:barrel', 'ns1:direct', 'own'])
  })

  describe('warnOnAmbiguousTypes', () => {
    // `@acme/types` is no path of this project: nothing says which `ABC` it is
    const ambiguous = {
      '/src/types/abc.ts': abc,
      '/src/types/xy.ts': xy,
      '/src/use.ts': use('@acme/types'),
    }

    it('is silent by default', async () => {
      const log = logger()
      await keysOf(ambiguous, {}, log)
      expect(log.warnings).toEqual([])
    })

    it('warns once per file and name, naming the declaring files', async () => {
      const log = logger()
      await keysOf({
        ...ambiguous,
        '/src/use2.ts': `
          import { ABC as Letters } from "@acme/types";
          export const f = (abc: Letters) => t("letters." + abc);
          export const g = (abc: Letters) => t("more." + abc);
        `,
      }, { warnOnAmbiguousTypes: 'warn' }, log)
      expect(log.warnings).toHaveLength(2)
      expect(log.warnings[0]).toMatch(/^Cannot tell which "ABC" .*src[\\/]use\.ts means: .*src[\\/]types[\\/]abc\.ts, .*src[\\/]types[\\/]xy\.ts declare it differently/)
      expect(log.warnings[1]).toMatch(/^Cannot tell which "ABC" .*src[\\/]use2\.ts means/)
    })

    it('aborts extraction with "error"', async () => {
      await expect(keysOf(ambiguous, { warnOnAmbiguousTypes: 'error' })).rejects.toThrow(/Cannot tell which "ABC" .*src[\\/]use\.ts means/)
    })

    it('does not warn when the file declares the name or imports it from where it is declared, or the declarations agree', async () => {
      const log = logger()
      await keysOf({
        '/src/types/abc.ts': abc,
        '/src/types/index.ts': 'export * from "./abc";',
        '/src/types/xy.ts': xy,
        '/src/use.ts': use('./types'),
        '/src/same1.ts': 'export type Size = "s" | "m";',
        '/src/same2.ts': 'export type Size = "m" | "s";',
        '/src/use2.ts': 'import { Size } from "@acme/size"; export const f = (s: Size) => t("sizes." + s);',
        '/src/a.ts': 'interface Props { size: "a" | "b" }',
        '/src/b.ts': 'interface Props { size: "c" }',
        '/src/c.ts': 'interface Props { size: string; onClick: () => void }\nexport const C = (p: Props) => t("c.static");',
      }, { warnOnAmbiguousTypes: 'error' }, log)
      expect(log.warnings).toEqual([])
    })

    it('warns about a guessed object type once, though two tables hold it', async () => {
      const log = logger()
      await keysOf({
        '/src/a.ts': 'export const LABELS = { save: "one" } as const;',
        '/src/b.ts': 'export const LABELS = { save: "two" } as const;',
        '/src/c.ts': 'import { LABELS } from "@acme/labels";\ntype K = keyof typeof LABELS;\nt(LABELS.save);',
      }, { warnOnAmbiguousTypes: true }, log)
      expect(log.warnings).toHaveLength(1)
      expect(log.warnings[0]).toMatch(/^Cannot tell which "LABELS" .*src[\\/]c\.ts means/)
    })
  })
})
