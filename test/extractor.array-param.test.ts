import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { glob } from 'glob'
import { findKeys } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

const keysOf = async (code: string) => {
  vol.fromJSON({ '/src/app.ts': code })
  vi.mocked(glob).mockResolvedValue(['/src/app.ts'])
  const { allKeys } = await findKeys({
    locales: ['en'],
    extract: { input: ['src/**/*.ts'], output: 'locales/{{language}}/{{namespace}}.json', functions: ['t'] },
  })
  return [...allKeys.values()].map(k => k.key).sort()
}

describe('extractor: arrays of a string union (#300)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('binds the callback parameter of map() on a parameter typed as an array of a union', async () => {
    expect(await keysOf(`
      export type Color = "RED" | "GREEN" | "BLUE";
      export const translateColors = (
        t: TFunction<"common", undefined>,
        colors: Color[],
      ) => colors.map((color) => t(\`color.\${color}\`));
    `)).toEqual(['color.BLUE', 'color.GREEN', 'color.RED'])
  })

  it('handles readonly arrays, Array<T>, array type aliases and for...of', async () => {
    expect(await keysOf(`
      type Size = 's' | 'm'
      type Sizes = Size[]
      const a = (sizes: readonly Size[]) => sizes.map(s => t(\`a.\${s}\`))
      const b = (sizes: Array<Size>) => sizes.forEach(s => t(\`b.\${s}\`))
      const c = (sizes: Sizes) => { for (const s of sizes) t(\`c.\${s}\`) }
    `)).toEqual(['a.m', 'a.s', 'b.m', 'b.s', 'c.m', 'c.s'])
  })
})
