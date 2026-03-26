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
    output: string | ((language: string, namespace?: string) => string);

    /**
     * Default namespace when none is specified (default: 'translation').
     * Set to false will not generate any namespace, useful if i.e. the output is a single language json with 1 namespace (and no nesting).
     */
    defaultNS?: string | false;

    /** Namespace to use as fallback when a key is missing in the current namespace for a locale. */
    fallbackNS?: string | false;

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

    /** for linting: Optional accept-list of JSX attribute names to exclusively lint (takes precedence over ignoredAttributes).
     *
     * If not provided (and no `extract.acceptedAttributes` is set), the linter will fall back to a recommended
     * built-in accepted-list of common translatable attributes (e.g. `alt`, `title`, `placeholder`, `aria-label`, ...).
     * See README for the exact recommended list.
     */
    acceptedAttributes?: string[];

    /** for linting: Optional accept-list of JSX tag names to exclusively lint (takes precedence over ignoredTags).
     *
     * If not provided (and no `extract.acceptedTags` is set), the linter will fall back to a recommended
     * built-in accepted-list of common content-bearing tags (e.g. `p`, `span`, `div`, `button`, `label`, ...).
     * See README for the exact recommended list.
     */
    acceptedTags?: string[];

    /** HTML tags to preserve in Trans component serialization (default: ['br', 'strong', 'i']) */
    transKeepBasicHtmlNodesFor?: string[];

    /** Glob patterns for keys to preserve even if not found in source (for dynamic keys) */
    preservePatterns?: string[];

    /**
     * When true, preserves all context variants of keys that use context parameters.
     * For example, if 'friend' is used with context, all variants like 'friend_male',
     * 'friend_female', etc. are preserved even if not explicitly found in source code.
     * (default: false)
     */
    preserveContextVariants?: boolean;

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
     * 'json5': JSON5 file
     * 'yaml': YAML file
     * 'js': JavaScript file with ES Module syntax (export default)
     * 'js-esm': JavaScript file with ES Module syntax (export default)
     * 'js-cjs': JavaScript file with CommonJS syntax (module.exports)
     * 'ts': TypeScript file with ES Module syntax and `as const` for type safety
     */
    outputFormat?: 'json' | 'json5' | 'yaml' | 'js' | 'ts' | 'js-esm' | 'js-cjs' | 'ts';

    /**
     * If true, all namespaces will be merged into a single file per language.
     * The `output` path should not contain the `{{namespace}}` placeholder.
     * Example output: `locales/en.js`
     * (default: false)
     */
    mergeNamespaces?: boolean;

    /** If true, keys that are not found in the source code will be removed from translation files. (default: true) */
    removeUnusedKeys?: boolean;

    /**
     * Array of namespace names to ignore during extraction, status, and sync operations.
     * Keys using these namespaces will be excluded from processing.
     * Useful for monorepos where shared namespaces are managed elsewhere.
     * @example ['shared', 'common']
     */
    ignoreNamespaces?: string[];

    /**
     * If false, translation keys will not be extracted from comments.
     * (default: true)
     */
    extractFromComments?: boolean;

    // control whether base plural forms are generated when context is present
    generateBasePluralForms?: boolean

    // completely disable plural generation
    disablePlurals?: boolean

    /**
     * When true, generates the union of all configured locales' plural forms for every language.
     * For example, with locales ['en', 'pl'], English normally only gets _one/_other,
     * but with this option it also gets _few/_many (needed by Polish).
     * Only forms required by at least one configured locale are generated.
     * (default: false)
     */
    allPluralForms?: boolean

    /**
     * Prefix for nested translations.
     * (default: '$t(')
     */
    nestingPrefix?: string;

    /**
     * Suffix for nested translations.
     * (default: ')')
     */
    nestingSuffix?: string;

    /**
     * Separator for nested translation options.
     * (default: ',')
     */
    nestingOptionsSeparator?: string;

    /**
     * Interpolation prefix used in defaultValue templates and runtime interpolation.
     * Example: '{{' (default)
     */
    interpolationPrefix?: string;

    /**
     * Interpolation suffix used in defaultValue templates and runtime interpolation.
     * Example: '}}' (default)
     */
    interpolationSuffix?: string;

    /**
     * Custom scorer function for the `instrument` command.
     * When provided, this function is called for every candidate string during
     * instrumentation. It can override the built-in heuristic confidence score.
     *
     * Return a number between 0 and 1 to override the confidence score,
     * or `null` to skip the candidate entirely.
     * Return `undefined` to fall back to the built-in heuristic.
     */
    instrumentScorer?: CustomCandidateScorer;

    /**
     * Warn (or error) when the same ns:key is extracted with different default values.
     * - `true` or `'warn'`: log a warning for each conflict
     * - `'error'`: throw an error on the first conflict, aborting extraction
     * - `false` or omitted: silent (default)
     */
    warnOnConflicts?: boolean | 'warn' | 'error';
  };

  /** Configuration options for linter */
  lint?: {
    /** A list of JSX attribute names to ignore when linting for hardcoded strings. */
    ignoredAttributes?: string[];

    /** A list of JSX tag names whose content should be ignored when linting (e.g., 'code', 'pre'). */
    ignoredTags?: string[];

    /** for linting: Optional accept-list of JSX attribute names to exclusively lint (takes precedence over ignoredAttributes).
     *
     * If not provided (and no `extract.acceptedAttributes` is set), the linter will fall back to a recommended
     * built-in accepted-list of common translatable attributes (e.g. `alt`, `title`, `placeholder`, `aria-label`, ...).
     * See README for the exact recommended list.
     */
    acceptedAttributes?: string[];

    /** for linting: Optional accept-list of JSX tag names to exclusively lint (takes precedence over ignoredTags).
     *
     * If not provided (and no `extract.acceptedTags` is set), the linter will fall back to a recommended
     * built-in accepted-list of common content-bearing tags (e.g. `p`, `span`, `div`, `button`, `label`, ...).
     * See README for the exact recommended list.
     */
    acceptedTags?: string[];

    /** Glob pattern(s) for files to ignore during lint (in addition to those defined during extract) */
    ignore?: string | string[];

    /** Enable linting for interpolation parameter errors in translation calls (default: true) */
    checkInterpolationParams?: boolean;
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

    /**
     * Number of spaces or string to use for indentation when generating
     * TypeScript definitions. Falls back to `extract.indentation` when unset.
     */
    indentation?: number | string;
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

    /** Specify the cdn endpoint that should be used (depends on which cdn type you've in your locize project) */
    cdnType?: 'standard' | 'pro';

    /** Preview changes without making them */
    dryRun?: boolean;
  };
}

type MaybePromise<T> = T | Promise<T>

/**
 * Represents a linter issue reported for a source file.
 */
export interface LintIssue {
  /** The hardcoded text content or interpolation error message */
  text: string;
  /** Line number where the issue was found */
  line: number;
  /** Issue category */
  type?: 'hardcoded' | 'interpolation';
}

/**
 * Context object provided to linter plugin hooks.
 */
export interface LintPluginContext {
  /** The fully resolved i18next-cli configuration. */
  config: I18nextToolkitConfig;

  /** The logger instance used by the linter run. */
  logger: Logger;
}

/**
 * Context object provided to instrument plugin hooks.
 */
export interface InstrumentPluginContext {
  /** The fully resolved i18next-cli configuration. */
  config: I18nextToolkitConfig;

  /** The logger instance used by the instrument run. */
  logger: Logger;
}

/**
 * Linter-specific plugin hooks.
 *
 * This interface is kept separate so lint capabilities can evolve
 * without coupling extractor hook definitions.
 */
export interface LinterPlugin {
  /** Unique name for the plugin */
  name: string;

  /**
   * Optional file-extension hint for lint-only hooks (optimization only).
   *
   * Examples: ['.vue'], ['vue', 'svelte']
   */
  lintExtensions?: string[];

  /**
   * Hook called once at the beginning of the linting process.
   * Use for initialization required by lint hooks.
   */
  lintSetup?: (context: LintPluginContext) => MaybePromise<void>;

  /**
   * Hook called for each source file before lint parsing.
   *
   * Return semantics in lint pipeline:
   * - string: use transformed code
   * - undefined: pass through unchanged
   * - null: skip linting this file entirely
   */
  lintOnLoad?: (code: string, filePath: string) => MaybePromise<string | null | undefined>;

  /**
   * Hook called after linting one file, allowing issue post-processing.
   *
   * Return semantics:
   * - LintIssue[]: replace issues for this file
   * - undefined: keep issues unchanged
   */
  lintOnResult?: (filePath: string, issues: LintIssue[]) => MaybePromise<LintIssue[] | undefined>;
}

/**
 * Instrumenter-specific plugin hooks.
 *
 * This interface is kept separate so instrument capabilities can evolve
 * without coupling linter or extractor hook definitions.
 */
export interface InstrumenterPlugin {
  /** Unique name for the plugin */
  name: string;

  /**
   * Optional file-extension hint for instrument hooks.
   * When set, instrument hooks are only invoked for files matching these extensions.
   *
   * Examples: ['.vue'], ['.svelte']
   */
  instrumentExtensions?: string[];

  /**
   * Hook called once at the beginning of the instrument process.
   * Use for initialization required by instrument hooks.
   */
  instrumentSetup?: (context: InstrumentPluginContext) => MaybePromise<void>;

  /**
   * Hook called for each source file before string detection.
   *
   * Return semantics:
   * - string: use transformed code for detection
   * - undefined: pass through unchanged
   * - null: skip instrumenting this file entirely
   */
  instrumentOnLoad?: (code: string, filePath: string) => MaybePromise<string | null | undefined>;

  /**
   * Hook called after candidate detection for one file, allowing
   * post-processing of candidate strings.
   *
   * Return semantics:
   * - CandidateString[]: replace candidates for this file
   * - undefined: keep candidates unchanged
   */
  instrumentOnResult?: (filePath: string, candidates: CandidateString[]) => MaybePromise<CandidateString[] | undefined>;
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
export interface Plugin extends LinterPlugin, InstrumenterPlugin {
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
  setup?: () => MaybePromise<void>;

  /**
   * Hook called for each source file before it's parsed.
   * Allows transformation of source code before AST generation.
   *
   * @param code - The source code content
   * @param path - The file path being processed
   * @returns The transformed code (or undefined to keep original)
   */
  onLoad?: (code: string, path: string) => MaybePromise<string | undefined>;

  /**
   * Hook called for each AST node during traversal.
   * Enables custom extraction logic by examining syntax nodes.
   *
   * @param node - The current AST node being visited
   * @param context - Context object with helper methods
   */
  onVisitNode?: (node: Node, context: PluginContext) => void;

  /**
   * Hook called synchronously for every translation key submitted to the extractor,
   * including duplicates, before the deduplication decision is made.
   * Receives a frozen, fully-normalized ExtractedKey snapshot (namespace resolved,
   * defaultValue guaranteed non-null). The hook is purely observational — returning
   * void — and does not alter what is stored.
   *
   * @param key - A frozen snapshot of the extracted key
   */
  onKeySubmitted?: (key: Readonly<ExtractedKey>) => void;

  /**
   * Hook called after all files have been processed.
   * Useful for post-processing, validation, or reporting.
   *
   * @param keys - Final map of all extracted keys
   */
  onEnd?: (keys: ExtractedKeysMap) => MaybePromise<void>;

  /**
   * Hook called after all files have been processed and translation files have been generated.
   * Useful for post-processing, validation, or reporting based on the final results.
   *
   * @param results - Array of translation results with update status and content.
   * @param config - The i18next toolkit configuration object.
   */
  afterSync?: (results: TranslationResult[], config: I18nextToolkitConfig) => MaybePromise<void>;
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

  /** True when the extractor returned an already-expanded plural form (e.g. "key_one") */
  isExpandedPlural?: boolean

  /** Source locations where this key was found (optional, populated by plugins) */
  locations?: Array<{
    file: string
    line?: number
    column?: number
  }>

  /**
   * The base key (without context/plural suffixes) when this key accepts context.
   * For example, if the key is 'friend_male' and it has context, this would be 'friend'.
   * This is used to preserve all context variants in translation files.
   * Empty/undefined if the key doesn't use context.
   */
  keyAcceptingContext?: string;

  /**
   * Whether the namespace was derived from splitting the key by nsSeparator.
   * When true, the natural language heuristic may rejoin the namespace and key
   * if the namespace looks like natural language (contains spaces, etc.).
   * When false/undefined, the namespace was explicitly provided (via options,
   * useTranslation scope, etc.) and should not be subject to the heuristic.
   */
  nsFromKeySplit?: boolean;
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

  /**
   * Injects or overrides variable scope information in the innermost active scope.
   *
   * Use this inside an `onVisitNode` hook to teach the extractor about translation
   * functions whose namespace or key prefix cannot be determined by static analysis
   * alone — for example, when the namespace is derived from an external constant,
   * a config file, or a naming convention that the built-in resolver does not cover.
   *
   * The injected scope will be picked up by subsequent `t()` call resolution for
   * any variable matching `name` in the current scope chain, exactly as if the
   * extractor had found it through a `useTranslation` or `getFixedT` call.
   *
   * @param name - The variable name to register (e.g., `'t'`, `'myT'`).
   * @param info - The scope information to associate: `defaultNs` and/or `keyPrefix`.
   *
   * @example
   * ```typescript
   * // Plugin that resolves namespace from a well-known module-level constant
   * onVisitNode(node, context) {
   *   if (node.type === 'VariableDeclarator' && isMyHookCall(node)) {
   *     context.setVarInScope('t', {
   *       defaultNs: 'users',
   *       keyPrefix: 'login',
   *     })
   *   }
   * }
   * ```
   */
  setVarInScope: (name: string, info: ScopeInfo) => void
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

/**
 * Map of extracted translation keys with their metadata.
 * Used in plugin hooks like `onEnd` to access all extracted keys.
 *
 * @example
 * ```typescript
 * const myPlugin = (): Plugin => ({
 *   name: 'my-plugin',
 *   async onEnd(keys: ExtractedKeysMap) {
 *     console.log(`Found ${keys.size} keys`)
 *     for (const [uniqueKey, extractedKey] of keys.entries()) {
 *       // Process each key
 *     }
 *   }
 * })
 * ```
 */
export type ExtractedKeysMap = Map<string, ExtractedKey>

export interface RenameKeyResult {
  success: boolean
  sourceFiles: Array<{ path: string; changes: number }>
  translationFiles: Array<{ path: string; updated: boolean }>
  conflicts?: string[]
  error?: string
}

/**
 * Options for the instrument command
 */
export interface InstrumenterOptions {
  isDryRun?: boolean
  isInteractive?: boolean
  namespace?: string
  quiet?: boolean
}

/**
 * Represents a candidate string found in source code for instrumentation
 */
export interface CandidateString {
  /**
   * The string content
   */
  content: string

  /**
   * Confidence score (0-1) indicating likelihood this should be translated
   */
  confidence: number

  /**
   * Byte offset in the source file (from normalizeASTSpans)
   */
  offset: number

  /**
   * End byte offset in the source file
   */
  endOffset: number

  /**
   * Type of transformation needed
   */
  type: 'string-literal' | 'jsx-text' | 'jsx-attribute' | 'jsx-mixed' | 'template-literal'

  /**
   * File path where candidate was found
   */
  file: string

  /**
   * Line number (1-based)
   */
  line: number

  /**
   * Column number (0-based)
   */
  column: number

  /**
   * Optional key to use (if provided by user or generated)
   */
  key?: string

  /**
   * For JSX, the JSXElement node information
   */
  jsxNode?: {
    selfClosing: boolean
    openingTagEnd: number
    closingTagStart: number
  }

  /**
   * Reason for skipping (if candidate was filtered out)
   */
  skipReason?: string

  /**
   * Name of the enclosing React function component, if any.
   * When set, the candidate will use t() instead of i18next.t()
   * and a useTranslation() hook will be injected into the component.
   */
  insideComponent?: string

  /**
   * Interpolation variables for template literals with expressions or merged
   * JSX text-plus-expression runs.  When present the replacement will use
   * i18next interpolation syntax (`{{name}}`) and pass a variables object.
   */
  interpolations?: Array<{
    /** Variable name used in the i18next interpolation string */
    name: string
    /** Source-code expression (e.g. `count`, `profile.name`) */
    expression: string
  }>

  /**
   * For `jsx-mixed` candidates: the translation value with indexed tags
   * (e.g. `Click <1>here</1> to accept`).  Used by `writeExtractedKeys` for
   * the JSON output instead of `content`.
   */
  transValue?: string

  /**
   * Plural forms detected from a conditional (ternary) pattern.
   * When present the transformer emits `t(key, { count: expr })` and the
   * JSON writer creates `key_zero`, `key_one` and `key_other` entries.
   */
  pluralForms?: {
    /** Source expression used as `count` (e.g. `activeTasks`) */
    countExpression: string
    /** Text for the zero case (may be undefined when only one/other detected) */
    zero?: string
    /** Text for the singular case */
    one?: string
    /** Text for the plural ("other") case; uses `{{count}}` for the variable */
    other: string
  }
}

/**
 * Result of a file transformation during instrumentation
 */
export interface TransformResult {
  /**
   * Whether the file was modified
   */
  modified: boolean

  /**
   * The new file content after transformation
   */
  newContent?: string

  /**
   * Unified diff showing what changed
   */
  diff?: string

  /**
   * Errors that occurred during transformation
   */
  errors: string[]

  /**
   * Warnings about potential runtime issues (e.g. i18next.t() in React files)
   */
  warnings: string[]

  /**
   * Number of strings transformed
   */
  transformCount: number

  /**
   * Number of language-change sites instrumented
   */
  languageChangeCount: number

  /**
   * Injections made (imports, hooks)
   */
  injections: {
    importAdded?: boolean
    hookInjected?: boolean
  }
}

/**
 * Instrumentation result for a single file
 */
export interface FileInstrumentationResult {
  file: string
  candidates: CandidateString[]
  result: TransformResult
}

/**
 * Overall instrumentation results
 */
export interface InstrumentationResults {
  files: FileInstrumentationResult[]
  totalCandidates: number
  totalTransformed: number
  totalSkipped: number
  totalLanguageChanges: number
  extractedKeys: Map<string, { namespace?: string | false; defaultValue: string }>
}

/**
 * Represents a detected React function component boundary in source code.
 * Used to determine where to inject useTranslation() hooks.
 */
export interface ComponentBoundary {
  /** Component function name (e.g. 'Greeting', 'Dashboard') */
  name: string
  /** Byte offset of the opening { of the function body */
  bodyStart: number
  /** Byte offset of the closing } of the function body */
  bodyEnd: number
  /** Whether the component already calls useTranslation() */
  hasUseTranslation: boolean
}

/**
 * Represents a detected language-change call site in source code.
 * The instrumenter injects `i18n.changeLanguage(expr)` alongside the
 * existing application-level language setter.
 */
export interface LanguageChangeSite {
  /**
   * The source-code expression that represents the chosen language code.
   * Example: `lang.code`, `lng`, `selectedLocale`.
   */
  languageExpression: string

  /**
   * Byte offset where the injection should happen.
   * This is the start of the call expression that sets the language.
   */
  callStart: number

  /**
   * End byte offset of the call expression.
   */
  callEnd: number

  /**
   * Name of the enclosing React component, if any.
   * When set, `i18n` from useTranslation() hook will be used;
   * otherwise `i18next.changeLanguage()` is used directly.
   */
  insideComponent?: string

  /** 1-based line number */
  line: number
  /** 0-based column */
  column: number
}

/**
 * Result of scanning a file for candidates and component boundaries.
 */
export interface FileScanResult {
  candidates: CandidateString[]
  components: ComponentBoundary[]
  /** Detected language-change call sites */
  languageChangeSites: LanguageChangeSite[]
}

/**
 * Custom scorer function for the instrument command.
 * Allows overriding the built-in heuristic with domain-specific logic.
 *
 * @param content - The string content being evaluated
 * @param context - Contextual information about the string's location
 * @returns A confidence score (0-1), `null` to skip the candidate, or `undefined` to use the built-in heuristic
 */
export type CustomCandidateScorer = (
  content: string,
  context: {
    file: string
    offset: number
    code: string
    beforeContext: string
    afterContext: string
  }
) => number | null | undefined
