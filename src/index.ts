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
} from './types'
export { defineConfig } from './config'
export {
  extract,
  findKeys,
  getTranslations,
  runExtractor
} from './extractor'

export { runLinter, recommendedAcceptedTags, recommendedAcceptedAttributes } from './linter'
export { runSyncer } from './syncer'
export { runStatus } from './status'
export { runTypesGenerator } from './types-generator'
export { runRenameKey } from './rename-key'
export { runInstrumenter, writeExtractedKeys } from './instrumenter'
