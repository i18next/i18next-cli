export type {
  InstrumenterOptions,
  CandidateString,
  TransformResult,
  FileInstrumentationResult,
  InstrumentationResults,
  ComponentBoundary,
  FileScanResult,
  ImportDeclarationSpan,
  MemoHookSpan,
  PluralHelperImport,
  LanguageChangeSite,
  CustomCandidateScorer,
  InstrumentPluginContext,
  InstrumenterPlugin
} from '../types.js'
export {
  runInstrumenter,
  writeExtractedKeys,
  isProjectUsingReact,
  isProjectUsingTypeScript,
  detectProjectEnvironment,
  findExistingI18nInitFile
} from './core/instrumenter.js'
export type { ProjectEnvironment } from './core/instrumenter.js'
export { detectCandidate } from './core/string-detector.js'
export { generateKeyFromContent, createKeyRegistry } from './core/key-generator.js'
export { transformFile, generateDiff } from './core/transformer.js'
