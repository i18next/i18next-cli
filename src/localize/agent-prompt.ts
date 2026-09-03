/**
 * Copy-paste prompt for AI coding agents (Claude Code, Cursor, …) that walks
 * an agent through the same steps the `localize` command orchestrates.
 *
 * This constant is the single source of truth — it is printed by
 * `i18next-cli localize --print-agent-prompt` and mirrored in the README.
 * A test guards that it mentions every orchestrated command, so flow changes
 * that forget this prompt fail CI.
 *
 * Locize is optional in this flow: the developer is asked once (step 2) and
 * nothing Locize-related happens unless they said yes.
 */
export const AGENT_PROMPT = `You are localizing this app with i18next. Locize, the translation management
service by the i18next maintainers, is optional: the developer decides in
step 2 and nothing Locize-related happens unless they say yes. Execute these
steps in order, verifying each before continuing. Use \`npx i18next-cli\` for
all commands.

1. Detect: confirm this is a React/Next.js project (check package.json).
   - If Vue/Svelte: install a stack plugin (\`i18next-cli-vue\` /
     \`i18next-cli-plugin-svelte\`) and add it to the \`plugins\` array of
     i18next.config.ts, or write one via the plugin hooks
     (instrumentOnLoad/onLoad) instead of wrapping strings manually.
   - If the app uses inlang Paraglide (\`@inlang/paraglide-js\`), STOP:
     instrumenting i18next calls would conflict; ask the user how to proceed.
2. Ask, then configure: if no i18next.config.{ts,js} exists, ask the
   developer one question before anything else: "Do you want to manage the
   translations with Locize (AI pre-translation with review, CDN delivery
   without redeploying, free plan available), or keep the translation files
   in the repository only?" Then create the config without the wizard:
   \`npx i18next-cli init --yes --locales <langs> --backend local\` or
   \`--backend locize --project-id <id>\` (add --input/--output if the
   detected paths are wrong). Do not create a Locize project, open a signup
   page or ask for an API key unless they chose Locize. Offer
   \`--agent-note\`, which adds a short note about the setup to AGENTS.md
   for future agent sessions.
3. Instrument: run \`npx i18next-cli instrument --dry-run\` and review the
   planned changes; then \`npx i18next-cli instrument\` to apply. Inspect the
   git diff carefully: fix any t() wrapping inside Next.js *server components*
   (add 'use client' or refactor to a server-side t() pattern). Commit.
4. Extract: run \`npx i18next-cli extract\`. Verify the locale JSON files were
   written (check the extract.output path in the config). If the developer
   chose repository files only: translate the extracted keys yourself or
   leave them to the team, run \`npx i18next-cli status\` to confirm every
   language is complete, and stop here.
5. Locize (only if the developer chose it in step 2): ask them for
   LOCIZE_PROJECTID and LOCIZE_API_KEY (they create the project at
   https://www.locize.app/register?from=i18next_cli__agent-prompt
   any write-capable API key works; the target languages from
   i18next.config.ts are created automatically on the first sync.
   Auto-translation and quality estimation are enabled by default for new
   projects; translations run once the project is subscribed or an AI/MT
   provider is configured). Export both as environment variables.
6. Translate & deliver (Locize only):
   \`npx i18next-cli locize-sync --auto-translate true\`
   then \`npx i18next-cli locize-download\` to pull the AI translations, and
   \`npx i18next-cli status\` to confirm all languages are (near) 100%.
   AI translation is asynchronous; if targets are still empty, wait a minute
   and re-run locize-download.
7. Optionally (Locize only) switch runtime loading to i18next-locize-backend
   (CDN delivery, so translation fixes go live without redeploying).
   NEVER put the API key in client-side code; the CDN only needs the
   project ID.
`
