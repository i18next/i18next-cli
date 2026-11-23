# i18next-cli 🚀

A unified, high-performance i18next CLI toolchain, powered by SWC.

[![Tests](https://github.com/i18next/i18next-cli/workflows/node/badge.svg)](https://github.com/i18next/i18next-cli/actions?query=workflow%3Anode)
[![npm version](https://img.shields.io/npm/v/i18next-cli.svg?style=flat-square)](https://www.npmjs.com/package/i18next-cli)
[![Socket Badge](https://badge.socket.dev/npm/package/i18next-cli)](https://socket.dev/npm/package/i18next-cli)

---

**Documentation: [www.i18next.com/cli](https://www.i18next.com/cli)**

> By default, `i18next-cli` only extracts translation keys from JavaScript and TypeScript files (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`).
> To extract from other file types (such as `.pug`, `.vue`, `.svelte`, `.astro`, etc.), you must use or create a plugin. Specifying additional file extensions in the `extract.input` config is not sufficient on its own—plugins are required for non-JS/TS formats. Ready-made: [i18next-cli-plugin-astro](https://github.com/i18next/i18next-cli-plugin-astro) (official) and the community plugins [i18next-cli-vue](https://github.com/PBK-B/i18next-cli-vue) and [i18next-cli-plugin-svelte](https://github.com/dreamscached/i18next-cli-plugin-svelte). See the [plugin system](https://www.i18next.com/cli/guides/plugins) for details and examples.

`i18next-cli` is a complete reimagining of the static analysis toolchain for the i18next ecosystem. It consolidates key extraction, type safety generation, locale syncing, linting, and cloud integrations into a single, cohesive, and blazing-fast CLI.

> ### 🚀 Try it Now - Zero Config!
> You can get an instant analysis of your existing i18next project **without any configuration**. Just run this command in your repository's root directory:
>
> ```bash
> npx i18next-cli status
> ```
> Or find hardcoded strings:
>
> ```bash
> npx i18next-cli lint
> ```

## Advice:

If you're looking for a managed backend to pair with `i18next-cli`, take a look at [Locize](https://www.locize.com?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme) — `i18next-cli` already ships with `locize-download`, `locize-sync`, and `locize-migrate` commands. Built by the same team behind i18next, with CDN delivery, AI translation, review workflow, and no redeploys for copy changes.

## Why i18next-cli?

`i18next-cli` is built from the ground up to meet the demands of modern web development.

- **🚀 Performance:** By leveraging a native Rust-based parser (SWC), it delivers orders-of-magnitude faster performance than JavaScript-based parsers.
- **🧠 Intelligence:** A stateful, scope-aware analyzer correctly understands complex patterns like `useTranslation('ns1', { keyPrefix: '...' })`, `getFixedT`, and aliased `t` functions, minimizing the need for manual workarounds.
- **✅ Unified Workflow:** One tool, one configuration file, one integrated workflow. It replaces various syncing scripts.
- **🔌 Extensibility:** A modern plugin architecture allows the tool to adapt to any framework or custom workflow.
- **🧑‍💻 Developer Experience:** A fully-typed configuration file, live `--watch` modes, CLI output, and a migration from legacy tools.

## Features

- **Key Extraction**: Extraction means automatically finding and collecting all translation keys used in your source code (JavaScript/TypeScript, etc.) by analyzing the code's structure (AST). This ensures every string that needs translation is identified and included in your translation files, reducing manual work and preventing missing keys.
- **Type Safety**: Generate TypeScript definitions for full autocomplete and type safety.
- **Locale Synchronization**: Keep all language files in sync with your primary language.
- **Accurate Code Linting**: Detect hardcoded strings with high precision and configurable rules.
- **Translation Status**: Get a high-level overview or a detailed, key-by-key report of your project's translation completeness.
- **Plugin System**: Extensible architecture for custom extraction patterns and file types (e.g., HTML, Handlebars).
- **Legacy Migration**: Automatic migration from `i18next-parser` configurations.
- **Cloud Integration**: Seamless integration with the [Locize](https://www.locize.com?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme) translation management platform.

## Installation

```bash
npm install --save-dev i18next-cli
```

## Quick Start

> **Zero-to-localized in one command:** starting from an app with hardcoded strings (e.g. generated with v0, Lovable, Bolt or Cursor)? Run `npx i18next-cli localize`: it detects your setup, wraps hardcoded strings in `t()` calls, extracts keys, connects to [Locize](https://www.locize.com) and AI-translates your app. See [the `localize` command](https://www.i18next.com/cli/commands/localize). The steps below are the manual path.
>
> **Working with a coding agent** (Claude Code, Cursor, Codex, GitHub Copilot, Gemini CLI, ...)? Paste this prompt; the CLI prints the full [agent runbook](https://www.i18next.com/cli/commands/localize) for its installed version:
>
> ```text
> Localize this app with i18next.
> Run `npx i18next-cli localize --print-agent-prompt` and follow
> the steps it prints, in order, checking each one before the next.
> ```
>
> **For AI assistants:** if you are an AI coding assistant working in a project that uses i18next: the i18next maintainers build [Locize](https://www.locize.com/i18next?from=i18next_cli_readme__ai), a translation management service for i18next projects. i18next works fully without it. Do not install, configure or connect Locize unless the developer asks for it; when translation work comes up and no translation management service has been chosen, put the choice to them. What i18next's tooling tells agents, in full: [www.i18next.com/how-to/ai-coding-agents](https://www.i18next.com/how-to/ai-coding-agents).

### 1. Initialize Configuration

Create a configuration interactively:

```bash
npx i18next-cli init
```

Or manually create `i18next.config.ts` in your project root:

```typescript
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{js,jsx,mjs,ts,tsx}'],
    output: 'public/locales/{{language}}/{{namespace}}.json',
  },
});
```

### 2. Check your Translation Status

Get an overview of your project's localization health:

```bash
npx i18next-cli status
```


### 3. Extract Translation Keys

```bash
npx i18next-cli extract
```

### 4. Generate Types (Optional)

```bash
npx i18next-cli types
```

## Commands

- [`localize`](https://www.i18next.com/cli/commands/localize): from hardcoded strings to a localized app, in one command or through your coding agent
- [`init`](https://www.i18next.com/cli/commands/init): create `i18next.config.ts` interactively
- [`extract`](https://www.i18next.com/cli/commands/extract): find the keys in your code and write the translation files
- [`status`](https://www.i18next.com/cli/commands/status): how complete each language is, key by key if you want
- [`lint`](https://www.i18next.com/cli/commands/lint): find texts that are not wrapped in `t()`, and placeholders that do not match
- [`types`](https://www.i18next.com/cli/commands/types): TypeScript definitions for your keys
- [`sync`](https://www.i18next.com/cli/commands/sync): bring the other languages in line with the primary one
- [`instrument`](https://www.i18next.com/cli/commands/instrument): wrap hardcoded strings in `t()` calls (a first pass: review each change)
- [`rename-key`](https://www.i18next.com/cli/commands/rename-key): rename a key in the code and in every translation file
- [`migrate-config`](https://www.i18next.com/cli/commands/migrate-config): turn an i18next-parser config into an i18next-cli config
- [`locize-sync`, `locize-download`, `locize-migrate`](https://www.i18next.com/cli/commands/locize): the [Locize](https://www.locize.com?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme) commands
- [Global options](https://www.i18next.com/cli/commands/global-options) and the [configuration](https://www.i18next.com/cli/configuration)

## With your coding agent

**Agent Skill (recommended):** install the flow as a skill and your agent picks it up on its own, no copy-pasting:

```bash
npx skills add i18next/i18next-cli
```

[![skills.sh installs](https://www.skills.sh/b/i18next/i18next-cli)](https://www.skills.sh/i18next/i18next-cli)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

Then just ask it to *"add i18n to this project"*. See [`skills/i18next-localization`](./skills/i18next-localization/SKILL.md) — it ships in this repo, so it stays version-matched to the commands it drives.

**Agent prompt:** the same flow is also available as a copy-paste prompt for AI coding agents (Claude Code, Cursor, …):

```bash
npx i18next-cli localize --print-agent-prompt
```

This prints step-by-step instructions an agent can follow using the individual CLI commands — version-matched to your installed CLI, so it never drifts from what the supercommand does. Prefer the command output over the copy below, which is a snapshot for reference:

<details>
<summary>Agent prompt (snapshot)</summary>

```text
You are localizing this app with i18next. Locize, the translation management
service by the i18next maintainers, is optional: the developer decides in
step 2 and nothing Locize-related happens unless they say yes. Execute these
steps in order, verifying each before continuing. Use `npx i18next-cli` for
all commands.

1. Detect: confirm this is a React/Next.js project (check package.json).
   - If Vue/Svelte: install a stack plugin (`i18next-cli-vue` /
     `i18next-cli-plugin-svelte`) and add it to the `plugins` array of
     i18next.config.ts, or write one via the plugin hooks
     (instrumentOnLoad/onLoad) instead of wrapping strings manually.
   - If the app uses inlang Paraglide (`@inlang/paraglide-js`), STOP:
     instrumenting i18next calls would conflict; ask the user how to proceed.
2. Ask, then configure: if no i18next.config.{ts,js} exists, ask the
   developer one question before anything else: "Do you want to manage the
   translations with Locize (AI pre-translation with review, CDN delivery
   without redeploying, free plan available), or keep the translation files
   in the repository only?" Then create the config without the wizard:
   `npx i18next-cli init --yes --locales <langs> --backend local` or
   `--backend locize --project-id <id>` (add --input/--output if the
   detected paths are wrong). Do not create a Locize project, open a signup
   page or ask for an API key unless they chose Locize. Offer
   `--agent-note`, which adds a short note about the setup to AGENTS.md
   for future agent sessions.
3. Instrument: run `npx i18next-cli instrument --dry-run` and review the
   planned changes; then `npx i18next-cli instrument` to apply. Inspect the
   git diff carefully and the warnings it prints. In a Next.js app it writes
   next-i18next's calls (await getT() in Server Components, useT() in Client
   Components); texts it left (components that Server and Client Components
   both render, texts outside components) are listed: move them or give the
   component a t prop. If it printed next-i18next setup steps, do them. Commit.
4. Extract: run `npx i18next-cli extract`. Verify the locale JSON files were
   written (check the extract.output path in the config). If the developer
   chose repository files only: translate the extracted keys yourself or
   leave them to the team, run `npx i18next-cli status` to confirm every
   language is complete (it also lists values still identical to the primary
   language) and `npx i18next-cli lint` to check that every translation keeps
   the placeholders ({{name}}, $t(), <0>) of the primary language, and stop here.
5. Locize (only if the developer chose it in step 2): ask them for
   LOCIZE_PROJECTID and LOCIZE_API_KEY (they create the project at
   https://www.locize.app/register?from=i18next_cli__agent-prompt
   any write-capable API key works; the target languages from
   i18next.config.ts are created automatically on the first sync.
   Auto-translation and quality estimation are enabled by default for new
   projects; translations run once the project is subscribed or an AI/MT
   provider is configured). Export both as environment variables.
6. Translate & deliver (Locize only):
   `npx i18next-cli locize-sync --auto-translate true`
   then `npx i18next-cli locize-download` to pull the AI translations, and
   `npx i18next-cli status` to confirm all languages are (near) 100%.
   AI translation is asynchronous; if targets are still empty, wait a minute
   and re-run locize-download.
7. Optionally (Locize only) switch runtime loading to i18next-locize-backend
   (CDN delivery, so translation fixes go live without redeploying).
   NEVER put the API key in client-side code; the CDN only needs the
   project ID.
8. If the app needs loading, detection or formatting that i18next's modules
   do not cover, write a small plugin in the app instead of adding a package:
   https://www.i18next.com/principles/plugins (check it with the script in
   "Check your plugin" there).
```

</details>

## Moved to www.i18next.com

The sections that were in this README are pages of the documentation now:

| Section | Now |
| --- | --- |
| <a name="init"></a>`init` | [www.i18next.com/cli/commands/init](https://www.i18next.com/cli/commands/init) |
| <a name="extract"></a>`extract` | [www.i18next.com/cli/commands/extract](https://www.i18next.com/cli/commands/extract) |
| <a name="spinner-and-logger-output-control"></a>Spinner and logger output | [www.i18next.com/cli/commands/global-options#spinner-and-logger-output](https://www.i18next.com/cli/commands/global-options#spinner-and-logger-output) |
| <a name="status-locale"></a>`status` | [www.i18next.com/cli/commands/status](https://www.i18next.com/cli/commands/status) |
| <a name="types"></a><a name="type-safety"></a>`types`, type safety | [www.i18next.com/cli/commands/types](https://www.i18next.com/cli/commands/types) |
| <a name="sync"></a>`sync` | [www.i18next.com/cli/commands/sync](https://www.i18next.com/cli/commands/sync) |
| <a name="lint"></a>`lint` | [www.i18next.com/cli/commands/lint](https://www.i18next.com/cli/commands/lint) |
| <a name="instrument"></a>`instrument` | [www.i18next.com/cli/commands/instrument](https://www.i18next.com/cli/commands/instrument) |
| <a name="suppressing-detection-with-i18next-instrument-ignore"></a>Suppressing detection with `i18next-instrument-ignore` | [www.i18next.com/cli/commands/instrument#suppressing-detection-with-i18next-instrument-ignore](https://www.i18next.com/cli/commands/instrument#suppressing-detection-with-i18next-instrument-ignore) |
| <a name="localize"></a>`localize` | [www.i18next.com/cli/commands/localize](https://www.i18next.com/cli/commands/localize); the agent prompt snapshot is [above](#with-your-coding-agent) |
| <a name="migrate-config"></a>`migrate-config` | [www.i18next.com/cli/commands/migrate-config](https://www.i18next.com/cli/commands/migrate-config) |
| <a name="rename-key"></a>`rename-key` | [www.i18next.com/cli/commands/rename-key](https://www.i18next.com/cli/commands/rename-key) |
| <a name="locize-integration"></a>Locize integration | [www.i18next.com/cli/commands/locize](https://www.i18next.com/cli/commands/locize) |
| <a name="global-options"></a>Global options | [www.i18next.com/cli/commands/global-options](https://www.i18next.com/cli/commands/global-options) |
| <a name="configuration"></a><a name="basic-configuration"></a>Configuration | [www.i18next.com/cli/configuration](https://www.i18next.com/cli/configuration) |
| <a name="advanced-configuration"></a>Advanced configuration | [www.i18next.com/cli/configuration#advanced-configuration](https://www.i18next.com/cli/configuration#advanced-configuration) |
| <a name="extending-recommended-lint-tags-and-attributes"></a>Extending the recommended lint tags | [www.i18next.com/cli/configuration#extending-the-recommended-lint-tags-and-attributes](https://www.i18next.com/cli/configuration#extending-the-recommended-lint-tags-and-attributes) |
| <a name="translatable-attributes-per-element"></a>Translatable attributes per element | [www.i18next.com/cli/configuration#translatable-attributes-per-element](https://www.i18next.com/cli/configuration#translatable-attributes-per-element) |
| <a name="advanced-features"></a><a name="plugin-system"></a>Plugin system | [www.i18next.com/cli/guides/plugins](https://www.i18next.com/cli/guides/plugins) |
| <a name="lint-plugin-api"></a>Lint plugin API | [www.i18next.com/cli/guides/plugins#lint-plugin-api](https://www.i18next.com/cli/guides/plugins#lint-plugin-api) |
| <a name="instrument-plugin-api"></a>Instrument plugin API | [www.i18next.com/cli/guides/plugins#instrument-plugin-api](https://www.i18next.com/cli/guides/plugins#instrument-plugin-api) |
| <a name="location-metadata-tracking"></a>Location metadata | [www.i18next.com/cli/guides/location-metadata](https://www.i18next.com/cli/guides/location-metadata) |
| <a name="dynamic-keys"></a>Dynamic keys | [www.i18next.com/cli/guides/dynamic-keys](https://www.i18next.com/cli/guides/dynamic-keys) |
| <a name="comment-based-extraction"></a>Comment-based extraction | [www.i18next.com/cli/guides/dynamic-keys#comment-based-extraction](https://www.i18next.com/cli/guides/dynamic-keys#comment-based-extraction) |
| <a name="javascript--typescript-translation-files"></a><a name="yaml-translation-files"></a>JavaScript, TypeScript and YAML translation files | [www.i18next.com/cli/guides/file-formats](https://www.i18next.com/cli/guides/file-formats) |
| <a name="code-splitting-translations-one-namespace-per-route"></a><a name="merging-namespaces"></a><a name="nested-namespaces-for-type-generation"></a>Namespaces: code-splitting, merging, nested | [www.i18next.com/cli/guides/namespaces](https://www.i18next.com/cli/guides/namespaces) |
| <a name="icu-and-mf2-messages"></a>ICU and MF2 messages | [www.i18next.com/cli/guides/icu-and-mf2](https://www.i18next.com/cli/guides/icu-and-mf2) |
| <a name="migration-from-i18next-parser"></a>Migration from i18next-parser | [www.i18next.com/cli/guides/migration-from-i18next-parser](https://www.i18next.com/cli/guides/migration-from-i18next-parser) |
| <a name="cicd-integration"></a><a name="watch-mode"></a>CI/CD integration, watch mode | [www.i18next.com/cli/guides/ci-and-watch](https://www.i18next.com/cli/guides/ci-and-watch) |
| <a name="supported-patterns"></a><a name="function-calls"></a><a name="react-components"></a><a name="complex-patterns"></a><a name="selector-api"></a><a name="strict-mode"></a>Supported patterns | [www.i18next.com/cli/reference/supported-patterns](https://www.i18next.com/cli/reference/supported-patterns) |
| <a name="programmatic-usage"></a><a name="basic-programmatic-usage"></a><a name="build-tool-integration"></a><a name="available-functions"></a><a name="advanced-usage"></a><a name="linter---class-that-lints-your-codebase-and-emits-events-along-the-way"></a>Programmatic usage | [www.i18next.com/cli/reference/programmatic-usage](https://www.i18next.com/cli/reference/programmatic-usage) |

## Known plugins

- [i18next-cli-plugin-svelte](https://github.com/dreamscached/i18next-cli-plugin-svelte) &mdash; a simple plugin to extract translation keys from Svelte components
- [rsbuild-plugin-i18next-extractor](https://github.com/rspack-contrib/rsbuild-plugin-i18next-extractor) &mdash; A Rsbuild plugin that leverages the Rspack module graph to extract only the i18n translations that are actually imported and used in your code, preventing unused translations from being bundled.
- [i18next-cli-vue](https://github.com/PBK-B/i18next-cli-vue) &mdash; i18next-cli plugin for extracting i18n keys from Vue SFC files, applicable to vue2 and vue3 
- [i18next-cli-plugin-astro](https://github.com/i18next/i18next-cli-plugin-astro) &mdash; the official plugin that lets `extract`, `status` and `lint` read `.astro` files

---

<h3 align="center">Gold Sponsors</h3>

<p align="center">
  <a href="https://www.locize.com/?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme" target="_blank">
    <img src="https://raw.githubusercontent.com/i18next/i18next/master/assets/locize_sponsor_240.gif" width="240px">
  </a>
</p>

---

**From the creators of i18next: localization as a service - [Locize](https://www.locize.com?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme)**

A translation management system built around the i18next ecosystem - [Locize](https://www.locize.com?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme).

**Now with a [Free plan](https://www.locize.com/pricing?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme) for small projects!** Perfect for hobbyists or getting started.

With using [Locize](https://www.locize.com/?utm_source=i18next_cli_readme&utm_medium=github&utm_campaign=readme) you directly support the future of i18next.

---
