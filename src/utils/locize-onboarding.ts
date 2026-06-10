import inquirer from 'inquirer'
import { execa } from 'execa'

/** Rough 8-4-4-4-12 hex UUID shape — not strict (locize project IDs may evolve). */
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Opens the given URL in the user's default browser using the platform-native command.
 * Returns true on success, false if there's nowhere to open one (CI, headless Linux)
 * or if spawning the command failed.
 */
export async function openBrowser (url: string, opts: { ci?: boolean } = {}): Promise<boolean> {
  // Short-circuit: no point spawning a browser-opener in CI or headless Linux.
  if (opts.ci || process.env.CI === 'true') return false
  const isWSL = !!process.env.WSL_DISTRO_NAME
  if (
    process.platform === 'linux' && !isWSL &&
    !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
  ) {
    return false
  }

  try {
    if (process.platform === 'darwin') {
      await execa('open', [url], { stdio: 'ignore' })
    } else if (process.platform === 'win32') {
      // `start` is a cmd.exe builtin; the empty "" is the window-title slot
      await execa('cmd', ['/c', 'start', '""', url], { stdio: 'ignore' })
    } else if (isWSL) {
      // WSL: try the wslu / wsl-open shims that bridge to the Windows side
      // before falling back to xdg-open (which usually isn't installed there).
      try {
        await execa('wslview', [url], { stdio: 'ignore' })
      } catch {
        try {
          await execa('wsl-open', [url], { stdio: 'ignore' })
        } catch {
          await execa('xdg-open', [url], { stdio: 'ignore' })
        }
      }
    } else {
      await execa('xdg-open', [url], { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

/**
 * Prompts for Locize credentials (Project ID + optional API key) and returns them.
 * Warns (but does not block) when the Project ID does not look like a UUID.
 */
export async function promptLocizeCredentials (): Promise<{ projectId: string, apiKey?: string }> {
  const credentials = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectId',
      message: 'Locize Project ID (e.g. 4eeb5ce0-a7a7-453f-8eb3-078f6eeb56fe):',
      validate: (input: string) => input.trim().length > 0 || 'Project ID cannot be empty.',
      filter: (input: string) => input.trim(),
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'Locize API key (needed for saveMissing / auto-publish / sync during development; leave empty to skip and add later via env var):',
      filter: (input: string) => input.trim(),
    },
  ])

  if (!UUID_SHAPE.test(credentials.projectId)) {
    console.log("⚠️  The Project ID doesn't look like a UUID (8-4-4-4-12 hex). It will still be written — double-check it in your Locize project settings.")
  }
  // API keys come in multiple shapes (UUID, `lz_pat_…`, `lz_api_…`, etc.) —
  // treat them as opaque; no client-side format check.

  const result: { projectId: string, apiKey?: string } = { projectId: credentials.projectId }
  if (credentials.apiKey) result.apiKey = credentials.apiKey
  return result
}
