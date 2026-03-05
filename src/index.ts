export type {
  I18nextToolkitConfig,
  Plugin,
  LinterPlugin,
  InstrumenterPlugin,
  LintPluginContext,
  LintIssue,
  PluginContext,
  ExtractedKey,
  TranslationResult,
  ExtractedKeysMap,
  RenameKeyResult,
  Logger,
  InstrumenterOptions,
  CandidateString,
  TransformResult,
  FileInstrumentationResult,
  InstrumentationResults,
  ComponentBoundary,
  FileScanResult,
  CustomCandidateScorer,
  InstrumentPluginContext
} from './types.js'
export { defineConfig } from './config.js'
export {
  extract,
  findKeys,
  getTranslations,
  runExtractor
} from './extractor.js'

export { runLinter, recommendedAcceptedTags, recommendedAcceptedAttributes } from './linter.js'
export { runSyncer } from './syncer.js'
export { runStatus } from './status.js'
export { runTypesGenerator } from './types-generator.js'
export { runRenameKey } from './rename-key.js'
export { runInstrumenter, writeExtractedKeys } from './instrumenter/index.js'
