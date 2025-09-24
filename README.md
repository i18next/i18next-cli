# i18next-toolkit 🚀

A unified, high-performance i18next CLI toolchain, powered by SWC.

[![Tests](https://github.com/i18next/i18next-toolkit/workflows/node/badge.svg)](https://github.com/i18next/i18next-toolkit/actions?query=workflow%3Anode)
[![npm version](https://img.shields.io/npm/v/i18next-toolkit.svg?style=flat-square)](https://www.npmjs.com/package/i18next-toolkit)

---

`i18next-toolkit` is a complete reimagining of the static analysis toolchain for the i18next ecosystem. It consolidates key extraction, type safety generation, locale syncing, linting, and cloud integrations into a single, cohesive, and blazing-fast CLI.

## Why i18next-toolkit?

`i18next-toolkit` is built from the ground up to meet the demands of modern web development.

- **🚀 Performance:** By leveraging a native Rust-based parser (SWC), it delivers orders-of-magnitude faster performance than JavaScript-based parsers.
- **🧠 Intelligence:** A stateful, scope-aware analyzer correctly understands complex patterns like `useTranslation('ns1', { keyPrefix: '...' })`, `getFixedT`, and aliased `t` functions, minimizing the need for manual workarounds.
- **✅ Unified Workflow:** One tool, one configuration file, one integrated workflow. It replaces various syncing scripts.
- **🔌 Extensibility:** A modern plugin architecture allows the tool to adapt to any framework or custom workflow.
- **🧑‍💻 Developer Experience:** A fully-typed configuration file, live `--watch` modes, CLI output, and a migration from legacy tools.

## Features

- **Key Extraction**: Extract translation keys from JavaScript/TypeScript files with advanced AST analysis
- **Type Safety**: Generate TypeScript definitions for full autocomplete and type safety
- **Locale Synchronization**: Keep all language files in sync with your primary language
- **Code Linting**: Tries to detect hardcoded strings and translation best practices violations
- **Translation Status**: Get a high-level overview of your project's translation completeness
- **Plugin System**: Extensible architecture for custom extraction patterns and file types (e.g., HTML, Handlebars)
- **Legacy Migration**: Automatic migration from `i18next-parser` configurations
- **Cloud Integration**: Seamless integration with [locize](https://www.locize.com) translation management platform

## Installation

```bash
npm install --save-dev i18next-toolkit
```

## Quick Start

### 1. Initialize Configuration

Create a configuration interactively:

```bash
npx i18next-toolkit init
```

Or manually create `i18next.config.ts` in your project root:

```typescript
import { defineConfig } from 'i18next-toolkit';

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
npx i18next-toolkit status
```

### 3. Extract Translation Keys

```bash
npx i18next-toolkit extract
```

### 4. Generate Types (Optional)

```bash
npx i18next-toolkit types
```

## Commands

### `init`
Interactive setup wizard to create your configuration file.

```bash
npx i18next-toolkit init
```

### `extract`
Parses source files, extracts keys, and updates your JSON translation files.

```bash
npx i18next-toolkit extract [options]
```

**Options:**
- `--watch, -w`: Re-run automatically when files change
- `--ci`: Exit with non-zero status if any files are updated (for CI/CD)

**Examples:**
```bash
# One-time extraction
npx i18next-toolkit extract

# Watch mode for development
npx i18next-toolkit extract --watch

# CI mode (fails if files changed)
npx i18next-toolkit extract --ci
```

### `status`
Displays a health check of your project's translation status, showing the completeness of each language against the primary language.

```bash
npx i18next-toolkit status
```

This command provides:
- Total number of translation keys found in your source code
- Translation progress for each secondary language with visual progress bars
- Percentage and key counts for easy tracking

### `types`
Generates TypeScript definitions from your translation files for full type-safety and autocompletion.

```bash
npx i18next-toolkit types [options]
```

**Options:**
- `--watch, -w`: Re-run automatically when translation files change

### `sync`
Synchronizes secondary language files against your primary language file, adding missing keys and removing extraneous ones.

```bash
npx i18next-toolkit sync
```

### `lint`
Analyzes your source code for internationalization issues like hardcoded strings.

```bash
npx i18next-toolkit lint
```

### `migrate-config`
Automatically migrates a legacy `i18next-parser.config.js` file to the new `i18next.config.ts` format.

```bash
npx i18next-toolkit migrate-config
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
npx i18next-toolkit locize-download

# Upload/sync translations to Locize  
npx i18next-toolkit locize-sync

# Migrate local translations to Locize
npx i18next-toolkit locize-migrate
```

**Locize Command Options:**

The `locize-sync` command supports additional options:

```bash
npx i18next-toolkit locize-sync [options]
```

**Options:**
- `--update-values`: Update values of existing translations on locize
- `--src-lng-only`: Check for changes in source language only
- `--compare-mtime`: Compare modification times when syncing
- `--dry-run`: Run the command without making any changes

**Interactive Setup:** If your locize credentials are missing or invalid, the toolkit will guide you through an interactive setup process to configure your Project ID, API Key, and version.

## Configuration

The configuration file supports both TypeScript (`.ts`) and JavaScript (`.js`) formats. Use the `defineConfig` helper for type safety and IntelliSense.

### Basic Configuration

```typescript
// i18next.config.ts
import { defineConfig } from 'i18next-toolkit';

export default defineConfig({
  locales: ['en', 'de', 'fr'],
  extract: {
    input: ['src/**/*.{ts,tsx,js,jsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
  },
});
```

### Advanced Configuration

```typescript
import { defineConfig } from 'i18next-toolkit';

export default defineConfig({
  locales: ['en', 'de', 'fr'],
  
  // Key extraction settings
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'locales/{{language}}/{{namespace}}.json',
    
    // Translation functions to detect
    functions: ['t', 'i18n.t', 'i18next.t'],
    
    // React components to analyze
    transComponents: ['Trans', 'Translation'],
    
    // useTranslation hook variations
    useTranslationNames: ['useTranslation', 'useAppTranslation'],
    
    // Namespace and key configuration
    defaultNS: 'translation',
    nsSeparator: ':',
    keySeparator: '.',
    contextSeparator: '_',
    pluralSeparator: '_',
    
    // Preserve dynamic keys matching patterns
    preservePatterns: [
      'dynamic.feature.*',
      'generated.*.key'
    ],
    
    // Output formatting
    sort: true,
    indentation: 2,
    
    // Primary language settings
    primaryLanguage: 'en',
    secondaryLanguages: ['de', 'fr'],

    defaultValue: '', // Default value for missing keys
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

Create custom plugins to extend extraction capabilities. The plugin system is powerful enough to support non-JavaScript files (e.g., HTML, Handlebars) by using the `onEnd` hook with custom parsers.

```typescript
import { defineConfig, Plugin } from 'i18next-toolkit';

const myCustomPlugin = (): Plugin => ({
  name: 'my-custom-plugin',
  
  async setup() {
    // Initialize plugin
  },
  
  async onLoad(code: string, file: string) {
    // Transform code before parsing
    return code;
  },
  
  onVisitNode(node: any, context: PluginContext) {
    // Custom AST node processing
    if (node.type === 'CallExpression') {
      // Extract custom translation patterns
      context.addKey({
        key: 'custom.key',
        defaultValue: 'Custom Value',
        ns: 'custom'
      });
    }
  },
  
  async onEnd(allKeys: Map<string, ExtractedKey>) {
    // Process all extracted keys or add additional keys from non-JS files
    // Example: Parse HTML files for data-i18n attributes
    const htmlFiles = await glob('src/**/*.html');
    for (const file of htmlFiles) {
      const content = await readFile(file, 'utf-8');
      const matches = content.match(/data-i18n="([^"]+)"/g) || [];
      for (const match of matches) {
        const key = match.replace(/data-i18n="([^"]+)"/, '$1');
        allKeys.set(`translation:${key}`, { key, ns: 'translation' });
      }
    }
  }
});

export default defineConfig({
  locales: ['en', 'de'],
  plugins: [myCustomPlugin()],
  // ... other config
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

## Migration from i18next-parser

Automatically migrate from legacy `i18next-parser.config.js`:

```bash
npx i18next-toolkit migrate-config
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
  run: npx i18next-toolkit extract --ci
```

## Watch Mode

For development, use watch mode to automatically update translations:

```bash
npx i18next-toolkit extract --watch
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
```

### React Components
```jsx
// Trans component
<Trans i18nKey="welcome">Welcome {{name}}</Trans>
<Trans ns="common">user.greeting</Trans>

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
