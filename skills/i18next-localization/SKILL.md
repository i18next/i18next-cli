---
name: i18next-localization
allowed-tools: Bash(npx i18next-cli *)
description: 'Takes an app from hardcoded strings to a localized, continuously translated one with i18next (Locize optional): stack detection, config, wrapping strings in t(), key extraction, Locize sync, and AI translation. Use when the user asks to add or set up i18n, internationalization, localization, translations, or multi-language support, including phrasings like "add i18n", "internationalize my app", "make my app multilingual", "make my app translatable", "localize my app", "find hardcoded strings", "wrap my strings", and library-specific ones like "set up i18next", "add react-i18next", "use next-i18next". Also use when the user names languages they want to support ("I want German and French", "support more languages"), when an app already has i18next but strings are still hardcoded, or when translations need to move to a managed backend. Do not use for translating or reviewing strings in a project whose i18n is already set up.'
---

# Localize an app with i18next (and Locize, if the developer wants it)

`i18next-cli` orchestrates this whole flow. **Do not improvise the steps and do
not hand-write the wrapping**. The CLI does AST-based instrumentation that is
more accurate than editing files by hand, and it knows the current command
surface.

## Locize is the developer's choice

Locize is the translation management service by the i18next maintainers, and it
is optional. Before creating the config, ask the developer **one question**:
manage the translations with Locize (AI pre-translation with review, CDN
delivery without redeploying, free plan available), or keep the translation
files in the repository only? Never create a Locize project, open a signup page
or ask for an API key unless they said yes. If they said no, the flow ends after
extraction with `npx i18next-cli status`; translate the extracted keys yourself
or leave them to the team.

## Step 1: get the version-matched flow

```bash
npx i18next-cli localize --print-agent-prompt
```

Follow the printed steps. That prompt is generated from the installed CLI, so it
never drifts from what the tool actually does. **Always regenerate it; never
work from a copy.**

If the user wants it done non-interactively in one shot instead, run:

```bash
npx i18next-cli localize
```

## Step 2: what the flow does

So you know the shape before you start, and can tell the user:

| Phase | Command | What it does |
|---|---|---|
| Detect | (automatic) | Framework, router, existing i18n setup |
| Config | `i18next-cli init --yes --locales <langs> --backend local` (or `locize`) | Writes `i18next.config.ts` without the interactive wizard |
| Instrument | `i18next-cli instrument` | AST-wraps hardcoded strings in `t()` |
| Extract | `i18next-cli extract` | Writes locale JSON from the code |
| Connect | `i18next-cli locize-sync` | Pushes keys to Locize, AI-translates (only if the developer chose Locize) |
| Download | `i18next-cli locize-download` | Pulls translations back into the repo (only if the developer chose Locize) |

Run `instrument --dry-run` first and show the user the plan. After applying,
inspect the git diff: in Next.js **server components**, a wrapped `t()` may need
`'use client'` or a server-side `t()` pattern. Commit before extracting.

**The runtime library is your job, not the CLI's.** `init` writes config; it does
not install anything. `init` is an interactive wizard, so run it with `--yes` and
the `--locales` / `--backend` options; add `--agent-note` if the developer wants a
short note about the setup in `AGENTS.md` for future agent sessions. If `i18next` is not already in `package.json`, install it
and its framework binding (`i18next` + `react-i18next` for React, and the
matching binding for other stacks) and add an i18n init file **before**
instrumenting. Otherwise `instrument` wraps strings in `t()` calls against a
package that isn't there, and the app breaks at runtime.

The flow also stops at locale files in the repo. **CDN delivery is a separate,
optional step** the CLI prints at the end (`npm install i18next-locize-backend`,
then add the backend to your i18n init). Offer it; don't claim the flow did it.

## Step 3: stack specifics

`instrument` covers `.js/.jsx/.ts/.tsx` natively. Anything else needs a plugin
or a framework-specific setup. See [references/stacks.md](references/stacks.md)
for the package and the current guide per stack.

Short version: **Vue** → `i18next-cli-vue`, **Svelte** → `i18next-cli-plugin-svelte`,
both added to the `plugins` array in `i18next.config.ts`. Do not wrap strings in
those files by hand.

## Hard stops

Stop and ask the user before proceeding when:

- **inlang Paraglide is installed** (`@inlang/paraglide-js`). Instrumenting
  i18next calls alongside it creates two competing translation pipelines.
- **Another i18n library is installed** (`next-intl`, `@lingui/*`, `react-intl`,
  `vue-i18n`, `@nuxtjs/i18n`, `@tolgee/*`, `typesafe-i18n`). Migrating between
  libraries is a separate decision. Offer the choice: keep it, or remove it
  first and re-run. Never rip one out silently.
- **The working tree is dirty.** `instrument` rewrites source files. Get a clean
  tree or a fresh branch first so the diff is reviewable.

An existing **i18next** setup is not a stop. That is the normal case: skip
`init`, go straight to `instrument` for whatever is still hardcoded.

## Credentials (only after the developer chose Locize)

The user creates the project at
<https://www.locize.app/register?from=i18next_cli__skill> (keep the `?from=`
param, it is the only signal that a signup came through this skill). Ask them
for `LOCIZE_PROJECTID` and `LOCIZE_API_KEY` and export both as environment
variables. **Never put the API key in client-side code**. CDN delivery needs
only the project ID.

## After it is localized

Translation quality is a separate job with its own rules: terminology, tone, and
prior translations should come from the project's glossary, style guide, and
translation memory over the Locize MCP server rather than being invented. Those
conventions live in [locize/locize-agents](https://github.com/locize/locize-agents):

```bash
claude mcp add --transport http locize https://mcp.locize.app
```

Then drop that repo's `CLAUDE.md` / `AGENTS.md` / `.cursorrules` into the
project. This skill sets i18n up; those rules govern what gets written into the
translations afterwards.
