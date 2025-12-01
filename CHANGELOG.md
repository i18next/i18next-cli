# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.28.2](https://github.com/i18next/i18next-cli/compare/v1.28.1...v1.28.2) - 2025-12-01

- **Extractor:** Improved robustness for JSX/TSX placeholder extraction. Replaced silent fallback (`out += '{{value}}'`) with explicit error in JSX placeholders now throw an error instead of silently producing incorrect output. [#133](https://github.com/i18next/i18next-cli/issues/133)
- **Extractor:** Removed unnecessary regex workaround for TypeScript type assertions inside JSX curly braces. SWC now correctly parses `{ key: value as any }` and similar patterns, so extraction logic relies solely on AST analysis for reliability. [#133](https://github.com/i18next/i18next-cli/issues/133)
- **Tests:** Fixed and clarified TypeScript test cases for JSX placeholder extraction, ensuring coverage for type assertions and object expressions in `<Trans>` components. [#133](https://github.com/i18next/i18next-cli/issues/133)

## [1.28.1](https://github.com/i18next/i18next-cli/compare/v1.28.0...v1.28.1) - 2025-12-01

- **Extractor:** Fixed a bug where TypeScript type assertions inside JSX curly braces (e.g. `{count as any}` or `{ key: property } as any`) resulted in incorrect or silently bad extractions. The extractor now strips type assertions and correctly extracts placeholders such as `{{count}}` and `{{key}}` from TSX/JSX. [#133](https://github.com/i18next/i18next-cli/issues/133)

## [1.28.0](https://github.com/i18next/i18next-cli/compare/v1.27.1...v1.28.0) - 2025-11-29

- feat(status): exit when locales have missing keys [#132](https://github.com/i18next/i18next-cli/pull/132)

## [1.27.1](https://github.com/i18next/i18next-cli/compare/v1.27.0...v1.27.1) - 2025-11-27

- ensure `.json5` files are inferred from filename when `extract.outputFormat` is omitted [#130](https://github.com/i18next/i18next-cli/issues/130)

## [1.27.0](https://github.com/i18next/i18next-cli/compare/v1.26.1...v1.27.0) - 2025-11-27

- Add JSON5 support: translation files with `.json5` extension now try to preserve comments and formatting [#130](https://github.com/i18next/i18next-cli/issues/130)
- fix(extractor): address skipped Trans extraction test by restoring correct JSX `<Trans>` child placeholder indexing and spacing handling [#129](https://github.com/i18next/i18next-cli/issues/129)

## [1.26.1](https://github.com/i18next/i18next-cli/compare/v1.26.0...v1.26.1) - 2025-11-26

- improved jsx-parser [#128](https://github.com/i18next/i18next-cli/issues/128)

## [1.26.0](https://github.com/i18next/i18next-cli/compare/v1.25.1...v1.26.0) - 2025-11-26

- feat(extractor): add --sync-all flag to extract command — sync primary defaults and clear synced keys in all other locales [#127](https://github.com/i18next/i18next-cli/issues/127)
- prepare some skipped test for some Trans extraction use cases [#128](https://github.com/i18next/i18next-cli/issues/128) and [#129](https://github.com/i18next/i18next-cli/issues/129)

## [1.25.1](https://github.com/i18next/i18next-cli/compare/v1.25.0...v1.25.1) - 2025-11-25

- improve(linter): fall back to built‑in recommended accept‑lists for tags & attributes when none are configured [#125](https://github.com/i18next/i18next-cli/issues/125)

## [1.25.0](https://github.com/i18next/i18next-cli/compare/v1.24.22...v1.25.0) - 2025-11-25

- feat(linter): add accept-lists for tags & attributes (`lint.acceptedTags` / `lint.acceptedAttributes`) [#125](https://github.com/i18next/i18next-cli/issues/125)

## [1.24.22](https://github.com/i18next/i18next-cli/compare/v1.24.21...v1.24.22) - 2025-11-24

- fix(extractor): correctly compute numeric placeholders for nested JSX children in `<Trans>` (off-by-one caused by explicit {" "} expression and formatting whitespace), so extracted keys match react-i18next runtime behavior [#124](https://github.com/i18next/i18next-cli/issues/124)

## [1.24.21](https://github.com/i18next/i18next-cli/compare/v1.24.20...v1.24.21) - 2025-11-21

- extractor: make TypeScript TFunction generic namespace detection robust across AST variants [#122](https://github.com/i18next/i18next-cli/issues/122)

## [1.24.20](https://github.com/i18next/i18next-cli/compare/v1.24.19...v1.24.20) - 2025-11-20

- extractor: detect namespace from TypeScript TFunction generic (e.g. `TFunction<"my-custom-namespace">`) [#122](https://github.com/i18next/i18next-cli/issues/122)

## [1.24.19](https://github.com/i18next/i18next-cli/compare/v1.24.18...v1.24.19) - 2025-11-19

- fix(extractor): ensure `<Trans>` inherits `keyPrefix` from `useTranslation` when `t` is passed as a prop [#121](https://github.com/i18next/i18next-cli/issues/121)

## [1.24.18](https://github.com/i18next/i18next-cli/compare/v1.24.17...v1.24.18) - 2025-11-19

- fix(status): correctly handle flat (no-namespace) translation files when extract.defaultNS = false and extract.mergeNamespaces = true [#120](https://github.com/i18next/i18next-cli/issues/120)

## [1.24.17](https://github.com/i18next/i18next-cli/compare/v1.24.16...v1.24.17) - 2025-11-19

- improve rename-key when Selector API is used with bracket notation [#119](https://github.com/i18next/i18next-cli/issues/119)

## [1.24.16](https://github.com/i18next/i18next-cli/compare/v1.24.15...v1.24.16) - 2025-11-19

- fix: note in generated i18next.d.ts [#119](https://github.com/i18next/i18next-cli/issues/119)

## [1.24.15](https://github.com/i18next/i18next-cli/compare/v1.24.14...v1.24.15) - 2025-11-19

- fix: rename-key fails when Selector API is used [#119](https://github.com/i18next/i18next-cli/issues/119)

## [1.24.14](https://github.com/i18next/i18next-cli/compare/v1.24.13...v1.24.14) - 2025-11-18

- fix: patch glob sec vuln [#117](https://github.com/i18next/i18next-cli/pull/117)
- improved build setup

## [1.24.13](https://github.com/i18next/i18next-cli/compare/v1.24.12...v1.24.13) - 2025-11-17

- fix(extractor): correctly extract keys from `<Trans>` when i18nKey uses the selector API (arrow function) [#114](https://github.com/i18next/i18next-cli/issues/114)

## [1.24.12](https://github.com/i18next/i18next-cli/compare/v1.24.11...v1.24.12) - 2025-11-17

- update dependencies and pass indentation option to types generation

## [1.24.11](https://github.com/i18next/i18next-cli/compare/v1.24.10...v1.24.11) - 2025-11-17

- fix(types): correctly generate types when using `mergeNamespaces: true` [#113](https://github.com/i18next/i18next-cli/issues/113)

## [1.24.10](https://github.com/i18next/i18next-cli/compare/v1.24.9...v1.24.10) - 2025-11-16

- improve handling of namespace/keyPrefix argument parsing to address [#112](https://github.com/i18next/i18next-cli/issues/112)

## [1.24.9](https://github.com/i18next/i18next-cli/compare/v1.24.8...v1.24.9) - 2025-11-16

- fix: a namespace prefix passed as an argument (e.g. to useTranslation or custom hooks) could be treated as part of the translation key, producing unexpected nested namespace objects in generated JSON files. [#112](https://github.com/i18next/i18next-cli/issues/112)

## [1.24.8](https://github.com/i18next/i18next-cli/compare/v1.24.7...v1.24.8) - 2025-11-14

- improved Trans component parsing further [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.24.7](https://github.com/i18next/i18next-cli/compare/v1.24.6...v1.24.7) - 2025-11-14

- improved Trans component parsing further [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.24.6](https://github.com/i18next/i18next-cli/compare/v1.24.5...v1.24.6) - 2025-11-14

- improved Trans component parsing further [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.24.5](https://github.com/i18next/i18next-cli/compare/v1.24.4...v1.24.5) - 2025-11-13

- improved Trans component parsing further [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.24.4](https://github.com/i18next/i18next-cli/compare/v1.24.3...v1.24.4) - 2025-11-13

- **Location Metadata:** Fixed critical bug in location tracking where line and column numbers were consistently pointing to the end of file instead of actual usage positions. The extractor now uses text-based search instead of relying on SWC span offsets, which were accumulating across multiple files in the same process. This ensures accurate source location metadata for plugins that track where translation keys are used in the codebase. [#111](https://github.com/i18next/i18next-cli/issues/111)

## [1.24.3](https://github.com/i18next/i18next-cli/compare/v1.24.2...v1.24.3) - 2025-11-12

- improved Trans component parsing further [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.24.2](https://github.com/i18next/i18next-cli/compare/v1.24.1...v1.24.2) - 2025-11-12

- **Extractor (`--sync-primary`):** Fixed a bug where default values containing colons (like `"fallback:"`) were incorrectly identified as namespace-prefixed keys, resulting in empty strings in translation files when using the `--sync-primary` flag. [#110](https://github.com/i18next/i18next-cli/issues/110)

## [1.24.1](https://github.com/i18next/i18next-cli/compare/v1.24.0...v1.24.1) - 2025-11-12

- Windows fix for new **CLI:** command `rename-key`

## [1.24.0](https://github.com/i18next/i18next-cli/compare/v1.23.6...v1.24.0) - 2025-11-12

- **CLI:** Introduced the `rename-key` command for safely refactoring translation keys across your entire codebase. This new command updates both source files and translation JSON files atomically, automatically handling namespaces, plurals, and multiple locales. [#109](https://github.com/i18next/i18next-cli/issues/109)
- improved Trans component parsing further [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.23.7](https://github.com/i18next/i18next-cli/compare/v1.23.6...v1.23.7) - 2025-11-12

- improved Trans component parsing further [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.23.6](https://github.com/i18next/i18next-cli/compare/v1.23.5...v1.23.6) - 2025-11-12

- fix jsx extraction [#108](https://github.com/i18next/i18next-cli/issues/108)
- improved Trans component parsing for spaces [#102](https://github.com/i18next/i18next-cli/issues/102)

## [1.23.5](https://github.com/i18next/i18next-cli/compare/v1.23.4...v1.23.5) - 2025-11-11

- **Extractor:** Fixed custom sort function not being applied to nested keys. When providing a custom `sort` function (e.g., for case-insensitive sorting to match locize's behavior), the sorting logic is now correctly applied throughout the entire object hierarchy, not just at the top level. This ensures consistent key ordering at all nesting levels in translation files. [#106](https://github.com/i18next/i18next-cli/issues/106)

## [1.23.4](https://github.com/i18next/i18next-cli/compare/v1.23.3...v1.23.4) - 2025-11-11

- Fix preservingContextVariants when using shorthand property for context in options. [#105](https://github.com/i18next/i18next-cli/pull/105)

## [1.23.3](https://github.com/i18next/i18next-cli/compare/v1.23.2...v1.23.3) - 2025-11-10

- Fix preservingContextVariants with fully dynamic context in Trans. [#104](https://github.com/i18next/i18next-cli/pull/104)

## [1.23.2](https://github.com/i18next/i18next-cli/compare/v1.23.1...v1.23.2) - 2025-11-10

- **Plugin System:** Exported `ExtractedKeysMap` type alias for improved TypeScript support in custom plugins. Plugin authors can now import and use `ExtractedKeysMap` directly instead of manually constructing `Map<string, ExtractedKey>` when typing the `onEnd` hook's keys parameter. This provides better discoverability and a more convenient API for plugin development. [#103](https://github.com/i18next/i18next-cli/issues/103)

## [1.23.1](https://github.com/i18next/i18next-cli/compare/v1.23.0...v1.23.1) - 2025-11-10

- **Extractor (`<Trans>`):** Fixed self-closing tag formatting in Trans component extraction. Self-closing HTML tags like `<br />` (with space before slash) are now correctly preserved as `<br />` instead of being normalized to `<br/>` (without space). This ensures consistent formatting between source code and extracted translation keys, matching common JSX/HTML conventions and maintaining compatibility with existing translation workflows. [#101](https://github.com/i18next/i18next-cli/issues/101)

## [1.23.0](https://github.com/i18next/i18next-cli/compare/v1.22.2...v1.23.0) - 2025-11-09

- **Extractor:** Add a `preserveContextVariants` option to keep context variants when removing unused keys. When enabled, all context variants of keys that use context parameters are preserved in translation files even if not explicitly found in source code. [#99](https://github.com/i18next/i18next-cli/pull/99)

## [1.22.2](https://github.com/i18next/i18next-cli/compare/v1.22.1...v1.22.2) - 2025-11-08

- **Status Command:** Fixed incorrect plural key requirements for languages with different pluralization rules. The status report now correctly evaluates each language based on its own plural categories instead of incorrectly using the primary language's rules. For example, Swedish (which only requires `_one` and `_other` forms) will now show 100% completion when both forms are present, even when other languages in the project like French require additional forms (`_many`). This ensures accurate translation progress reporting across multilingual projects with varying plural rules. [#98](https://github.com/i18next/i18next-cli/issues/98)

## [1.22.1](https://github.com/i18next/i18next-cli/compare/v1.22.0...v1.22.1) - 2025-11-06

- **Types-Generator:** Add a comment to the start of the types file to note it is auto-generated [#97](https://github.com/i18next/i18next-cli/pull/97)

## [1.22.0](https://github.com/i18next/i18next-cli/compare/v1.21.1...v1.22.0) - 2025-11-06

- **Plugin System:** Enhanced `ExtractedKey` type and plugin hooks to support location metadata tracking. Plugins can now access file paths, etc. for each extracted translation key via the `locations` array property. [#95](https://github.com/i18next/i18next-cli/issues/95)

## [1.21.1](https://github.com/i18next/i18next-cli/compare/v1.21.0...v1.21.1) - 2025-11-05

- **Extractor (`--sync-primary`):** Fixed a bug where `<Trans i18nKey='namespace:key' />` components with namespaced keys were having their existing primary language translations overwritten with the full namespaced key string (e.g., `'translation:app.preservedTrans'`) when using the `--sync-primary` flag. The extractor now correctly identifies namespaced keys in defaultValue as derived (auto-generated) defaults rather than explicit developer-provided values, preserving existing translations when no explicit defaultValue is provided. This ensures that `<Trans>` components without explicit defaults behave consistently with `t()` calls under `--sync-primary`. [#92](https://github.com/i18next/i18next-cli/issues/92)

## [1.21.0](https://github.com/i18next/i18next-cli/compare/v1.20.4...v1.21.0) - 2025-11-05

- **Extractor:** Enhanced `preservePatterns` with namespace pattern support. You can now preserve entire namespaces or namespace-specific key patterns using the namespace separator (e.g., `'assets:*'` to preserve all keys in the `assets` namespace, or `'common:button.*'` to preserve specific patterns within a namespace). This is particularly useful for managing translations that are handled externally, loaded dynamically, or constructed at runtime. Pattern matching respects the configured `nsSeparator` setting. [#90](https://github.com/i18next/i18next-cli/issues/90)

## [1.20.4](https://github.com/i18next/i18next-cli/compare/v1.20.3...v1.20.4) - 2025-11-04

- improve(extractor): tolerate JSX/TSX in `.ts` files by retrying parse with TSX enabled. [#75](https://github.com/i18next/i18next-cli/issues/75)

## [1.20.3](https://github.com/i18next/i18next-cli/compare/v1.20.2...v1.20.3) - 2025-11-04

- improve(linter): tolerate JSX/TSX in `.ts` files by retrying parse with TSX enabled and emitting a per-file error (no global crash). [#75](https://github.com/i18next/i18next-cli/issues/75)

## [1.20.2](https://github.com/i18next/i18next-cli/compare/v1.20.1...v1.20.2) - 2025-11-03

- fix(extractor): prevent per-file variable leakage so unrelated variables in other files are not resolved as translation keys [#88](https://github.com/i18next/i18next-cli/issues/88)

## [1.20.1](https://github.com/i18next/i18next-cli/compare/v1.20.0...v1.20.1) - 2025-11-03

- feat(extractor): handle nullish coalescing (??) when resolving static expression keys — the extractor now treats `a ?? b` as the union of possible left/right string values (e.g. `t(a ?? 'x')` yields both sides when statically resolvable). [#86](https://github.com/i18next/i18next-cli/issues/86)

## [1.20.0](https://github.com/i18next/i18next-cli/compare/v1.19.3...v1.20.0) - 2025-11-03

- feat(extractor): statically extract keys referenced via TypeScript enums (e.g. `t(ERROR_CODE.UNKNOWN_ERROR)` → `'UNKNOWN_ERROR'`). Resolves only string-initialized enum members; conservative, non-breaking. [#87](https://github.com/i18next/i18next-cli/issues/87)

## [1.19.3](https://github.com/i18next/i18next-cli/compare/v1.19.2...v1.19.3) - 2025-11-02

- fix(extractor): improving preserve flat JSON output when extract.defaultNS is false during re-extraction. [#73](https://github.com/i18next/i18next-cli/issues/73)

## [1.19.2](https://github.com/i18next/i18next-cli/compare/v1.19.1...v1.19.2) - 2025-11-02

- fix(extractor): preserve flat output when extract.defaultNS is false on re-extracttion. [#73](https://github.com/i18next/i18next-cli/issues/73)

## [1.19.1](https://github.com/i18next/i18next-cli/compare/v1.19.0...v1.19.1) - 2025-10-31

- fix: Prevent parser crashes on TypeScript files that use angle‑bracket type assertions (e.g. `const x = <SomeType>getValue()`). The extractor and linter now choose SWC's TSX parsing mode based on the file extension (`.tsx` => JSX enabled, `.ts`/`.mts`/`.cts` => JSX disabled), avoiding accidental JSX parsing of compile‑time casts. [#84](https://github.com/i18next/i18next-cli/issues/84)

## [1.19.0](https://github.com/i18next/i18next-cli/compare/v1.18.1...v1.19.0) - 2025-10-31

- feat(extractor): improve key extraction to detect translation keys stored in local variables, object properties and simple string expressions [#83](https://github.com/i18next/i18next-cli/issues/83)

## [1.18.1](https://github.com/i18next/i18next-cli/compare/v1.18.0...v1.18.1) - 2025-10-30

- improve regression introduced in v1.17.2 [#82](https://github.com/i18next/i18next-cli/issues/82)

## [1.18.0](https://github.com/i18next/i18next-cli/compare/v1.17.2...v1.18.0) - 2025-10-30

- fix regression introduced in v1.17.2 [#82](https://github.com/i18next/i18next-cli/issues/82)
- enhancement(linter): use emitter for runLinter API [#79](https://github.com/i18next/i18next-cli/pull/79)

## [1.17.2](https://github.com/i18next/i18next-cli/compare/v1.17.1...v1.17.2) - 2025-10-29

- fix(status, extractor): avoid double‑expanding plural keys which could make locales show 0% translated [#81](https://github.com/i18next/i18next-cli/issues/81)
- fix(extractor): emit base key for single‑category plural languages (ja, zh, ko) [#82](https://github.com/i18next/i18next-cli/issues/82)

## [1.17.1](https://github.com/i18next/i18next-cli/compare/v1.17.0...v1.17.1) - 2025-10-29

- fix: regression for windows introduced in v1.17.0

## [1.17.0](https://github.com/i18next/i18next-cli/compare/v1.16.0...v1.17.0) - 2025-10-29

- feat: support functional `extract.output` for per-package paths [#80](https://github.com/i18next/i18next-cli/issues/80)

## [1.16.0](https://github.com/i18next/i18next-cli/compare/v1.15.0...v1.16.0) - 2025-10-28

- feat(extractor): better support for custom translation hooks returning t/getFixedT [#78](https://github.com/i18next/i18next-cli/issues/78)

## [1.15.0](https://github.com/i18next/i18next-cli/compare/v1.14.0...v1.15.0) - 2025-10-27

- feat(cli): add global `-c, --config <path>` option to override automatic config detection and point the CLI at a specific i18next config file. [#77](https://github.com/i18next/i18next-cli/issues/77)

## [1.14.0](https://github.com/i18next/i18next-cli/compare/v1.13.1...v1.14.0) - 2025-10-27

- Parse simple template strings when extracting defaultValue-s [#76](https://github.com/i18next/i18next-cli/pull/76)

## [1.13.1](https://github.com/i18next/i18next-cli/compare/v1.13.0...v1.13.1) - 2025-10-27

- fix: Self Closing Tags are not ignored by linter even when put in ignoredTags [#75](https://github.com/i18next/i18next-cli/issues/75)

## [1.13.0](https://github.com/i18next/i18next-cli/compare/v1.12.1...v1.13.0) - 2025-10-24

- Extract: add support for `defaultNS: false`. When enabled, the extractor will not generate or wrap keys under a namespace and will output a single language JSON with top-level keys (useful for projects that keep translations in a single file per language). Preserves existing behavior when omitted or set to a string. [#73](https://github.com/i18next/i18next-cli/issues/73)

## [1.12.1](https://github.com/i18next/i18next-cli/compare/v1.12.0...v1.12.1) - 2025-10-23

- try to improve linter for spread operator usage [#72](https://github.com/i18next/i18next-cli/issues/72)

## [1.12.0](https://github.com/i18next/i18next-cli/compare/v1.11.14...v1.12.0) - 2025-10-23

- feat(default-value): add value parameter to defaultValue function [#71](https://github.com/i18next/i18next-cli/pull/71)

## [1.11.14](https://github.com/i18next/i18next-cli/compare/v1.11.13...v1.11.14) - 2025-10-22

- Better Fix for: Stop infinite watch loops by properly honoring extract.ignore patterns [#70](https://github.com/i18next/i18next-cli/issues/70)

## [1.11.13](https://github.com/i18next/i18next-cli/compare/v1.11.12...v1.11.13) - 2025-10-22

- Fix: Stop infinite watch loops by properly honoring extract.ignore patterns [#70](https://github.com/i18next/i18next-cli/issues/70)

## [1.11.12](https://github.com/i18next/i18next-cli/compare/v1.11.11...v1.11.12) - 2025-10-21

- further improve jsx-parser [#66](https://github.com/i18next/i18next-cli/issues/66)

## [1.11.11](https://github.com/i18next/i18next-cli/compare/v1.11.10...v1.11.11) - 2025-10-20

- Expose TranslationResult type for working with afterSync plugin / hook [#69](https://github.com/i18next/i18next-cli/issues/69)

## [1.11.10](https://github.com/i18next/i18next-cli/compare/v1.11.9...v1.11.10) - 2025-10-20

- further improve jsx-parser [#66](https://github.com/i18next/i18next-cli/issues/66)

## [1.11.9](https://github.com/i18next/i18next-cli/compare/v1.11.8...v1.11.9) - 2025-10-20

- Fix: Make --sync-primary (syncPrimaryWithDefaults) smarter — only overwrite primary-language plural/context variants when the source actually provides an explicit default [#67](https://github.com/i18next/i18next-cli/issues/67)
- Fix: Detect shorthand object property "count" in t(...) calls (e.g. t('key', { count })) so plural keys are generated correctly. Adds handling for shorthand AST shapes and tests to cover the case. [#68](https://github.com/i18next/i18next-cli/issues/68)

## [1.11.8](https://github.com/i18next/i18next-cli/compare/v1.11.7...v1.11.8) - 2025-10-20

- Fix: Make `<Trans>` child indexing more robust by recognizing self-closing HTML tags (e.g. `<br/>`) and treating them as layout-only when appropriate. This prevents preserved HTML and surrounding formatting whitespace from shifting component placeholder indexes, so extracted default values now match react‑i18next runtime normalization. [#63](https://github.com/i18next/i18next-cli/issues/63)

## [1.11.7](https://github.com/i18next/i18next-cli/compare/v1.11.6...v1.11.7) - 2025-10-20

- improve: extractor --sync-primary (--syncPrimaryWithDefaults) incorrectly reset plural variants to empty strings, effectively removing existing plural translations [#67](https://github.com/i18next/i18next-cli/issues/67)
- improve Trans child indexing further [#63](https://github.com/i18next/i18next-cli/issues/63)

## [1.11.6](https://github.com/i18next/i18next-cli/compare/v1.11.5...v1.11.6) - 2025-10-19

- Fix Trans child indexing to match react-i18next and handle layout-only whitespace correctly [#63](https://github.com/i18next/i18next-cli/issues/63)

## [1.11.5](https://github.com/i18next/i18next-cli/compare/v1.11.4...v1.11.5) - 2025-10-17

- **Extractor:** ignore formatting-only JSXText nodes when serializing <Trans> children to avoid inflated component placeholder indexes and incorrect keys caused by indentation/newlines — fixes [#66](https://github.com/i18next/i18next-cli/issues/66)
- **Extractor:** prevent scope leakage and ensure correct namespace resolution for t()/getFixedT() when functions reference `t` declared later in the same file; restores idempotent extraction regardless of input file ordering — fixes [#65](https://github.com/i18next/i18next-cli/issues/65)

## [1.11.4](https://github.com/i18next/i18next-cli/compare/v1.11.3...v1.11.4) - 2025-10-15

- **Extractor:** Ignore formatting-only JSXText nodes that contain only whitespace/newlines when serializing `<Trans>` children. This prevents inflated component placeholder indexes caused by indentation/newlines while preserving intentional spaces (e.g. `{' '}`). Resulting keys now match react-i18next runtime normalization. See [#63](https://github.com/i18next/i18next-cli/issues/63).

## [1.11.3](https://github.com/i18next/i18next-cli/compare/v1.11.2...v1.11.3) - 2025-10-13

- **Extractor:** Fixed the `--watch` flag being ignored in the `extract` command. The watch mode now properly monitors source files for changes and re-runs extraction automatically, matching the behavior of other commands like `types` and `lint`. [#62](https://github.com/i18next/i18next-cli/issues/62)

## [1.11.2](https://github.com/i18next/i18next-cli/compare/v1.11.1...v1.11.2) - 2025-10-13

- **Extractor (`--sync-primary`):** Fixed critical bug where keys without explicit defaultValue were being overwritten with empty strings when using the `--sync-primary` flag. The `syncPrimaryWithDefaults` feature now correctly distinguishes between explicit default values provided in code (e.g., `t('key', 'New default')`) and derived defaults (e.g., when defaultValue equals the key name). Keys without explicit defaults now preserve their existing translations in the primary language, while only keys with meaningful code-specified defaults are updated. This ensures the feature works as intended for incremental translation updates without destroying existing content. [#61](https://github.com/i18next/i18next-cli/issues/61)
- **Extractor (AST):** Fixed inconsistent defaultValue generation for plural keys where different plural forms of the same base key could receive different default values during AST extraction. All plural forms now correctly inherit the same explicit defaultValue from the `t()` call's second argument.
- **Extractor (AST):** Fixed context+plural combinations generating unwanted base plural keys. When extracting keys with static context (e.g., `t('notifications.new', { context: 'email', count: 3 })`), the extractor now only generates context-specific plural forms (`notifications.new_email_one`, `notifications.new_email_other`) without creating redundant base plural forms (`notifications.new_one`, `notifications.new_other`).

## [1.11.1](https://github.com/i18next/i18next-cli/compare/v1.11.0...v1.11.1) - 2025-10-12

- **Syncer:** Enhanced fix for TypeScript resource file handling in `sync` command. Building on the initial fix in v1.10.4 that resolved sync command failures with `outputFormat: 'ts'`, this release improves the TypeScript file parsing reliability and error handling when loading translation files with complex export patterns and TypeScript-specific syntax. [#59](https://github.com/i18next/i18next-cli/issues/59)

## [1.11.0](https://github.com/i18next/i18next-cli/compare/v1.10.4...v1.11.0) - 2025-10-11

- **Extractor:** Introduced `--sync-primary` CLI option to automatically synchronize primary language values with default values from code. When enabled, the extractor updates existing primary language translations to match the default values specified in your source code (e.g., `t('key', 'New default')` will update the primary language JSON), while preserving secondary language translations and keys without explicit defaults. This enables a streamlined development workflow where developers can focus on editing translation defaults directly in code without manually managing JSON files. Perfect for rapid prototyping and watch mode development. [#60](https://github.com/i18next/i18next-cli/issues/60)

## [1.10.4](https://github.com/i18next/i18next-cli/compare/v1.10.3...v1.10.4) - 2025-10-10

- **Syncer:** Fixed `sync` command failure when using TypeScript resource files with `outputFormat: 'ts'`. The syncer now properly loads and parses TypeScript translation files (e.g., `export default { ... } as const`) using jiti with TypeScript path alias support, enabling seamless synchronization across all supported file formats. [#59](https://github.com/i18next/i18next-cli/issues/59)

## [1.10.3](https://github.com/i18next/i18next-cli/compare/v1.10.2...v1.10.3) - 2025-10-08

- **Extractor (`<Trans>`):** Fixed variable placeholder extraction from object expressions in Trans components. Previously, expressions like `<Trans>Hello {{name: userName}}</Trans>` would lose the variable placeholder and extract as `"Hello "` instead of `"Hello {{name}}"`. The JSX children serializer now correctly handles both simple identifiers (`{{name}}`) and object expressions (`{{name: value}}`) to preserve variable placeholders in the extracted translation keys. [#58](https://github.com/i18next/i18next-cli/issues/58)

## [1.10.2](https://github.com/i18next/i18next-cli/compare/v1.10.1...v1.10.2) - 2025-10-08

### Fixed
- **Extractor:** Fixed plural form sorting to follow canonical i18next order (zero, one, two, few, many, other) instead of alphabetical sorting. Plural keys are now properly grouped by their base key and sorted within each group according to i18next's pluralization rules, ensuring consistent and predictable translation file structure. For example, `item_other`, `item_one`, `item_zero` now correctly sorts to `item_zero`, `item_one`, `item_other`. [#57](https://github.com/i18next/i18next-cli/issues/57)

### Enhanced  
- **Extractor:** Added intelligent handling for the optional `_zero` suffix in plural forms. The extractor now preserves existing `_zero` keys when related plural forms are present in the extracted keys, but removes them when no related plurals exist. This aligns with i18next's special handling of `count: 0` scenarios where `_zero` provides more natural language expressions (e.g., "No items" instead of "0 items"), while ensuring unused `_zero` forms don't accumulate in translation files.

## [1.10.1](https://github.com/i18next/i18next-cli/compare/v1.10.0...v1.10.1) - 2025-10-07

- **Extractor:** Fixed incorrect behavior of the `preservePatterns` option where keys matching the specified patterns were being extracted instead of being excluded from extraction. The option now correctly skips keys that match the glob patterns during both AST-based extraction and comment parsing, preventing re-extraction of keys that already exist in other translation files (e.g., when `BUILDINGS.*` keys exist in `assets.json` but shouldn't be duplicated in `app.json`). This resolves issues where dynamic key references were incorrectly creating duplicate entries in extracted translation files, allowing developers to use patterns like `t('BUILDINGS.ACADEMY.NAME')` directly without workarounds. [#53](https://github.com/i18next/i18next-cli/issues/53)

## [1.10.0](https://github.com/i18next/i18next-cli/compare/v1.9.0...v1.10.0) - 2025-10-07

### Added
- **Extractor:** Introduced `disablePlurals` configuration option to disable plural key generation when pluralization is handled by other systems or when you only need the base key for interpolation. When enabled, `t('item', { count: 5 })` will only generate `item` instead of `item_one`, `item_other`, etc. This is useful for projects using external pluralization libraries or custom count handling. [#55](https://github.com/i18next/i18next-cli/issues/55)

### Fixed
- **Plugin System:** Fixed incorrect TypeScript type definition for the `keys` argument in the `Plugin.onEnd` hook. The keys parameter now correctly represents a `Map<string, ExtractedKey>` instead of the previous incorrect type, improving type safety for plugin development. [#56](https://github.com/i18next/i18next-cli/pull/56)
- **Extractor:** Fixed a critical bug where empty string keys (`""`) were being created in translation files under specific conditions. This occurred when namespace processing resulted in empty keys (e.g., `t('ns:')` with `keyPrefix` combinations) or when malformed key patterns created nested empty key structures. The extractor now validates and skips problematic key combinations that would result in empty keys, preventing corrupted translation files. [#54](https://github.com/i18next/i18next-cli/issues/54)

## [1.9.0](https://github.com/i18next/i18next-cli/compare/v1.8.0...v1.9.0) - 2025-10-07

### Enhanced
- **Extractor (TypeScript):** Added support for dynamic variables in TypeScript using the `satisfies` operator. The extractor can now properly resolve variables constrained with `satisfies` expressions to extract all possible translation keys, enabling type-safe dynamic key generation patterns. [#42](https://github.com/i18next/i18next-cli/pull/42)

### Fixed
- **Extractor (Comments):** Fixed pluralization logic for commented `t()` calls to generate the correct plural forms for each target language. When Arabic (`ar-SA`) is included in the locales, the extractor now properly generates all 6 Arabic plural forms (`_zero`, `_one`, `_two`, `_few`, `_many`, `_other`) in Arabic files while maintaining the correct 2 forms (`_one`, `_other`) for English files. Previously, all languages would only receive English plural forms regardless of their actual pluralization rules.

### Added
- **Extractor:** Introduced the `generateBasePluralForms` configuration option to control whether base plural forms are generated when context is present. When set to `false`, calls like `t('key', { context: 'male', count: 1 })` will only generate context-specific forms (`key_male_one`, `key_male_other`) without creating base forms (`key_one`, `key_other`), reducing translation file clutter for context-only scenarios. Defaults to `true` to maintain backward compatibility.

## [1.8.0](https://github.com/i18next/i18next-cli/compare/v1.7.1...v1.8.0) - 2025-10-06

- **Extractor:** The `defaultValue` option now accepts a function `(key, namespace, language) => string` for dynamic default value generation. This enables powerful patterns like i18next-parser compatibility (`defaultValue: (key) => key`), development-friendly TODO markers (`defaultValue: (key) => \`TODO: translate ${key}\``), and language-specific fallbacks. The function receives the translation key, namespace, and target language as parameters, allowing for sophisticated fallback strategies. [#52](https://github.com/i18next/i18next-cli/issues/52)

## [1.7.1](https://github.com/i18next/i18next-cli/compare/v1.7.0...v1.7.1) - 2025-10-06

- **Extractor (Comments):** Enhanced comment parser to support ordinal plurals alongside cardinal plurals and context combinations. Commented `t()` calls now correctly handle ordinal flags (e.g., `// t('position', { count: 1, ordinal: true })`) and generate all appropriate ordinal plural forms (`position_ordinal_one`, `position_ordinal_two`, `position_ordinal_few`, `position_ordinal_other`) using the proper `Intl.PluralRules` API. The parser also supports ordinal detection via `_ordinal` suffix in keys and properly combines ordinal plurals with context options for comprehensive key generation. This ensures complete parity with the AST-based extractor for all plural types. [#50](https://github.com/i18next/i18next-cli/issues/50)

## [1.7.0](https://github.com/i18next/i18next-cli/compare/v1.6.1...v1.7.9) - 2025-10-06

- **Extractor (Comments):** Improved comment extraction for complex translation patterns with both context and plural options. Commented `t()` calls like `// t('options.option', { context: 'month', count: 1 })` now correctly generate all combinations of context and plural forms (e.g., `options.option_month_one`, `options.option_month_other`, `options.option_day_one`, etc.), providing comprehensive key extraction for dynamic scenarios where developers use commented hints to declare all possible runtime values. [#50](https://github.com/i18next/i18next-cli/issues/50)
- **Plugin System:** Added new `extractKeysFromExpression` and `extractContextFromExpression` plugin hooks for simplified custom key extraction. These pure, context-less functions allow plugins to parse specific expressions during AST traversal without handling pluralization, namespace resolution, or file writing manually. Perfect for TypeScript-specific syntax (like `satisfies` expressions), template literals with dynamic variables, or custom key generation patterns. Plugins can now focus on expression parsing logic while the core extractor handles the heavy lifting. [#49](https://github.com/i18next/i18next-cli/pull/49)

## [1.6.1](https://github.com/i18next/i18next-cli/compare/v1.6.0...v1.6.1) - 2025-10-05

- **Extractor (Comments):** Fixed namespace scope resolution for `t()` calls in comments. Commented translation calls like `// t("Private")` now correctly inherit the namespace from the surrounding `useTranslation('access')` scope instead of defaulting to the default namespace, matching i18next-parser behavior. This ensures consistency between commented and actual translation calls within the same component scope. [#44](https://github.com/i18next/i18next-cli/issues/44)
- **Extractor:** Loosened context value parsing to handle edge cases where empty strings or dynamic expressions in context options could cause extraction failures. The parser now gracefully handles various context value types and expressions. [#48](https://github.com/i18next/i18next-cli/pull/48)
- **Plugin System:** Fixed plugin execution timing by running `onVisitNode` hooks inline during AST traversal instead of after it. This ensures plugins have access to scope information (like `getVarFromScope`) when processing nodes, enabling more sophisticated custom extraction logic. Plugins can now properly access variable scope context during the main AST walking phase. [#47](https://github.com/i18next/i18next-cli/pull/47)

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
