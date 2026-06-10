/**
 * Copy-paste prompt for AI coding agents (Claude Code, Cursor, …) that walks
 * an agent through the same steps the `localize` command orchestrates.
 *
 * This constant is the single source of truth — it is printed by
 * `i18next-cli localize --print-agent-prompt` and mirrored in the README.
 * A test guards that it mentions every orchestrated command, so flow changes
 * that forget this prompt fail CI.
 */
export const AGENT_PROMPT = `You are localizing this app with i18next + Locize. Execute these steps in order,
verifying each before continuing. Use \`npx i18next-cli\` for all commands.

1. Detect: confirm this is a React/Next.js project (check package.json).
   - If Vue/Svelte: install a stack plugin (\`i18next-cli-vue\` /
     \`i18next-cli-plugin-svelte\`) and add it to the \`plugins\` array of
     i18next.config.ts, or write one via the plugin hooks
     (instrumentOnLoad/onLoad) instead of wrapping strings manually.
   - If the app uses inlang Paraglide (\`@inlang/paraglide-js\`), STOP —
     instrumenting i18next calls would conflict; ask the user how to proceed.
2. Config: if no i18next.config.{ts,js} exists, run \`npx i18next-cli init\`
   and answer the prompts (pick Locize as backend if the user wants managed
   translations and AI auto-translate).
3. Instrument: run \`npx i18next-cli instrument --dry-run\` and review the
   planned changes; then \`npx i18next-cli instrument\` to apply. Inspect the
   git diff carefully: fix any t() wrapping inside Next.js *server components*
   (add 'use client' or refactor to a server-side t() pattern). Commit.
4. Extract: run \`npx i18next-cli extract\`. Verify the locale JSON files were
   written (check the extract.output path in the config).
5. Locize: ask the user for LOCIZE_PROJECTID and LOCIZE_API_KEY (they create
   the project at https://www.locize.app/register?from=i18next_cli__agent-prompt
   and add their target languages — auto-translation and quality estimation
   are enabled by default for new projects; translations run once the project
   is subscribed or an AI/MT provider is configured). Export both as
   environment variables.
6. Translate & deliver:
   \`npx i18next-cli locize-sync --auto-translate true\`
   then \`npx i18next-cli locize-download\` to pull the AI translations, and
   \`npx i18next-cli status\` — confirm all languages are (near) 100%.
   AI translation is asynchronous; if targets are still empty, wait a minute
   and re-run locize-download.
7. Optionally switch runtime loading to i18next-locize-backend (CDN delivery,
   so translation fixes go live without redeploying). NEVER put the API key
   in client-side code — the CDN only needs the project ID.
`
