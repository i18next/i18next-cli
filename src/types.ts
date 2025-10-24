import type { Expression, Node, ObjectExpression } from '@swc/core'

/**
 * Main configuration interface for the i18next toolkit.
 * Defines all available options for extraction, type generation, synchronization, and integrations.
 *
 * @example
 * ```typescript
 * const config: I18nextToolkitConfig = {
 *   locales: ['en', 'de', 'fr'],
 *   extract: {
 *     input: ['src/**\/*.{ts,tsx}'],
 *     output: 'locales/{{language}}/{{namespace}}.json',
 *     functions: ['t', 'i18n.t'],
 *     transComponents: ['Trans', 'Translation']
 *   },
 *   types: {
 *     input: ['locales/en/*.json'],
 *     output: 'src/types/i18next.d.ts'
 *   }
 * }
 * ```
 */
export interface I18nextToolkitConfig {
  /** Array of supported locale codes (e.g., ['en', 'de', 'fr']) */
  locales: string[];

  /** Configuration options for translation key extraction */
  extract: {
    /** Glob pattern(s) for source files to scan for translation keys */
    input: string | string[];

    /** Glob pattern(s) for files to ignore during extraction */
    ignore?: string | string[];

    /** Output path template with placeholders: {{language}} for locale, {{namespace}} for namespace */
    output: string;

    /**
     * Default namespace when none is specified (default: 'translation').
     * Set to false will not generate any namespace, useful if i.e. the output is a single language json with 1 namespace (and no nesting).
     */
    defaultNS?: string | false;

    /** Separator for nested keys, or false for flat keys (default: '.') */
    keySeparator?: string | false | null;

    /** Separator between namespace and key, or false to disable (default: ':') */
    nsSeparator?: string | false | null;

    /** Separator for context variants (default: '_') */
    contextSeparator?: string;

    /** Separator for plural variants (default: '_') */
    pluralSeparator?: string;

    /** Function names to extract translation calls from (default: ['t', '*.t']) */
    functions?: string[];

    /** JSX component names to extract translations from (default: ['Trans']) */
    transComponents?: string[];

    /**
     * Hook function names that return translation functions.
     * Can be a string for default behavior (ns: arg 0, keyPrefix: arg 1)
     * or an object for custom argument positions.
     * (default: ['useTranslation', 'getT', 'useT'])
     */
    useTranslationNames?: Array<string | {
      name: string;
      nsArg?: number;
      keyPrefixArg?: number;
    }>;

    /** A list of JSX attribute names to ignore when linting for hardcoded strings. */
    ignoredAttributes?: string[];

    /** A list of JSX tag names whose content should be ignored when linting (e.g., 'code', 'pre'). */
    ignoredTags?: string[];

    /** HTML tags to preserve in Trans component serialization (default: ['br', 'strong', 'i']) */
    transKeepBasicHtmlNodesFor?: string[];

    /** Glob patterns for keys to preserve even if not found in source (for dynamic keys) */
    preservePatterns?: string[];

    /** Whether to sort keys alphabetically in output files, or a comparator function to customize the order (default: true) */
    sort?: boolean | ((a: ExtractedKey, b: ExtractedKey) => number);

    /** Number of spaces for JSON indentation (default: 2) */
    indentation?: number | string;

    /** Default value to use for missing translations in secondary languages */
    defaultValue?: string | ((key: string, namespace: string, language: string, value: string) => string);

    /** Primary language that provides default values (default: first locale) */
    primaryLanguage?: string;

    /** Secondary languages that get empty values initially */
    secondaryLanguages?: string[];

    /**
     * The format of the output translation files.
     * 'json': Standard JSON file (default)
     * 'js': JavaScript file with ES Module syntax (export default)
     * 'js-esm': JavaScript file with ES Module syntax (export default)
     * 'js-cjs': JavaScript file with CommonJS syntax (module.exports)
     * 'ts': TypeScript file with ES Module syntax and `as const` for type safety
     */
    outputFormat?: 'json' | 'js' | 'js-esm' | 'js-esm' | 'js-cjs' | 'ts';

    /**
     * If true, all namespaces will be merged into a single file per language.
     * The `output` path should not contain the `{{namespace}}` placeholder.
     * Example output: `locales/en.js`
     * (default: false)
     */
    mergeNamespaces?: boolean;

    /** If true, keys that are not found in the source code will be removed from translation files. (default: true) */
    removeUnusedKeys?: boolean;

    // New option to control whether base plural forms are generated when context is present
    generateBasePluralForms?: boolean

    // New option to completely disable plural generation
    disablePlurals?: boolean
  };

  /** Configuration options for TypeScript type generation */
  types?: {
    /** Glob pattern(s) for translation files to generate types from */
    input: string | string[];

    /** Output path for the main TypeScript definition file */
    output: string;

    /** Enable type-safe selector API (boolean or 'optimize' for smaller types) */
    enableSelector?: boolean | 'optimize';

    /** Path for the separate resources interface file */
    resourcesFile?: string;
  };

  /** Array of plugins to extend functionality */
  plugins?: Plugin[];

  /** Configuration for Locize integration */
  locize?: {
    /** Locize project ID */
    projectId?: string;

    /** Locize API key (recommended to use environment variables) */
    apiKey?: string;

    /** Version to sync with (default: 'latest') */
    version?: string;

    /** Whether to update existing translation values on Locize */
    updateValues?: boolean;

    /** Only sync the source language to Locize */
    sourceLanguageOnly?: boolean;

    /** Compare modification times when syncing */
    compareModificationTime?: boolean;

    /** Preview changes without making them */
    dryRun?: boolean;
  };
}

/**
 * Plugin interface for extending the i18next toolkit functionality.
 * Plugins can hook into various stages of the extraction process.
 *
 * @example
 * ```typescript
 * const myPlugin = (): Plugin => ({
 *   name: 'my-custom-plugin',
 *
 *   setup: async () => {
 *     console.log('Plugin initialized')
 *   },
 *
 *   onLoad: (code, filePath) => {
 *     // Transform code before parsing
 *     return code.replace(/OLD_PATTERN/g, 'NEW_PATTERN')
 *   },
 *
 *   onVisitNode: (node, context) => {
 *     if (node.type === 'CallExpression') {
 *       // Custom extraction logic
 *       context.addKey({ key: 'custom.key', defaultValue: 'Custom Value' })
 *     }
 *   },
 *
 *   onEnd: async (allKeys) => {
 *     console.log(`Found ${allKeys.size} total keys`)
 *   }
 * })
 * ```
 */
export interface Plugin {
  /** Unique name for the plugin */
  name: string;

  /**
   * Custom function to extract keys from an AST expression. Useful
   * for plugins that need to extract key patterns from `t(..., options)`
   * or `<Trans i18nKey={...} />`.
   *
   * @param expression - An expression to extract keys from
   * @param config - The i18next toolkit configuration object
   * @param logger - Logger instance for output
   *
   * @returns An array of extracted keys
   */
  extractKeysFromExpression?: (expression: Expression, config: Omit<I18nextToolkitConfig, 'plugins'>, logger: Logger) => string[];

  /**
   * Custom function to extract context from an AST expression. Useful
   * for plugins that need to extract context patterns from `t('key', { context: ... })`
   * or `<Trans i18nKey="key" context={...} />`.
   *
   * @param expression - An expression to extract context from
   * @param config - The i18next toolkit configuration object
   * @param logger - Logger instance for output
   *
   * @returns An array of extracted context values
   */
  extractContextFromExpression?: (expression: Expression, config: Omit<I18nextToolkitConfig, 'plugins'>, logger: Logger) => string[];

  /**
   * Hook called once at the beginning of the extraction process.
   * Use for initialization tasks like setting up resources or validating configuration.
   */
  setup?: () => void | Promise<void>;

  /**
   * Hook called for each source file before it's parsed.
   * Allows transformation of source code before AST generation.
   *
   * @param code - The source code content
   * @param path - The file path being processed
   * @returns The transformed code (or undefined to keep original)
   */
  onLoad?: (code: string, path: string) => string | Promise<string>;

  /**
   * Hook called for each AST node during traversal.
   * Enables custom extraction logic by examining syntax nodes.
   *
   * @param node - The current AST node being visited
   * @param context - Context object with helper methods
   */
  onVisitNode?: (node: Node, context: PluginContext) => void;

  /**
   * Hook called after all files have been processed.
   * Useful for post-processing, validation, or reporting.
   *
   * @param keys - Final map of all extracted keys
   */
  onEnd?: (keys: Map<string, ExtractedKey>) => void | Promise<void>;

  /**
   * Hook called after all files have been processed and translation files have been generated.
   * Useful for post-processing, validation, or reporting based on the final results.
   *
   * @param results - Array of translation results with update status and content.
   * @param config - The i18next toolkit configuration object.
   */
  afterSync?: (results: TranslationResult[], config: I18nextToolkitConfig) => void | Promise<void>;
}

/**
 * Represents an extracted translation key with its metadata.
 * Contains all information needed to generate translation files.
 *
 * @example
 * ```typescript
 * const extractedKey: ExtractedKey = {
 *   key: 'user.profile.name',
 *   defaultValue: 'Full Name',
 *   ns: 'common',
 *   hasCount: false
 * }
 * ```
 */
export interface ExtractedKey {
  /** The translation key (may be nested with separators) */
  key: string;

  /** Default value to use in the primary language */
  defaultValue?: string;

  /** Namespace this key belongs to */
  ns?: string | false;

  /**
   * Whether the namespace was implicit (i.e. no explicit ns on the source).
   * When true and config.extract.defaultNS === false the key should be treated
   * as "no namespace" for output generation (top-level file).
   */
  nsIsImplicit?: boolean;

  /** Whether this key is used with pluralization (count parameter) */
  hasCount?: boolean;

  /** Whether this key is used with ordinal pluralization */
  isOrdinal?: boolean;

  /** AST node for options object, used for advanced plural handling in Trans */
  optionsNode?: ObjectExpression;

  /** hold the raw context expression from the AST */
  contextExpression?: Expression;

  /** Whether the defaultValue was explicitly provided in source code (vs derived from children/key) */
  explicitDefault?: boolean;
}

/**
 * Result of processing translation files for a specific locale and namespace.
 * Contains the generated translations and metadata about changes.
 *
 * @example
 * ```typescript
 * const result: TranslationResult = {
 *   path: '/project/locales/en/common.json',
 *   updated: true,
 *   newTranslations: { button: { save: 'Save', cancel: 'Cancel' } },
 *   existingTranslations: { button: { save: 'Save' } }
 * }
 * ```
 */
export interface TranslationResult {
  /** Full file system path where the translation file will be written */
  path: string;

  /** Whether the file content changed and needs to be written */
  updated: boolean;

  /** The new translation object to be written to the file */
  newTranslations: Record<string, any>;

  /** The existing translation object that was read from the file */
  existingTranslations: Record<string, any>;
}

/**
 * Logger interface for consistent output formatting across the toolkit.
 * Implementations can customize how messages are displayed or stored.
 *
 * @example
 * ```typescript
 * class FileLogger implements Logger {
 *   info(message: string) { fs.appendFileSync('info.log', message) }
 *   warn(message: string) { fs.appendFileSync('warn.log', message) }
 *   error(message: string) { fs.appendFileSync('error.log', message) }
 * }
 * ```
 */
export interface Logger {
  /**
   * Logs an informational message.
   * @param message - The message to log
   */
  info(message: string): void;

  /**
   * Logs a warning message.
   * @param message - The warning message to log
   */
  warn(message: string, more?: any): void;

  /**
   * Logs an error message.
   * @param message - The error message to log
   */
  error(message: string | any): void;
}

/**
 * Context object provided to plugins during AST traversal.
 * Provides helper methods for plugins to interact with the extraction process.
 *
 * @example
 * ```typescript
 * // Inside a plugin's onVisitNode hook:
 * onVisitNode(node, context) {
 *   if (isCustomTranslationCall(node)) {
 *     context.addKey({
 *       key: extractKeyFromNode(node),
 *       defaultValue: extractDefaultFromNode(node),
 *       ns: 'custom'
 *     })
 *   }
 * }
 * ```
 */
export interface PluginContext {
  /**
   * Adds a translation key to the extraction results.
   * Keys are automatically deduplicated by their namespace:key combination.
   *
   * @param keyInfo - The extracted key information
   */
  addKey: (keyInfo: ExtractedKey) => void;

  /** The fully resolved i18next-cli configuration. */
  config: I18nextToolkitConfig;

  /** The shared logger instance. */
  logger: Logger;

  /**
   * Retrieves variable information from the current scope chain.
   * Searches from the innermost scope outwards.
   * @param name - The variable name to look up (e.g., 't').
   * @returns Scope information if found, otherwise undefined.
   */
  getVarFromScope: (name: string) => ScopeInfo | undefined;
}

/**
 * Represents variable scope information tracked during AST traversal.
 * Used to maintain context about translation functions and their configuration.
 */
export interface ScopeInfo {
  /** Default namespace for translation calls in this scope */
  defaultNs?: string;
  /** Key prefix to prepend to all translation keys in this scope */
  keyPrefix?: string;
}

/**
 * Configuration for useTranslation hook patterns.
 * Defines how to extract namespace and key prefix information from hook calls.
 *
 * @example
 * ```typescript
 * // For: const { t } = useTranslation('common', { keyPrefix: 'user' })
 * const config: UseTranslationHookConfig = {
 *   name: 'useTranslation',
 *   nsArg: 0,      // namespace is first argument
 *   keyPrefixArg: 1 // keyPrefix is in second argument (options object)
 * }
 * ```
 */
export interface UseTranslationHookConfig {
  /** The name of the hook function (e.g., 'useTranslation', 'getT') */
  name: string;
  /** Zero-based index of the argument containing the namespace */
  nsArg: number;
  /** Zero-based index of the argument containing options with keyPrefix */
  keyPrefixArg: number;
}

/**
 * Optional hooks for customizing AST visitor behavior during extraction.
 * Allows plugins and external code to extend the visitor's capabilities.
 *
 * @example
 * ```typescript
 * const hooks: ASTVisitorHooks = {
 *   onBeforeVisitNode: (node) => {
 *     console.log(`Visiting ${node.type}`)
 *   },
 *
 *   resolvePossibleKeyStringValues: (expression) => {
 *     // Custom logic to extract keys from complex expressions
 *     if (isCustomKeyExpression(expression)) {
 *       return ['custom.key.1', 'custom.key.2']
 *     }
 *     return []
 *   }
 * }
 * ```
 */
export interface ASTVisitorHooks {
  /**
   * Called before visiting each AST node during traversal.
   * Useful for logging, debugging, or pre-processing nodes.
   *
   * @param node - The AST node about to be visited
   */
  onBeforeVisitNode?: (node: Node) => void

  /**
   * Called after visiting each AST node during traversal.
   * Useful for cleanup, post-processing, or collecting statistics.
   *
   * @param node - The AST node that was just visited
   */
  onAfterVisitNode?: (node: Node) => void

  /**
   * Custom resolver for extracting context values from expressions.
   * Supplements the built-in expression resolution with plugin-specific logic.
   *
   * @param expression - The expression to extract context from
   * @param returnEmptyStrings - Whether to include empty strings in results
   * @returns Array of possible context string values
   */
  resolvePossibleContextStringValues?: (expression: Expression, returnEmptyStrings?: boolean) => string[]

  /**
   * Custom resolver for extracting translation keys from expressions.
   * Supplements the built-in expression resolution with plugin-specific logic.
   *
   * @param expression - The expression to extract keys from
   * @param returnEmptyStrings - Whether to include empty strings in results
   * @returns Array of possible translation key values
   */
  resolvePossibleKeyStringValues?: (expression: Expression, returnEmptyStrings?: boolean) => string[]
}
