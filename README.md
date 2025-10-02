# i18next-cli 🚀

A unified, high-performance i18next CLI toolchain, powered by SWC.

[![Tests](https://github.com/i18next/i18next-cli/workflows/node/badge.svg)](https://github.com/i18next/i18next-cli/actions?query=workflow%3Anode)
[![npm version](https://img.shields.io/npm/v/i18next-cli.svg?style=flat-square)](https://www.npmjs.com/package/i18next-cli)

---

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

## Why i18next-cli?

`i18next-cli` is built from the ground up to meet the demands of modern web development.

- **🚀 Performance:** By leveraging a native Rust-based parser (SWC), it delivers orders-of-magnitude faster performance than JavaScript-based parsers.
- **🧠 Intelligence:** A stateful, scope-aware analyzer correctly understands complex patterns like `useTranslation('ns1', { keyPrefix: '...' })`, `getFixedT`, and aliased `t` functions, minimizing the need for manual workarounds.
- **✅ Unified Workflow:** One tool, one configuration file, one integrated workflow. It replaces various syncing scripts.
- **🔌 Extensibility:** A modern plugin architecture allows the tool to adapt to any framework or custom workflow.
- **🧑‍💻 Developer Experience:** A fully-typed configuration file, live `--watch` modes, CLI output, and a migration from legacy tools.

## Features

- **Key Extraction**: Extract translation keys from JavaScript/TypeScript files with advanced AST analysis.
- **Type Safety**: Generate TypeScript definitions for full autocomplete and type safety.
- **Locale Synchronization**: Keep all language files in sync with your primary language.
- **Accurate Code Linting**: Detect hardcoded strings with high precision and configurable rules.
- **Translation Status**: Get a high-level overview or a detailed, key-by-key report of your project's translation completeness.
- **Plugin System**: Extensible architecture for custom extraction patterns and file types (e.g., HTML, Handlebars).
- **Legacy Migration**: Automatic migration from `i18next-parser` configurations.
- **Cloud Integration**: Seamless integration with the [locize](https://locize.com) translation management platform.

## Installation

```bash
npm install --save-dev i18next-cli
```

## Quick Start

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
    input: ['src/**/*.{js,jsx,ts,tsx}'],
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

### `init`
Interactive setup wizard to create your configuration file.

```bash
npx i18next-cli init
```

### `extract`
Parses source files, extracts keys, and updates your JSON translation files.

```bash
npx i18next-cli extract [options]
```

**Options:**
- `--watch, -w`: Re-run automatically when files change
- `--ci`: Exit with non-zero status if any files are updated (for CI/CD)
- `--dry-run`: Does not change any files - useful in combination with `--ci` (for CI/CD)

**Examples:**
```bash
# One-time extraction
npx i18next-cli extract

# Watch mode for development
npx i18next-cli extract --watch

# CI mode (fails if files changed)
npx i18next-cli extract --ci
```

### `status [locale]`

Displays a health check of your project's translation status. Can run without a config file.

**Options:**
- `--namespace <ns>, -n <ns>`: Filter the report by a specific namespace.

**Usage Examples:**

```bash
# Get a high-level summary for all locales and namespaces
npx i18next-cli status

# Get a detailed, key-by-key report for the 'de' locale
npx i18next-cli status de

# Get a summary for only the 'common' namespace across all locales
npx i18next-cli status --namespace common

# Get a detailed report for the 'de' locale, showing only the 'common' namespace
npx i18next-cli status de --namespace common
```

The detailed view provides a rich, at-a-glance summary for each namespace, followed by a list of every key and its translation status.

**Example Output (`npx i18next-cli status de`):**

```bash
Key Status for "de":

Overall: [■■■■■■■■■■■■■■■■■■■■] 100% (12/12)

Namespace: common
Namespace Progress: [■■■■■■■■■■■■■■■■■■■■] 100% (4/4)
  ✓ button.save
  ✓ button.cancel
  ✓ greeting
  ✓ farewell

Namespace: translation
Namespace Progress: [■■■■■■■■■■■■■■■■□□□□] 80% (8/10)
  ✓ app.title
  ✓ app.welcome
  ✗ app.description
  ...
```

### `types`
Generates TypeScript definitions from your translation files for full type-safety and autocompletion.

```bash
npx i18next-cli types [options]
```

**Options:**
- `--watch, -w`: Re-run automatically when translation files change

### `sync`
Synchronizes secondary language files against your primary language file, adding missing keys and removing extraneous ones.

```bash
npx i18next-cli sync
```

### `lint`
Analyzes your source code for internationalization issues like hardcoded strings. Can run without a config file.

```bash
npx i18next-cli lint
```

## Watch Mode

Use watch mode to automatically lint on save:

```bash
npx i18next-cli lint --watch

### `migrate-config`
Automatically migrates a legacy `i18next-parser.config.js` file to the new `i18next.config.ts` format.

```bash
npx i18next-cli migrate-config
```

### Locize Integration

**Prerequisites:** The locize commands require `locize-cli` to be installed:

```bash
# Install globally (recommended)
npm install -g locize-cli
```

Sync translations with the Locize translation management platform:

```bash
# Download translations from Locize
npx i18next-cli locize-download

# Upload/sync translations to Locize  
npx i18next-cli locize-sync

# Migrate local translations to Locize
npx i18next-cli locize-migrate
```

**Locize Command Options:**

The `locize-sync` command supports additional options:

```bash
npx i18next-cli locize-sync [options]
```

**Options:**
- `--update-values`: Update values of existing translations on locize
- `--src-lng-only`: Check for changes in source language only
- `--compare-mtime`: Compare modification times when syncing
- `--dry-run`: Run the command without making any changes

**Interactive Setup:** If your locize credentials are missing or invalid, the toolkit will guide you through an interactive setup process to configure your Project ID, API Key, and version.

## Configuration

The configuration file supports both TypeScript (`.ts`) and JavaScript (`.js`) formats. Use the `defineConfig` helper for type safety and IntelliSense.

> **💡 No Installation Required?** If you don't want to install `i18next-cli` as a dependency, you can skip the `defineConfig` helper and return a plain JavaScript object or JSON instead. The `defineConfig` function is purely for TypeScript support and doesn't affect functionality.

### Basic Configuration

```typescript
// i18next.config.ts
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'de', 'fr'],
  extract: {
    input: ['src/**/*.{ts,tsx,js,jsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
});
```

**Alternative without local installation:**

```javascript
// i18next.config.js
export default {
  locales: ['en', 'de', 'fr'],
  extract: {
    input: ['src/**/*.{ts,tsx,js,jsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
};
```

### Advanced Configuration

```typescript
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'de', 'fr'],
  
  // Key extraction settings
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',

    /** Glob pattern(s) for files to ignore during extraction */
    ignore: ['node_modules/**'],

    // Use '.ts' files with `export default` instead of '.json'
    outputFormat: 'ts',

    // Combine all namespaces into a single file per language (e.g., locales/en.ts)
    // Note: `output` path must not contain `{{namespace}}` when this is true.
    mergeNamespaces: false, 
    
    // Translation functions to detect. Defaults to ['t', '*.t'].
    // Supports wildcards for suffixes.
    functions: ['t', '*.t', 'i18next.t'],
    
    // React components to analyze
    transComponents: ['Trans', 'Translation'],
    
    // HTML tags to preserve in Trans component default values
    transKeepBasicHtmlNodesFor: ['br', 'strong', 'i', 'p'],
    
    // Hook-like functions that return a t function.
    // Supports strings for default behavior or objects for custom argument positions.
    useTranslationNames: [
      'useTranslation', // Standard hook (ns: arg 0, keyPrefix: arg 1)
      'getT',
      'useT',
      {
        name: 'loadPageTranslations',
        nsArg: 1,       // Namespace is the 2nd argument (index 1)
        keyPrefixArg: 2 // Options with keyPrefix is the 3rd (index 2)
      }
    ],

    // Add custom JSX attributes to ignore during linting
    ignoredAttributes: ['data-testid', 'aria-label'],

    // JSX tag names whose content should be ignored when linting
    ignoredTags: ['pre'],
    
    // Namespace and key configuration
    defaultNS: 'translation',
    nsSeparator: ':',
    keySeparator: '.', // Or `false` to disable nesting and use flat keys
    contextSeparator: '_',
    pluralSeparator: '_',
    
    // Preserve dynamic keys matching patterns
    preservePatterns: [
      'dynamic.feature.*',
      'generated.*.key'
    ],
    
    // Output formatting
    sort: true, // can be also a sort function => i.e. (a, b) => a.key > b.key ? -1 : a.key < b.key ? 1 : 0, // sort in reverse order
    indentation: 2, // can be also a string
    
    // Primary language settings
    primaryLanguage: 'en', // Defaults to the first locale in the `locales` array
    secondaryLanguages: ['de', 'fr'], // Defaults to all locales except primaryLanguage

    defaultValue: '', // Default value for missing keys in secondary languages

    /** If true, keys that are not found in the source code will be removed from translation files. (default: true) */
    removeUnusedKeys: true,
  },
  
  // TypeScript type generation
  types: {
    input: ['locales/en/*.json'],
    output: 'src/types/i18next.d.ts',
    resourcesFile: 'src/types/resources.d.ts',
    enableSelector: true, // Enable type-safe key selection
  },
  
  // Locize integration
  locize: {
    projectId: 'your-project-id',
    apiKey: process.env.LOCIZE_API_KEY, // Recommended: use environment variables
    version: 'latest',
  },
  
  // Plugin system
  plugins: [
    // Add custom plugins here
  ],
});
```

## Advanced Features

### Plugin System

Create custom plugins to extend the capabilities of `i18next-cli`. The plugin system provides several hooks that allow you to tap into different stages of the extraction process.

**Available Hooks:**

  - `setup`: Runs once when the CLI is initialized. Use it for any setup tasks.
  - `onLoad`: Runs for each file *before* it is parsed. You can use this to transform code (e.g., transpile a custom language to JavaScript).
  - `onVisitNode`: Runs for every node in the Abstract Syntax Tree (AST) of a parsed JavaScript/TypeScript file. This is useful for finding custom translation patterns in your code.
  - `onEnd`: Runs after all JS/TS files have been parsed but *before* the final keys are compared with existing translation files. This is the ideal hook for parsing non-JavaScript files (like `.html`, `.vue`, or `.svelte`) and adding their keys to the collection.
  - `afterSync`: Runs after the extractor has compared the found keys with your translation files and generated the final results. This is perfect for post-processing tasks, like generating a report of newly added keys.

**Example Plugin (`my-custom-plugin.mjs`):**

```typescript
import { glob } from 'glob';
import { readFile, writeFile } from 'node:fs/promises';

export const myCustomPlugin = () => ({
  name: 'my-custom-plugin',
  
  /**
   * Runs after the core extractor has finished but before comparison.
   * Ideal for adding keys from non-JS/TS files.
   */
  async onEnd(allKeys) {
    // Example: Parse HTML files for data-i18n attributes
    const htmlFiles = await glob('src/**/*.html');
    for (const file of htmlFiles) {
      const content = await readFile(file, 'utf-8');
      const matches = content.match(/data-i18n="([^"]+)"/g) || [];
      for (const match of matches) {
        const key = match.replace(/data-i18n="([^"]+)"/, '$1');
        // Add the found key to the collection
        allKeys.set(`translation:${key}`, { key, ns: 'translation', defaultValue: key });
      }
    }
  },

  /**
   * Runs after the extractor has generated the final translation results.
   * Ideal for reporting or post-processing.
   */
  async afterSync(results, config) {
    const primaryLanguage = config.extract.primaryLanguage || config.locales[0];
    const newKeys = [];

    for (const result of results) {
      // Find the result for the primary language
      if (!result.path.includes(`/${primaryLanguage}/`)) continue;
      
      const newKeysFlat = Object.keys(result.newTranslations);
      const existingKeysFlat = Object.keys(result.existingTranslations);
      
      // Find keys that are in the new file but not the old one
      for (const key of newKeysFlat) {
        if (!existingKeysFlat.includes(key)) {
          newKeys.push({
            key: key,
            defaultValue: result.newTranslations[key],
          });
        }
      }
    }

    if (newKeys.length > 0) {
      console.log(`[My Plugin] Found ${newKeys.length} new keys!`);
      // Example: Write a report for your copywriter
      await writeFile('new-keys-report.json', JSON.stringify(newKeys, null, 2));
    }
  }
});
```

**Configuration (`i18next.config.ts`):**

```typescript
import { defineConfig } from 'i18next-cli';
import { myCustomPlugin } from './my-custom-plugin.mjs';

export default defineConfig({
  locales: ['en', 'de'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
  plugins: [
    myCustomPlugin(),
  ],
});
```

### Dynamic Key Preservation

Use `preservePatterns` to maintain dynamically generated keys:

```typescript
// Code like this:
const key = `user.${role}.permission`;
t(key);

// With this config:
export default defineConfig({
  extract: {
    preservePatterns: ['user.*.permission']
  }
});

// Will preserve existing keys matching the pattern
```

### Comment-Based Extraction

Extract keys from comments for documentation or edge cases:

```javascript
// t('welcome.message', 'Welcome to our app!')
// t('user.greeting', { defaultValue: 'Hello!', ns: 'common' })
```

### JavaScript & TypeScript Translation Files

For projects that prefer to keep everything in a single module type, you can configure the CLI to output JavaScript or TypeScript files instead of JSON.

Configuration (`i18next.config.ts`):

```typescript
export default defineConfig({
  extract: {
    output: 'src/locales/{{language}}/{{namespace}}.ts', // Note the .ts extension
    outputFormat: 'ts', // Use TypeScript with ES Modules
  }
});
```

This will generate files like `src/locales/en/translation.ts` with the following content:

```typescript
export default {
  "myKey": "My value"
} as const;
```

### Merging Namespaces

You can also combine all namespaces into a single file per language. This is useful for reducing the number of network requests in some application setups.

Configuration (`i18next.config.ts`):

```typescript
export default defineConfig({
  extract: {
    // Note: The `output` path no longer contains the {{namespace}} placeholder
    output: 'src/locales/{{language}}.ts',
    outputFormat: 'ts',
    mergeNamespaces: true,
  }
});
```

This will generate a single file per language, like `src/locales/en.ts`, with namespaces as top-level keys:

```typescript
export default {
  "translation": {
    "key1": "Value 1"
  },
  "common": {
    "keyA": "Value A"
  }
} as const;
```

## Migration from i18next-parser

Automatically migrate from legacy `i18next-parser.config.js`:

```bash
npx i18next-cli migrate-config
```

This will:
- Convert your existing configuration to the new format
- Map old options to new equivalents
- Preserve custom settings where possible
- Create a new `i18next.config.ts` file

## CI/CD Integration

Use the `--ci` flag to fail builds when translations are outdated:

```yaml
# GitHub Actions example
- name: Check translations
  run: npx i18next-cli extract --ci
```

## Watch Mode

For development, use watch mode to automatically update translations:

```bash
npx i18next-cli extract --watch
```

## Type Safety

Generate TypeScript definitions for full type safety:

```typescript
// Generated types enable autocomplete and validation
t('user.profile.name'); // ✅ Valid key
t('invalid.key');       // ❌ TypeScript error
```

---

## Supported Patterns

The toolkit automatically detects these i18next usage patterns:

### Function Calls

```javascript
// Basic usage
t('key')
t('key', 'Default value')
t('key', { defaultValue: 'Default' })

// With namespaces
t('ns:key')
t('key', { ns: 'namespace' })

// With interpolation
t('key', { name: 'John' })

// With plurals and context
t('key', { count: 1 }); // Cardinal plural
t('keyWithContext', { context: 'male' });
t('keyWithDynContext', { context: isMale ? 'male' : 'female' });

// With ordinal plurals
t('place', { count: 1, ordinal: true });
t('place', {
  count: 2,
  ordinal: true,
  defaultValue_ordinal_one: '{{count}}st place',
  defaultValue_ordinal_two: '{{count}}nd place',
  defaultValue_ordinal_other: '{{count}}th place'
});

// With key fallbacks
t(['key.primary', 'key.fallback']);
t(['key.primary', 'key.fallback'], { defaultValue: 'The fallback value' });

// With structured content (returnObjects)
t('countries', { returnObjects: true });
```

The extractor correctly handles **cardinal and ordinal plurals** (`count`), as well as context options, generating all necessary suffixed keys (e.g., `key_one`, `key_ordinal_one`, `keyWithContext_male`). It can even statically analyze ternary expressions in the `context` option to extract all possible variations.

### React Components

```jsx
// Trans component
<Trans i18nKey="welcome">Welcome {{name}}</Trans>
<Trans ns="common">user.greeting</Trans>
<Trans count={num}>You have {{num}} message</Trans>
<Trans context={isMale ? 'male' : 'female'}>A friend</Trans>

// useTranslation hook
const { t } = useTranslation('namespace');
const { t } = useTranslation(['ns1', 'ns2']);
```

### Complex Patterns

```javascript
// Aliased functions
const translate = t;
translate('key');

// Destructured hooks
const { t: translate } = useTranslation();

// getFixedT
const fixedT = getFixedT('en', 'namespace');
fixedT('key');
```

---

<h3 align="center">Gold Sponsors</h3>

<p align="center">
  <a href="https://www.locize.com/" target="_blank">
    <img src="https://raw.githubusercontent.com/i18next/i18next/master/assets/locize_sponsor_240.gif" width="240px">
  </a>
</p>

---

**From the creators of i18next: localization as a service - locize.com**

A translation management system built around the i18next ecosystem - [locize.com](https://www.locize.com).

![locize](https://cdn.prod.website-files.com/67a323e323a50df7f24f0a6f/67b8bbb29365c3a3c21c0898_github_locize.png)

With using [locize](https://locize.com/?utm_source=i18next_readme&utm_medium=github) you directly support the future of i18next.

---
