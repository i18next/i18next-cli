# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0](https://github.com/i18next/i18next-cli/compare/v0.9.4...v1.0.0) - 2025-xx-yy

- not yet released

## [0.9.4] - 2025-09-25

### Added
- **Status Command:** Added a `--namespace` option to filter the status report by a single namespace.

### Fixed
- **Linter:** Corrected a persistent bug causing inaccurate line number reporting for found issues.
- **Linter:** Significantly improved accuracy by adding heuristics to ignore URLs, paths, symbols, and common non-translatable JSX attributes (like `className`, `type`, etc.).

## [0.9.3] - 2025-09-25

- improved heuristic-config

## [0.9.2] - 2025-09-25

- added new paths for heuristic-config
- fix some other dependencies

## [0.9.1] - 2025-09-25

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
