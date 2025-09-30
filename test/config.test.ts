import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../src/config'

describe('config: loadConfig with real files', () => {
  let tempDirPath: string
  let originalCwd: string

  beforeEach(async () => {
    // Create a unique temporary directory in the OS temp folder
    tempDirPath = await mkdtemp(join(tmpdir(), 'i18next-cli-'))

    // Store the original CWD and then change into the temp directory
    originalCwd = process.cwd()
    process.chdir(tempDirPath)
  })

  afterEach(async () => {
    // Change back to the original CWD and remove the temporary directory
    process.chdir(originalCwd)
    await rm(tempDirPath, { recursive: true, force: true })
  })

  it('should resolve TypeScript path aliases from a real tsconfig.json file', async () => {
    // 1. Create the necessary files inside the temporary directory
    await writeFile(
      join(tempDirPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
      })
    )

    await mkdir(join(tempDirPath, 'src', 'i18n'), { recursive: true })

    await writeFile(
      join(tempDirPath, 'src', 'i18n', 'settings.ts'),
      'export const SUPPORTED_LOCALES = [\'en-US\', \'de-DE\'];'
    )

    // The content of our temporary config file
    const configContent = `
      // Define a dummy defineConfig since we're not in a real project environment
      const defineConfig = (config) => config;

      import { SUPPORTED_LOCALES } from '@/i18n/settings';

      export default defineConfig({
        locales: SUPPORTED_LOCALES,
        extract: {
          input: 'src/**/*.{ts,tsx}',
          output: 'locales/{{language}}/{{namespace}}.json',
        },
      });
    `
    await writeFile(join(tempDirPath, 'i18next.config.ts'), configContent)

    // 2. Run the function under test. It will now operate within the temp directory
    // as if it were the project root.
    const config = await loadConfig()

    // 3. Assert the outcome
    expect(config).not.toBeNull()
    expect(config?.locales).toEqual(['en-US', 'de-DE'])
  })
})
