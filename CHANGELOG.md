# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0](https://github.com/i18next/i18next-cli/compare/v1.5.11...v1.6.0) - 2025-10-05

### Added
- **Plugin System:** Enhanced plugin capabilities with improved context access and error handling. Plugins now receive richer context objects including:
  - `getVarFromScope(name)`: Access to variable scope information for understanding `useTranslation` hooks, `getFixedT` calls, and namespace context
  - Full configuration access via `context.config`
  - Enhanced logging utilities via `context.logger`
- **Plugin System:** Added robust error handling for plugin hooks. Plugin failures (in `onLoad` and `onVisitNode`) no longer crash the extraction process but are logged as warnings, allowing extraction to continue gracefully
- **Plugin System:** Improved TypeScript support in plugins with better AST node access, enabling plugins to handle TypeScript-specific syntax like `satisfies` and `as` operators for advanced extraction patterns

### Enhanced
- **Extractor:** The `processFile` function now provides plugins with comprehensive access to the parsing context, enabling sophisticated custom extraction logic that can leverage variable scope analysis and TypeScript-aware parsing
- **Extractor (`<Trans>`):** Fixed namespace prefix duplication when both `ns` prop and namespace prefix in `i18nKey` are specified. When a `<Trans>` component has both `ns="form"` and `i18nKey="form:cost_question.description"`, the extractor now correctly removes the redundant namespace prefix and extracts `cost_question.description` to the `form.json` file, matching i18next and i18next-parser behavior. [#45](https://github.com/i18next/i18next-cli/issues/45)
- **Extractor (Comments):** Fixed namespace scope resolution for `t()` calls in comments. Commented translation calls like `// t("Private")` now correctly inherit the namespace from the surrounding `useTranslation('access')` scope instead of defaulting to the default namespace, matching i18next-parser behavior. This ensures consistency between commented and actual translation calls within the same component scope. [#44](https://github.com/i18next/i18next-cli/issues/44)

## [1.5.11](https://github.com/i18next/i18next-cli/compare/v1.5.10...v1.5.11) - 2025-10-05

- **Extractor:** Fixed handling of empty strings in template literals where conditional expressions could result in empty string concatenation (e.g., `` t(`key${condition ? '.suffix' : ''}`) ``). Empty strings are now properly filtered out during template literal resolution, ensuring only valid key variants are generated. [#41](https://github.com/i18next/i18next-cli/pull/41)

## [1.5.10](https://github.com/i18next/i18next-cli/compare/v1.5.9...v1.5.10) - 2025-10-05

- **Extractor:** Added support for template literals as translation keys in both `t()` functions and `<Trans>` components. The extractor can now resolve complex template strings with nested expressions, ternary operators, and mixed data types to extract all possible key variants (e.g., `` t(`state.${isDone ? 'done' : 'notDone'}.title`) `` generates both `state.done.title` and `state.notDone.title`). [#39](https://github.com/i18next/i18next-cli/pull/39)

## [1.5.9](https://github.com/i18next/i18next-cli/compare/v1.5.8...v1.5.9) - 2025-10-05

### Added
- **Extractor (`<Trans>`):** Added support for plural-specific default values from `tOptions` prop (e.g., `defaultValue_other: "Items"`). The extractor now correctly uses these values when generating plural keys for Trans components. [#36](https://github.com/i18next/i18next-cli/pull/36)
- **Extractor:** Added support for dynamic expressions in `t()` function arguments. The extractor can now resolve ternary operators and other static expressions to extract all possible key variants (e.g., `t(isOpen ? 'open' : 'closed')`). [#37](https://github.com/i18next/i18next-cli/pull/37)

### Enhanced
- **Extractor (`<Trans>`):** Improved namespace resolution consistency by prioritizing namespace from `i18nKey` prop over other sources. When a Trans component uses `i18nKey="ns:key"`, the namespace from the key now takes precedence over the `t` prop namespace, matching i18next's behavior. [#38](https://github.com/i18next/i18next-cli/pull/38)

## [1.5.8](https://github.com/i18next/i18next-cli/compare/v1.5.7...v1.5.8) - 2025-10-05

- **Extractor:** Fixed namespace resolution/override order where explicitly passed `ns` options in `t()` calls were being incorrectly overridden by hook-level namespaces. The extractor now properly prioritizes explicit namespace options over inferred ones. [#32](https://github.com/i18next/i18next-cli/issues/32)
- **Extractor (`<Trans>`):** Fixed a bug where `context` and `count` props on Trans components were treated as mutually exclusive. The extractor now correctly generates all combinations of context and plural forms (e.g., `key_context_one`, `key_context_other`) to match i18next's behavior. [#33](https://github.com/i18next/i18next-cli/issues/33)
- **Extractor:** Fixed a bug where passing an empty string as a context value (e.g., `context: test ? 'male' : ''`) resulted in keys with trailing underscores. Empty strings are now treated as "no context" like i18next does, ensuring clean key generation. [#34](https://github.com/i18next/i18next-cli/issues/34)

## [1.5.7](https://github.com/i18next/i18next-cli/compare/v1.5.6...v1.5.7) - 2025-10-04

### Added
- **Migration:** Added support for custom config file paths in the `migrate-config` command. You can now use a positional argument to specify non-standard config file locations (e.g., `i18next-cli migrate-config my-config.mjs`). [#31](https://github.com/i18next/i18next-cli/issues/31)
- **Programmatic API:** Exported `runTypesGenerator` function for programmatic usage for build tool integration.

### Enhanced
- **Migration:** Added warning for deprecated `compatibilityJSON: 'v3'` option in legacy configs.

## [1.5.6](https://github.com/i18next/i18next-cli/compare/v1.5.5...v1.5.6) - 2025-10-03

- **Programmatic API:** Exported `runExtractor`, `runLinter`, `runSyncer`, and `runStatus` functions for programmatic usage. You can now use `i18next-cli` directly in your build scripts, Gulp tasks, or any Node.js application without running the CLI commands. [#30](https://github.com/i18next/i18next-cli/issues/30)

## [1.5.5](https://github.com/i18next/i18next-cli/compare/v1.5.4...v1.5.5) - 2025-10-03

- **Extractor:** Fixed a regression where existing nested translation objects were being replaced with string values when extracted with regular `t()` calls. The extractor now preserves existing nested objects when no explicit default value is provided, ensuring compatibility with global `returnObjects: true` configurations and preventing data loss during extraction. [#29](https://github.com/i18next/i18next-cli/issues/29)

## [1.5.4](https://github.com/i18next/i18next-cli/compare/v1.5.3...v1.5.4) - 2025-10-02

- **Extractor:** Fixed a sorting edge case where keys with identical spellings but different cases (e.g., `FOO` and `foo`) were not consistently ordered. Lowercase variants now correctly appear before uppercase variants when the spelling is identical, ensuring predictable and stable sort order across all translation files.

## [1.5.3](https://github.com/i18next/i18next-cli/compare/v1.5.2...v1.5.3) - 2025-10-02

- **Extractor:** Fixed a regression where key sorting became case-sensitive (e.g., a key like `'Zebra'` would incorrectly appear before `'apple'`). Sorting has been restored to be case-insensitive, ensuring a natural alphabetical order at all levels of the translation files.

## [1.5.2](https://github.com/i18next/i18next-cli/compare/v1.5.1...v1.5.2) - 2025-10-02

- **Extractor:** Fixed a regression where keys within nested objects were no longer being sorted alphabetically (e.g., `buttons.scroll-to-top` would appear before `buttons.cancel`). The sorting logic now recursively sorts keys at all levels of the translation object to ensure a consistent and predictable order.

## [1.5.1](https://github.com/i18next/i18next-cli/compare/v1.5.0...v1.5.1) - 2025-10-02

- **Extractor:** Improved the default key extraction by updating the default `functions` option to `['t', '*.t']`. This allows the extractor to automatically find keys in common patterns like `i18n.t(...)` and `this.t(...)` without any configuration.

## [1.5.0](https://github.com/i18next/i18next-cli/compare/v1.4.0...v1.5.0) - 2025-10-02

### Added
- **Extractor:** Added wildcard support to the `extract.functions` option. Patterns starting with `*.` (e.g., `'*.t'`) will now match any function call ending with that suffix, making configuration easier for projects with multiple translation function instances.

### Fixed
- **Extractor:** Fixed a bug that caused incorrect key sorting when a mix of flat and nested keys were present (e.g., `person` and `person-foo`). Sorting is now correctly applied to the top-level keys of the final generated object. [#27](https://github.com/i18next/i18next-cli/issues/27)
- **Extractor:** Fixed a bug where refactoring a nested key into its parent (e.g., changing `t('person.name')` to `t('person')`) would not correctly remove the old nested object from the translation file. [#28](https://github.com/i18next/i18next-cli/issues/28)

## [1.4.0](https://github.com/i18next/i18next-cli/compare/v1.3.0...v1.4.0) - 2025-10-02

### Added
- **Plugin System:** Introduced a new `afterSync` plugin hook. This hook runs after the extractor has finished processing and writing files, providing plugins with the final results. This is ideal for post-processing tasks, such as generating a report of newly added keys.

### Fixed
- **Extractor:** Fixed a bug where translation keys inside class methods were not being extracted, particularly when using member expressions based on `this` (e.g., `this._i18n.t('key')`). [#25](https://github.com/i18next/i18next-cli/issues/25)
- **Extractor:** Fixed a critical bug where `removeUnusedKeys` would fail to remove keys from a file if it was the last key remaining. The extractor now correctly processes and empties files and namespaces when all keys have been removed from the source code. [#26](https://github.com/i18next/i18next-cli/issues/26)

## [1.3.0](https://github.com/i18next/i18next-cli/compare/v1.2.1...v1.3.0) - 2025-10-02

### Added
- **Linter:** Introduced a new `--watch` flag for the `lint` command, enabling it to run automatically on file changes for real-time feedback during development.
- **Extractor:** Introduced a new `--dry-run` flag for the `extract` command. When used, the extractor will report potential changes but will not write any files to disk, which is useful for validation in CI/CD pipelines. [#22](https://github.com/i18next/i18next-cli/issues/22)

### Fixed
- **Extractor:** Reduced console noise in `extract --watch` mode. The promotional tip is now only displayed once per watch session, instead of after every file change. [#20](https://github.com/i18next/i18next-cli/issues/20)

## [1.2.1](https://github.com/i18next/i18next-cli/compare/v1.2.0...v1.2.1) - 2025-10-02

- **Extractor:** Fixed a bug where translation keys inside class methods were not being extracted. This was caused by a fragile AST traversal logic that has now been made more robust. [19](https://github.com/i18next/i18next-cli/issues/19)

## [1.2.0](https://github.com/i18next/i18next-cli/compare/v1.1.0...v1.2.0) - 2025-10-02

### Added

  - **Extractor:** The `extract.sort` option now accepts a custom comparator function, allowing for advanced key sorting logic beyond simple alphabetical order. [#16](https://github.com/i18next/i18next-cli/pull/16)

### Changed

  - **File Output:** All generated translation files (`.json`, `.js`, `.ts`) now end with a trailing newline to improve compatibility with POSIX standards and various linters. [#17](https://github.com/i18next/i18next-cli/pull/17)
  - **Extractor:** The `extract.indentation` option now accepts a string (e.g., `'\t'`) in addition to a number, allowing for the use of tab characters for indentation in the output files. [#15](https://github.com/i18next/i18next-cli/pull/15)

## [1.1.0](https://github.com/i18next/i18next-cli/compare/v1.0.2...v1.1.0) - 2025-10-02

- **Extractor:** Added a new `extract.removeUnusedKeys` option to control whether keys no longer found in the source code are removed from translation files. This defaults to `true` to maintain the existing pruning behavior. Set it to `false` to preserve all existing keys, which is useful for projects with dynamic keys. [#18](https://github.com/i18next/i18next-cli/issues/18)

## [1.0.2](https://github.com/i18next/i18next-cli/compare/v1.0.1...v1.0.2) - 2025-10-01

- **Extractor & Linter:** Added a new `extract.ignore` option to provide a simpler and more reliable way to exclude files from processing. This option accepts an array of glob patterns and is respected by both the `extract` and `lint` commands, avoiding the need for complex negative glob patterns.

## [1.0.1](https://github.com/i18next/i18next-cli/compare/v1.0.0...v1.0.1) - 2025-10-01

- **Extractor:** Fixed a bug where the comment parser was too aggressive, causing it to incorrectly extract keys from non-translation functions (like `test()` or `http.get()`) found inside comments. The parser is now more specific and safely targets only valid, commented-out `t()` calls. [#13](https://github.com/i18next/i18next-cli/issues/13)

## [1.0.0](https://github.com/i18next/i18next-cli/compare/v0.9.20...v1.0.0) - 2025-10-01

🎉 **Official v1.0.0 Release!**

This release marks the official v1.0.0 milestone for `i18next-cli`, signifying that the tool is stable, feature-complete, and ready for production use - any future breaking changes will require a major version bump per SemVer.

After extensive development and numerous bug fixes across the v0.9.x series, the core feature set is now considered robust and reliable. Thank you to everyone who contributed by reporting issues and providing valuable feedback!

## [0.9.20](https://github.com/i18next/i18next-cli/compare/v0.9.19...v0.9.20) - 2025-09-30

- **Extractor (`<Trans>`):** Added support for the `tOptions` prop on the `<Trans>` component. The extractor can now read plural-specific default values (e.g., `defaultValue_other`), namespaces (`ns`), and `context` from this prop, providing parity with the `t()` function's advanced options.

## [0.9.19](https://github.com/i18next/i18next-cli/compare/v0.9.18...v0.9.19) - 2025-09-30

- **Status Command:** Greatly improved the accuracy of the translation status report for plural keys. The command now calculates the total number of required keys for each language based on that specific language's pluralization rules (e.g., 2 forms for English, 6 for Arabic), rather than incorrectly using the primary language's rules for all locales.
- **Extractor:** Corrected the logic for ordinal plurals and default value fallbacks. The extractor now recognizes keys with an `_ordinal` suffix as ordinal plurals. The fallback hierarchy for all plural default values (e.g., `defaultValue_one`, `defaultValue_other`) now correctly matches i18next's behavior.

## [0.9.18](https://github.com/i18next/i18next-cli/compare/v0.9.17...v0.9.18) - 2025-09-30

- **Extractor:** Fixed a bug where translation keys were not found in custom functions that were part of an object (e.g., `i18n.t(...)`). The `functions` configuration option now correctly handles member expressions in addition to simple function names. [#10](https://github.com/i18next/i18next-cli/issues/10)
- **Extractor:** Fixed a critical bug where the `extract` command would incorrectly overwrite existing translations in secondary languages when using the `mergeNamespaces: true` option. The fix also resolves a related issue where unused keys were not being correctly pruned from the primary language file in the same scenario. The translation manager logic is now more robust for both merged and non-merged configurations. [#11](https://github.com/i18next/i18next-cli/issues/11)

## [0.9.17](https://github.com/i18next/i18next-cli/compare/v0.9.16...v0.9.17) - 2025-09-29

- **Extractor:** Fixed a bug where namespace and `keyPrefix` information from custom `useTranslationNames` hooks was ignored when the `t` function was assigned directly to a variable (e.g., `let t = myHook()`). The extractor now correctly handles this pattern in addition to destructuring assignments. [#9](https://github.com/i18next/i18next-cli/issues/9)

## [0.9.16](https://github.com/i18next/i18next-cli/compare/v0.9.15...v0.9.16) - 2025-09-29

### Changed
- **Extractor:** Enhanced the `useTranslationNames` option to support custom hook-like functions with configurable argument positions for namespaces and `keyPrefix`. The extractor can now also correctly identify these functions when they are asynchronous (i.e., used with `await`).

### Fixed
- **Extractor:** Fixed a critical crash that occurred when extracting 'mixed keys' (e.g., both a `parent` key and a `parent.child` key exist). The extractor now handles this conflict by preserving the parent key and adding the child key as a flat, top-level key to prevent data loss.

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
