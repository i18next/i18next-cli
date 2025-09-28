# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0](https://github.com/i18next/i18next-cli/compare/v0.9.15...v1.0.0) - 2025-xx-yy

- not yet released

## [0.9.15](https://github.com/i18next/i18next-cli/compare/v0.9.14...v0.9.15) - 2025-09-28

- **Config Loader:** Fixed a tricky crash that occurred when loading an `i18next.config.ts` file with dependencies that use certain module patterns (e.g., `zod`). This was resolved by disabling `jiti`'s CJS/ESM interoperability layer to ensure modules are imported reliably. [#8](https://github.com/i18next/i18next-cli/issues/8)

## [0.9.14](https://github.com/i18next/i18next-cli/compare/v0.9.13...v0.9.14) - 2025-09-28

- **Config Loader:** Added support for TypeScript path aliases in the `i18next.config.ts` file. The tool now automatically finds and parses your project's `tsconfig.json` (searching upwards from the current directory), allowing you to use aliases like `@/...` to import shared settings or constants into your configuration. [#7](https://github.com/i18next/i18next-cli/issues/7)

## [0.9.13](https://github.com/i18next/i18next-cli/compare/v0.9.12...v0.9.13) - 2025-09-27

- **Linter & Extractor:** Fixed a parser crash that occurred when analyzing TypeScript files containing decorator syntax. Both the `lint` and `extract` commands will now correctly process files that use decorators. [#6](https://github.com/i18next/i18next-cli/issues/6)

## [0.9.12](https://github.com/i18next/i18next-cli/compare/v0.9.11...v0.9.12) - 2025-09-27

### Added
- **CLI:** The `init` command is now smarter. It uses a heuristic scan of the project to suggest tailored defaults for locales and file paths in the interactive setup wizard.

### Fixed
- **CLI:** Fixed a critical bug where the `types` command would hang without exiting after generating files if they already existed. [#5](https://github.com/i18next/i18next-cli/issues/5)
- **Types Generator:** Corrected an issue where default configuration values were not being applied, causing the `types` command to fail if the `types` property was not explicitly defined in the config file.

## [0.9.11](https://github.com/i18next/i18next-cli/compare/v0.9.10...v0.9.11) - 2025-09-26

### Added
- **Extractor:** Added support for plural-specific default values (e.g., `defaultValue_other`, `defaultValue_two`) in `t()` function options. [#3](https://github.com/i18next/i18next-cli/issues/3)
- **Extractor:** Added support for ordinal plurals (e.g., `t('key', { count: 1, ordinal: true })`), generating the correct suffixed keys (`key_ordinal_one`, `key_ordinal_two`, etc.) for all languages.

### Fixed
- **Extractor:** Fixed an issue where the AST walker would not find `t()` calls inside nested functions, such as an `array.map()` callback, within JSX. [#4](https://github.com/i18next/i18next-cli/issues/4)

## [0.9.10] - 2025-09-25(https://github.com/i18next/i18next-cli/compare/v0.9.9...v0.9.10)

### Added
- **JavaScript/TypeScript Translation Files:** Added the `outputFormat` option to support generating translation files as `.json` (default), `.js` (ESM or CJS), or `.ts` modules.
- **Merged Namespace Files:** Added the `mergeNamespaces` option to combine all namespaces into a single file per language, streamlining imports and file structures.

## [0.9.9] - 2025-09-25(https://github.com/i18next/i18next-cli/compare/v0.9.8...v0.9.9)

- **Extractor:** Now supports static and dynamic (ternary) `context` options in both `t()` and `<Trans>`.

## [0.9.8](https://github.com/i18next/i18next-cli/compare/v0.9.7...v0.9.8) - 2025-09-25

- support t returnObjects

## [0.9.7](https://github.com/i18next/i18next-cli/compare/v0.9.6...v0.9.7) - 2025-09-25

- support t key fallbacks

## [0.9.6](https://github.com/i18next/i18next-cli/compare/v0.9.5...v0.9.6) - 2025-09-25

- show amount of namespaces in status output

## [0.9.5](https://github.com/i18next/i18next-cli/compare/v0.9.4...v0.9.5) - 2025-09-25

- introduced ignoredTags option

## [0.9.4](https://github.com/i18next/i18next-cli/compare/v0.9.3...v0.9.4) - 2025-09-25

### Added
- **Status Command:** Added a `--namespace` option to filter the status report by a single namespace.

### Fixed
- **Linter:** Corrected a persistent bug causing inaccurate line number reporting for found issues.
- **Linter:** Significantly improved accuracy by adding heuristics to ignore URLs, paths, symbols, and common non-translatable JSX attributes (like `className`, `type`, etc.).

## [0.9.3](https://github.com/i18next/i18next-cli/compare/v0.9.2...v0.9.3) - 2025-09-25

- improved heuristic-config

## [0.9.2](https://github.com/i18next/i18next-cli/compare/v0.9.1...v0.9.2) - 2025-09-25

- added new paths for heuristic-config
- fix some other dependencies

## [0.9.1](https://github.com/i18next/i18next-cli/compare/v0.9.0...v0.9.1) - 2025-09-25

- move glob from devDependency to dependency

## [0.9.0] - 2025-09-25

### Added

This is the initial public release of `i18next-cli`, a complete, high-performance replacement for `i18next-parser` and `i18next-scanner`.

#### Core Engine & Extractor
-   Initial high-performance, SWC-based parsing engine for JavaScript and TypeScript.
-   Advanced, scope-aware AST analysis for intelligent key extraction.
-   Support for `t()` functions, `<Trans>` components, `useTranslation` hooks (including `keyPrefix` and aliasing), and `getFixedT`.
-   Handles complex i18next features: namespaces (via ns-separator, options, and hooks), plurals, and context.
-   Support for the type-safe selector API (`t($=>$.key.path)`).
-   Extraction from commented-out code to support documentation-driven keys.

#### Commands
-   **`init`**: Interactive wizard to create a new configuration file (`i18next.config.ts` or `.js`).
-   **`extract`**: Extracts keys and updates translation files, with `--watch` and `--ci` modes.
-   **`types`**: Generates TypeScript definitions for type-safe i18next usage and autocompletion.
-   **`sync`**: Synchronizes secondary language files with a primary language file, adding missing keys and removing unused ones.
-   **`lint`**: Lints the codebase for potential issues like hardcoded strings.
-   **`status`**: Displays a project health dashboard with a summary view and a detailed, key-by-key view (`status [locale]`).
-   **`migrate-config`**: Provides an automatic migration path from a legacy `i18next-parser.config.js`.
-   **`locize-*`**: Full suite of commands (`sync`, `download`, `migrate`) for seamless integration with the locize TMS, including an interactive setup for credentials.

#### Configuration & DX
-   **Zero-Config Mode**: `status` and `lint` commands work out-of-the-box on most projects by heuristically detecting the project structure.
-   **Typed Configuration**: Fully-typed config file (`i18next.config.ts`) with a `defineConfig` helper.
-   **Robust TS Support**: On-the-fly TypeScript config file loading (`.ts`) is supported in consumer projects via `jiti`.
-   **Dynamic Key Support**: `preservePatterns` option to support dynamic keys.
-   **Configurable Linter**: The linter can be customized with an `ignoredAttributes` option.
-   **Polished UX**: Consistent `ora` spinners provide clear feedback on all asynchronous commands.
-   **Dual CJS/ESM Support**: Modern package structure for broad compatibility.

#### Plugin System
-   Initial plugin architecture with `setup`, `onLoad`, `onVisitNode`, and `onEnd` hooks, allowing for custom extraction logic and support for other file types (e.g., HTML, Handlebars).
