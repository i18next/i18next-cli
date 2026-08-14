import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_PROMPT } from '../src/localize/agent-prompt'

/** Commands the `localize` flow drives, without their flags. */
const ORCHESTRATED_COMMANDS = [
  'i18next-cli init',
  'i18next-cli instrument',
  'i18next-cli extract',
  'i18next-cli locize-sync',
  'i18next-cli locize-download',
]

/**
 * Drift guard: the agent prompt is the copy-paste variant of the `localize`
 * flow. If the orchestrated steps change, this test forces the prompt to be
 * updated alongside them.
 */
describe('AGENT_PROMPT', () => {
  it('mentions every command the localize flow orchestrates', () => {
    const orchestratedCommands = [
      ...ORCHESTRATED_COMMANDS,
      'i18next-cli instrument --dry-run',
      'i18next-cli locize-sync --auto-translate true',
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
    // Normalize CRLF first — on Windows the README may be checked out with
    // autocrlf line endings.
    const readme = (await readFile(resolve(__dirname, '..', 'README.md'), 'utf-8')).replace(/\r\n/g, '\n')
    const snapshot = readme.match(/<summary>Agent prompt \(snapshot\)<\/summary>\s*```text\n([\s\S]*?)```/)
    expect(snapshot, 'README must contain the agent-prompt snapshot block').not.toBeNull()
    expect(snapshot![1].trim()).toBe(AGENT_PROMPT.trim())
  })
})

/**
 * The installable Agent Skill (`npx skills add i18next/i18next-cli`) deliberately
 * does not embed a copy of AGENT_PROMPT — it tells the agent to regenerate it via
 * `--print-agent-prompt`, so it cannot drift. What it *can* get wrong is the
 * delegation contract and its own loadability, so guard those.
 */
describe('i18next-localization skill', () => {
  const skillDir = resolve(__dirname, '..', 'skills', 'i18next-localization')
  const readSkill = () => readFile(resolve(skillDir, 'SKILL.md'), 'utf-8').then((s) => s.replace(/\r\n/g, '\n'))

  it('has frontmatter within the Agent Skills spec limits', async () => {
    // Violating any of these makes the skill silently fail to load rather than error:
    // name <= 64 chars, lowercase/digits/hyphens, no "anthropic"/"claude"; description
    // non-empty and <= 1024 chars. Neither may contain XML tags.
    const skill = await readSkill()
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)
    expect(frontmatter, 'frontmatter must open on line 1').not.toBeNull()

    const name = frontmatter![1].match(/^name:[ \t]*(.+)$/m)?.[1].trim()
    expect(name, 'name must match the skill directory').toBe('i18next-localization')
    expect(name!.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(/^[a-z0-9-]+$/)
    expect(name).not.toMatch(/anthropic|claude/i)

    // Folded scalar (`>-`): un-indent the continuation lines to get the real length.
    const description = frontmatter![1]
      .replace(/^[\s\S]*?^description:[ \t]*>-?[ \t]*\n/m, '')
      .replace(/\n[ \t]+/g, ' ')
      .trim()
    expect(description.length, 'description must be non-empty').toBeGreaterThan(0)
    expect(description.length, 'description exceeds the 1024-char spec limit').toBeLessThanOrEqual(1024)
    expect(name! + description, 'no XML tags allowed').not.toMatch(/<[a-zA-Z/]/)
  })

  it('delegates to --print-agent-prompt rather than snapshotting the steps', async () => {
    const skill = await readSkill()
    expect(skill).toContain('i18next-cli localize --print-agent-prompt')
    // A copied prompt would drift silently; the skill must not carry one.
    expect(skill).not.toContain(AGENT_PROMPT.slice(0, 80))
  })

  it('mentions every orchestrated command, the stack plugins and the Paraglide guard', async () => {
    const skill = await readSkill()
    for (const command of ORCHESTRATED_COMMANDS) expect(skill).toContain(command)
    expect(skill).toContain('i18next-cli-vue')
    expect(skill).toContain('i18next-cli-plugin-svelte')
    expect(skill).toContain('@inlang/paraglide-js')
  })

  it('has no dead relative links', async () => {
    const skill = await readSkill()
    const links = [...skill.matchAll(/]\(([^)#]+)\)/g)]
      .map((m) => m[1])
      .filter((href) => !href.startsWith('http'))
    expect(links.length, 'expected at least one relative reference link').toBeGreaterThan(0)
    for (const href of links) {
      expect(existsSync(resolve(skillDir, href)), `dead link -> ${href}`).toBe(true)
    }
  })
})
