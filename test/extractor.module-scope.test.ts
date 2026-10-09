import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { glob } from 'glob'
import { resolve } from 'path'
import { findKeys } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
// the tsconfig `paths` are read through node:fs/promises
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

vi.mock('glob', () => ({ glob: vi.fn() }))

const keysOf = async (files: Record<string, string>) => {
  vol.fromJSON(files)
  vi.mocked(glob).mockResolvedValue(Object.keys(files).filter(f => /\.tsx?$/.test(f)))
  const { allKeys } = await findKeys({
    locales: ['en'],
    extract: { input: ['src/**/*.ts'], output: 'locales/{{language}}/{{namespace}}.json', functions: ['t'] },
  })
  return [...allKeys.values()].map(k => k.key).sort()
}

// Two generated OpenAPI clients that both declare `components`
const github = `
  export interface components {
    schemas: { "security-advisory-ecosystems": "npm" | "erlang"; account: { status: "gh-active" } };
  }
`
const digitalOcean = `
  export interface components {
    schemas: { account: { status: "active" | "locked" } };
  }
`

describe('extractor: same-named declarations in different modules (#306)', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('resolves each renamed import to the module it comes from', async () => {
    expect(await keysOf({
      '/src/api/github-api.ts': github,
      '/src/api/digital-ocean-api.ts': digitalOcean,
      '/src/app.ts': `
        import { components as githubComponents } from "./api/github-api";
        import { components as digitalOceanComponents } from "./api/digital-ocean-api";

        const getEcosystem = (): githubComponents["schemas"]["security-advisory-ecosystems"] => "erlang";
        const getAccountStatus = (): digitalOceanComponents["schemas"]["account"]["status"] => "locked";

        const ecosystem = getEcosystem();
        t(\`gitHubEcosystem.\${ecosystem}\`);
        const accountStatus = getAccountStatus();
        t(\`accountStatus.\${accountStatus}\`);
      `,
    })).toEqual(['accountStatus.active', 'accountStatus.locked', 'gitHubEcosystem.erlang', 'gitHubEcosystem.npm'])
  })

  it('keeps the same name apart across files, namespace imports, path aliases and .js specifiers', async () => {
    expect(await keysOf({
      [resolve(process.cwd(), 'tsconfig.json')]: JSON.stringify({ compilerOptions: { baseUrl: '/', paths: { '@api/*': ['./src/api/*'] } } }),
      '/src/api/github-api.ts': github,
      '/src/api/digital-ocean-api.ts': digitalOcean,
      '/src/a.ts': `
        import type { components } from "./api/github-api.js";
        declare const status: components["schemas"]["account"]["status"];
        t(\`a.\${status}\`);
      `,
      '/src/b.ts': `
        import type { components } from "@api/digital-ocean-api";
        declare const status: components["schemas"]["account"]["status"];
        t(\`b.\${status}\`);
      `,
      '/src/c.ts': `
        import * as GH from "./api/github-api";
        declare const ecosystem: GH.components["schemas"]["security-advisory-ecosystems"];
        t(\`c.\${ecosystem}\`);
      `,
    })).toEqual(['a.gh-active', 'b.active', 'b.locked', 'c.erlang', 'c.npm'])
  })
})
