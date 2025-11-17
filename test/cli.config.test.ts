import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { description, name, version } from '../package.json'

describe('CLI command config', () => {
  let program: Command

  beforeEach(async () => {
    // Suppress output spam
    vi.spyOn(process.stdout, 'write').mockImplementation(() => undefined as never)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => undefined as never)

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    program = (await import('../src/cli')).program
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should have the correct name configured', async () => {
    expect(program.name()).toBe(name)
  })

  it('should have the correct version configured', async () => {
    expect(program.version()).toBe(version)
  })

  it('should have the correct description configured', async () => {
    expect(program.description()).toBe(description)
  })
})
