import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ensureConfig } from '../src/config'
import { runInit } from '../src/init'
import inquirer from 'inquirer'

// --- MOCK MODULES ---
// Mock inquirer to control its prompt answers
vi.mock('inquirer')

// Mock runInit so we can check if it's called, without running the whole wizard
vi.mock('../src/init', () => ({
  runInit: vi.fn(),
}))

describe('config: ensureConfig', () => {
  let exitSpy: any

  beforeEach(() => {
    // Reset mocks and spies before each test
    vi.clearAllMocks()
    vi.spyOn(process, 'cwd').mockReturnValue('/non-existent-path') // Ensure findConfigFile returns null
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should prompt the user and call runInit when user answers "Yes"', async () => {
    // Simulate the user answering "Yes" to the prompt
    vi.mocked(inquirer.prompt).mockResolvedValue({ shouldInit: true })

    vi.mock('../src/config', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/config')>()
      return {
        ...original,
        // Mock loadConfig to return a value on the second call
        loadConfig: vi.fn()
          .mockResolvedValueOnce(null) // First call finds no config
          .mockResolvedValueOnce({ locales: ['en'], extract: {} }), // Second call finds a config
      }
    })

    await ensureConfig()

    expect(inquirer.prompt).toHaveBeenCalledTimes(1)
    expect(runInit).toHaveBeenCalledTimes(1)
  })

  it('should exit the process when user answers "No"', async () => {
    // Simulate the user answering "No" to the prompt
    vi.mocked(inquirer.prompt).mockResolvedValue({ shouldInit: false })

    await ensureConfig()

    expect(inquirer.prompt).toHaveBeenCalledTimes(1)
    expect(runInit).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
