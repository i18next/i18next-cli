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
    extract: { input: ['src/**/*.ts'], output: 'locales/{{language}}/{{namespace}}.json', functions: ['t'] },
  })
  return [...allKeys.values()].map(k => k.key).sort()
}

describe('extractor: members of nested object types (#302)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('resolves unions nested in object types and indexed access types', async () => {
    expect(await keysOf({
      '/src/app.ts': `
        export type DeepObject = {
          status: "200" | "400" | "404";
          Bar: { status: "201" | "400" };
          Foo: { Bar: { status: "200" | "400" | "404" } };
        };
        declare function getDeepObject(): DeepObject
        const deepObject = getDeepObject();
        t(\`status.\${deepObject.status}\`);
        t(\`barStatus.\${deepObject.Bar.status}\`);
        t(\`fooBarStatus.\${deepObject.Foo.Bar.status}\`);
        declare const raw: string
        t(\`asserted.\${raw as DeepObject['Bar']['status']}\`);
      `,
    })).toEqual([
      'asserted.201', 'asserted.400',
      'barStatus.201', 'barStatus.400',
      'fooBarStatus.200', 'fooBarStatus.400', 'fooBarStatus.404',
      'status.200', 'status.400', 'status.404',
    ])
  })

  it('follows openapi-typescript references, optional chaining and destructuring across files', async () => {
    expect(await keysOf({
      '/src/app.ts': `
        import type { components } from './schema'
        type Pet = components["schemas"]["Pet"]
        const describePet = (pet: Pet) => {
          t(\`status.\${pet.status}\`)
          t(\`category.\${pet.category?.kind}\`)
          t(\`parent.\${pet.category?.parent?.kind}\`)
          const { kind } = pet.category
          t(\`destructured.\${kind}\`)
        }
      `,
      '/src/schema.ts': `
        export interface components {
          schemas: {
            Pet: { id?: number; status?: "available" | "sold"; category?: components["schemas"]["Category"] };
            Category: { kind: "a" | "b"; parent?: components["schemas"]["Category"] };
          };
        }
      `,
    })).toEqual([
      'category.a', 'category.b',
      'destructured.a', 'destructured.b',
      'parent.a', 'parent.b',
      'status.available', 'status.sold',
    ])
  })

  it('stays bounded on recursive types', async () => {
    expect(await keysOf({
      '/src/app.ts': `
        interface Node { kind: 'leaf' | 'branch'; left: Node; right: Node }
        type Tree<T> = { value: T; child: Tree<T> }
        declare const node: Node
        declare const tree: Tree<'x' | 'y'>
        t(\`node.\${node.left.right.kind}\`)
        t(\`tree.\${tree.child.child.value}\`)
      `,
    })).toEqual(['node.branch', 'node.leaf', 'tree.x', 'tree.y'])
  })
})
