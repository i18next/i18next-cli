import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openBrowser } from '../src/utils/locize-onboarding'
import { execa } from 'execa'

vi.mock('execa')

const URL = 'https://www.locize.app/register?from=i18next_cli__localize'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

const setPlatform = (platform: string) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('openBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execa).mockResolvedValue({ stdout: '', stderr: '' } as any)
    vi.unstubAllEnvs()
    vi.stubEnv('CI', '')
    vi.stubEnv('WSL_DISTRO_NAME', '')
    delete process.env.WSL_DISTRO_NAME
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses `open` on macOS', async () => {
    setPlatform('darwin')
    const opened = await openBrowser(URL)
    expect(opened).toBe(true)
    expect(execa).toHaveBeenCalledWith('open', [URL], { stdio: 'ignore' })
  })

  it('uses the cmd.exe `start` builtin on Windows', async () => {
    setPlatform('win32')
    const opened = await openBrowser(URL)
    expect(opened).toBe(true)
    expect(execa).toHaveBeenCalledWith('cmd', ['/c', 'start', '""', URL], { stdio: 'ignore' })
  })

  it('does not spawn anything when the ci option is set', async () => {
    setPlatform('darwin')
    const opened = await openBrowser(URL, { ci: true })
    expect(opened).toBe(false)
    expect(execa).not.toHaveBeenCalled()
  })

  it('does not spawn anything when CI=true in the environment', async () => {
    setPlatform('darwin')
    vi.stubEnv('CI', 'true')
    const opened = await openBrowser(URL)
    expect(opened).toBe(false)
    expect(execa).not.toHaveBeenCalled()
  })

  it('short-circuits on headless Linux (no DISPLAY/WAYLAND_DISPLAY)', async () => {
    setPlatform('linux')
    vi.stubEnv('DISPLAY', '')
    vi.stubEnv('WAYLAND_DISPLAY', '')
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    const opened = await openBrowser(URL)
    expect(opened).toBe(false)
    expect(execa).not.toHaveBeenCalled()
  })

  it('returns false when the platform opener fails', async () => {
    setPlatform('darwin')
    vi.mocked(execa).mockRejectedValue(new Error('no browser'))
    const opened = await openBrowser(URL)
    expect(opened).toBe(false)
  })
})
