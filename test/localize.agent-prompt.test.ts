import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_PROMPT } from '../src/localize/agent-prompt'

/**
 * Drift guard: the agent prompt is the copy-paste variant of the `localize`
 * flow. If the orchestrated steps change, this test forces the prompt to be
 * updated alongside them.
 */
describe('AGENT_PROMPT', () => {
  it('mentions every command the localize flow orchestrates', () => {
    const orchestratedCommands = [
      'i18next-cli init',
      'i18next-cli instrument --dry-run',
      'i18next-cli instrument',
      'i18next-cli extract',
      'i18next-cli locize-sync --auto-translate true',
      'i18next-cli locize-download',
      'i18next-cli status',
    ]
    for (const command of orchestratedCommands) {
      expect(AGENT_PROMPT).toContain(command)
    }
  })

  it('covers the plugin guidance for non-React stacks and the Paraglide guard', () => {
    expect(AGENT_PROMPT).toContain('i18next-cli-vue')
    expect(AGENT_PROMPT).toContain('i18next-cli-plugin-svelte')
    expect(AGENT_PROMPT).toContain('@inlang/paraglide-js')
  })

  it('explains the new-project defaults and credential handling', () => {
    expect(AGENT_PROMPT).toContain('LOCIZE_PROJECTID')
    expect(AGENT_PROMPT).toContain('LOCIZE_API_KEY')
    expect(AGENT_PROMPT).toMatch(/enabled by default for new\s+projects/)
    expect(AGENT_PROMPT).toMatch(/NEVER put the API key\s+in client-side code/)
  })

  it('matches the snapshot embedded in the README', async () => {
    const readme = await readFile(resolve(__dirname, '..', 'README.md'), 'utf-8')
    const snapshot = readme.match(/<summary>Agent prompt \(snapshot\)<\/summary>\s*```text\n([\s\S]*?)```/)
    expect(snapshot, 'README must contain the agent-prompt snapshot block').not.toBeNull()
    expect(snapshot![1].trim()).toBe(AGENT_PROMPT.trim())
  })
})
