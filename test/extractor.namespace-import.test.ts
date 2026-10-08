import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { glob } from 'glob'
import { findKeys } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

const keysOf = async (files: Record<string, string>) => {
  vol.fromJSON(files)
  vi.mocked(glob).mockResolvedValue(Object.keys(files))
  const { allKeys } = await findKeys({
    locales: ['en'],
    extract: { input: ['src/**/*.{ts,tsx}'], output: 'locales/{{language}}/{{namespace}}.json', functions: ['t'] },
  })
  return [...allKeys.values()].map(k => k.key).sort()
}

const types = `
  export type Color = 'RED' | 'GREEN'
  export const SIZES = ['s', 'm'] as const
  export enum Status { New = 'new', Done = 'done' }
  export const LABELS = { save: 'label.save', cancel: 'label.cancel' } as const
  export interface Props { level: 'low' | 'high' }
`

describe('extractor: namespace imports (#305)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('resolves types and values read through a namespace import', async () => {
    expect(await keysOf({
      '/src/types.ts': types,
      '/src/app.tsx': `
        import type { FC } from 'react'
        import * as Types from './types'

        const byParam = (color: Types.Color) => t(\`param.\${color}\`)
        declare const raw: string
        t(\`assert.\${raw as Types.Color}\`)
        declare const status: Types.Status
        t(\`enum.\${status}\`)
        t(\`member.\${Types.Status.Done}\`)
        Types.SIZES.map((size) => t(\`array.\${size}\`))
        t(Types.LABELS.save)
        Object.keys(Types.LABELS).forEach((k) => t(\`keys.\${k}\`))
        declare const key: keyof typeof Types.LABELS
        t(\`keyof.\${key}\`)
        const Comp: FC<Types.Props> = ({ level }) => t(\`props.\${level}\`)
      `,
    })).toEqual([
      'array.m', 'array.s',
      'assert.GREEN', 'assert.RED',
      'enum.done', 'enum.new',
      'keyof.cancel', 'keyof.save',
      'keys.cancel', 'keys.save',
      'label.save',
      'member.done',
      'param.GREEN', 'param.RED',
      'props.high', 'props.low',
    ])
  })

  it('resolves a namespace re-exported from a barrel and imported under another name', async () => {
    expect(await keysOf({
      '/src/types.ts': types,
      '/src/index.ts': 'export * as Shared from \'./types\'',
      '/src/app.ts': `
        import { Shared as S } from './index'
        const byParam = (color: S.Color) => t(\`param.\${color}\`)
        S.SIZES.forEach((size) => t(\`array.\${size}\`))
      `,
    })).toEqual(['array.m', 'array.s', 'param.GREEN', 'param.RED'])
  })
})
