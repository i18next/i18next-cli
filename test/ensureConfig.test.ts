import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock inquirer to detect if prompt is shown, and prevent hanging
const mockPrompt = vi.fn()
vi.mock('inquirer', () => ({ default: { prompt: mockPrompt } }))

// Mock runInit so it doesn't actually run
vi.mock('../src/init', () => ({ runInit: vi.fn() }))

// Mock jiti to simulate a config file that throws on load
vi.mock('jiti', () => ({
  createJiti: () => ({
    import: vi.fn().mockRejectedValue(new Error('oops!'))
  })
}))

// Mock fs/promises so findConfigFile finds a file, but loading throws
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined), // config file "exists"
    readFile: actual.readFile, // keep real readFile for tsconfig parsing
  }
})

describe('ensureConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should throw and NOT prompt when config file exists but throws during loading', async () => {
    vi.resetModules()
    const { ensureConfig } = await import('../src/config')

    await expect(ensureConfig()).rejects.toThrow('oops!')

    // The "would you like to create one?" prompt must NOT appear
    expect(mockPrompt).not.toHaveBeenCalled()
  })
})
