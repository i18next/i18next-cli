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

describe('extractor: types inferred from function returns and derived types (#298)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('resolves a member of a union of object types returned by a function', async () => {
    expect(await keysOf(`
      type Duck = { type: 'DUCK', fly: true; swim: true }
      type Dog = { type: 'DOG', swim: true }
      type Animal = Duck | Dog
      const getAnimal = (): Animal => ({ type: 'DOG', swim: true })
      const animal = getAnimal()
      t(\`animal.\${animal.type}\`)
      t(\`direct.\${getAnimal().type}\`)
    `)).toEqual(['animal.DOG', 'animal.DUCK', 'direct.DOG', 'direct.DUCK'])
  })

  it('instantiates generic object types and follows the value through variables', async () => {
    expect(await keysOf(`
      type AnimalType = 'DUCK' | 'DOG'
      type AnimalBase<T extends AnimalType> = { type: T }
      type Duck = AnimalBase<'DUCK'> & { fly: true; swim: true }
      type Dog = AnimalBase<'DOG'> & { swim: true }
      type Animal = Duck | Dog
      function getAnimal (): Animal { return { type: 'DOG', swim: true } }
      const animal = getAnimal()
      const animalType = animal.type
      const { type } = getAnimal()
      const bare: AnimalBase = animal
      t(\`var.\${animalType}\`)
      t(\`destructured.\${type}\`)
      t(\`bare.\${bare.type}\`)
    `)).toEqual(['bare.DOG', 'bare.DUCK', 'destructured.DOG', 'destructured.DUCK', 'var.DOG', 'var.DUCK'])
  })

  it('resolves (typeof X)[keyof typeof X] and elements of an array', async () => {
    expect(await keysOf(`
      const COLOR = { BLUE: 'BLUE', YELLOW: 'YELLOW' } as const
      type Color = (typeof COLOR)[keyof typeof COLOR]
      const colors: Color[] = ['BLUE', 'YELLOW']
      for (let i = 0; i < colors.length; i++) {
        const typed: Color = colors[i]
        const inferred = colors[i]
        t(\`typed.\${typed}\`)
        t(\`inferred.\${inferred}\`)
      }
      t(\`first.\${colors[0]}\`)
    `)).toEqual(['first.BLUE', 'inferred.BLUE', 'inferred.YELLOW', 'typed.BLUE', 'typed.YELLOW'])
  })
})
