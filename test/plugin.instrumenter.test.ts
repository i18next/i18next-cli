import { vol } from 'memfs'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInstrumenter } from '../src/instrumenter'
import type { I18nextToolkitConfig, Plugin, InstrumentPluginContext } from '../src/index'

vi.mock('fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})
vi.mock('glob', () => ({ glob: vi.fn() }))

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}

const packageJson = JSON.stringify({
  name: 'test-app',
  dependencies: { react: '^18.0.0', 'react-i18next': '^14.0.0' }
})

function makeConfig (overrides?: Partial<I18nextToolkitConfig['extract']>): I18nextToolkitConfig {
  return {
    locales: ['en'],
    extract: {
      input: ['src/**/*.tsx'],
      output: 'locales/{{language}}/{{namespace}}.json',
      functions: ['t'],
      transComponents: ['Trans'],
      primaryLanguage: 'en',
      defaultNS: 'translation',
      ...overrides
    }
  }
}

describe('plugin system: instrumenter', () => {
  beforeEach(async () => {
    vol.reset()
    vi.clearAllMocks()

    const { glob } = await import('glob')
    vi.mocked(glob).mockResolvedValue(['/src/App.tsx'])

    // Provide package.json for React detection
    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}'
    })

    // Override process.cwd for isProjectUsingReact / isProjectUsingTypeScript
    vi.spyOn(process, 'cwd').mockReturnValue('/')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should run instrumentSetup once and provide InstrumentPluginContext', async () => {
    let setupCalls = 0
    let receivedContext: InstrumentPluginContext | undefined
    const plugin: Plugin = {
      name: 'instrument-setup-test',
      instrumentSetup: async (context) => {
        setupCalls += 1
        receivedContext = context
      }
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Hello world</p> }'
    })

    const config = makeConfig()
    config.plugins = [plugin]

    await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)

    expect(setupCalls).toBe(1)
    expect(receivedContext).toBeDefined()
    expect(receivedContext?.config.locales).toEqual(['en'])
    expect(typeof receivedContext?.logger.info).toBe('function')
  })

  it('should skip a file when instrumentOnLoad returns null', async () => {
    const plugin: Plugin = {
      name: 'instrument-skip-file',
      instrumentOnLoad: async () => null
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Visible text</p> }'
    })

    const config = makeConfig()
    config.plugins = [plugin]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    expect(result.totalCandidates).toBe(0)
    expect(result.files).toHaveLength(0)
  })

  it('should transform file content when instrumentOnLoad returns a string', async () => {
    const plugin: Plugin = {
      name: 'instrument-transform-content',
      instrumentOnLoad: async (_code, _filePath) => {
        // Replace the original content with something that has a different hardcoded string
        return 'export default function App() { return <p>Replaced text</p> }'
      }
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Original text</p> }'
    })

    const config = makeConfig()
    config.plugins = [plugin]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    expect(result.totalCandidates).toBeGreaterThan(0)
    // Should detect "Replaced text" instead of "Original text"
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates.some(c => c.content === 'Replaced text')).toBe(true)
    expect(candidates.some(c => c.content === 'Original text')).toBe(false)
  })

  it('should pass through when instrumentOnLoad returns undefined', async () => {
    const plugin: Plugin = {
      name: 'instrument-passthrough',
      instrumentOnLoad: async () => undefined
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Passthrough text</p> }'
    })

    const config = makeConfig()
    config.plugins = [plugin]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates.some(c => c.content === 'Passthrough text')).toBe(true)
  })

  it('should allow instrumentOnResult to filter candidates', async () => {
    const plugin: Plugin = {
      name: 'instrument-filter-result',
      instrumentOnResult: async (_filePath, candidates) => {
        // Only keep candidates that contain "keep"
        return candidates.filter(c => c.content.includes('keep'))
      }
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': [
        'export default function App() {',
        '  return (',
        '    <div>',
        '      <p>keep this text</p>',
        '      <p>remove this text</p>',
        '    </div>',
        '  )',
        '}'
      ].join('\n')
    })

    const config = makeConfig()
    config.plugins = [plugin]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every(c => c.content.includes('keep'))).toBe(true)
    expect(candidates.some(c => c.content.includes('remove'))).toBe(false)
  })

  it('should pass through when instrumentOnResult returns undefined', async () => {
    const plugin: Plugin = {
      name: 'instrument-result-passthrough',
      instrumentOnResult: async () => undefined
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Some text</p> }'
    })

    const config = makeConfig()
    config.plugins = [plugin]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates.some(c => c.content === 'Some text')).toBe(true)
  })

  it('should apply instrumentExtensions as a skip hint', async () => {
    const tsOnlyPlugin: Plugin = {
      name: 'ts-only-instrument-plugin',
      instrumentExtensions: ['.ts'],
      instrumentOnLoad: async () => 'export default function App() { return <p>From ts plugin</p> }'
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Original tsx text</p> }'
    })

    const config = makeConfig()
    config.plugins = [tsOnlyPlugin]

    // Plugin targets .ts but file is .tsx — plugin should be skipped
    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates.some(c => c.content === 'Original tsx text')).toBe(true)
    expect(candidates.some(c => c.content === 'From ts plugin')).toBe(false)
  })

  it('should support instrumentExtensions without dot prefix', async () => {
    const plugin: Plugin = {
      name: 'tsx-extension-without-dot',
      instrumentExtensions: ['tsx'],
      instrumentOnLoad: async () => 'export default function App() { return <p>From extension hint</p> }'
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Original</p> }'
    })

    const config = makeConfig()
    config.plugins = [plugin]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates.some(c => c.content === 'From extension hint')).toBe(true)
  })

  it('should run instrumentOnLoad hooks in sequence', async () => {
    const first: Plugin = {
      name: 'first',
      instrumentOnLoad: async () => 'export default function App() { return <p>Alpha stage one</p> }'
    }
    const second: Plugin = {
      name: 'second',
      instrumentOnLoad: async (code) => code.replace('Alpha stage one', 'Beta stage two')
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Original text here</p> }'
    })

    const config = makeConfig()
    config.plugins = [first, second]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    const candidates = result.files.flatMap(f => f.candidates)
    // The second plugin's transformation should be in effect
    expect(candidates.some(c => c.content === 'Beta stage two')).toBe(true)
    expect(candidates.some(c => c.content === 'Alpha stage one')).toBe(false)
    expect(candidates.some(c => c.content === 'Original text here')).toBe(false)
  })

  it('should run instrumentOnResult hooks in sequence', async () => {
    const filterPlugin: Plugin = {
      name: 'filter',
      instrumentOnResult: async (_file, candidates) => {
        // Add a synthetic candidate
        return [
          ...candidates,
          {
            content: 'synthetic',
            confidence: 1,
            offset: 0,
            endOffset: 0,
            type: 'string-literal' as const,
            file: _file,
            line: 1,
            column: 0
          }
        ]
      }
    }
    const secondPlugin: Plugin = {
      name: 'second-filter',
      instrumentOnResult: async (_file, candidates) => {
        // Only keep synthetic
        return candidates.filter(c => c.content === 'synthetic')
      }
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Real text</p> }'
    })

    const config = makeConfig()
    config.plugins = [filterPlugin, secondPlugin]

    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].content).toBe('synthetic')
  })

  it('should continue when a plugin throws in hooks', async () => {
    const plugin: Plugin = {
      name: 'instrument-throws',
      instrumentSetup: async () => {
        throw new Error('setup boom')
      },
      instrumentOnLoad: async () => {
        throw new Error('load boom')
      },
      instrumentOnResult: async () => {
        throw new Error('result boom')
      }
    }

    vol.fromJSON({
      '/package.json': packageJson,
      '/tsconfig.json': '{}',
      '/src/App.tsx': 'export default function App() { return <p>Still instrument this</p> }'
    })

    const config = makeConfig()
    config.plugins = [plugin]

    // Should not throw — errors are caught and logged
    const result = await runInstrumenter(config, { isDryRun: true, quiet: true }, silentLogger)

    // Warn calls: 1 for setup, 1 for onLoad, 1 for onResult
    const warnCalls = silentLogger.warn.mock.calls
    const pluginWarns = warnCalls.filter((call: unknown[]) =>
      typeof call[0] === 'string' && call[0].includes('instrument-throws')
    )
    expect(pluginWarns.length).toBeGreaterThanOrEqual(2) // at least setup + onLoad

    // The file should still be processed
    expect(result.totalCandidates).toBeGreaterThan(0)
    const candidates = result.files.flatMap(f => f.candidates)
    expect(candidates.some(c => c.content === 'Still instrument this')).toBe(true)
  })
})
