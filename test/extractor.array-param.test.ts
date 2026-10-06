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

describe('extractor: inline array literals (#301)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('binds the callback parameter of map() and for...of on an inline as-const array', async () => {
    expect(await keysOf(`
      const translatedQuarters = ([1, 2, 3, 4] as const).map((q) => t(\`QUARTER.\${q}\`));
      for (const unit of ['day', 'hour'] as const) t(\`unit.\${unit}\`)
      ;([{ size: 's' }, { size: 'm' }] as const).forEach(({ size }) => t(\`size.\${size}\`))
    `)).toEqual(['QUARTER.1', 'QUARTER.2', 'QUARTER.3', 'QUARTER.4', 'size.m', 'size.s', 'unit.day', 'unit.hour'])
  })
})

describe('extractor: props typed through React.FC (#303)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('binds the props of a component typed React.FC<Props> and iterates a typed member', async () => {
    vol.fromJSON({
      '/src/ColorList.tsx': `
        import * as React from "react";
        import { useTranslation } from "react-i18next";

        export type Color = 'RED' | 'GREEN' | 'BLUE'
        type Size = 's' | 'm'

        interface Props {
          colors: Color[];
          sizes: Size[];
        }

        const ColorList: React.FC<Props> = (props) => {
          const { t } = useTranslation();
          return (
            <ul>
              {props.colors.map((color) => (
                <li key={color}>{t(\`Color.\${color}\`)}</li>
              ))}
            </ul>
          );
        };

        const SizeList: FC<Props> = ({ sizes }) => {
          const { t } = useTranslation();
          return <>{sizes.map((size) => t(\`Size.\${size}\`))}</>;
        };

        export default ColorList;
      `,
    })
    vi.mocked(glob).mockResolvedValue(['/src/ColorList.tsx'])
    const { allKeys } = await findKeys({
      locales: ['en'],
      extract: { input: ['src/**/*.tsx'], output: 'locales/{{language}}/{{namespace}}.json' },
    })
    expect([...allKeys.values()].map(k => k.key).sort()).toEqual(['Color.BLUE', 'Color.GREEN', 'Color.RED', 'Size.m', 'Size.s'])
  })

  it('types the props of forwardRef and memo, and iterates typed arrays of objects', async () => {
    vol.fromJSON({
      '/src/Lists.tsx': `
        import { forwardRef, memo, type FC } from "react";
        import { useTranslation } from "react-i18next";

        type Item = { kind: 'a' | 'b' }
        interface Props { level: 'low' | 'high'; items: Item[] }

        export const WithRef = forwardRef<HTMLDivElement, Props>((props, ref) => {
          const { t } = useTranslation();
          return <div ref={ref}>{t(\`level.\${props.level}\`)}</div>;
        });

        export const Memo = memo<Props>(({ items }) => {
          const { t } = useTranslation();
          return <>{items.map(({ kind }) => t(\`destructured.\${kind}\`))}</>;
        });

        export const MemoFC: FC<Props> = memo((props) => {
          const { t } = useTranslation();
          for (const item of props.items) t(\`forOf.\${item.kind}\`)
          return <>{props.items.map((item) => t(\`member.\${item.kind}\`))}</>;
        });
      `,
    })
    vi.mocked(glob).mockResolvedValue(['/src/Lists.tsx'])
    const { allKeys } = await findKeys({
      locales: ['en'],
      extract: { input: ['src/**/*.tsx'], output: 'locales/{{language}}/{{namespace}}.json' },
    })
    expect([...allKeys.values()].map(k => k.key).sort()).toEqual([
      'destructured.a', 'destructured.b', 'forOf.a', 'forOf.b', 'level.high', 'level.low', 'member.a', 'member.b',
    ])
  })
})
